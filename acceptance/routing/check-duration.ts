import assert from "node:assert/strict";
import { formatDuration } from "./duration";

for (const input of [null, NaN, Infinity, -Infinity])
  assert.equal(formatDuration(input), "Unavailable");
for (const [input, want] of [
  [-100, "0s"],
  [0, "0s"],
  [999, "0s"],
  [1500, "1s"],
  [60000, "1m 0s"],
  [61000, "1m 1s"],
  [3661000, "1h 1m 1s"],
  [90061000, "25h 1m 1s"],
] as const)
  assert.equal(formatDuration(input), want);
