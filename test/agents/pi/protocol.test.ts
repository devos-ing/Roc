import { describe, expect, test } from "bun:test";
import {
  classifyPiTurnFailure,
  mapPiUsage,
  PiBackendCursorSchema,
} from "../../../src/agents/pi/protocol";

describe("classifyPiTurnFailure", () => {
  test("classifies aborted turns as retryable infra failures", () => {
    expect(classifyPiTurnFailure("aborted", undefined)).toMatchObject({
      code: "turn_interrupted",
      category: "infra",
      retryable: true,
    });
  });

  test("classifies length stops as non-retryable protocol failure", () => {
    expect(classifyPiTurnFailure("length", undefined)).toMatchObject({
      code: "context_window_exceeded",
      category: "protocol",
      retryable: false,
    });
  });

  test("classifies error stops with authentication text as non-retryable", () => {
    expect(
      classifyPiTurnFailure("error", "request unauthorized (401)"),
    ).toMatchObject({
      code: "authentication_failed",
      category: "infra",
      retryable: false,
    });
  });

  test("classifies error stops with rate limit text as retryable", () => {
    expect(classifyPiTurnFailure("error", "rate limit hit")).toMatchObject({
      code: "backend_unavailable",
      category: "infra",
      retryable: true,
    });
  });

  test("falls back to a retryable generic turn failure", () => {
    expect(classifyPiTurnFailure("error", undefined)).toMatchObject({
      code: "turn_failed",
      category: "infra",
      retryable: true,
    });
  });
});

describe("mapPiUsage", () => {
  test("folds cache reads and writes into the prompt total", () => {
    expect(
      mapPiUsage({
        input: 1000,
        output: 50,
        cacheRead: 400,
        cacheWrite: 10,
        reasoning: 20,
      }),
    ).toEqual({
      inputTokens: 1410,
      cachedInputTokens: 400,
      outputTokens: 50,
      reasoningOutputTokens: 20,
    });
  });

  test("tolerates missing optional fields", () => {
    expect(mapPiUsage({ input: 10, output: 5 })).toEqual({
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 5,
      reasoningOutputTokens: 0,
    });
  });

  test("keeps a fully cached prompt a non-zero input total", () => {
    expect(mapPiUsage({ input: 0, output: 40, cacheRead: 150 })).toEqual({
      inputTokens: 150,
      cachedInputTokens: 150,
      outputTokens: 40,
      reasoningOutputTokens: 0,
    });
  });

  test("counts cache writes as prompt input and clamps reasoning only", () => {
    expect(
      mapPiUsage({ input: 100, output: 40, cacheWrite: 60, reasoning: 60 }),
    ).toEqual({
      inputTokens: 160,
      cachedInputTokens: 0,
      outputTokens: 40,
      reasoningOutputTokens: 40,
    });
  });
});

describe("PiBackendCursorSchema", () => {
  const base = {
    version: 1,
    nextSequence: 1,
    sessionId: "sess-1",
    sessionFile: "/tmp/pi/sess-1.jsonl",
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
  };

  test("accepts a minimal cursor and optional durable markers", () => {
    expect(PiBackendCursorSchema.safeParse(base).success).toBe(true);
    expect(
      PiBackendCursorSchema.safeParse({
        ...base,
        entryAnchor: "entry-7",
        outputDelivered: true,
        reviewStatusBefore: "",
      }).success,
    ).toBe(true);
  });

  test("rejects cursors with unknown or mistyped fields", () => {
    expect(
      PiBackendCursorSchema.safeParse({ ...base, extra: true }).success,
    ).toBe(false);
    expect(
      PiBackendCursorSchema.safeParse({ ...base, sessionId: "" }).success,
    ).toBe(false);
    expect(
      PiBackendCursorSchema.safeParse({ ...base, usage: null }).success,
    ).toBe(false);
  });
});
