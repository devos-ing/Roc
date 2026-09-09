import assert from "node:assert/strict";
import { first } from "./first";

assert.equal(first(1), 2);
assert.equal(first(-1), 0);
assert.equal(first(0), 1);
