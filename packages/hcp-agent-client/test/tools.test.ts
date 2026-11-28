// The tool layer (HCP 10.5): a model gets the person's context through tools,
// and never the access token, in a definition, a result or an error.

import assert from "node:assert/strict";
import { test } from "node:test";

import { ContextTools, NO_ACCESS, toMcpResult, type ContextToolSpec, type HcpAgentClient } from "../src/index.js";
import { ASK, PURPOSE, harness, stepRevoke } from "./harness.js";

const TRAVEL: ContextToolSpec = {
  name: "get_travel_preferences",
  description: "The user's travel preferences, as they shared them.",
  categories: ["travel_preferences"],
  purpose: PURPOSE,
};
const HEALTH: ContextToolSpec = { name: "get_health_context", description: "Health context.", categories: ["health_context"], purpose: PURPOSE };

/** Every token the reference provider mints starts with this; none may reach a model. */
const TOKEN_PREFIX = "hcp_at_";

async function setup(applyDirectives?: ConstructorParameters<typeof ContextTools>[1]["applyDirectives"]) {
  const h = harness();
  const out = await h.client.requestGrant(ASK, { onHeld: ({ threadId }) => h.world.personApproves(threadId) });
  if (out.kind !== "granted") throw new Error(out.kind);
  await h.client.resubmit(out.threadId); // a second token under the grant
  const tools = new ContextTools(h.client, { tools: [TRAVEL, HEALTH], ...(applyDirectives ? { applyDirectives } : {}) });
  return { ...h, tools, grantId: out.grantId };
}

test("a tool returns the disclosed entries, in order, with purpose and useUntil, and no token", async () => {
  const { tools, sent } = await setup();
  const result = await tools.call("get_travel_preferences", { question: "How does the user like to fly?" });
  assert.equal(result.isError, false);
  assert.deepEqual(
    result.entries.map((e) => e.text),
    ["Prefers aisle seats and early-morning flights.", "Avoids overnight layovers."],
  );
  assert.equal(result.purpose, PURPOSE);
  assert.match(result.text, /use until 2026-11-25T\d\d:\d\d:\d\dZ/);
  assert.ok(!JSON.stringify(result).includes(TOKEN_PREFIX));
  assert.ok(!JSON.stringify(toMcpResult(result)).includes(TOKEN_PREFIX));
  // The token was presented, by the client, in the document it built.
  assert.ok(String((sent.at(-1)!.payload as { accessToken: string }).accessToken).startsWith(TOKEN_PREFIX));
});

test("tool definitions carry no token and no grant identifier", async () => {
  const { tools, grantId } = await setup();
  const defs = JSON.stringify(tools.definitions());
  assert.ok(!defs.includes(TOKEN_PREFIX));
  assert.ok(!defs.includes(grantId));
});

test("a tool outside the grant answers no access, without querying", async () => {
  const { tools, sent } = await setup();
  const before = sent.length;
  const result = await tools.call("get_health_context", { question: "Any allergies?" });
  assert.deepEqual([result.isError, result.text], [true, NO_ACCESS]);
  assert.equal(sent.length, before);
});

test("after revocation a tool answers no access, and the refusal carries no token", async () => {
  const { tools, world, grantId } = await setup();
  await stepRevoke(world, grantId);
  const first = await tools.call("get_travel_preferences", { question: "Seat?" }); // hcp:invalidToken: the client forgets the grant
  const second = await tools.call("get_travel_preferences", { question: "Seat?" });
  for (const r of [first, second]) {
    assert.deepEqual([r.isError, r.text], [true, NO_ACCESS]);
    assert.ok(!JSON.stringify(r).includes(TOKEN_PREFIX));
  }
});

test("directives are applied in code: a deny stops the result, and the directives never reach the model", async () => {
  const seen: unknown[][] = [];
  const { tools } = await setup((directives) => {
    seen.push([...directives]);
    return { allow: false, reason: "sharing is off" };
  });
  const result = await tools.call("get_travel_preferences", { question: "Seat?" });
  assert.equal(result.isError, true);
  assert.deepEqual(result.entries, []);
  assert.deepEqual(seen, [[]]);
});

test("the last guard: a result that would contain a held token is withheld", async () => {
  const token = "hcp_at_fake_token";
  const stub = {
    purgeExpired: () => 0,
    grants: () => [{ grantId: "g", grant: { status: "active", access: [{ actions: ["read"], categories: ["travel_preferences"], purposes: [{ code: PURPOSE }] }] } }],
    query: async () => ({ kind: "entries", grantId: "g", purpose: PURPOSE, retrievalId: "r", entries: [{ ref: "x", text: `leaked ${token}`, categories: ["travel_preferences"], useUntil: "2026-11-25T11:00:00Z" }], categoriesSearched: [], minimization: {}, directives: [] }),
    containsToken: (s: string) => s.includes(token),
  } as unknown as HcpAgentClient;
  const result = await new ContextTools(stub, { tools: [TRAVEL] }).call("get_travel_preferences", { question: "?" });
  assert.equal(result.isError, true);
  assert.ok(!JSON.stringify(result).includes(token));
});

test("a bad tool call is the caller's error, not a query", async () => {
  const { tools } = await setup();
  await assert.rejects(tools.call("nope", { question: "?" }), /no tool/);
  await assert.rejects(tools.call("get_travel_preferences", {}), /needs a question/);
});
