import { createHash } from "node:crypto";
import { z } from "zod";
import {
  HarnessStepRequestSchema,
  ImplementOutputSchema,
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
  ItemCompletedNotificationSchema,
  ThreadStartResponseSchema,
  ThreadTokenUsageUpdatedNotificationSchema,
  TurnCompletedNotificationSchema,
  TurnStartResponseSchema,
} from "./protocol";
import {
  ImplementOutputJsonSchema,
  ScoutOutputJsonSchema,
  implementPrompt,
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
}).strict();

type BackendCursor = z.infer<typeof BackendCursorSchema>;
type Usage = BackendCursor["usage"];
type EventWithoutSequence = {
  [Type in HarnessEvent["type"]]: Omit<Extract<HarnessEvent, { type: Type }>, "sequence">;
}[HarnessEvent["type"]];
type SupportedRequest = HarnessStepRequest & {
  attempt: HarnessStepRequest["attempt"] & { role: "scout" | "implement" };
  input: Extract<HarnessStepRequest["input"], { role: "scout" | "implement" }>;
};

type ActiveAttempt = {
  attemptId: string;
  taskId: string;
  role: "scout" | "implement";
  threadId: string;
  turnId: string;
  baseCommit: string;
  outputDelivered: boolean;
  startedAt: string;
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
  if (request.mode !== "dispatch") {
    throw protocolError(
      "codex_reconcile_not_supported",
      "Codex reconciliation is not available for this role adapter",
      request,
    );
  }
  if (request.attempt.role === "review" || request.input.role === "review") {
    throw protocolError(
      "codex_review_not_supported",
      "Codex Review is not available in the Scout and Implement adapter",
      request,
    );
  }
  if (request.attempt.role !== request.input.role) {
    throw protocolError(
      "codex_role_mismatch",
      "Harness attempt role does not match its input role",
      request,
    );
  }
  return request as SupportedRequest;
}

function threadSandbox(role: "scout" | "implement"): "read-only" | "workspace-write" {
  return role === "scout" ? "read-only" : "workspace-write";
}

function turnSandbox(role: "scout" | "implement", workspace: TaskWorkspace): unknown {
  if (role === "scout") return { type: "readOnly", networkAccess: false };
  return {
    type: "workspaceWrite",
    writableRoots: [workspace.path],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function prompt(request: SupportedRequest): string {
  return request.input.role === "scout"
    ? scoutPrompt(request.input)
    : implementPrompt(request.input);
}

function outputSchema(role: "scout" | "implement"): unknown {
  return role === "scout" ? ScoutOutputJsonSchema : ImplementOutputJsonSchema;
}

export function createCodexHarness(input: {
  client: CodexClientApi;
  worktrees: TaskWorktreeManager;
  now?: () => string;
}): AgentHarness {
  const now = input.now ?? (() => new Date().toISOString());
  const activeAttempts = new Map<string, ActiveAttempt>();
  const terminalAttempts = new Set<string>();

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

    const threadId = threadResponse.thread.id;
    let rawTurnResponse: unknown;
    try {
      rawTurnResponse = await input.client.request("turn/start", {
        threadId,
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
        threadId,
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
        threadId,
        error,
      );
    }

    const startedAt = now();
    const active: ActiveAttempt = {
      attemptId: request.attempt.attemptId,
      taskId: request.attempt.taskId,
      role: request.attempt.role,
      threadId,
      turnId: turnResponse.turn.id,
      baseCommit: workspace.baseCommit,
      outputDelivered: false,
      startedAt,
    };
    activeAttempts.set(active.attemptId, active);
    const cursor: BackendCursor = {
      version: 1,
      nextSequence: 1,
      threadId: active.threadId,
      turnId: active.turnId,
      usage: zeroUsage,
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
        throw protocolError(
          "codex_server_request_not_supported",
          "Codex requested an interaction during an unattended role turn",
          request,
          active.threadId,
        );
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

        let decoded: unknown;
        try {
          decoded = JSON.parse(item.text);
        } catch (error) {
          throw protocolError(
            "invalid_structured_output",
            "Codex returned invalid structured output",
            request,
            active.threadId,
            error,
          );
        }

        let output: z.infer<typeof ScoutOutputSchema> | z.infer<typeof ImplementOutputSchema>;
        try {
          output = active.role === "scout"
            ? ScoutOutputSchema.parse(decoded)
            : ImplementOutputSchema.parse(decoded);
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
        active.outputDelivered = true;
        return delivery(cursor, {
          type: "attempt.output",
          eventId: `${active.attemptId}:${item.id}:output`,
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
          throw protocolError(
            "codex_turn_not_completed",
            "Codex role turn did not complete successfully",
            request,
            active.threadId,
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
        activeAttempts.delete(active.attemptId);
        terminalAttempts.add(active.attemptId);
        return delivery(cursor, {
          type: "attempt.completed",
          eventId: `${active.attemptId}:${active.turnId}:completed`,
          attemptId: active.attemptId,
          occurredAt: now(),
        });
      }

      // Additive notifications without normalized product meaning are ignored.
    }
  }

  return {
    async step(rawRequest): Promise<HarnessDelivery> {
      const request = supportedRequest(HarnessStepRequestSchema.parse(rawRequest));
      if (request.backendCursor === undefined) return dispatch(request);

      const cursor = parseCursor(request.backendCursor, request);
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
