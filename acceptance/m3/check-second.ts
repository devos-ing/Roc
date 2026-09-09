import assert from "node:assert/strict";
import { second } from "./second";

assert.equal(second(1), 2);
assert.equal(second(-1), -2);
assert.equal(second(0), 0);
