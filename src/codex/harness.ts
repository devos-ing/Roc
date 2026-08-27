import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type AgentHarness,
  type HarnessDelivery,
  type HarnessEvent,
  type HarnessStepRequest,
  HarnessStepRequestSchema,
  ImplementOutputSchema,
  ReviewOutputSchema,
  ScoutOutputSchema,
} from "../harness/contracts";
import { AgileError, normalizeError } from "../runtime/errors";
import type {
  TaskBranchManager,
  TaskWorkspace,
} from "../workspace/task-branch";
import type { CodexClientApi } from "./client";
import {
  ImplementDraftOutputJsonSchema,
  ImplementDraftOutputSchema,
  implementPrompt,
  ReviewOutputJsonSchema,
  reviewPrompt,
  ScoutOutputJsonSchema,
  scoutPrompt,
} from "./prompts";
import {
  AgentMessageItemSchema,
  classifyCodexTurnFailure,
  ExitedReviewModeItemSchema,
  ItemCompletedNotificationSchema,
  KnownServerRequestSchema,
  ReviewStartResponseSchema,
  ThreadReadResponseSchema,
  ThreadStartResponseSchema,
  ThreadTokenUsageUpdatedNotificationSchema,
  TurnCompletedNotificationSchema,
  TurnStartResponseSchema,
} from "./protocol";
import {
  buildDefaultSkillConfig,
  type DefaultSkillPolicy,
  SkillListResponseSchema,
} from "./skill-policy";

const UsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningOutputTokens: z.number().int().nonnegative(),
  })
  .strict();

const BackendCursorSchema = z
  .object({
    version: z.literal(1),
    nextSequence: z.number().int().positive(),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    usage: UsageSchema,
    outputDelivered: z.literal(true).optional(),
    reviewStatusBefore: z.string().optional(),
  })
  .strict();

type BackendCursor = z.infer<typeof BackendCursorSchema>;
type Usage = BackendCursor["usage"];
type EventWithoutSequence = {
  [Type in HarnessEvent["type"]]: Omit<
    Extract<HarnessEvent, { type: Type }>,
    "sequence"
  >;
}[HarnessEvent["type"]];
type SupportedRequest = HarnessStepRequest;

type ActiveAttempt = {
  attemptId: string;
  taskId: string;
  role: "scout" | "implement" | "review";
  threadId: string;
  turnId: string;
  baseCommit: string;
  outputDelivered: boolean;
  startedAt: string;
  reviewStatusBefore?: string;
  reconciledCompletion?: boolean;
};

const zeroUsage: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

function protocolError(
  code: string,
  message: string,
  request: HarnessStepRequest,
  threadId?: string,
  cause?: unknown,
): AgileError {
  return new AgileError({
    code,
    category: "protocol",
    retryable: true,
    component: "codex-harness",
    message,
    taskId: request.attempt.taskId,
    attemptId: request.attempt.attemptId,
    threadId,
    cause,
  });
}

function serializeCursor(cursor: BackendCursor): string {
  return JSON.stringify(BackendCursorSchema.parse(cursor));
}

function parseCursor(raw: string, request: HarnessStepRequest): BackendCursor {
  try {
    return BackendCursorSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw protocolError(
      "invalid_backend_cursor",
      "Codex backend cursor is invalid",
      request,
      undefined,
      error,
    );
  }
}

function cumulativeHash(usage: Usage): string {
  const canonical = JSON.stringify({
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function delivery(
  cursor: BackendCursor,
  event: EventWithoutSequence,
): HarnessDelivery {
  const sequence = cursor.nextSequence;
  return {
    kind: "event",
    nextCursor: serializeCursor({ ...cursor, nextSequence: sequence + 1 }),
    event: { ...event, sequence } as HarnessEvent,
  };
}

function sameSource(
  threadId: string,
  turnId: string,
  active: ActiveAttempt,
  request: HarnessStepRequest,
): void {
  if (threadId !== active.threadId || turnId !== active.turnId) {
    throw protocolError(
      "codex_notification_identity_mismatch",
      "Codex notification does not belong to the active turn",
      request,
      active.threadId,
    );
  }
}

function supportedRequest(request: HarnessStepRequest): SupportedRequest {
  if (request.attempt.role !== request.input.role) {
    throw protocolError(
      "codex_role_mismatch",
      "Harness attempt role does not match its input role",
      request,
    );
  }
  return request as SupportedRequest;
}

function threadSandbox(
  role: "scout" | "implement" | "review",
): "read-only" | "workspace-write" {
  return role === "implement" ? "workspace-write" : "read-only";
}

function turnSandbox(
  role: "scout" | "implement",
  workspace: TaskWorkspace,
): unknown {
  if (role === "scout") return { type: "readOnly", networkAccess: false };
  return {
    type: "workspaceWrite",
    writableRoots: [workspace.path],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  };
}

function prompt(request: SupportedRequest): string {
  if (request.input.role === "scout") return scoutPrompt(request.input);
  if (request.input.role === "implement") return implementPrompt(request.input);
  return reviewPrompt(request.input);
}

function outputSchema(role: "scout" | "implement" | "review"): unknown {
  if (role === "scout") return ScoutOutputJsonSchema;
  if (role === "implement") return ImplementDraftOutputJsonSchema;
  return ReviewOutputJsonSchema;
}

export function createCodexHarness(input: {
  client: CodexClientApi;
  branches: TaskBranchManager;
  skillPolicy?: DefaultSkillPolicy;
  now?: () => string;
}): AgentHarness {
  const now = input.now ?? (() => new Date().toISOString());
  const activeAttempts = new Map<string, ActiveAttempt>();
  const terminalAttempts = new Set<string>();
  const policyInterruptedTurns = new Set<string>();
  const terminalTurnSources = new Set<string>();

  function turnSource(threadId: string, turnId: string): string {
    return JSON.stringify([threadId, turnId]);
  }

  function terminalize(active: ActiveAttempt): void {
    activeAttempts.delete(active.attemptId);
    terminalAttempts.add(active.attemptId);
    terminalTurnSources.add(turnSource(active.threadId, active.turnId));
  }

  function withoutTerminalMarkers(cursor: BackendCursor): BackendCursor {
    const result = { ...cursor };
    delete result.outputDelivered;
    delete result.reviewStatusBefore;
    return result;
  }

  function failedDelivery(
    cursor: BackendCursor,
    active: ActiveAttempt,
    code: string,
    message: string,
    retryable = true,
  ): HarnessDelivery {
    terminalize(active);
    return delivery(withoutTerminalMarkers(cursor), {
      type: "attempt.failed_infra",
      eventId: `${active.attemptId}:${active.turnId}:failed_infra:${code}`,
      attemptId: active.attemptId,
      occurredAt: now(),
      code,
      message,
      retryable,
    });
  }

  function taskFailure(
    request: SupportedRequest,
    error: unknown,
  ): HarnessDelivery {
    const normalized = normalizeError(error, {
      code: "unexpected_task_failure",
      category: "infra",
      retryable: true,
      component: "codex-harness",
      message: "The Codex task failed unexpectedly",
      taskId: request.attempt.taskId,
      attemptId: request.attempt.attemptId,
    });
    if (normalized.category === "startup" || normalized.category === "domain") {
      throw normalized;
    }

    let cursor: BackendCursor | undefined;
    if (request.backendCursor !== undefined) {
      try {
        cursor = BackendCursorSchema.parse(JSON.parse(request.backendCursor));
      } catch {
        // A malformed task cursor still becomes a task-scoped terminal event.
      }
    }
    const known = activeAttempts.get(request.attempt.attemptId);
    const active: ActiveAttempt = known ?? {
      attemptId: request.attempt.attemptId,
      taskId: request.attempt.taskId,
      role: request.attempt.role,
      threadId: cursor?.threadId ?? `unavailable:${request.attempt.attemptId}`,
      turnId: cursor?.turnId ?? `unavailable:${request.attempt.attemptId}`,
      baseCommit: request.input.ticket.baseCommit ?? "",
      outputDelivered: false,
      startedAt: now(),
    };
    const failureCursor: BackendCursor = cursor ?? {
      version: 1,
      nextSequence: 1,
      threadId: active.threadId,
      turnId: active.turnId,
      usage: zeroUsage,
    };
    if (normalized.category === "policy") {
      terminalize(active);
      return delivery(withoutTerminalMarkers(failureCursor), {
        type: "attempt.blocked_policy",
        eventId: `${active.attemptId}:${active.turnId}:blocked_policy:${normalized.code}`,
        attemptId: active.attemptId,
        occurredAt: now(),
        code: normalized.code,
        message: normalized.message,
      });
    }
    return failedDelivery(
      failureCursor,
      active,
      normalized.code,
      normalized.message,
      normalized.retryable,
    );
  }

  function completedDelivery(
    cursor: BackendCursor,
    active: ActiveAttempt,
  ): HarnessDelivery {
    terminalize(active);
    return delivery(withoutTerminalMarkers(cursor), {
      type: "attempt.completed",
      eventId: `${active.attemptId}:${active.turnId}:completed`,
      attemptId: active.attemptId,
      occurredAt: now(),
    });
  }

  function classifiedTurnFailure(
    cursor: BackendCursor,
    active: ActiveAttempt,
    status: "failed" | "interrupted",
    error: unknown,
  ): HarnessDelivery {
    const failure = classifyCodexTurnFailure(status, error);
    if (failure.category === "policy") {
      terminalize(active);
      return delivery(withoutTerminalMarkers(cursor), {
        type: "attempt.blocked_policy",
        eventId: `${active.attemptId}:${active.turnId}:blocked_policy:${failure.code}`,
        attemptId: active.attemptId,
        occurredAt: now(),
        code: failure.code,
        message: failure.message,
      });
    }
    return failedDelivery(
      cursor,
      active,
      failure.code,
      failure.message,
      failure.retryable,
    );
  }

  async function assertReviewInvariant(
    request: SupportedRequest,
  ): Promise<void> {
    if (request.input.role !== "review") return;
    const baseCommit = request.input.ticket.baseCommit;
    if (baseCommit === undefined) {
      throw new AgileError({
        code: "missing_task_base_commit",
        category: "protocol",
        retryable: false,
        component: "codex-harness",
        message: "Review cannot prove the task base commit",
        taskId: request.attempt.taskId,
        attemptId: request.attempt.attemptId,
      });
    }
    try {
      await input.branches.assertReviewReady(
        request.attempt.taskId,
        request.input.implementation.commitSha,
        baseCommit,
      );
    } catch (error) {
      throw new AgileError({
        code: "invalid_review_commit",
        category: "protocol",
        retryable: false,
        component: "codex-harness",
        message: "Review requires the exact sole clean implementation commit",
        taskId: request.attempt.taskId,
        attemptId: request.attempt.attemptId,
        cause: error,
      });
    }
  }

  async function dispatch(request: SupportedRequest): Promise<HarnessDelivery> {
    const existing = activeAttempts.get(request.attempt.attemptId);
    if (existing) {
      if (
        existing.taskId !== request.attempt.taskId ||
        existing.role !== request.attempt.role
      ) {
        throw protocolError(
          "codex_attempt_identity_mismatch",
          "Active Codex attempt identity does not match the dispatch request",
          request,
          existing.threadId,
        );
      }
      const cursor: BackendCursor = {
        version: 1,
        nextSequence: 1,
        threadId: existing.threadId,
        turnId: existing.turnId,
        usage: zeroUsage,
        ...(existing.reviewStatusBefore === undefined
          ? {}
          : { reviewStatusBefore: existing.reviewStatusBefore }),
      };
      return delivery(cursor, {
        type: "attempt.started",
        eventId: `${request.attempt.attemptId}:${existing.turnId}:started`,
        attemptId: request.attempt.attemptId,
        occurredAt: existing.startedAt,
        threadId: existing.threadId,
        turnId: existing.turnId,
        baseCommit: existing.baseCommit,
      });
    }

    const workspace = await input.branches.prepare(
      request.attempt.taskId,
      request.input.ticket.baseCommit,
    );
    let reviewStatusBefore: string | undefined;
    if (request.attempt.role === "review") {
      try {
        await assertReviewInvariant(request);
        reviewStatusBefore = await input.branches.status(
          request.attempt.taskId,
          workspace.baseCommit,
        );
      } catch (error) {
        throw normalizeError(error, {
          code: "review_status_snapshot_failed",
          category: "infra",
          retryable: true,
          component: "codex-harness",
          message: "Could not snapshot the Review workspace",
          taskId: request.attempt.taskId,
          attemptId: request.attempt.attemptId,
        });
      }
    }
    let skillsConfig: { path: string; enabled: boolean }[] | undefined;
    if (input.skillPolicy !== undefined) {
      try {
        const catalog = SkillListResponseSchema.parse(
          await input.client.request("skills/list", {
            cwds: [workspace.path],
          }),
        );
        const workspaceSkills = catalog.data.find(
          (entry) => entry.cwd === workspace.path,
        );
        if (
          workspaceSkills === undefined ||
          workspaceSkills.errors.length > 0
        ) {
          throw new Error(
            "Codex did not return a complete workspace skill catalog",
          );
        }
        skillsConfig = buildDefaultSkillConfig(
          workspaceSkills.skills,
          input.skillPolicy,
        );
      } catch (error) {
        throw normalizeError(error, {
          code: "codex_skill_catalog_failed",
          category: "infra",
          retryable: true,
          component: "codex-harness",
          message: "Could not apply the role skill allowlist",
          taskId: request.attempt.taskId,
          attemptId: request.attempt.attemptId,
        });
      }
    }
    const threadConfig = {
      ...(request.attempt.role === "review"
        ? { model_reasoning_effort: request.attempt.effort }
        : {}),
      ...(skillsConfig === undefined
        ? {}
        : { skills: { config: skillsConfig } }),
    };
    let rawThreadResponse: unknown;
    try {
      rawThreadResponse = await input.client.request("thread/start", {
        model: request.attempt.model,
        cwd: workspace.path,
        approvalPolicy: "never",
        sandbox: threadSandbox(request.attempt.role),
        serviceName: "agile_agents",
        ...(Object.keys(threadConfig).length === 0
          ? {}
          : { config: threadConfig }),
      });
    } catch (error) {
      throw normalizeError(error, {
        code: "codex_thread_start_failed",
        category: "infra",
        retryable: true,
        component: "codex-harness",
        message: "Codex did not start the role thread",
        taskId: request.attempt.taskId,
        attemptId: request.attempt.attemptId,
      });
    }
    let threadResponse: z.infer<typeof ThreadStartResponseSchema>;
    try {
      threadResponse = ThreadStartResponseSchema.parse(rawThreadResponse);
    } catch (error) {
      throw protocolError(
        "invalid_thread_start_response",
        "Codex returned an invalid role thread",
        request,
        undefined,
        error,
      );
    }

    const anchorThreadId = threadResponse.thread.id;
    let threadId: string;
    let turnId: string;
    if (request.attempt.role === "review") {
      let rawReviewResponse: unknown;
      try {
        rawReviewResponse = await input.client.request("review/start", {
          threadId: anchorThreadId,
          target: { type: "custom", instructions: prompt(request) },
          delivery: "detached",
        });
      } catch (error) {
        throw normalizeError(error, {
          code: "codex_review_start_failed",
          category: "infra",
          retryable: true,
          component: "codex-harness",
          message: "Codex did not start the detached Review turn",
          taskId: request.attempt.taskId,
          attemptId: request.attempt.attemptId,
          threadId: anchorThreadId,
        });
      }
      let reviewResponse: z.infer<typeof ReviewStartResponseSchema>;
      try {
        reviewResponse = ReviewStartResponseSchema.parse(rawReviewResponse);
      } catch (error) {
        throw protocolError(
          "invalid_review_start_response",
          "Codex returned an invalid detached Review turn",
          request,
          anchorThreadId,
          error,
        );
      }
      if (reviewResponse.reviewThreadId === anchorThreadId) {
        throw protocolError(
          "review_not_detached",
          "Codex did not isolate Review from its empty anchor thread",
          request,
          anchorThreadId,
        );
      }
      threadId = reviewResponse.reviewThreadId;
      turnId = reviewResponse.turn.id;
    } else {
      let rawTurnResponse: unknown;
      try {
        rawTurnResponse = await input.client.request("turn/start", {
          threadId: anchorThreadId,
          input: [{ type: "text", text: prompt(request) }],
          model: request.attempt.model,
          effort: request.attempt.effort,
          sandboxPolicy: turnSandbox(request.attempt.role, workspace),
          outputSchema: outputSchema(request.attempt.role),
        });
      } catch (error) {
        throw normalizeError(error, {
          code: "codex_turn_start_failed",
          category: "infra",
          retryable: true,
          component: "codex-harness",
          message: "Codex did not start the role turn",
          taskId: request.attempt.taskId,
          attemptId: request.attempt.attemptId,
          threadId: anchorThreadId,
        });
      }
      let turnResponse: z.infer<typeof TurnStartResponseSchema>;
      try {
        turnResponse = TurnStartResponseSchema.parse(rawTurnResponse);
      } catch (error) {
        throw protocolError(
          "invalid_turn_start_response",
          "Codex returned an invalid role turn",
          request,
          anchorThreadId,
          error,
        );
      }
      threadId = anchorThreadId;
      turnId = turnResponse.turn.id;
    }

    const startedAt = now();
    const active: ActiveAttempt = {
      attemptId: request.attempt.attemptId,
      taskId: request.attempt.taskId,
      role: request.attempt.role,
      threadId,
      turnId,
      baseCommit: workspace.baseCommit,
      outputDelivered: false,
      startedAt,
      reviewStatusBefore,
    };
    activeAttempts.set(active.attemptId, active);
    const cursor: BackendCursor = {
      version: 1,
      nextSequence: 1,
      threadId: active.threadId,
      turnId: active.turnId,
      usage: zeroUsage,
      ...(reviewStatusBefore === undefined ? {} : { reviewStatusBefore }),
    };
    return delivery(cursor, {
      type: "attempt.started",
      eventId: `${active.attemptId}:${active.turnId}:started`,
      attemptId: active.attemptId,
      occurredAt: startedAt,
      threadId: active.threadId,
      turnId: active.turnId,
      baseCommit: active.baseCommit,
    });
  }

  async function nextDelivery(
    request: SupportedRequest,
    initialCursor: BackendCursor,
    active: ActiveAttempt,
  ): Promise<HarnessDelivery> {
    let cursor = initialCursor;
    while (true) {
      let message: Awaited<ReturnType<CodexClientApi["nextServerMessage"]>>;
      try {
        message = await input.client.nextServerMessage();
      } catch (error) {
        throw normalizeError(error, {
          code: "codex_message_read_failed",
          category: "infra",
          retryable: true,
          component: "codex-harness",
          message: "Could not read the Codex role event stream",
          taskId: request.attempt.taskId,
          attemptId: request.attempt.attemptId,
          threadId: active.threadId,
        });
      }
      if ("id" in message) {
        const known = KnownServerRequestSchema.safeParse(message);
        if (known.success) {
          switch (known.data.method) {
            case "item/commandExecution/requestApproval":
            case "item/fileChange/requestApproval":
              input.client.respond(known.data.id, { decision: "decline" });
              break;
            case "item/permissions/requestApproval":
              input.client.respond(known.data.id, {
                permissions: {},
                scope: "turn",
              });
              break;
            case "item/tool/requestUserInput":
              input.client.respond(known.data.id, { answers: {} });
              break;
            case "mcpServer/elicitation/request":
              input.client.respond(known.data.id, {
                action: "decline",
                content: null,
                _meta: null,
              });
              break;
          }
          if (
            known.data.params.threadId !== active.threadId ||
            known.data.params.turnId !== active.turnId
          ) {
            continue;
          }
        } else {
          const knownMethod = [
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
            "item/permissions/requestApproval",
            "item/tool/requestUserInput",
            "mcpServer/elicitation/request",
          ].includes(message.method);
          if (
            typeof message.id === "string" ||
            typeof message.id === "number"
          ) {
            input.client.respondError(
              message.id,
              knownMethod ? -32602 : -32601,
              knownMethod ? "Invalid request parameters" : "Method not found",
            );
          }
        }
        try {
          await input.client.request("turn/interrupt", {
            threadId: active.threadId,
            turnId: active.turnId,
          });
        } catch {
          // The policy block is authoritative even if the interrupted process exits first.
        }
        policyInterruptedTurns.add(turnSource(active.threadId, active.turnId));
        terminalize(active);
        return delivery(withoutTerminalMarkers(cursor), {
          type: "attempt.blocked_policy",
          eventId: `${active.attemptId}:${active.turnId}:blocked_policy:approval_required:${String(message.id)}`,
          attemptId: active.attemptId,
          occurredAt: now(),
          code: "approval_required",
          message:
            "Codex requested an interaction during an unattended role turn",
        });
      }

      if (message.method === "thread/tokenUsage/updated") {
        let notification: z.infer<
          typeof ThreadTokenUsageUpdatedNotificationSchema
        >;
        try {
          notification =
            ThreadTokenUsageUpdatedNotificationSchema.parse(message);
        } catch (error) {
          throw protocolError(
            "invalid_token_usage",
            "Codex sent invalid cumulative token usage",
            request,
            active.threadId,
            error,
          );
        }
        if (
          terminalTurnSources.has(
            turnSource(
              notification.params.threadId,
              notification.params.turnId,
            ),
          )
        )
          continue;
        sameSource(
          notification.params.threadId,
          notification.params.turnId,
          active,
          request,
        );
        const cumulative: Usage = {
          inputTokens: notification.params.tokenUsage.total.inputTokens,
          cachedInputTokens:
            notification.params.tokenUsage.total.cachedInputTokens,
          outputTokens: notification.params.tokenUsage.total.outputTokens,
          reasoningOutputTokens:
            notification.params.tokenUsage.total.reasoningOutputTokens,
        };
        const delta: Usage = {
          inputTokens: cumulative.inputTokens - cursor.usage.inputTokens,
          cachedInputTokens:
            cumulative.cachedInputTokens - cursor.usage.cachedInputTokens,
          outputTokens: cumulative.outputTokens - cursor.usage.outputTokens,
          reasoningOutputTokens:
            cumulative.reasoningOutputTokens -
            cursor.usage.reasoningOutputTokens,
        };
        if (Object.values(delta).some((value) => value < 0)) {
          throw protocolError(
            "non_monotonic_token_usage",
            "Codex cumulative token usage moved backwards",
            request,
            active.threadId,
          );
        }
        cursor = { ...cursor, usage: cumulative };
        if (Object.values(delta).every((value) => value === 0)) continue;
        return delivery(cursor, {
          type: "attempt.usage_delta",
          eventId: `${active.attemptId}:${active.turnId}:usage:${cumulativeHash(cumulative)}`,
          attemptId: active.attemptId,
          occurredAt: now(),
          ...delta,
        });
      }

      if (message.method === "item/completed") {
        let notification: z.infer<typeof ItemCompletedNotificationSchema>;
        try {
          notification = ItemCompletedNotificationSchema.parse(message);
        } catch (error) {
          throw protocolError(
            "invalid_completed_item",
            "Codex sent an invalid completed item",
            request,
            active.threadId,
            error,
          );
        }
        if (
          terminalTurnSources.has(
            turnSource(
              notification.params.threadId,
              notification.params.turnId,
            ),
          )
        )
          continue;
        sameSource(
          notification.params.threadId,
          notification.params.turnId,
          active,
          request,
        );
        let itemId: string;
        let encodedOutput: string;
        if (active.role === "review") {
          if (notification.params.item.type !== "exitedReviewMode") continue;
          let item: z.infer<typeof ExitedReviewModeItemSchema>;
          try {
            item = ExitedReviewModeItemSchema.parse(notification.params.item);
          } catch (error) {
            throw protocolError(
              "invalid_structured_output",
              "Codex returned an invalid Review completion item",
              request,
              active.threadId,
              error,
            );
          }
          itemId = item.id;
          encodedOutput = item.review;
        } else {
          if (notification.params.item.type !== "agentMessage") continue;
          let item: z.infer<typeof AgentMessageItemSchema>;
          try {
            item = AgentMessageItemSchema.parse(notification.params.item);
          } catch (error) {
            throw protocolError(
              "invalid_structured_output",
              "Codex returned an invalid final agent message",
              request,
              active.threadId,
              error,
            );
          }
          if (item.phase === "commentary") continue;
          itemId = item.id;
          encodedOutput = item.text;
        }

        let decoded: unknown;
        try {
          decoded = JSON.parse(encodedOutput);
        } catch (error) {
          throw protocolError(
            "invalid_structured_output",
            "Codex returned invalid structured output",
            request,
            active.threadId,
            error,
          );
        }

        let output:
          | z.infer<typeof ScoutOutputSchema>
          | z.infer<typeof ImplementOutputSchema>
          | z.infer<typeof ReviewOutputSchema>;
        if (active.role === "implement") {
          let draft: z.infer<typeof ImplementDraftOutputSchema>;
          try {
            draft = ImplementDraftOutputSchema.parse(decoded);
          } catch (error) {
            throw protocolError(
              "invalid_structured_output",
              "Codex returned invalid structured output",
              request,
              active.threadId,
              error,
            );
          }
          let commitSha: string;
          try {
            commitSha = await input.branches.commitChanges(
              active.taskId,
              active.baseCommit,
            );
          } catch (error) {
            throw protocolError(
              "invalid_implementation_commit",
              "The trusted Harness could not create or reuse the implementation commit",
              request,
              active.threadId,
              error,
            );
          }
          output = ImplementOutputSchema.parse({ ...draft, commitSha });
        } else {
          try {
            output =
              active.role === "scout"
                ? ScoutOutputSchema.parse(decoded)
                : ReviewOutputSchema.parse(decoded);
          } catch (error) {
            throw protocolError(
              "invalid_structured_output",
              "Codex returned invalid structured output",
              request,
              active.threadId,
              error,
            );
          }
        }
        if (output.kind === "review") {
          await assertReviewInvariant(request);
          let statusAfter: string;
          try {
            statusAfter = await input.branches.status(
              active.taskId,
              active.baseCommit,
            );
          } catch {
            return failedDelivery(
              cursor,
              active,
              "review_status_snapshot_failed",
              "Could not verify the Review workspace",
            );
          }
          if (statusAfter !== active.reviewStatusBefore) {
            return failedDelivery(
              cursor,
              active,
              "review_mutated_workspace",
              "Review changed the scheduler checkout",
            );
          }
        }
        active.outputDelivered = true;
        return delivery(
          { ...cursor, outputDelivered: true },
          {
            type: "attempt.output",
            eventId: `${active.attemptId}:${itemId}:output`,
            attemptId: active.attemptId,
            occurredAt: now(),
            output,
          },
        );
      }

      if (message.method === "turn/completed") {
        let notification: z.infer<typeof TurnCompletedNotificationSchema>;
        try {
          notification = TurnCompletedNotificationSchema.parse(message);
        } catch (error) {
          throw protocolError(
            "invalid_turn_completion",
            "Codex sent an invalid turn completion",
            request,
            active.threadId,
            error,
          );
        }
        const interruptedSource = turnSource(
          notification.params.threadId,
          notification.params.turn.id,
        );
        if (terminalTurnSources.has(interruptedSource)) continue;
        if (
          notification.params.turn.status === "interrupted" &&
          policyInterruptedTurns.delete(interruptedSource)
        ) {
          continue;
        }
        sameSource(
          notification.params.threadId,
          notification.params.turn.id,
          active,
          request,
        );
        if (notification.params.turn.status !== "completed") {
          return classifiedTurnFailure(
            cursor,
            active,
            notification.params.turn.status,
            notification.params.turn.error,
          );
        }
        if (!active.outputDelivered) {
          throw protocolError(
            "invalid_structured_output",
            "Codex completed without a validated structured output",
            request,
            active.threadId,
          );
        }
        return completedDelivery(cursor, active);
      }

      // Additive notifications without normalized product meaning are ignored.
    }
  }

  async function reconcile(
    request: SupportedRequest,
    cursor: BackendCursor,
  ): Promise<HarnessDelivery> {
    const recovered: ActiveAttempt = {
      attemptId: request.attempt.attemptId,
      taskId: request.attempt.taskId,
      role: request.attempt.role,
      threadId: cursor.threadId,
      turnId: cursor.turnId,
      baseCommit: request.input.ticket.baseCommit ?? "",
      outputDelivered: cursor.outputDelivered === true,
      startedAt: now(),
      reviewStatusBefore: cursor.reviewStatusBefore,
    };
    const orphaned = (message: string): HarnessDelivery =>
      failedDelivery(cursor, recovered, "orphaned_turn", message);

    if (request.attempt.role === "review") {
      try {
        await assertReviewInvariant(request);
      } catch (error) {
        return taskFailure(request, error);
      }
    }

    let rawReadResponse: unknown;
    try {
      await input.client.request("thread/resume", {
        threadId: cursor.threadId,
      });
      rawReadResponse = await input.client.request("thread/read", {
        threadId: cursor.threadId,
        includeTurns: true,
      });
    } catch {
      return orphaned("Codex could not recover authoritative turn history");
    }

    const readResponse = ThreadReadResponseSchema.safeParse(rawReadResponse);
    if (
      !readResponse.success ||
      readResponse.data.thread.id !== cursor.threadId
    ) {
      return orphaned("Codex returned invalid authoritative turn history");
    }
    const turn = readResponse.data.thread.turns.find(
      (candidate) => candidate.id === cursor.turnId,
    );
    if (!turn) {
      return orphaned("Codex history does not contain the persisted turn");
    }
    if (turn.status !== "inProgress") {
      terminalTurnSources.add(turnSource(cursor.threadId, cursor.turnId));
    }
    if (turn.status === "failed" || turn.status === "interrupted") {
      return classifiedTurnFailure(cursor, recovered, turn.status, turn.error);
    }
    if (turn.status !== "completed") {
      return orphaned(
        "Codex history cannot prove that the persisted turn completed",
      );
    }

    let itemId: string;
    let encodedOutput: string;
    if (request.attempt.role === "review") {
      const candidate = [...turn.items]
        .reverse()
        .find((item) => item.type === "exitedReviewMode");
      const item = ExitedReviewModeItemSchema.safeParse(candidate);
      if (!item.success) {
        return orphaned(
          "Completed Review history has no structured Review output",
        );
      }
      itemId = item.data.id;
      encodedOutput = item.data.review;
    } else {
      const candidate = [...turn.items]
        .reverse()
        .find(
          (item) => item.type === "agentMessage" && item.phase !== "commentary",
        );
      const item = AgentMessageItemSchema.safeParse(candidate);
      if (!item.success) {
        return orphaned(
          "Completed Codex history has no structured role output",
        );
      }
      itemId = item.data.id;
      encodedOutput = item.data.text;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(encodedOutput);
    } catch {
      return orphaned(
        "Completed Codex history contains invalid structured output",
      );
    }

    let output:
      | z.infer<typeof ScoutOutputSchema>
      | z.infer<typeof ImplementOutputSchema>
      | z.infer<typeof ReviewOutputSchema>;
    if (request.attempt.role === "implement") {
      const draft = ImplementDraftOutputSchema.safeParse(decoded);
      if (!draft.success) {
        return orphaned(
          "Completed Codex history contains invalid structured output",
        );
      }
      let commitSha: string;
      try {
        commitSha = await input.branches.commitChanges(
          recovered.taskId,
          recovered.baseCommit || undefined,
        );
      } catch {
        return failedDelivery(
          cursor,
          recovered,
          "invalid_implementation_commit",
          "The trusted Harness could not create or reuse the implementation commit",
        );
      }
      output = ImplementOutputSchema.parse({ ...draft.data, commitSha });
    } else {
      const parsedOutput =
        request.attempt.role === "scout"
          ? ScoutOutputSchema.safeParse(decoded)
          : ReviewOutputSchema.safeParse(decoded);
      if (!parsedOutput.success) {
        return orphaned(
          "Completed Codex history contains invalid structured output",
        );
      }
      output = parsedOutput.data;
    }
    if (output.kind === "review") {
      if (cursor.reviewStatusBefore === undefined) {
        return orphaned("Recovered Review has no workspace mutation baseline");
      }
      try {
        await assertReviewInvariant(request);
      } catch (error) {
        return taskFailure(request, error);
      }
      let statusAfter: string;
      try {
        statusAfter = await input.branches.status(
          recovered.taskId,
          recovered.baseCommit,
        );
      } catch {
        return orphaned("Recovered Review workspace status is unavailable");
      }
      if (statusAfter !== cursor.reviewStatusBefore) {
        return failedDelivery(
          cursor,
          recovered,
          "review_mutated_workspace",
          "Review changed the scheduler checkout",
        );
      }
    }

    if (cursor.outputDelivered === true) {
      return completedDelivery(cursor, recovered);
    }

    recovered.outputDelivered = true;
    recovered.reconciledCompletion = true;
    activeAttempts.set(recovered.attemptId, recovered);
    return delivery(
      { ...cursor, outputDelivered: true },
      {
        type: "attempt.output",
        eventId: `${recovered.attemptId}:${itemId}:output`,
        attemptId: recovered.attemptId,
        occurredAt: now(),
        output,
      },
    );
  }

  return {
    async step(rawRequest): Promise<HarnessDelivery> {
      const request = HarnessStepRequestSchema.parse(rawRequest);
      try {
        supportedRequest(request);
        if (request.backendCursor === undefined) {
          if (request.mode === "reconcile") {
            terminalAttempts.add(request.attempt.attemptId);
            const unavailableCursor: BackendCursor = {
              version: 1,
              nextSequence: 1,
              threadId: `unavailable:${request.attempt.attemptId}`,
              turnId: `unavailable:${request.attempt.attemptId}`,
              usage: zeroUsage,
            };
            return delivery(unavailableCursor, {
              type: "attempt.failed_infra",
              eventId: `${request.attempt.attemptId}:reconcile:failed_infra:orphaned_turn`,
              attemptId: request.attempt.attemptId,
              occurredAt: now(),
              code: "orphaned_turn",
              message:
                "No persisted Codex turn identity is available for reconciliation",
              retryable: true,
            });
          }
          return await dispatch(request);
        }

        const cursor = parseCursor(request.backendCursor, request);
        if (request.mode === "reconcile")
          return await reconcile(request, cursor);
        const active = activeAttempts.get(request.attempt.attemptId);
        if (!active) {
          throw protocolError(
            "codex_attempt_not_active",
            "Codex attempt is not active",
            request,
            cursor.threadId,
          );
        }
        if (
          active.taskId !== request.attempt.taskId ||
          active.role !== request.attempt.role
        ) {
          throw protocolError(
            "codex_attempt_identity_mismatch",
            "Active Codex attempt identity does not match the delivery request",
            request,
            active.threadId,
          );
        }
        sameSource(cursor.threadId, cursor.turnId, active, request);
        if (active.reconciledCompletion)
          return completedDelivery(cursor, active);
        return await nextDelivery(request, cursor, active);
      } catch (error) {
        return taskFailure(request, error);
      }
    },

    async cancel(attemptId): Promise<void> {
      if (terminalAttempts.has(attemptId)) return;
      const active = activeAttempts.get(attemptId);
      if (!active)
        throw new Error(`Unknown active Codex attempt: ${attemptId}`);
      try {
        await input.client.request("turn/interrupt", {
          threadId: active.threadId,
          turnId: active.turnId,
        });
      } catch (error) {
        throw normalizeError(error, {
          code: "codex_turn_interrupt_failed",
          category: "infra",
          retryable: true,
          component: "codex-harness",
          message: "Could not interrupt the active Codex turn",
          taskId: active.taskId,
          attemptId: active.attemptId,
          threadId: active.threadId,
        });
      }
    },
  };
}
