import assert from "node:assert/strict";
import type {
  AgentHarness,
  HarnessDelivery,
  HarnessEvent,
  HarnessStepRequest,
} from "../../src/harness/contracts";
import { HarnessEventSchema } from "../../src/harness/contracts";
import type { TaskBranchManager } from "../../src/workspace/task-branch";
import { git } from "../helpers/git";

/**
 * Backend conformance suite.
 *
 * Split in two halves. `defineNormalizedConformance` holds the
 * normalized-event invariants every backend runs — including the in-memory
 * fake harness (see docs/research/fake-codex-harness-options.md, "Fake 與
 * adapter 共用同一 normalized-event conformance suite"). It asserts the
 * event stream the scheduler depends on and deliberately does not compare
 * protocol shapes. `defineAdapterConformance` adds the cases that observe the
 * real adapter machinery: protocol-level interaction handling, reconcile
 * recovery, and workspace safety against real git checkouts. All protocol
 * vocabulary (method names, params, cursor encoding) stays inside each
 * backend's ProtocolDriver implementation — cursors are opaque to the suite;
 * only the driver may decode them. The one declared axis is
 * `reconcileInFlight`: whether an in-flight attempt can be recovered from
 * persisted history ("history") or only reported as an orphan ("orphan").
 */

export type ConformanceRole = "scout" | "implement" | "review";

export type ScriptedUsage = {
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
};

export type RoleStartObservation = {
  role: ConformanceRole;
  model: string;
  effort: string;
};

export interface ProtocolDriver {
  /** The backend ref the next turn for `role` will run under. */
  peekNextRef(role: ConformanceRole): string;
  /**
   * Queue a complete turn for `role`. Returns the backend ref the turn will
   * run under (same value `peekNextRef(role)` returned before this call).
   */
  scriptSuccessfulTurn(
    role: ConformanceRole,
    options?: {
      usage?: ScriptedUsage;
      /** Write one extra file inside the checkout while the turn runs. */
      mutateWorkspace?: boolean;
      /** Complete the turn with structurally invalid output. */
      invalidOutput?: boolean;
    },
  ): string;
  /** Queue a mid-turn server approval/user-input request on `ref`. */
  scriptInteractionRequest(ref: string): void;
  /** Queue a notification that belongs to a foreign turn or thread. */
  scriptForeignTurnNotification(ref: string): void;
  /** Mint a backend-native cursor for `ref`. */
  mintCursor(input: MintCursorInput): string;
  /** Normalized record of every role start the backend dispatched. */
  roleStartRequests(): RoleStartObservation[];
  /** Whether the backend rejected the server interaction request it received. */
  interactionRejections(): number;
  /** Number of cancellation requests sent (interrupt/stop). */
  interruptionRequestCount(): number;
  /** Decodes the next sequence an event delivered after `cursor` will carry. */
  cursorNextSequence(cursor: string): number;
  /** Decodes the cumulative usage persisted in `cursor`. */
  cursorUsage(cursor: string): NormalizedUsageTotals;
}

export type MintCursorInput = {
  ref: string;
  nextSequence?: number;
  usage?: ScriptedUsage;
  outputDelivered?: boolean;
  /**
   * Script an authoritative completed turn for `ref` in persisted history, so
   * a history-recovery reconcile can reconstruct the outcome.
   */
  recoveredCompletedTurn?: boolean;
};

export type NormalizedUsageTotals = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export interface NormalizedConformanceFixture {
  readonly harness: AgentHarness;
  readonly driver: ProtocolDriver;
  dispose(): Promise<void>;
}

export interface AdapterConformanceFixture
  extends NormalizedConformanceFixture {
  readonly branches: TaskBranchManager;
  readonly sourceRoot: string;
  readonly workspace: {
    readonly path: string;
    readonly branch: string;
    readonly baseCommit: string;
  };
}

export interface NormalizedConformanceConfig {
  createFixture(): Promise<NormalizedConformanceFixture>;
}

export interface AdapterConformanceConfig {
  readonly reconcileInFlight: "history" | "orphan";
  createFixture(): Promise<AdapterConformanceFixture>;
}

export type ConformanceCase = {
  readonly group: string;
  readonly name: string;
  run(): Promise<void>;
};

const ticket = {
  id: "T1",
  cycleId: "2026-W35",
  title: "Backend conformance",
  spec: {
    problem: "Backends drift silently",
    desiredOutcome: "Every backend satisfies the same invariants",
    scope: ["test/agents"],
    nonGoals: ["Protocol matrices"],
    acceptanceCriteria: ["Conformance suite passes"],
    validation: ["bun test test/agents"],
    dependencies: [],
    risk: "low" as const,
    contextCandidates: [],
    tokenCeiling: 10_000,
  },
  priority: 0,
  approvalRequired: false,
  approved: true,
  status: "scouting" as const,
};

/**
 * Structured outputs the scripted turns deliver for each role. Shared by the
 * suite's request builder and every ProtocolDriver so all backends script
 * identical payloads; drivers only encode them into their own protocol.
 */
export const roleOutputs = {
  scout: {
    kind: "scout" as const,
    summary: "The seam is AgentHarness",
    files: ["test/agents/conformance.ts"],
    tests: ["test/agents/conformance.ts"],
    risks: ["Protocol shapes drift"],
  },
  implement: {
    kind: "implement" as const,
    validation: ["bun test test/agents"],
    risks: [],
    limitations: [],
  },
  review: {
    kind: "review" as const,
    decision: "accepted" as const,
    findings: [],
    remainingGaps: [],
  },
};

const scoutOutput = roleOutputs.scout;

// Models are provider-scoped ids (`provider/modelId`) because the Pi backend
// parses its catalog model that way; the other backends pass the identifier
// through untouched, so the shared shape is the provider-scoped one.
export const roleAttempts: Record<
  ConformanceRole,
  Pick<HarnessStepRequest["attempt"], "modelProfile" | "model" | "effort">
> = {
  scout: { modelProfile: "luna", model: "conformance/scout", effort: "high" },
  implement: {
    modelProfile: "terra",
    model: "conformance/implement",
    effort: "xhigh",
  },
  review: {
    modelProfile: "sol",
    model: "conformance/review",
    effort: "medium",
  },
};

/** Normalizes scripted usage into the totals shape cursors and deltas use. */
export function normalizedUsage(
  usage: ScriptedUsage | undefined,
): NormalizedUsageTotals {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    cachedInputTokens: usage?.cachedInputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    reasoningOutputTokens: usage?.reasoningTokens ?? 0,
  };
}

function conformanceRequest(
  role: ConformanceRole,
  options: {
    attemptId: string;
    backendCursor?: string;
    mode?: "dispatch" | "reconcile";
    implementation?: { commitSha: string };
    baseCommit?: string;
  },
): HarnessStepRequest {
  const attempt = roleAttempts[role];
  const base = {
    attemptId: options.attemptId,
    taskId: ticket.id,
    role,
    retryIndex: 0 as const,
    ...attempt,
  };
  if (role === "scout") {
    return {
      mode: options.mode ?? "dispatch",
      attempt: base,
      input: { role: "scout", ticket },
      backendCursor: options.backendCursor,
    };
  }
  if (role === "implement") {
    return {
      mode: options.mode ?? "dispatch",
      attempt: base,
      input: {
        role: "implement",
        ticket: { ...ticket, status: "implementing" as const },
        scout: scoutOutput,
      },
      backendCursor: options.backendCursor,
    };
  }
  return {
    mode: options.mode ?? "dispatch",
    attempt: base,
    input: {
      role: "review",
      ticket: {
        ...ticket,
        status: "reviewing" as const,
        baseCommit: options.baseCommit ?? "a".repeat(40),
      },
      scout: scoutOutput,
      implementation: {
        kind: "implement",
        commitSha: options.implementation?.commitSha ?? "b".repeat(40),
        validation: [],
        risks: [],
        limitations: [],
      },
    },
    backendCursor: options.backendCursor,
  };
}

const TERMINAL = new Set([
  "attempt.completed",
  "attempt.failed_infra",
  "attempt.blocked_policy",
]);

async function collect(
  harness: AgentHarness,
  request: HarnessStepRequest,
): Promise<{ events: HarnessEvent[]; cursors: string[] }> {
  const events: HarnessEvent[] = [];
  const cursors: string[] = [];
  let current: HarnessStepRequest = request;
  for (let step = 0; step < 50; step += 1) {
    const delivery = await harness.step(current);
    if (delivery.kind === "idle") {
      if (delivery.nextCursor === undefined) break;
      current = { ...request, backendCursor: delivery.nextCursor };
      continue;
    }
    if (delivery.kind === "closed") break;
    events.push(delivery.event);
    cursors.push(delivery.nextCursor);
    if (TERMINAL.has(delivery.event.type)) break;
    current = { ...request, backendCursor: delivery.nextCursor };
  }
  return { events, cursors };
}

function assertTerminal(events: HarnessEvent[]): void {
  const last = events.at(-1);
  assert.ok(last !== undefined, "expected at least one event");
  assert.ok(
    TERMINAL.has(last.type),
    `expected a terminal event, got ${JSON.stringify(last)}`,
  );
}

async function sourceHead(root: string): Promise<string> {
  return git(["rev-parse", "HEAD"], root);
}

async function assertSourceUntouched(
  fixture: AdapterConformanceFixture,
  headBefore: string,
): Promise<void> {
  assert.equal(
    await sourceHead(fixture.sourceRoot),
    headBefore,
    "source repository HEAD moved",
  );
  assert.equal(
    await git(["status", "--porcelain"], fixture.sourceRoot),
    "",
    "source repository working tree changed",
  );
}

function createCase<F extends NormalizedConformanceFixture>(
  config: { createFixture(): Promise<F> },
  group: string,
  name: string,
  test: (fixture: F) => Promise<void>,
): ConformanceCase {
  return {
    group,
    name,
    async run(): Promise<void> {
      const fixture = await config.createFixture();
      try {
        await test(fixture);
      } finally {
        await fixture.dispose();
      }
    },
  };
}

const scriptedUsage: ScriptedUsage = {
  inputTokens: 1200,
  cachedInputTokens: 300,
  outputTokens: 80,
  reasoningTokens: 40,
};

export function defineNormalizedConformance(
  config: NormalizedConformanceConfig,
): readonly ConformanceCase[] {
  const cases: ConformanceCase[] = [];

  // ---- sequence and cursors ----------------------------------------------

  cases.push(
    createCase(
      config,
      "sequence and cursors",
      "a happy turn emits strictly increasing sequences and chained cursors",
      async (fixture) => {
        const ref = fixture.driver.scriptSuccessfulTurn("scout", {
          usage: scriptedUsage,
        });
        assert.ok(ref.length > 0);
        const { events, cursors } = await collect(
          fixture.harness,
          conformanceRequest("scout", { attemptId: "attempt-seq" }),
        );
        assertTerminal(events);
        for (const [index, event] of events.entries()) {
          assert.equal(event.sequence, index + 1);
          HarnessEventSchema.parse(event);
        }
        for (const [index, event] of events.entries()) {
          const cursor = cursors[index];
          assert.ok(cursor !== undefined, "missing cursor for an event");
          assert.equal(
            fixture.driver.cursorNextSequence(cursor),
            event.sequence + 1,
            `cursor after sequence ${event.sequence} does not chain`,
          );
        }
      },
    ),
  );

  cases.push(
    createCase(
      config,
      "sequence and cursors",
      "late notifications from a completed turn are drained before the next attempt",
      async (fixture) => {
        const firstRef = fixture.driver.scriptSuccessfulTurn("scout", {
          usage: scriptedUsage,
        });
        const first = await collect(
          fixture.harness,
          conformanceRequest("scout", { attemptId: "attempt-drain-1" }),
        );
        assertTerminal(first.events);
        const secondUsage: ScriptedUsage = {
          inputTokens: 2400,
          cachedInputTokens: 150,
          outputTokens: 60,
          reasoningTokens: 25,
        };
        fixture.driver.scriptForeignTurnNotification(firstRef);
        fixture.driver.scriptSuccessfulTurn("scout", { usage: secondUsage });
        const second = await collect(
          fixture.harness,
          conformanceRequest("scout", { attemptId: "attempt-drain-2" }),
        );
        assertTerminal(second.events);
        const types = second.events.map((event) => event.type);
        assert.equal(types[0], "attempt.started");
        assert.equal(types.at(-1), "attempt.completed");
        for (const [index, event] of second.events.entries()) {
          assert.equal(event.sequence, index + 1);
        }
        // The second attempt must be fully isolated from the first turn and
        // its late notification: its usage totals are exactly the second
        // scripted turn's, with nothing leaking in from the stale ref.
        const deltas = second.events.filter(
          (
            event,
          ): event is Extract<HarnessEvent, { type: "attempt.usage_delta" }> =>
            event.type === "attempt.usage_delta",
        );
        const sum = (
          pick: (
            delta: Extract<HarnessEvent, { type: "attempt.usage_delta" }>,
          ) => number,
        ) => deltas.reduce((total, delta) => total + pick(delta), 0);
        assert.equal(
          sum((delta) => delta.inputTokens),
          2400,
        );
        assert.equal(
          sum((delta) => delta.cachedInputTokens),
          150,
        );
        assert.equal(
          sum((delta) => delta.outputTokens),
          60,
        );
        assert.equal(
          sum((delta) => delta.reasoningOutputTokens),
          25,
        );
      },
    ),
  );

  cases.push(
    createCase(
      config,
      "sequence and cursors",
      "redispatching an active attempt restarts the sequence with the same event id",
      async (fixture) => {
        const request = conformanceRequest("scout", {
          attemptId: "attempt-redispatch",
        });
        const first = await fixture.harness.step(request);
        assert.equal(first.kind, "event");
        if (first.kind !== "event") throw new Error("unreachable");
        assert.equal(first.event.type, "attempt.started");
        assert.equal(first.event.sequence, 1);

        const second = await fixture.harness.step(request);
        assert.equal(second.kind, "event");
        if (second.kind !== "event") throw new Error("unreachable");
        assert.equal(second.event.type, "attempt.started");
        assert.equal(second.event.sequence, 1);
        assert.equal(second.event.eventId, first.event.eventId);
      },
    ),
  );

  // ---- output before completion -------------------------------------------

  cases.push(
    createCase(
      config,
      "output before completion",
      "usage deltas precede the output, and completion is the final event",
      async (fixture) => {
        fixture.driver.scriptSuccessfulTurn("scout", { usage: scriptedUsage });
        const { events } = await collect(
          fixture.harness,
          conformanceRequest("scout", { attemptId: "attempt-order" }),
        );
        assertTerminal(events);
        const types = events.map((event) => event.type);
        const outputIndex = types.indexOf("attempt.output");
        assert.ok(outputIndex > 0, "expected an output event");
        const lastUsage = types.lastIndexOf("attempt.usage_delta");
        if (lastUsage !== -1) {
          assert.ok(
            lastUsage < outputIndex,
            "a usage delta arrived after the output",
          );
        }
        assert.equal(types.at(-1), "attempt.completed");
        for (const [index, event] of events.entries()) {
          assert.equal(event.sequence, index + 1);
        }
      },
    ),
  );

  cases.push(
    createCase(
      config,
      "output before completion",
      "invalid structured output fails closed without output or completion",
      async (fixture) => {
        // Backends that retry invalid structured output in-session (the
        // ZCode backend sends up to two schema-restating corrections) consume
        // one scripted invalid turn per correction round before failing;
        // backends without the retry fail on the first turn and ignore the
        // extra scripted turns.
        for (let index = 0; index < 3; index += 1) {
          fixture.driver.scriptSuccessfulTurn("scout", {
            usage: scriptedUsage,
            invalidOutput: true,
          });
        }
        const { events } = await collect(
          fixture.harness,
          conformanceRequest("scout", { attemptId: "attempt-invalid" }),
        );
        assertTerminal(events);
        const types = events.map((event) => event.type);
        assert.ok(!types.includes("attempt.output"));
        assert.ok(!types.includes("attempt.completed"));
        const failure = events.at(-1);
        assert.ok(failure?.type === "attempt.failed_infra");
        if (failure.type !== "attempt.failed_infra")
          throw new Error("unreachable");
        assert.equal(failure.code, "invalid_structured_output");
        assert.equal(failure.retryable, true);
      },
    ),
  );

  // ---- attribution (normalized) ------------------------------------------

  cases.push(
    createCase(
      config,
      "attribution",
      "usage deltas sum to the scripted totals and the final cursor",
      async (fixture) => {
        fixture.driver.scriptSuccessfulTurn("scout", { usage: scriptedUsage });
        const { events, cursors } = await collect(
          fixture.harness,
          conformanceRequest("scout", { attemptId: "attempt-usage" }),
        );
        assertTerminal(events);
        const deltas = events.filter(
          (
            event,
          ): event is Extract<HarnessEvent, { type: "attempt.usage_delta" }> =>
            event.type === "attempt.usage_delta",
        );
        assert.ok(deltas.length > 0, "expected at least one usage delta");
        const sum = (
          pick: (
            delta: Extract<HarnessEvent, { type: "attempt.usage_delta" }>,
          ) => number,
        ) => deltas.reduce((total, delta) => total + pick(delta), 0);
        assert.equal(
          sum((delta) => delta.inputTokens),
          scriptedUsage.inputTokens,
        );
        assert.equal(
          sum((delta) => delta.cachedInputTokens),
          scriptedUsage.cachedInputTokens ?? 0,
        );
        assert.equal(
          sum((delta) => delta.outputTokens),
          scriptedUsage.outputTokens ?? 0,
        );
        assert.equal(
          sum((delta) => delta.reasoningOutputTokens),
          scriptedUsage.reasoningTokens ?? 0,
        );
        const finalCursorString = cursors.at(-1);
        assert.ok(finalCursorString !== undefined);
        const finalUsage = fixture.driver.cursorUsage(finalCursorString);
        assert.equal(finalUsage.inputTokens, scriptedUsage.inputTokens);
        assert.equal(
          finalUsage.cachedInputTokens,
          scriptedUsage.cachedInputTokens ?? 0,
        );
        assert.equal(finalUsage.outputTokens, scriptedUsage.outputTokens ?? 0);
        assert.equal(
          finalUsage.reasoningOutputTokens,
          scriptedUsage.reasoningTokens ?? 0,
        );
      },
    ),
  );

  cases.push(
    createCase(
      config,
      "attribution",
      "a turn that reports no usage emits no usage delta",
      async (fixture) => {
        fixture.driver.scriptSuccessfulTurn("scout", {
          usage: {
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
          },
        });
        const { events } = await collect(
          fixture.harness,
          conformanceRequest("scout", { attemptId: "attempt-zero-usage" }),
        );
        assertTerminal(events);
        assert.ok(
          !events.some((event) => event.type === "attempt.usage_delta"),
          "a zero-usage turn must not emit usage deltas",
        );
        const types = events.map((event) => event.type);
        assert.ok(types.includes("attempt.output"));
        assert.equal(types.at(-1), "attempt.completed");
      },
    ),
  );

  return cases;
}

export function defineAdapterConformance(
  config: AdapterConformanceConfig,
): readonly ConformanceCase[] {
  const cases: ConformanceCase[] = [];

  // ---- approval becomes blocked_policy --------------------------------------

  cases.push(
    createCase(
      config,
      "approval",
      "a mid-turn interaction request blocks the attempt and is rejected",
      async (fixture) => {
        const ref = fixture.driver.peekNextRef("scout");
        fixture.driver.scriptInteractionRequest(ref);
        const request = conformanceRequest("scout", {
          attemptId: "attempt-blocked",
        });
        const started = await fixture.harness.step(request);
        assert.equal(started.kind, "event");
        if (started.kind !== "event") throw new Error("unreachable");
        const { events } = await collect(fixture.harness, {
          ...request,
          backendCursor: started.nextCursor,
        });
        assertTerminal(events);
        const types = events.map((event) => event.type);
        assert.ok(!types.includes("attempt.output"));
        assert.ok(!types.includes("attempt.completed"));
        const blocked = events.at(-1);
        assert.ok(blocked?.type === "attempt.blocked_policy");
        if (blocked.type !== "attempt.blocked_policy")
          throw new Error("unreachable");
        assert.equal(blocked.code, "approval_required");

        assert.ok(
          fixture.driver.interactionRejections() >= 1,
          "backend did not reject the interaction request",
        );
        const interrupts = fixture.driver.interruptionRequestCount();
        assert.ok(interrupts >= 1, "backend did not interrupt the turn");
        await fixture.harness.cancel("attempt-blocked");
        assert.equal(
          fixture.driver.interruptionRequestCount(),
          interrupts,
          "cancel after a terminal event must be a no-op",
        );
      },
    ),
  );

  // ---- cancel and reconcile are deterministic -------------------------------

  cases.push(
    createCase(
      config,
      "cancel and reconcile",
      "cancelling an active attempt interrupts exactly once",
      async (fixture) => {
        const request = conformanceRequest("scout", {
          attemptId: "attempt-cancel",
        });
        const started = await fixture.harness.step(request);
        assert.equal(started.kind, "event");
        if (started.kind !== "event") throw new Error("unreachable");
        await fixture.harness.cancel("attempt-cancel");
        assert.equal(fixture.driver.interruptionRequestCount(), 1);
      },
    ),
  );

  cases.push(
    createCase(
      config,
      "cancel and reconcile",
      "reconciling a delivered cursor completes deterministically",
      async (fixture) => {
        const request = conformanceRequest("scout", {
          attemptId: "attempt-reconcile-delivered",
          mode: "reconcile",
        });
        const cursor = fixture.driver.mintCursor({
          ref: "conformance-delivered:conformance-delivered",
          nextSequence: 4,
          usage: scriptedUsage,
          outputDelivered: true,
        });
        const first = await fixture.harness.step({
          ...request,
          backendCursor: cursor,
        });
        assert.equal(first.kind, "event");
        if (first.kind !== "event") throw new Error("unreachable");
        assert.equal(first.event.type, "attempt.completed");
        assert.equal(first.event.sequence, 4);
        const second = await fixture.harness.step({
          ...request,
          backendCursor: cursor,
        });
        assert.deepEqual(
          JSON.parse(JSON.stringify(second)) as HarnessDelivery,
          JSON.parse(JSON.stringify(first)) as HarnessDelivery,
        );
      },
    ),
  );

  cases.push(
    createCase(
      config,
      "cancel and reconcile",
      "reconciling without a cursor reports a retryable orphaned turn",
      async (fixture) => {
        const request = conformanceRequest("scout", {
          attemptId: "attempt-reconcile-orphan",
          mode: "reconcile",
        });
        const first = await fixture.harness.step(request);
        assert.equal(first.kind, "event");
        if (first.kind !== "event") throw new Error("unreachable");
        assert.equal(first.event.type, "attempt.failed_infra");
        if (first.event.type !== "attempt.failed_infra")
          throw new Error("unreachable");
        assert.equal(first.event.code, "orphaned_turn");
        assert.equal(first.event.retryable, true);
        const second = await fixture.harness.step(request);
        assert.equal(
          JSON.stringify(second),
          JSON.stringify(first),
          "repeated orphan reconcile is not deterministic",
        );
      },
    ),
  );

  if (config.reconcileInFlight === "orphan") {
    cases.push(
      createCase(
        config,
        "cancel and reconcile",
        "reconciling a persisted in-flight cursor without recoverable history is a deterministic orphan",
        async (fixture) => {
          const request = conformanceRequest("scout", {
            attemptId: "attempt-reconcile-inflight",
            mode: "reconcile",
          });
          const cursor = fixture.driver.mintCursor({
            ref: "conformance-inflight:conformance-inflight",
            nextSequence: 2,
            usage: { inputTokens: 0 },
          });
          const reconciled = await fixture.harness.step({
            ...request,
            backendCursor: cursor,
          });
          assert.equal(reconciled.kind, "event");
          if (reconciled.kind !== "event") throw new Error("unreachable");
          assert.equal(reconciled.event.type, "attempt.failed_infra");
          if (reconciled.event.type !== "attempt.failed_infra")
            throw new Error("unreachable");
          assert.equal(reconciled.event.code, "orphaned_turn");
          assert.equal(reconciled.event.retryable, true);
          const repeat = await fixture.harness.step({
            ...request,
            backendCursor: cursor,
          });
          assert.equal(JSON.stringify(repeat), JSON.stringify(reconciled));
        },
      ),
    );
  }

  if (config.reconcileInFlight === "history") {
    cases.push(
      createCase(
        config,
        "cancel and reconcile",
        "reconciling a persisted in-flight cursor recovers the authoritative completed history",
        async (fixture) => {
          const request = conformanceRequest("scout", {
            attemptId: "attempt-reconcile-inflight",
            mode: "reconcile",
          });
          const cursor = fixture.driver.mintCursor({
            ref: "conformance-inflight:conformance-inflight",
            nextSequence: 2,
            usage: { inputTokens: 900, outputTokens: 70, reasoningTokens: 30 },
            recoveredCompletedTurn: true,
          });
          const output = await fixture.harness.step({
            ...request,
            backendCursor: cursor,
          });
          assert.equal(output.kind, "event");
          if (output.kind !== "event") throw new Error("unreachable");
          assert.equal(output.event.type, "attempt.output");
          assert.equal(output.event.sequence, 2);
          assert.equal(output.event.output.kind, "scout");
          // Re-reconciling the same persisted in-flight cursor replays the
          // same normalized recovery, byte for byte.
          const repeatOutput = await fixture.harness.step({
            ...request,
            backendCursor: cursor,
          });
          assert.equal(
            JSON.stringify(repeatOutput),
            JSON.stringify(output),
            "repeated in-flight reconcile is not deterministic",
          );
          const completed = await fixture.harness.step({
            ...request,
            backendCursor: output.nextCursor,
          });
          assert.equal(completed.kind, "event");
          if (completed.kind !== "event") throw new Error("unreachable");
          assert.equal(completed.event.type, "attempt.completed");
          assert.equal(completed.event.sequence, 3);
          const repeatCompleted = await fixture.harness.step({
            ...request,
            backendCursor: output.nextCursor,
          });
          assert.equal(
            JSON.stringify(repeatCompleted),
            JSON.stringify(completed),
            "repeated completion reconcile is not deterministic",
          );
        },
      ),
    );
  }

  // ---- workspace safety ------------------------------------------------------

  cases.push(
    createCase(
      config,
      "workspace safety",
      "a scout turn leaves the checkout and the source untouched",
      async (fixture) => {
        const headBefore = await sourceHead(fixture.sourceRoot);
        fixture.driver.scriptSuccessfulTurn("scout", { usage: scriptedUsage });
        const { events } = await collect(
          fixture.harness,
          conformanceRequest("scout", { attemptId: "attempt-scout-clean" }),
        );
        assertTerminal(events);
        assert.equal(
          await git(["status", "--porcelain"], fixture.workspace.path),
          "",
          "checkout is dirty after a read-only scout turn",
        );
        await assertSourceUntouched(fixture, headBefore);
      },
    ),
  );

  cases.push(
    createCase(
      config,
      "workspace safety",
      "an implement turn lands exactly one commit on the task branch",
      async (fixture) => {
        const headBefore = await sourceHead(fixture.sourceRoot);
        fixture.driver.scriptSuccessfulTurn("implement", {
          usage: scriptedUsage,
          mutateWorkspace: true,
        });
        const { events } = await collect(
          fixture.harness,
          conformanceRequest("implement", { attemptId: "attempt-implement" }),
        );
        assertTerminal(events);
        const output = events.find(
          (event): event is Extract<HarnessEvent, { type: "attempt.output" }> =>
            event.type === "attempt.output",
        );
        assert.ok(output !== undefined, "expected an implement output");
        assert.ok(output.output.kind === "implement");
        if (output.output.kind !== "implement") throw new Error("unreachable");
        assert.match(output.output.commitSha, /^[0-9a-f]{40}$/);
        assert.equal(
          await git(
            [
              "rev-list",
              "--count",
              `${fixture.workspace.baseCommit}..refs/heads/${fixture.workspace.branch}`,
            ],
            fixture.workspace.path,
          ),
          "1",
        );
        assert.equal(
          await git(["status", "--porcelain"], fixture.workspace.path),
          "",
          "checkout is dirty after the trusted commit",
        );
        await assertSourceUntouched(fixture, headBefore);
      },
    ),
  );

  cases.push(
    createCase(
      config,
      "workspace safety",
      "a review turn that mutates the checkout fails closed",
      async (fixture) => {
        fixture.driver.scriptSuccessfulTurn("implement", {
          usage: scriptedUsage,
          mutateWorkspace: true,
        });
        const implement = await collect(
          fixture.harness,
          conformanceRequest("implement", { attemptId: "attempt-impl-review" }),
        );
        const implementOutput = implement.events.find(
          (event): event is Extract<HarnessEvent, { type: "attempt.output" }> =>
            event.type === "attempt.output",
        );
        assert.ok(
          implementOutput !== undefined &&
            implementOutput.output.kind === "implement",
        );
        if (
          implementOutput === undefined ||
          implementOutput.output.kind !== "implement"
        ) {
          throw new Error("unreachable");
        }

        fixture.driver.scriptSuccessfulTurn("review", {
          mutateWorkspace: true,
        });
        const { events } = await collect(
          fixture.harness,
          conformanceRequest("review", {
            attemptId: "attempt-review-mutated",
            implementation: { commitSha: implementOutput.output.commitSha },
            baseCommit: fixture.workspace.baseCommit,
          }),
        );
        assertTerminal(events);
        const types = events.map((event) => event.type);
        assert.ok(!types.includes("attempt.output"));
        assert.ok(!types.includes("attempt.completed"));
        const failure = events.at(-1);
        assert.ok(failure?.type === "attempt.failed_infra");
        if (failure.type !== "attempt.failed_infra")
          throw new Error("unreachable");
        // The specific failure code and retryability are backend vocabulary
        // (the workspace guard may reject at the commit invariant or the
        // status compare); the shared invariant is failing closed without
        // any output.
      },
    ),
  );

  // ---- attribution -------------------------------------------------------------

  cases.push(
    createCase(
      config,
      "attribution",
      "every dispatched turn carries the attempt's model and effort",
      async (fixture) => {
        const turns: ConformanceRole[] = ["scout", "implement", "review"];
        let implementation: { commitSha: string } | undefined;
        for (const [index, role] of turns.entries()) {
          fixture.driver.scriptSuccessfulTurn(role, {
            usage: scriptedUsage,
            mutateWorkspace: role === "implement",
          });
          const { events } = await collect(
            fixture.harness,
            conformanceRequest(role, {
              attemptId: `attempt-attribution-${index}`,
              implementation,
              baseCommit: fixture.workspace.baseCommit,
            }),
          );
          assertTerminal(events);
          if (role === "implement") {
            const output = events.find(
              (
                event,
              ): event is Extract<HarnessEvent, { type: "attempt.output" }> =>
                event.type === "attempt.output",
            );
            assert.ok(
              output !== undefined && output.output.kind === "implement",
            );
            if (output === undefined || output.output.kind !== "implement") {
              throw new Error("unreachable");
            }
            implementation = { commitSha: output.output.commitSha };
          }
        }
        const starts = fixture.driver.roleStartRequests();
        for (const role of turns) {
          const observed = starts.filter((entry) => entry.role === role);
          assert.equal(observed.length, 1, `expected one ${role} start`);
          const start = observed[0];
          assert.ok(start !== undefined);
          assert.equal(
            start.model,
            roleAttempts[role].model,
            `${role} dispatched the wrong model`,
          );
          assert.equal(
            start.effort,
            roleAttempts[role].effort,
            `${role} dispatched the wrong effort`,
          );
        }
      },
    ),
  );

  return cases;
}
