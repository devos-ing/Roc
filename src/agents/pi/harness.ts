import { createHash } from "node:crypto";
import type { z } from "zod";
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
import { PiClient, type PiClientApi } from "./client";
import { implementPrompt, reviewPrompt, scoutPrompt } from "./prompts";
import {
  classifyPiTurnFailure,
  mapPiUsage,
  PiAgentSettledEventSchema,
  type PiAssistantMessage,
  PiAssistantMessageSchema,
  type PiBackendCursor,
  PiBackendCursorSchema,
  PiExtensionUiRequestEventSchema,
  PiGetEntriesDataSchema,
  PiGetStateDataSchema,
  PiMessageEndEventSchema,
  type TokenUsageTotals,
} from "./protocol";

type Usage = TokenUsageTotals;
type EventWithoutSequence = {
  [Type in HarnessEvent["type"]]: Omit<
    Extract<HarnessEvent, { type: Type }>,
    "sequence"
  >;
}[HarnessEvent["type"]];
type SupportedRequest = HarnessStepRequest;
type PiEvent = Awaited<ReturnType<PiClientApi["nextEvent"]>>;

type ActiveAttempt = {
  attemptId: string;
  taskId: string;
  role: "scout" | "implement" | "review";
  client?: PiClientApi;
  sessionId: string;
  sessionFile: string;
  baseCommit: string;
  outputDelivered: boolean;
  startedAt: string;
  reviewStatusBefore?: string;
  reconciledCompletion?: boolean;
  pendingDeliveries: HarnessDelivery[];
  usageSum: Usage;
  lastAssistant?: PiAssistantMessage;
};

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
      const decoded = JSON.parse(candidate) as unknown;
      // Real-backend smoke found models echoing the embedded JSON Schema as a
      // "$schema" property alongside the data; it is harmless metadata.
      if (
        decoded !== null &&
        typeof decoded === "object" &&
        !Array.isArray(decoded) &&
        "$schema" in decoded
      ) {
        const { $schema: _ignored, ...data } = decoded as Record<
          string,
          unknown
        >;
        return data;
      }
      return decoded;
    } catch {
      // Try the next extraction candidate.
    }
  }
  throw new Error("Response does not contain a JSON object");
}

/** Concatenates the text blocks of one finalized assistant message. */
function assistantText(message: PiAssistantMessage): string {
  return message.content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

/** Splits one `provider/modelId` catalog identifier into its Pi pair. */
function parseCatalogModel(id: string): { provider: string; modelId: string } {
  const separator = id.indexOf("/");
  if (separator <= 0 || separator === id.length - 1) {
    throw new AgileError({
      code: "pi_model_invalid",
      category: "protocol",
      retryable: false,
      component: "pi-harness",
      message: "The Pi catalog model id must be provider/modelId",
    });
  }
  return { provider: id.slice(0, separator), modelId: id.slice(separator + 1) };
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
    component: "pi-harness",
    message,
    taskId: request.attempt.taskId,
    attemptId: request.attempt.attemptId,
    threadId: sessionId,
    cause,
  });
}

/** Validates and serializes a durable backend cursor. */
function serializeCursor(cursor: PiBackendCursor): string {
  return JSON.stringify(PiBackendCursorSchema.parse(cursor));
}

/** Parses a durable backend cursor or raises a task-scoped protocol error. */
function parseCursor(
  raw: string,
  request: HarnessStepRequest,
): PiBackendCursor {
  try {
    return PiBackendCursorSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw protocolError(
      "invalid_backend_cursor",
      "Pi backend cursor is invalid",
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
  cursor: PiBackendCursor,
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
      "pi_role_mismatch",
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

/** Creates a Pi-backed harness with per-attempt child processes and durable cursors. */
export function createPiHarness(input: {
  branches: TaskBranchManager;
  startClient?: (cwd: string) => Promise<PiClientApi>;
  now?: () => string;
}): AgentHarness {
  /** Starts one Pi child process rooted at the given working directory. */
  const startClient =
    input.startClient ?? ((cwd: string) => PiClient.start({ cwd }));
  /** Returns the current timestamp through the injected or system clock. */
  const now = input.now ?? (() => new Date().toISOString());
  const activeAttempts = new Map<string, ActiveAttempt>();
  const terminalAttempts = new Set<string>();

  /** Removes transient completion markers from a terminal cursor. */
  function withoutTerminalMarkers(cursor: PiBackendCursor): PiBackendCursor {
    const result = { ...cursor };
    delete result.outputDelivered;
    delete result.reviewStatusBefore;
    return result;
  }

  /** Marks an attempt terminal, releases its child process, and drops state. */
  function terminalize(active: ActiveAttempt): void {
    activeAttempts.delete(active.attemptId);
    terminalAttempts.add(active.attemptId);
    if (active.client !== undefined) {
      void active.client.close().catch(() => undefined);
    }
  }

  /** Terminalizes an attempt and emits a structured infrastructure-failure delivery. */
  function failedDelivery(
    cursor: PiBackendCursor,
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
      component: "pi-harness",
      message: "The Pi task failed unexpectedly",
      taskId: request.attempt.taskId,
      attemptId: request.attempt.attemptId,
    });
    if (normalized.category === "startup" || normalized.category === "domain") {
      throw normalized;
    }

    let cursor: PiBackendCursor | undefined;
    if (request.backendCursor !== undefined) {
      try {
        cursor = PiBackendCursorSchema.parse(JSON.parse(request.backendCursor));
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
      sessionFile:
        cursor?.sessionFile ?? `unavailable:${request.attempt.attemptId}`,
      baseCommit: request.input.ticket.baseCommit ?? "",
      outputDelivered: false,
      startedAt: now(),
      pendingDeliveries: [],
      usageSum: zeroUsage,
    };
    const failureCursor: PiBackendCursor = cursor ?? {
      version: 1,
      nextSequence: 1,
      sessionId: active.sessionId,
      sessionFile: active.sessionFile,
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
    cursor: PiBackendCursor,
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

  /** Classifies a failed settle and emits the corresponding terminal delivery. */
  function classifiedTurnFailure(
    cursor: PiBackendCursor,
    active: ActiveAttempt,
    stopReason: string,
    errorMessage: string | undefined,
  ): HarnessDelivery {
    const failure = classifyPiTurnFailure(stopReason, errorMessage);
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
        component: "pi-harness",
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
        component: "pi-harness",
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
          "pi_attempt_identity_mismatch",
          "Active Pi attempt identity does not match the dispatch request",
          request,
          existing.sessionId,
        );
      }
      const cursor: PiBackendCursor = {
        version: 1,
        nextSequence: 1,
        sessionId: existing.sessionId,
        sessionFile: existing.sessionFile,
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
          component: "pi-harness",
          message: "Could not snapshot the Review workspace",
          taskId: request.attempt.taskId,
          attemptId: request.attempt.attemptId,
        });
      }
    }

    // Pi has no protocol-level sandbox and its working directory is
    // process-level state, so every attempt owns one child process rooted at
    // the task workspace; that is a working directory, not a confinement
    // boundary. Turns can still write outside the checkout with absolute
    // paths or parent traversal, and the Review status comparison only sees
    // changes inside the task checkout.
    let catalogModel: { provider: string; modelId: string };
    try {
      catalogModel = parseCatalogModel(request.attempt.model);
    } catch (error) {
      throw normalizeError(error, {
        code: "pi_model_invalid",
        category: "protocol",
        retryable: true,
        component: "pi-harness",
        message: "The Pi attempt model is not a provider/modelId pair",
        taskId: request.attempt.taskId,
        attemptId: request.attempt.attemptId,
      });
    }

    let client: PiClientApi;
    try {
      client = await startClient(workspace.path);
    } catch (error) {
      throw normalizeError(error, {
        code: "pi_process_start_failed",
        category: "infra",
        retryable: true,
        component: "pi-harness",
        message: "Could not start the Pi role process",
        taskId: request.attempt.taskId,
        attemptId: request.attempt.attemptId,
      });
    }

    try {
      // Setting model and thinking level over the RPC after startup is more
      // deterministic than a --model flag: the routed pair is confirmed by
      // the session state rather than assumed from argv. Pi thinking levels
      // cover every Roc effort, so the effort maps one-to-one.
      await client.request("set_model", {
        provider: catalogModel.provider,
        modelId: catalogModel.modelId,
      });
      await client.request("set_thinking_level", {
        level: request.attempt.effort,
      });

      let rawState: unknown;
      try {
        rawState = await client.request("get_state");
      } catch (error) {
        throw protocolError(
          "invalid_session_state",
          "Pi returned an invalid role session state",
          request,
          undefined,
          error,
        );
      }
      let state: z.infer<typeof PiGetStateDataSchema>;
      try {
        state = PiGetStateDataSchema.parse(rawState);
      } catch (error) {
        throw protocolError(
          "invalid_session_state",
          "Pi returned an invalid role session state",
          request,
          undefined,
          error,
        );
      }

      try {
        await client.request("prompt", { message: prompt(request) });
      } catch (error) {
        throw normalizeError(error, {
          code: "pi_prompt_send_failed",
          category: "infra",
          retryable: true,
          component: "pi-harness",
          message: "Pi did not accept the role prompt",
          taskId: request.attempt.taskId,
          attemptId: request.attempt.attemptId,
          threadId: state.sessionId,
        });
      }

      const startedAt = now();
      const active: ActiveAttempt = {
        attemptId: request.attempt.attemptId,
        taskId: request.attempt.taskId,
        role: request.attempt.role,
        client,
        sessionId: state.sessionId,
        sessionFile: state.sessionFile,
        baseCommit: workspace.baseCommit,
        outputDelivered: false,
        startedAt,
        reviewStatusBefore,
        pendingDeliveries: [],
        usageSum: zeroUsage,
      };
      activeAttempts.set(active.attemptId, active);
      const cursor: PiBackendCursor = {
        version: 1,
        nextSequence: 1,
        sessionId: active.sessionId,
        sessionFile: active.sessionFile,
        usage: zeroUsage,
        ...(reviewStatusBefore === undefined ? {} : { reviewStatusBefore }),
      };
      return delivery(cursor, {
        type: "attempt.started",
        eventId: `${active.attemptId}:${active.sessionId}:started`,
        attemptId: active.attemptId,
        occurredAt: startedAt,
        threadId: active.sessionId,
        baseCommit: active.baseCommit,
      });
    } catch (error) {
      // A half-started attempt owns its child process; release it before
      // the failure is normalized into a terminal delivery.
      void client.close().catch(() => undefined);
      throw error;
    }
  }

  /** Reads the durable entry anchor for a settled turn, best-effort. */
  async function settledEntryAnchor(
    client: PiClientApi | undefined,
  ): Promise<string | undefined> {
    if (client === undefined) return undefined;
    try {
      const data = PiGetEntriesDataSchema.parse(
        await client.request("get_entries"),
      );
      return data.leafId ?? undefined;
    } catch {
      // The anchor is forward-looking durable state; v1 never resumes from
      // it, so a failed read never fails a validated output.
      return undefined;
    }
  }

  /** Builds the terminal delivery chain for a successful settled prompt. */
  async function completeFromSettled(
    request: SupportedRequest,
    cursor: PiBackendCursor,
    active: ActiveAttempt,
  ): Promise<HarnessDelivery[]> {
    const message = active.lastAssistant;
    if (message === undefined) {
      throw protocolError(
        "no_assistant_output",
        "Pi settled without a final assistant message",
        request,
        active.sessionId,
      );
    }

    let decoded: unknown;
    try {
      decoded = extractJsonObject(assistantText(message));
    } catch (error) {
      throw protocolError(
        "invalid_structured_output",
        "Pi returned invalid structured output",
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
          "Pi returned invalid structured output",
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
          "The trusted Harness could not create or reuse the implementation commit",
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
          "Pi returned invalid structured output",
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
    const cumulative = active.usageSum;
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
        "Pi token usage moved backwards",
        request,
        active.sessionId,
      );
    }
    let runningCursor: PiBackendCursor = { ...cursor, usage: cumulative };
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
    const entryAnchor = await settledEntryAnchor(active.client);
    if (entryAnchor !== undefined) {
      runningCursor = { ...runningCursor, entryAnchor };
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
    // The completion delivery is built lazily when it is actually handed
    // out, because building it here would terminalize the attempt while the
    // queued output delivery has not been consumed yet.
    return deliveries;
  }

  /** Consumes Pi events until the next normalized harness delivery is available. */
  async function nextDelivery(
    request: SupportedRequest,
    initialCursor: PiBackendCursor,
    active: ActiveAttempt,
  ): Promise<HarnessDelivery> {
    const cursor = initialCursor;
    if (active.pendingDeliveries.length > 0) {
      const queued = active.pendingDeliveries.shift();
      if (queued !== undefined) return queued;
    }
    if (active.outputDelivered) {
      // The settled prompt's structured output was already delivered; hand
      // out the terminal completion delivery now.
      return completedDelivery(cursor, active);
    }
    while (true) {
      const client = active.client;
      if (client === undefined) {
        throw protocolError(
          "pi_attempt_not_active",
          "The Pi attempt has no live process",
          request,
          active.sessionId,
        );
      }
      let event: PiEvent;
      try {
        event = await client.nextEvent();
      } catch (error) {
        throw normalizeError(error, {
          code: "pi_event_read_failed",
          category: "infra",
          retryable: true,
          component: "pi-harness",
          message: "Could not read the Pi role event stream",
          taskId: request.attempt.taskId,
          attemptId: request.attempt.attemptId,
          threadId: active.sessionId,
        });
      }

      if (event.type === "message_end") {
        let messageEnd: z.infer<typeof PiMessageEndEventSchema>;
        try {
          messageEnd = PiMessageEndEventSchema.parse(event);
        } catch (error) {
          throw protocolError(
            "invalid_message_end",
            "Pi sent an invalid message_end event",
            request,
            active.sessionId,
            error,
          );
        }
        const rawMessage = messageEnd.message as { role?: unknown };
        if (rawMessage.role !== "assistant") continue;
        let message: PiAssistantMessage;
        try {
          message = PiAssistantMessageSchema.parse(messageEnd.message);
        } catch (error) {
          throw protocolError(
            "invalid_assistant_message",
            "Pi sent an invalid assistant message",
            request,
            active.sessionId,
            error,
          );
        }
        // message_end.message is the authoritative terminal form: usage is
        // accumulated per assistant message so compaction-inflated session
        // stats never reach the attempt totals, and the last assistant
        // message before settling is the turn's final answer.
        active.lastAssistant = message;
        const usage = mapPiUsage(message.usage);
        active.usageSum = {
          inputTokens: active.usageSum.inputTokens + usage.inputTokens,
          cachedInputTokens:
            active.usageSum.cachedInputTokens + usage.cachedInputTokens,
          outputTokens: active.usageSum.outputTokens + usage.outputTokens,
          reasoningOutputTokens:
            active.usageSum.reasoningOutputTokens + usage.reasoningOutputTokens,
        };
        continue;
      }

      if (event.type === "agent_settled") {
        if (!PiAgentSettledEventSchema.safeParse(event).success) {
          throw protocolError(
            "invalid_settled_event",
            "Pi sent an invalid agent_settled event",
            request,
            active.sessionId,
          );
        }
        if (active.outputDelivered) {
          throw protocolError(
            "invalid_structured_output",
            "Pi settled more than once for the role prompt",
            request,
            active.sessionId,
          );
        }
        const message = active.lastAssistant;
        if (message === undefined) {
          return failedDelivery(
            cursor,
            active,
            "no_assistant_output",
            "Pi settled without a final assistant message",
          );
        }
        if (message.stopReason !== "stop") {
          return classifiedTurnFailure(
            cursor,
            active,
            message.stopReason,
            message.errorMessage,
          );
        }
        const deliveries = await completeFromSettled(request, cursor, active);
        const first = deliveries.shift();
        active.pendingDeliveries = deliveries;
        if (first !== undefined) {
          active.outputDelivered = true;
          return first;
        }
        return completedDelivery(cursor, active);
      }

      if (event.type === "extension_ui_request") {
        let uiRequest: z.infer<typeof PiExtensionUiRequestEventSchema>;
        try {
          uiRequest = PiExtensionUiRequestEventSchema.parse(event);
        } catch (error) {
          throw protocolError(
            "invalid_extension_ui_request",
            "Pi sent an invalid extension UI request",
            request,
            active.sessionId,
            error,
          );
        }
        // Any extension UI interaction during an unattended role turn is
        // cancelled: nobody can answer dialogs, and blocking the agent is
        // the safest deterministic outcome.
        client.send({
          type: "extension_ui_response",
          id: uiRequest.id,
          cancelled: true,
        });
        try {
          await client.request("abort");
        } catch {
          // The policy block is authoritative even if the abort races exit.
        }
        terminalize(active);
        return delivery(withoutTerminalMarkers(cursor), {
          type: "attempt.blocked_policy",
          eventId: `${active.attemptId}:${active.sessionId}:blocked_policy:approval_required:${uiRequest.id}`,
          attemptId: active.attemptId,
          occurredAt: now(),
          code: "approval_required",
          message: "Pi requested an interaction during an unattended role turn",
        });
      }

      // Additive events without normalized product meaning (agent_start,
      // agent_end, turn_*, message_start, message_update, tool_execution_*)
      // are ignored.
    }
  }

  /** Rebuilds authoritative attempt state from the persisted backend cursor. */
  async function reconcile(
    request: SupportedRequest,
    cursor: PiBackendCursor,
  ): Promise<HarnessDelivery> {
    const recovered: ActiveAttempt = {
      attemptId: request.attempt.attemptId,
      taskId: request.attempt.taskId,
      role: request.attempt.role,
      sessionId: cursor.sessionId,
      sessionFile: cursor.sessionFile,
      baseCommit: request.input.ticket.baseCommit ?? "",
      outputDelivered: cursor.outputDelivered === true,
      startedAt: now(),
      reviewStatusBefore: cursor.reviewStatusBefore,
      pendingDeliveries: [],
      usageSum: { ...cursor.usage },
    };
    if (request.attempt.role === "review") {
      try {
        await assertReviewInvariant(request);
      } catch (error) {
        return taskFailure(request, error);
      }
    }
    if (cursor.outputDelivered === true) {
      // A persisted outputDelivered marker proves the settled prompt's
      // structured output was already validated; only the terminal event
      // was missed.
      recovered.outputDelivered = true;
      recovered.reconciledCompletion = true;
      activeAttempts.set(recovered.attemptId, recovered);
      return completedDelivery(cursor, recovered);
    }
    // The Pi session file and entry anchor are durable on disk, but v1 has
    // no reattach path: the child process is gone and Roc does not yet
    // resume an in-flight prompt from get_entries. The attempt is retried
    // from its ticket; the persisted anchors stay available for that future.
    terminalAttempts.add(recovered.attemptId);
    return failedDelivery(
      cursor,
      recovered,
      "orphaned_turn",
      "No persisted Pi turn state is recoverable for reconciliation",
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
            const unavailableCursor: PiBackendCursor = {
              version: 1,
              nextSequence: 1,
              sessionId: `unavailable:${request.attempt.attemptId}`,
              sessionFile: `unavailable:${request.attempt.attemptId}`,
              usage: zeroUsage,
            };
            return delivery(unavailableCursor, {
              type: "attempt.failed_infra",
              eventId: `${request.attempt.attemptId}:reconcile:failed_infra:orphaned_turn`,
              attemptId: request.attempt.attemptId,
              occurredAt: now(),
              code: "orphaned_turn",
              message:
                "No persisted Pi session identity is available for reconciliation",
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
            "pi_attempt_not_active",
            "Pi attempt is not active",
            request,
            cursor.sessionId,
          );
        }
        if (
          active.taskId !== request.attempt.taskId ||
          active.role !== request.attempt.role
        ) {
          throw protocolError(
            "pi_attempt_identity_mismatch",
            "Active Pi attempt identity does not match the delivery request",
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

    /** Aborts an active nonterminal Pi role process and reaps it. */
    async cancel(attemptId): Promise<void> {
      if (terminalAttempts.has(attemptId)) return;
      const active = activeAttempts.get(attemptId);
      if (!active) throw new Error(`Unknown active Pi attempt: ${attemptId}`);
      const client = active.client;
      if (client === undefined) return;
      try {
        await client.request("abort");
      } catch (error) {
        throw normalizeError(error, {
          code: "pi_abort_failed",
          category: "infra",
          retryable: true,
          component: "pi-harness",
          message: "Could not abort the active Pi role turn",
          taskId: active.taskId,
          attemptId: active.attemptId,
          threadId: active.sessionId,
        });
      }
      // Closing bounds the abort: the client ends stdin, waits briefly for
      // the child to exit on its own, then SIGKILLs it as the fallback.
      await client.close();
    },
  };
}
