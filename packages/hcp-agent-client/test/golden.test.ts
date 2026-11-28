// The shared test vectors: the client, in the Context Client's place, drives
// the reference provider through the eight steps of SCENARIO.md and prints
// exactly the upstream golden transcript. Every document the client builds,
// signs and checks is byte-compatible with the reference Context Client's.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ASK, QUERY, harness, stepRevoke } from "./harness.js";

const here = (p: string) => new URL(p, import.meta.url);

test("the client replays the reference scenario and prints the golden transcript byte for byte", async () => {
  const { world, client, sendNotice } = harness();

  world.step("1. Discover (trust-task-discovery 0.4)");
  const types = await client.discover();
  assert.ok(types.includes("https://trusttasks.org/spec/hcp/grants/request/0.1"));

  world.step("2. Grant request (hcp/grants/request 0.1), held with trust-task-next-step");
  const granted = await client.requestGrant(ASK, { onHeld: ({ threadId }) => world.personApproves(threadId) });
  assert.equal(granted.kind, "granted");
  if (granted.kind !== "granted") return;

  world.step("3. Query (hcp/entries/query 0.1)");
  assert.equal((await client.query(granted.grantId, QUERY)).kind, "entries");

  await stepRevoke(world, granted.grantId);

  world.step("5. Query after revoke (hcp/entries/query 0.1) fails with hcp:invalidToken");
  const refused = await client.query(granted.grantId, QUERY);
  assert.deepEqual(refused.kind === "refused" && [refused.code, refused.grantForgotten], ["hcp:invalidToken", true]);

  world.step("6. Revocation notice (hcp/grants/revoked 0.1)");
  await sendNotice(granted.grantId);

  world.step("7. Grant request declined (hcp/grants/request 0.1): the person says no");
  const declined = await client.requestGrant(ASK, { onHeld: ({ threadId }) => world.personDeclines(threadId) });
  assert.equal(declined.kind === "refused" && declined.code, "permissionDenied");

  world.step("8. Grant request expired (hcp/grants/request 0.1): the hold's lifetime passes");
  const expired = await client.requestGrant(ASK, { onHeld: ({ threadId }) => world.personDoesNotDecide(threadId) });
  assert.equal(expired.kind === "refused" && expired.code, "permissionDenied");
  world.personApproves(expired.threadId); // too late: nothing changes
  const again = await client.resubmit(expired.threadId);
  assert.equal(again.kind === "refused" && again.code, "permissionDenied");
  const fresh = await client.requestGrant(ASK, { maxHoldSeconds: 0 });
  assert.equal(fresh.kind, "held");

  assert.equal(world.transcript.join(""), readFileSync(here("reference/transcript.golden.txt"), "utf8"));
});

test("the vendored reference files are exactly the pinned upstream ones", () => {
  const source = JSON.parse(readFileSync(here("reference/SOURCE.json"), "utf8")) as { files: Record<string, string> };
  for (const [file, sha256] of Object.entries(source.files)) {
    const actual = createHash("sha256").update(readFileSync(here(`reference/${file}`))).digest("hex");
    assert.equal(actual, sha256, `${file} differs from the pinned upstream file`);
  }
});
