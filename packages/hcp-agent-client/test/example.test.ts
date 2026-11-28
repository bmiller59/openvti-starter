// The example in examples/walkthrough.ts runs, so it cannot fall behind the API.

import assert from "node:assert/strict";
import { test } from "node:test";

import { NO_ACCESS } from "../src/index.js";
import { walkthrough } from "../examples/walkthrough.js";

test("the walkthrough example: identity, a held grant, a tool call, a notice through the receive loop", async () => {
  const { lines, before, after } = await walkthrough();
  assert.match(before, /Prefers aisle seats and early-morning flights\./);
  assert.ok(!before.includes("hcp_at_"), "the model never sees a token");
  assert.equal(after, NO_ACCESS);
  assert.ok(lines.some((l) => l.startsWith("receive loop stopped (deadline): 1 delivered, 0 dropped")));
});
