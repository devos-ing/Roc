import { createHash } from "node:crypto";
import { z } from "zod";
import {
  HarnessStepRequestSchema,
  ImplementOutputSchema,
  ReviewOutputSchema,
  ScoutOutputSchema,
  type AgentHarness,
  type HarnessDelivery,
  type HarnessEvent,
  type HarnessStepRequest,
} from "../harness/contracts";
import { AgileError, normalizeError } from "../runtime/errors";
import type { TaskWorkspace, TaskWorktreeManager } from "../workspace/task-worktree";
import type { CodexClientApi } from "./client";
import {
  AgentMessageItemSchema,
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
  ImplementOutputJsonSchema,
  ReviewOutputJsonSchema,
  ScoutOutputJsonSchema,
  implementPrompt,
  reviewPrompt,
  scoutPrompt,
} from "./prompts";

const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningOutputTokens: z.number().int().nonnegative(),
}).strict();

const BackendCursorSchema = z.object({
  version: z.literal(1),
  nextSequence: z.number().int().positive(),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  usage: UsageSchema,
  outputDelivered: z.literal(true).optional(),
  reviewStatusBefore: z.string().optional(),
}).strict();

type BackendCursor = z.infer<typeof BackendCursorSchema>;
type Usage = BackendCursor["usage"];
type EventWithoutSequence = {
  [Type in HarnessEvent["type"]]: Omit<Extract<HarnessEvent, { type: Type }>, "sequence">;
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

function turnSandbox(role: "scout" | "implement", workspace: TaskWorkspace): unknown {
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
  if (role === "implement") return ImplementOutputJsonSchema;
  return ReviewOutputJsonSchema;
}

export function createCodexHarness(input: {
  client: CodexClientApi;
  worktrees: TaskWorktreeManager;
  now?: () => string;
}): AgentHarness {
  const now = input.now ?? (() => new Date().toISOString());
  const activeAttempts = new Map<string, ActiveAttempt>();
  const terminalAttempts = new Set<string>();

  function terminalize(active: ActiveAttempt): void {
    activeAttempts.delete(active.attemptId);
    terminalAttempts.add(active.attemptId);
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
  ): HarnessDelivery {
    terminalize(active);
    return delivery(withoutTerminalMarkers(cursor), {
      type: "attempt.failed_infra",
      eventId: `${active.attemptId}:${active.turnId}:failed_infra:${code}`,
      attemptId: active.attemptId,
      occurredAt: now(),
      code,
      message,
      retryable: true,
    });
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

  async function dispatch(request: SupportedRequest): Promise<HarnessDelivery> {
    const existing = activeAttempts.get(request.attempt.attemptId);
    if (existing) {
      if (existing.taskId !== request.attempt.taskId || existing.role !== request.attempt.role) {
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

    const workspace = await input.worktrees.prepare(request.attempt.taskId);
    let reviewStatusBefore: string | undefined;
    if (request.attempt.role === "review") {
      try {
        reviewStatusBefore = await input.worktrees.status(request.attempt.taskId);
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
    let rawThreadResponse: unknown;
    try {
      rawThreadResponse = await input.client.request("thread/start", {
        model: request.attempt.model,
        cwd: workspace.path,
        approvalPolicy: "never",
        sandbox: threadSandbox(request.attempt.role),
        serviceName: "agile_agents",
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
              input.client.respond(known.data.id, { permissions: {}, scope: "turn" });
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
        } else {
          const knownMethod = [
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
            "item/permissions/requestApproval",
            "item/tool/requestUserInput",
            "mcpServer/elicitation/request",
          ].includes(message.method);
          if (typeof message.id === "string" || typeof message.id === "number") {
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
        terminalize(active);
        return delivery(withoutTerminalMarkers(cursor), {
          type: "attempt.blocked_policy",
          eventId:
            `${active.attemptId}:${active.turnId}:blocked_policy:approval_required`,
          attemptId: active.attemptId,
          occurredAt: now(),
          code: "approval_required",
          message: "Codex requested an interaction during an unattended role turn",
        });
      }

      if (message.method === "thread/tokenUsage/updated") {
        let notification: z.infer<typeof ThreadTokenUsageUpdatedNotificationSchema>;
        try {
          notification = ThreadTokenUsageUpdatedNotificationSchema.parse(message);
        } catch (error) {
          throw protocolError(
            "invalid_token_usage",
            "Codex sent invalid cumulative token usage",
            request,
            active.threadId,
            error,
          );
        }
        sameSource(notification.params.threadId, notification.params.turnId, active, request);
        const cumulative: Usage = {
          inputTokens: notification.params.tokenUsage.total.inputTokens,
          cachedInputTokens: notification.params.tokenUsage.total.cachedInputTokens,
          outputTokens: notification.params.tokenUsage.total.outputTokens,
          reasoningOutputTokens: notification.params.tokenUsage.total.reasoningOutputTokens,
        };
        const delta: Usage = {
          inputTokens: cumulative.inputTokens - cursor.usage.inputTokens,
          cachedInputTokens: cumulative.cachedInputTokens - cursor.usage.cachedInputTokens,
          outputTokens: cumulative.outputTokens - cursor.usage.outputTokens,
          reasoningOutputTokens:
            cumulative.reasoningOutputTokens - cursor.usage.reasoningOutputTokens,
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
        sameSource(notification.params.threadId, notification.params.turnId, active, request);
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
        try {
          output = active.role === "scout"
            ? ScoutOutputSchema.parse(decoded)
            : active.role === "implement"
              ? ImplementOutputSchema.parse(decoded)
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

        if (output.kind === "implement") {
          try {
            await input.worktrees.assertCommit(active.taskId, output.commitSha);
          } catch (error) {
            throw protocolError(
              "invalid_implementation_commit",
              "Codex returned an invalid implementation commit",
              request,
              active.threadId,
              error,
            );
          }
        }
        if (output.kind === "review") {
          let statusAfter: string;
          try {
            statusAfter = await input.worktrees.status(active.taskId);
          } catch (error) {
            return failedDelivery(
              cursor,
              active,
              "review_status_snapshot_failed",
              error instanceof Error
                ? `Could not verify the Review workspace: ${error.message}`
                : "Could not verify the Review workspace",
            );
          }
          if (statusAfter !== active.reviewStatusBefore) {
            return failedDelivery(
              cursor,
              active,
              "review_mutated_workspace",
              "Review changed the task worktree",
            );
          }
        }
        active.outputDelivered = true;
        return delivery({ ...cursor, outputDelivered: true }, {
          type: "attempt.output",
          eventId: `${active.attemptId}:${itemId}:output`,
          attemptId: active.attemptId,
          occurredAt: now(),
          output,
        });
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
        sameSource(notification.params.threadId, notification.params.turn.id, active, request);
        if (notification.params.turn.status !== "completed") {
          const status = notification.params.turn.status;
          return failedDelivery(
            cursor,
            active,
            `turn_${status}`,
            `Codex role turn ended with status ${status}`,
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
      baseCommit: "",
      outputDelivered: cursor.outputDelivered === true,
      startedAt: now(),
      reviewStatusBefore: cursor.reviewStatusBefore,
    };
    const orphaned = (message: string): HarnessDelivery => failedDelivery(
      cursor,
      recovered,
      "orphaned_turn",
      message,
    );

    let rawReadResponse: unknown;
    try {
      await input.client.request("thread/resume", { threadId: cursor.threadId });
      rawReadResponse = await input.client.request("thread/read", {
        threadId: cursor.threadId,
        includeTurns: true,
      });
    } catch {
      return orphaned("Codex could not recover authoritative turn history");
    }

    const readResponse = ThreadReadResponseSchema.safeParse(rawReadResponse);
    if (!readResponse.success || readResponse.data.thread.id !== cursor.threadId) {
      return orphaned("Codex returned invalid authoritative turn history");
    }
    const turn = readResponse.data.thread.turns.find((candidate) => candidate.id === cursor.turnId);
    if (!turn) {
      return orphaned("Codex history does not contain the persisted turn");
    }
    if (turn.status === "failed" || turn.status === "interrupted") {
      return failedDelivery(
        cursor,
        recovered,
        `turn_${turn.status}`,
        `Codex role turn ended with status ${turn.status}`,
      );
    }
    if (turn.status !== "completed") {
      return orphaned("Codex history cannot prove that the persisted turn completed");
    }

    let itemId: string;
    let encodedOutput: string;
    if (request.attempt.role === "review") {
      const candidate = [...turn.items]
        .reverse()
        .find((item) => item.type === "exitedReviewMode");
      const item = ExitedReviewModeItemSchema.safeParse(candidate);
      if (!item.success) {
        return orphaned("Completed Review history has no structured Review output");
      }
      itemId = item.data.id;
      encodedOutput = item.data.review;
    } else {
      const candidate = [...turn.items]
        .reverse()
        .find((item) => item.type === "agentMessage" && item.phase !== "commentary");
      const item = AgentMessageItemSchema.safeParse(candidate);
      if (!item.success) {
        return orphaned("Completed Codex history has no structured role output");
      }
      itemId = item.data.id;
      encodedOutput = item.data.text;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(encodedOutput);
    } catch {
      return orphaned("Completed Codex history contains invalid structured output");
    }

    const parsedOutput = request.attempt.role === "scout"
      ? ScoutOutputSchema.safeParse(decoded)
      : request.attempt.role === "implement"
        ? ImplementOutputSchema.safeParse(decoded)
        : ReviewOutputSchema.safeParse(decoded);
    if (!parsedOutput.success) {
      return orphaned("Completed Codex history contains invalid structured output");
    }
    const output = parsedOutput.data;

    if (output.kind === "implement") {
      try {
        await input.worktrees.assertCommit(recovered.taskId, output.commitSha);
      } catch {
        return orphaned("Completed Implement history does not prove a valid commit");
      }
    }
    if (output.kind === "review") {
      if (cursor.reviewStatusBefore === undefined) {
        return orphaned("Recovered Review has no workspace mutation baseline");
      }
      let statusAfter: string;
      try {
        statusAfter = await input.worktrees.status(recovered.taskId);
      } catch {
        return orphaned("Recovered Review workspace status is unavailable");
      }
      if (statusAfter !== cursor.reviewStatusBefore) {
        return failedDelivery(
          cursor,
          recovered,
          "review_mutated_workspace",
          "Review changed the task worktree",
        );
      }
    }

    if (cursor.outputDelivered === true) {
      return completedDelivery(cursor, recovered);
    }

    recovered.outputDelivered = true;
    recovered.reconciledCompletion = true;
    activeAttempts.set(recovered.attemptId, recovered);
    return delivery({ ...cursor, outputDelivered: true }, {
      type: "attempt.output",
      eventId: `${recovered.attemptId}:${itemId}:output`,
      attemptId: recovered.attemptId,
      occurredAt: now(),
      output,
    });
  }

  return {
    async step(rawRequest): Promise<HarnessDelivery> {
      const request = supportedRequest(HarnessStepRequestSchema.parse(rawRequest));
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
            eventId:
              `${request.attempt.attemptId}:reconcile:failed_infra:orphaned_turn`,
            attemptId: request.attempt.attemptId,
            occurredAt: now(),
            code: "orphaned_turn",
            message: "No persisted Codex turn identity is available for reconciliation",
            retryable: true,
          });
        }
        return dispatch(request);
      }

      const cursor = parseCursor(request.backendCursor, request);
      if (request.mode === "reconcile") return reconcile(request, cursor);
      const active = activeAttempts.get(request.attempt.attemptId);
      if (!active) {
        throw protocolError(
          "codex_attempt_not_active",
          "Codex attempt is not active",
          request,
          cursor.threadId,
        );
      }
      if (active.taskId !== request.attempt.taskId || active.role !== request.attempt.role) {
        throw protocolError(
          "codex_attempt_identity_mismatch",
          "Active Codex attempt identity does not match the delivery request",
          request,
          active.threadId,
        );
      }
      sameSource(cursor.threadId, cursor.turnId, active, request);
      if (active.reconciledCompletion) return completedDelivery(cursor, active);
      return nextDelivery(request, cursor, active);
    },

    async cancel(attemptId): Promise<void> {
      if (terminalAttempts.has(attemptId)) return;
      const active = activeAttempts.get(attemptId);
      if (!active) throw new Error(`Unknown active Codex attempt: ${attemptId}`);
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
