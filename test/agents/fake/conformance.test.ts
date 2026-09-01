import { describe, test } from "bun:test";
import { createFakeHarness } from "../../../src/harness/fake";
import type { ConformanceRole, ScriptedUsage } from "../conformance";
import {
  defineNormalizedConformance,
  type NormalizedConformanceFixture,
  type NormalizedUsageTotals,
  normalizedUsage,
  type ProtocolDriver,
  roleAttempts,
  roleOutputs,
} from "../conformance";

/**
 * Runs the shared normalized-event conformance suite against the in-memory
 * fake harness, per docs/research/fake-codex-harness-options.md ("Fake 與
 * adapter 共用同一 normalized-event conformance suite"). The fake cursor is a
 * deliberately non-JSON opaque token resolved through a driver-side table —
 * proof that the suite never decodes backend cursors itself. Model/effort
 * conformance is enforced structurally by the fake harness's own `expect`
 * checks, not by dispatch observation.
 */

const FAKE_NOW = "2026-08-31T00:00:00.000Z";

class FakeProtocolDriver implements ProtocolDriver {
  private readonly cursorRecords = new Map<string, FakeCursorRecord>();
  private cursorCounter = 0;

  constructor(
    private readonly scripting: { scriptAttempt(attempt: unknown): void },
  ) {}

  peekNextRef(role: ConformanceRole): string {
    return `fake:${role}`;
  }

  scriptSuccessfulTurn(
    role: ConformanceRole,
    options?: {
      usage?: ScriptedUsage;
      mutateWorkspace?: boolean;
      invalidOutput?: boolean;
    },
  ): string {
    const usage = normalizedUsage(options?.usage);
    const deliveries: { nextCursor: string; event: unknown }[] = [];
    const emit = (event: Record<string, unknown>): void => {
      deliveries.push({
        nextCursor: this.mintCursorValue(deliveries.length + 2, usage),
        event: {
          ...event,
          attemptId: "conformance",
          sequence: deliveries.length + 1,
          occurredAt: FAKE_NOW,
        },
      });
    };
    emit({ type: "attempt.started", eventId: `T1:${role}:0:started` });
    const hasUsage =
      usage.inputTokens > 0 ||
      usage.cachedInputTokens > 0 ||
      usage.outputTokens > 0 ||
      usage.reasoningOutputTokens > 0;
    if (hasUsage) {
      emit({
        type: "attempt.usage_delta",
        eventId: `T1:${role}:0:usage`,
        ...usage,
      });
    }
    if (options?.invalidOutput === true) {
      emit({
        type: "attempt.failed_infra",
        eventId: `T1:${role}:0:failed`,
        code: "invalid_structured_output",
        message: "scripted invalid structured output",
        retryable: true,
      });
    } else {
      const output =
        role === "implement"
          ? { ...roleOutputs.implement, commitSha: "c".repeat(40) }
          : roleOutputs[role];
      emit({
        type: "attempt.output",
        eventId: `T1:${role}:0:output`,
        output,
      });
      emit({ type: "attempt.completed", eventId: `T1:${role}:0:completed` });
    }
    this.scripting.scriptAttempt({
      taskId: "T1",
      role,
      retryIndex: 0,
      expect: {
        model: roleAttempts[role].model,
        effort: roleAttempts[role].effort,
      },
      deliveries,
    });
    return this.peekNextRef(role);
  }

  scriptInteractionRequest(): void {
    // Approval handling is an adapter-level case; the fake has no server
    // channel to reject, so there is nothing to script.
  }

  scriptForeignTurnNotification(): void {
    // The fake drains by construction — a new script replaces the previous
    // deliveries, so a stale ref cannot leak into the next attempt.
  }

  mintCursor(input: {
    ref: string;
    nextSequence?: number;
    usage?: ScriptedUsage;
    outputDelivered?: boolean;
    recoveredCompletedTurn?: boolean;
  }): string {
    return this.mintCursorValue(
      input.nextSequence ?? 2,
      normalizedUsage(input.usage),
    );
  }

  roleStartRequests(): never[] {
    // The fake harness enforces model/effort through its `expect` checks on
    // every step; there is no dispatch channel to observe separately.
    return [];
  }

  interactionRejections(): number {
    return 0;
  }

  interruptionRequestCount(): number {
    return 0;
  }

  cursorNextSequence(cursor: string): number {
    const record = this.cursorRecords.get(cursor);
    if (record === undefined) {
      throw new Error(`unknown fake cursor: ${cursor}`);
    }
    return record.nextSequence;
  }

  cursorUsage(cursor: string): NormalizedUsageTotals {
    const record = this.cursorRecords.get(cursor);
    if (record === undefined) {
      throw new Error(`unknown fake cursor: ${cursor}`);
    }
    return record.usage;
  }

  private mintCursorValue(
    nextSequence: number,
    usage: NormalizedUsageTotals,
  ): string {
    this.cursorCounter += 1;
    const cursor = `fake-cursor-${this.cursorCounter}`;
    this.cursorRecords.set(cursor, { nextSequence, usage });
    return cursor;
  }
}

type FakeCursorRecord = {
  nextSequence: number;
  usage: NormalizedUsageTotals;
};

async function createFixture(): Promise<NormalizedConformanceFixture> {
  // The baseline script covers cases that dispatch without scripting first
  // (redispatch); its cursor only needs to locate the delivery, never decode.
  const fake = createFakeHarness({
    attempts: [
      {
        taskId: "T1",
        role: "scout" as const,
        retryIndex: 0 as const,
        expect: {
          model: roleAttempts.scout.model,
          effort: roleAttempts.scout.effort,
        },
        deliveries: [
          {
            nextCursor: "fake-baseline-1",
            event: {
              type: "attempt.started",
              eventId: "T1:scout:0:started",
              attemptId: "conformance",
              sequence: 1,
              occurredAt: FAKE_NOW,
            },
          },
        ],
      },
    ],
  });
  const driver = new FakeProtocolDriver(fake);
  return {
    harness: fake.harness,
    driver,
    dispose: async () => {},
  };
}

const cases = defineNormalizedConformance({ createFixture });

describe("fake backend conformance", () => {
  for (const group of new Set(cases.map((entry) => entry.group))) {
    describe(group, () => {
      for (const entry of cases.filter((item) => item.group === group)) {
        test(entry.name, () => entry.run());
      }
    });
  }
});
