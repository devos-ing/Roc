import { expect, test } from "bun:test";
import { classifyCodexTurnFailure } from "../../src/codex/protocol";

test("classifies representative Codex turn failures without exposing provider text", () => {
  expect(
    classifyCodexTurnFailure("failed", {
      message: "token abc-secret was rejected",
      codexErrorInfo: "unauthorized",
    }),
  ).toEqual({
    code: "authentication_failed",
    category: "infra",
    retryable: false,
    message: "Codex authentication failed",
  });
  expect(
    classifyCodexTurnFailure("failed", {
      message: "model gpt-next was not found",
      codexErrorInfo: "badRequest",
    }),
  ).toMatchObject({ code: "model_unavailable", retryable: true });
  expect(
    classifyCodexTurnFailure("failed", {
      message: "policy detail",
      codexErrorInfo: "cyberPolicy",
    }),
  ).toMatchObject({
    code: "policy_denied",
    category: "policy",
    retryable: false,
  });
  expect(
    classifyCodexTurnFailure("failed", {
      message: "overloaded",
      codexErrorInfo: "serverOverloaded",
    }),
  ).toMatchObject({ code: "backend_unavailable", retryable: true });
  expect(
    classifyCodexTurnFailure("failed", {
      message: "bad input",
      codexErrorInfo: "badRequest",
    }),
  ).toMatchObject({ code: "invalid_request", retryable: false });
  expect(classifyCodexTurnFailure("interrupted", null)).toMatchObject({
    code: "turn_interrupted",
    retryable: true,
  });
});
