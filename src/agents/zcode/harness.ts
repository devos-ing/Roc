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
} from "../../harness/contracts";
import { AgileError, normalizeError } from "../../runtime/errors";
import type { TaskBranchManager } from "../../workspace/task-branch";
import {
  implementationCommitFailureMessage,
  restoreApprovedSourceCommit,
} from "../source-commit";
import type { ZcodeClientApi } from "./client";
import {
  implementPrompt,
  reviewPrompt,
  scoutPrompt,
  structuredOutputRetryPrompt,
} from "./prompts";
import {
  classifyZcodeTurnFailure,
  mapZcodeUsage,
  SessionCreateResponseSchema,
  SessionEventNotificationSchema,
  TokenUsageTotalsSchema,
  TurnCompletedEventSchema,
} from "./protocol";

const UsageSchema = TokenUsageTotalsSchema;

const BackendCursorSchema = z
  .object({
    version: z.literal(1),
    nextSequence: z.number().int().positive(),
    sessionId: z.string().min(1),
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
  sessionId: string;
  baseCommit: string;
  outputDelivered: boolean;
  startedAt: string;
  reviewStatusBefore?: string;
  reconciledCompletion?: boolean;
  pendingDeliveries: HarnessDelivery[];
  structuredRetries: number;
};

/** In-session corrections allowed before a JSON-less turn terminalizes the attempt. */
const maxStructuredOutputRetries = 2;

const zeroUsage: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

/** Extracts a JSON object from a final model response, tolerating fences and prose. */
function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/u, "")
    .replace(/\s*```$/u, "")
    .trim();
  const candidates = [unfenced];
  const firstBrace = unfenced.indexOf("{");
  const lastBrace = unfenced.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(unfenced.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next extraction candidate.
    }
  }
  throw new Error("Response does not contain a JSON object");
}

/** Reports whether a final model response contains an extractable JSON object. */
function responseContainsJsonObject(text: string): boolean {
  try {
    extractJsonObject(text);
    return true;
  } catch {
    return false;
  }
}

/** Creates a task-scoped protocol error with optional session context and cause. */
function protocolError(
  code: string,
  message: string,
  request: HarnessStepRequest,
  sessionId?: string,
  cause?: unknown,
): AgileError {
  return new AgileError({
    code,
    category: "protocol",
    retryable: true,
    component: "zcode-harness",
    message,
    taskId: request.attempt.taskId,
    attemptId: request.attempt.attemptId,
    threadId: sessionId,
    cause,
  });
}

/** Validates and serializes a durable backend cursor. */
function serializeCursor(cursor: BackendCursor): string {
  return JSON.stringify(BackendCursorSchema.parse(cursor));
}

/** Parses a durable backend cursor or raises a task-scoped protocol error. */
function parseCursor(raw: string, request: HarnessStepRequest): BackendCursor {
  try {
    return BackendCursorSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw protocolError(
      "invalid_backend_cursor",
      "ZCode backend cursor is invalid",
      request,
      undefined,
      error,
    );
  }
}

/** Hashes cumulative token usage in a stable canonical field order. */
function cumulativeHash(usage: Usage): string {
  const canonical = JSON.stringify({
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Wraps an event with its next sequence and advances the serialized cursor. */
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

/** Verifies role agreement between an attempt descriptor and its input. */
function supportedRequest(request: HarnessStepRequest): SupportedRequest {
  if (request.attempt.role !== request.input.role) {
    throw protocolError(
      "zcode_role_mismatch",
      "Harness attempt role does not match its input role",
      request,
    );
  }
  return request as SupportedRequest;
}

/** Builds the role-specific prompt for a validated harness request. */
function prompt(request: SupportedRequest): string {
  if (request.input.role === "scout") return scoutPrompt(request.input);
  if (request.input.role === "implement") return implementPrompt(request.input);
  return reviewPrompt(request.input);
}

/** Creates a ZCode-backed harness with durable cursors and workspace safeguards. */
export function createZcodeHarness(input: {
  client: ZcodeClientApi;
  branches: TaskBranchManager;
  now?: () => string;
}): AgentHarness {
  /** Returns the current timestamp through the injected or system clock. */
  const now = input.now ?? (() => new Date().toISOString());
  const activeAttempts = new Map<string, ActiveAttempt>();
  const terminalAttempts = new Set<string>();

  /** Removes transient completion markers from a terminal cursor. */
  function withoutTerminalMarkers(cursor: BackendCursor): BackendCursor {
    const result = { ...cursor };
    delete result.outputDelivered;
    delete result.reviewStatusBefore;
    return result;
  }

  /** Marks an attempt and its session terminal and removes active state. */
  function terminalize(active: ActiveAttempt): void {
    activeAttempts.delete(active.attemptId);
    terminalAttempts.add(active.attemptId);
  }

  /** Terminalizes an attempt and emits a structured infrastructure-failure delivery. */
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
      eventId: `${active.attemptId}:${active.sessionId}:failed_infra:${code}`,
      attemptId: active.attemptId,
      occurredAt: now(),
      code,
      message,
      retryable,
    });
  }

  /** Converts task-scoped operational failures into policy or infrastructure deliveries. */
  function taskFailure(
    request: SupportedRequest,
    error: unknown,
  ): HarnessDelivery {
    const normalized = normalizeError(error, {
      code: "unexpected_task_failure",
      category: "infra",
      retryable: true,
      component: "zcode-harness",
      message: "The ZCode task failed unexpectedly",
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
      sessionId:
        cursor?.sessionId ?? `unavailable:${request.attempt.attemptId}`,
      baseCommit: request.input.ticket.baseCommit ?? "",
      outputDelivered: false,
      startedAt: now(),
      pendingDeliveries: [],
      structuredRetries: 0,
    };
    const failureCursor: BackendCursor = cursor ?? {
      version: 1,
      nextSequence: 1,
      sessionId: active.sessionId,
      usage: zeroUsage,
    };
    if (normalized.category === "policy") {
      terminalize(active);
      return delivery(withoutTerminalMarkers(failureCursor), {
        type: "attempt.blocked_policy",
        eventId: `${active.attemptId}:${active.sessionId}:blocked_policy:${normalized.code}`,
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

  /** Terminalizes an attempt and emits its completion delivery. */
  function completedDelivery(
    cursor: BackendCursor,
    active: ActiveAttempt,
  ): HarnessDelivery {
    terminalize(active);
    return delivery(withoutTerminalMarkers(cursor), {
      type: "attempt.completed",
      eventId: `${active.attemptId}:${active.sessionId}:completed`,
      attemptId: active.attemptId,
      occurredAt: now(),
    });
  }

  /** Classifies a failed turn and emits the corresponding terminal delivery. */
  function classifiedTurnFailure(
    cursor: BackendCursor,
    active: ActiveAttempt,
    resultType: string,
    errorText: string | undefined,
  ): HarnessDelivery {
    const failure = classifyZcodeTurnFailure(resultType, errorText);
    if (failure.category === "policy") {
      terminalize(active);
      return delivery(withoutTerminalMarkers(cursor), {
        type: "attempt.blocked_policy",
        eventId: `${active.attemptId}:${active.sessionId}:blocked_policy:${failure.code}`,
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

  /** Verifies that Review targets the exact clean implementation commit. */
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
        component: "zcode-harness",
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
        component: "zcode-harness",
        message: "Review requires the exact sole clean implementation commit",
        taskId: request.attempt.taskId,
        attemptId: request.attempt.attemptId,
        cause: error,
      });
    }
  }

  /** Starts or resumes role execution and emits the attempt-started delivery. */
  async function dispatch(request: SupportedRequest): Promise<HarnessDelivery> {
    const existing = activeAttempts.get(request.attempt.attemptId);
    if (existing) {
      if (
        existing.taskId !== request.attempt.taskId ||
        existing.role !== request.attempt.role
      ) {
        throw protocolError(
          "zcode_attempt_identity_mismatch",
          "Active ZCode attempt identity does not match the dispatch request",
          request,
          existing.sessionId,
        );
      }
      const cursor: BackendCursor = {
        version: 1,
        nextSequence: 1,
        sessionId: existing.sessionId,
        usage: zeroUsage,
        ...(existing.reviewStatusBefore === undefined
          ? {}
          : { reviewStatusBefore: existing.reviewStatusBefore }),
      };
      return delivery(cursor, {
        type: "attempt.started",
        eventId: `${request.attempt.attemptId}:${existing.sessionId}:started`,
        attemptId: request.attempt.attemptId,
        occurredAt: existing.startedAt,
        threadId: existing.sessionId,
        baseCommit: existing.baseCommit,
      });
    }

    const workspace = await input.branches.prepare(
      request.attempt.taskId,
      request.input.ticket.baseCommit,
    );
    await restoreApprovedSourceCommit({
      branches: input.branches,
      request,
      baseCommit: workspace.baseCommit,
      component: "zcode-harness",
    });
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
          component: "zcode-harness",
          message: "Could not snapshot the Review workspace",
          taskId: request.attempt.taskId,
          attemptId: request.attempt.attemptId,
        });
      }
    }

    // The ZCode session uses the task workspace as its working directory,
    // but that is not a filesystem confinement boundary: ZCode has no
    // protocol-level sandbox, and turns can still write outside the task
    // checkout with absolute paths or parent traversal. The Review status
    // comparison only detects changes inside the task checkout; writes
    // outside it are invisible to it.
    const sessionModel = input.client.sessionModel;
    if (sessionModel === undefined) {
      // Fail closed instead of omitting the model: a session without an
      // attributable provider/model pair would run an unobservable
      // server-side default while the attempt records something else.
      throw new AgileError({
        code: "zcode_session_model_unresolved",
        category: "protocol",
        retryable: false,
        component: "zcode-harness",
        message: "The ZCode client has no attributable session model",
        taskId: request.attempt.taskId,
        attemptId: request.attempt.attemptId,
      });
    }
    let rawCreateResponse: unknown;
    try {
      rawCreateResponse = await input.client.request("session/create", {
        workspace: {
          workspacePath: workspace.path,
          workspaceKey: workspace.path,
        },
        mode: "yolo",
        // Forward the routed model so the persisted attribution matches the
        // session the child actually runs; effort maps to the protocol's
        // thought level (low/medium/high/xhigh/max covers every effort).
        model: {
          providerId: sessionModel.providerId,
          modelId: request.attempt.model,
        },
        thoughtLevel: request.attempt.effort,
      });
    } catch (error) {
      throw normalizeError(error, {
        code: "zcode_session_create_failed",
        category: "infra",
        retryable: true,
        component: "zcode-harness",
        message: "ZCode did not start the role session",
        taskId: request.attempt.taskId,
        attemptId: request.attempt.attemptId,
      });
    }
    let createResponse: z.infer<typeof SessionCreateResponseSchema>;
    try {
      createResponse = SessionCreateResponseSchema.parse(rawCreateResponse);
    } catch (error) {
      throw protocolError(
        "invalid_session_create_response",
        "ZCode returned an invalid role session",
        request,
        undefined,
        error,
      );
    }
    const sessionId = createResponse.session.sessionId;

    try {
      await input.client.request("session/subscribe", {
        sessionId,
        deliveryKind: "desktop-continuous",
      });
      await input.client.request("session/send", {
        sessionId,
        content: prompt(request),
      });
    } catch (error) {
      throw normalizeError(error, {
        code: "zcode_session_send_failed",
        category: "infra",
        retryable: true,
        component: "zcode-harness",
        message: "ZCode did not accept the role prompt",
        taskId: request.attempt.taskId,
        attemptId: request.attempt.attemptId,
        threadId: sessionId,
      });
    }

    const startedAt = now();
    const active: ActiveAttempt = {
      attemptId: request.attempt.attemptId,
      taskId: request.attempt.taskId,
      role: request.attempt.role,
      sessionId,
      baseCommit: workspace.baseCommit,
      outputDelivered: false,
      startedAt,
      reviewStatusBefore,
      pendingDeliveries: [],
      structuredRetries: 0,
    };
    activeAttempts.set(active.attemptId, active);
    const cursor: BackendCursor = {
      version: 1,
      nextSequence: 1,
      sessionId,
      usage: zeroUsage,
      ...(reviewStatusBefore === undefined ? {} : { reviewStatusBefore }),
    };
    return delivery(cursor, {
      type: "attempt.started",
      eventId: `${active.attemptId}:${sessionId}:started`,
      attemptId: active.attemptId,
      occurredAt: startedAt,
      threadId: sessionId,
      baseCommit: active.baseCommit,
    });
  }

  /** Builds the terminal delivery chain for a successful role turn. */
  async function completeFromTurn(
    request: SupportedRequest,
    cursor: BackendCursor,
    active: ActiveAttempt,
    payload: z.infer<typeof TurnCompletedEventSchema>,
  ): Promise<HarnessDelivery[]> {
    let decoded: unknown;
    try {
      decoded = extractJsonObject(payload.response);
    } catch (error) {
      throw protocolError(
        "invalid_structured_output",
        "ZCode returned invalid structured output",
        request,
        active.sessionId,
        error,
      );
    }

    let output:
      | z.infer<typeof ScoutOutputSchema>
      | z.infer<typeof ImplementOutputSchema>
      | z.infer<typeof ReviewOutputSchema>;
    if (active.role === "implement") {
      const draft = ImplementOutputSchema.omit({ commitSha: true }).safeParse(
        decoded,
      );
      if (!draft.success) {
        throw protocolError(
          "invalid_structured_output",
          "ZCode returned invalid structured output",
          request,
          active.sessionId,
          draft.error,
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
          implementationCommitFailureMessage(error),
          request,
          active.sessionId,
          error,
        );
      }
      output = ImplementOutputSchema.parse({ ...draft.data, commitSha });
    } else {
      const parsed =
        active.role === "scout"
          ? ScoutOutputSchema.safeParse(decoded)
          : ReviewOutputSchema.safeParse(decoded);
      if (!parsed.success) {
        throw protocolError(
          "invalid_structured_output",
          "ZCode returned invalid structured output",
          request,
          active.sessionId,
          parsed.error,
        );
      }
      output = parsed.data;
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
        return [
          failedDelivery(
            cursor,
            active,
            "review_status_snapshot_failed",
            "Could not verify the Review workspace",
          ),
        ];
      }
      if (
        active.reviewStatusBefore === undefined ||
        statusAfter !== active.reviewStatusBefore
      ) {
        return [
          failedDelivery(
            cursor,
            active,
            "review_mutated_workspace",
            "Review changed the task checkout",
          ),
        ];
      }
    }

    const deliveries: HarnessDelivery[] = [];
    const cumulative = mapZcodeUsage(payload.usage);
    const delta: Usage = {
      inputTokens: cumulative.inputTokens - cursor.usage.inputTokens,
      cachedInputTokens:
        cumulative.cachedInputTokens - cursor.usage.cachedInputTokens,
      outputTokens: cumulative.outputTokens - cursor.usage.outputTokens,
      reasoningOutputTokens:
        cumulative.reasoningOutputTokens - cursor.usage.reasoningOutputTokens,
    };
    if (Object.values(delta).some((value) => value < 0)) {
      throw protocolError(
        "non_monotonic_token_usage",
        "ZCode token usage moved backwards",
        request,
        active.sessionId,
      );
    }
    let runningCursor: BackendCursor = { ...cursor, usage: cumulative };
    if (!Object.values(delta).every((value) => value === 0)) {
      deliveries.push(
        delivery(runningCursor, {
          type: "attempt.usage_delta",
          eventId: `${active.attemptId}:${active.sessionId}:usage:${cumulativeHash(cumulative)}`,
          attemptId: active.attemptId,
          occurredAt: now(),
          ...delta,
        }),
      );
      // The usage delivery consumed this sequence number; advance the
      // cursor before building the output delivery or both would publish
      // the same sequence and the repository would reject the batch.
      runningCursor = {
        ...runningCursor,
        nextSequence: runningCursor.nextSequence + 1,
      };
    }
    runningCursor = { ...runningCursor, outputDelivered: true };
    deliveries.push(
      delivery(runningCursor, {
        type: "attempt.output",
        eventId: `${active.attemptId}:${active.sessionId}:output`,
        attemptId: active.attemptId,
        occurredAt: now(),
        output,
      }),
    );
    // The completion delivery is built lazily when it is actually handed out,
    // because building it here would terminalize the attempt while the queued
    // output delivery has not been consumed yet.
    return deliveries;
  }

  /** Consumes app-server messages until the next normalized harness delivery is available. */
  async function nextDelivery(
    request: SupportedRequest,
    initialCursor: BackendCursor,
    active: ActiveAttempt,
  ): Promise<HarnessDelivery> {
    const cursor = initialCursor;
    if (active.pendingDeliveries.length > 0) {
      const queued = active.pendingDeliveries.shift();
      if (queued !== undefined) return queued;
    }
    if (active.outputDelivered) {
      // The turn's structured output was already delivered; hand out the
      // terminal completion delivery now.
      return completedDelivery(cursor, active);
    }
    while (true) {
      let message: Awaited<ReturnType<ZcodeClientApi["nextServerMessage"]>>;
      try {
        message = await input.client.nextServerMessage();
      } catch (error) {
        throw normalizeError(error, {
          code: "zcode_message_read_failed",
          category: "infra",
          retryable: true,
          component: "zcode-harness",
          message: "Could not read the ZCode role event stream",
          taskId: request.attempt.taskId,
          attemptId: request.attempt.attemptId,
          threadId: active.sessionId,
        });
      }

      if ("id" in message) {
        // Any app-server interaction request during an unattended role turn
        // is refused: nobody can approve, and stopping the session is the
        // safest deterministic outcome.
        const knownInteraction =
          message.method.startsWith("interaction/") ||
          message.method.startsWith("session/requestRuntimePreferences");
        const requestId = message.id as string | number;
        input.client.respondError(
          requestId,
          knownInteraction ? -32602 : -32601,
          knownInteraction ? "Invalid request parameters" : "Method not found",
        );
        try {
          await input.client.request("session/stop", {
            sessionId: active.sessionId,
          });
        } catch {
          // The policy block is authoritative even if the stopped session exits first.
        }
        terminalize(active);
        return delivery(withoutTerminalMarkers(cursor), {
          type: "attempt.blocked_policy",
          eventId: `${active.attemptId}:${active.sessionId}:blocked_policy:approval_required:${String(message.id)}`,
          attemptId: active.attemptId,
          occurredAt: now(),
          code: "approval_required",
          message:
            "ZCode requested an interaction during an unattended role turn",
        });
      }

      if (message.method === "session/event") {
        let notification: z.infer<typeof SessionEventNotificationSchema>;
        try {
          notification = SessionEventNotificationSchema.parse(message);
        } catch (error) {
          throw protocolError(
            "invalid_session_event",
            "ZCode sent an invalid session event",
            request,
            active.sessionId,
            error,
          );
        }
        if (notification.params.sessionId !== active.sessionId) continue;

        if (notification.params.type === "turn.completed") {
          const event = TurnCompletedEventSchema.safeParse(
            notification.params.payload,
          );
          if (!event.success) {
            throw protocolError(
              "invalid_turn_completion",
              "ZCode sent an invalid turn completion",
              request,
              active.sessionId,
              event.error,
            );
          }
          if (event.data.resultType !== "success") {
            return classifiedTurnFailure(
              cursor,
              active,
              event.data.resultType,
              event.data.response,
            );
          }
          if (active.outputDelivered) {
            throw protocolError(
              "invalid_structured_output",
              "ZCode completed more than once for the role turn",
              request,
              active.sessionId,
            );
          }
          // A successful turn whose response carries no JSON object gets an
          // in-session correction round instead of terminalizing the attempt;
          // the retry counter is ephemeral because a restart already abandons
          // the in-flight turn (see reconcile).
          if (
            active.structuredRetries < maxStructuredOutputRetries &&
            !responseContainsJsonObject(event.data.response)
          ) {
            active.structuredRetries += 1;
            try {
              await input.client.request("session/send", {
                sessionId: active.sessionId,
                content: structuredOutputRetryPrompt(active.role),
              });
            } catch (error) {
              throw normalizeError(error, {
                code: "zcode_retry_send_failed",
                category: "infra",
                retryable: true,
                component: "zcode-harness",
                message: "ZCode did not accept the structured-output retry",
                taskId: request.attempt.taskId,
                attemptId: request.attempt.attemptId,
                threadId: active.sessionId,
              });
            }
            continue;
          }
          const deliveries = await completeFromTurn(
            request,
            cursor,
            active,
            event.data,
          );
          const first = deliveries.shift();
          active.pendingDeliveries = deliveries;
          if (first !== undefined) {
            active.outputDelivered = true;
            return first;
          }
          return completedDelivery(cursor, active);
        }

        if (notification.params.type === "turn.failed") {
          const payload = notification.params.payload as
            | {
                resultType?: unknown;
                error?: { message?: unknown; detail?: unknown } | string;
              }
            | undefined;
          const resultType =
            typeof payload?.resultType === "string"
              ? payload.resultType
              : "failed";
          const errorObject =
            payload?.error !== undefined && typeof payload.error === "object"
              ? payload.error
              : undefined;
          const parts = [
            typeof payload?.error === "string" ? payload.error : undefined,
            typeof errorObject?.message === "string"
              ? errorObject.message
              : undefined,
            typeof errorObject?.detail === "string"
              ? errorObject.detail
              : undefined,
          ].filter((part): part is string => part !== undefined);
          const errorText = parts.length > 0 ? parts.join(" ") : undefined;
          return classifiedTurnFailure(cursor, active, resultType, errorText);
        }
      }

      // Additive notifications without normalized product meaning are ignored.
    }
  }

  /** Rebuilds authoritative attempt state from the persisted backend cursor. */
  async function reconcile(
    request: SupportedRequest,
    cursor: BackendCursor,
  ): Promise<HarnessDelivery> {
    const recovered: ActiveAttempt = {
      attemptId: request.attempt.attemptId,
      taskId: request.attempt.taskId,
      role: request.attempt.role,
      sessionId: cursor.sessionId,
      baseCommit: request.input.ticket.baseCommit ?? "",
      outputDelivered: cursor.outputDelivered === true,
      startedAt: now(),
      reviewStatusBefore: cursor.reviewStatusBefore,
      pendingDeliveries: [],
      structuredRetries: 0,
    };
    if (request.attempt.role === "review") {
      try {
        await assertReviewInvariant(request);
      } catch (error) {
        return taskFailure(request, error);
      }
    }
    if (cursor.outputDelivered === true) {
      // A persisted outputDelivered marker proves the turn's structured
      // output was already validated; only the terminal event was missed.
      recovered.outputDelivered = true;
      recovered.reconciledCompletion = true;
      activeAttempts.set(recovered.attemptId, recovered);
      return completedDelivery(cursor, recovered);
    }
    // The ZCode app-server is spawned and owned by the scheduler process, so
    // a persisted in-flight turn cannot be resumed across a restart; the
    // attempt is retried from its ticket.
    terminalAttempts.add(recovered.attemptId);
    return failedDelivery(
      cursor,
      recovered,
      "orphaned_turn",
      "No persisted ZCode turn state is recoverable for reconciliation",
    );
  }

  return {
    /** Dispatches, advances, or reconciles one validated harness attempt. */
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
              sessionId: `unavailable:${request.attempt.attemptId}`,
              usage: zeroUsage,
            };
            return delivery(unavailableCursor, {
              type: "attempt.failed_infra",
              eventId: `${request.attempt.attemptId}:reconcile:failed_infra:orphaned_turn`,
              attemptId: request.attempt.attemptId,
              occurredAt: now(),
              code: "orphaned_turn",
              message:
                "No persisted ZCode session identity is available for reconciliation",
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
            "zcode_attempt_not_active",
            "ZCode attempt is not active",
            request,
            cursor.sessionId,
          );
        }
        if (
          active.taskId !== request.attempt.taskId ||
          active.role !== request.attempt.role
        ) {
          throw protocolError(
            "zcode_attempt_identity_mismatch",
            "Active ZCode attempt identity does not match the delivery request",
            request,
            active.sessionId,
          );
        }
        if (active.reconciledCompletion)
          return completedDelivery(cursor, active);
        return await nextDelivery(request, cursor, active);
      } catch (error) {
        return taskFailure(request, error);
      }
    },

    /** Stops an active nonterminal ZCode role session. */
    async cancel(attemptId): Promise<void> {
      if (terminalAttempts.has(attemptId)) return;
      const active = activeAttempts.get(attemptId);
      if (!active)
        throw new Error(`Unknown active ZCode attempt: ${attemptId}`);
      try {
        await input.client.request("session/stop", {
          sessionId: active.sessionId,
        });
      } catch (error) {
        throw normalizeError(error, {
          code: "zcode_session_stop_failed",
          category: "infra",
          retryable: true,
          component: "zcode-harness",
          message: "Could not stop the active ZCode session",
          taskId: active.taskId,
          attemptId: active.attemptId,
          threadId: active.sessionId,
        });
      }
    },
  };
}
