import { expect, test } from "bun:test";
import { createModelAdvisor } from "../../src/scheduler/model-routing";

const catalog = [
  { id: "gpt-5.6-luna", supportedReasoningEfforts: ["high"] },
  { id: "gpt-5.6-terra", supportedReasoningEfforts: ["high", "xhigh"] },
  { id: "gpt-5.6-sol", supportedReasoningEfforts: ["high", "xhigh"] },
];

test("resolves profiles to actual models without ever selecting low", () => {
  const advisor = createModelAdvisor(catalog);

  expect(advisor.decide({ role: "scout", risk: "medium", retryIndex: 0 })).toMatchObject({
    profile: "luna",
    model: "gpt-5.6-luna",
    effort: "high",
    fallbacks: ["gpt-5.6-terra", "gpt-5.6-sol"],
  });
  expect(advisor.decide({ role: "scout", risk: "high", retryIndex: 0 })).toMatchObject({
    profile: "terra",
    model: "gpt-5.6-terra",
    effort: "xhigh",
  });
  expect(advisor.decide({
    role: "implement",
    risk: "medium",
    retryIndex: 2,
    priorProfile: "terra",
    priorErrorCode: "backend_unavailable",
  })).toMatchObject({ profile: "sol", model: "gpt-5.6-sol", effort: "high" });
});

test("returns undefined when no model supports the required effort", () => {
  const advisor = createModelAdvisor([
    { id: "gpt-5.6-luna", supportedReasoningEfforts: ["low", "medium"] },
  ]);

  expect(advisor.decide({ role: "scout", risk: "medium", retryIndex: 0 })).toBeUndefined();
});

test("honors exact profile mapping and catalog order for compatible fallbacks", () => {
  const advisor = createModelAdvisor([
    { id: "gpt-5.6-terra-first", supportedReasoningEfforts: ["high"] },
    { id: "codex-model-2", supportedReasoningEfforts: ["high"] },
    { id: "codex-model-3", supportedReasoningEfforts: ["high"] },
  ], {
    terra: "codex-model-2",
    sol: "codex-model-3",
  });

  expect(advisor.decide({ role: "implement", risk: "medium", retryIndex: 0 })).toMatchObject({
    profile: "terra",
    model: "codex-model-2",
    fallbacks: ["codex-model-3"],
  });

  expect(createModelAdvisor([
    { id: "gpt-5.6-terra-first", supportedReasoningEfforts: ["high"] },
    { id: "gpt-5.6-terra-second", supportedReasoningEfforts: ["high"] },
  ]).decide({ role: "implement", risk: "medium", retryIndex: 0 })).toMatchObject({
    model: "gpt-5.6-terra-first",
  });
});
