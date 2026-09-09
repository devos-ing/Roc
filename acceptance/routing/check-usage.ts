import assert from "node:assert/strict";
import { summarizeUsage } from "./usage";

assert.deepEqual(summarizeUsage([]), {
  totalTokens: 0,
  cachedInputTokens: 0,
  incomplete: false,
});
const items = Object.freeze([
  Object.freeze({
    inputTokens: 100,
    cachedInputTokens: 80,
    outputTokens: 20,
    known: true,
  }),
  Object.freeze({
    inputTokens: 50,
    cachedInputTokens: 10,
    outputTokens: 5,
    known: true,
  }),
]);
assert.deepEqual(summarizeUsage(items), {
  totalTokens: 175,
  cachedInputTokens: 90,
  incomplete: false,
});
assert.deepEqual(
  summarizeUsage([
    ...items,
    { inputTokens: 30, cachedInputTokens: 0, outputTokens: 2, known: false },
  ]),
  { totalTokens: 207, cachedInputTokens: 90, incomplete: true },
);
assert.deepEqual(
  summarizeUsage([
    { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, known: false },
  ]),
  { totalTokens: 0, cachedInputTokens: 0, incomplete: true },
);
