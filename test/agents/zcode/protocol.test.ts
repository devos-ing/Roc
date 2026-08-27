import { describe, expect, test } from "bun:test";
import {
  classifyZcodeTurnFailure,
  mapZcodeUsage,
} from "../../../src/agents/zcode/protocol";

describe("classifyZcodeTurnFailure", () => {
  test("classifies interrupted turns as retryable infra failures", () => {
    expect(classifyZcodeTurnFailure("interrupted", undefined)).toMatchObject({
      code: "turn_interrupted",
      category: "infra",
      retryable: true,
    });
  });

  test("classifies authentication text as non-retryable", () => {
    expect(
      classifyZcodeTurnFailure("failed", "request unauthorized (401)"),
    ).toMatchObject({
      code: "authentication_failed",
      category: "infra",
      retryable: false,
    });
  });

  test("classifies context window text as non-retryable protocol failure", () => {
    expect(
      classifyZcodeTurnFailure("failed", "context window exceeded"),
    ).toMatchObject({
      code: "context_window_exceeded",
      category: "protocol",
      retryable: false,
    });
  });

  test("classifies rate limiting as retryable backend unavailability", () => {
    expect(classifyZcodeTurnFailure("failed", "rate limit hit")).toMatchObject({
      code: "backend_unavailable",
      category: "infra",
      retryable: true,
    });
  });

  test("falls back to a retryable generic turn failure", () => {
    expect(classifyZcodeTurnFailure("failed", undefined)).toMatchObject({
      code: "turn_failed",
      category: "infra",
      retryable: true,
    });
  });
});

describe("mapZcodeUsage", () => {
  test("maps native fields and clamps cached and reasoning totals", () => {
    expect(
      mapZcodeUsage({
        inputTokens: 1000,
        outputTokens: 50,
        reasoningTokens: 20,
        cacheReadTokens: 400,
        cacheWriteTokens: 10,
      }),
    ).toEqual({
      inputTokens: 1000,
      cachedInputTokens: 400,
      outputTokens: 50,
      reasoningOutputTokens: 20,
    });
  });

  test("tolerates missing optional fields", () => {
    expect(mapZcodeUsage({ inputTokens: 10, outputTokens: 5 })).toEqual({
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 5,
      reasoningOutputTokens: 0,
    });
  });
});
