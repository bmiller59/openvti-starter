// The bounded 429 retry used by test:roles (scripts/lib/rate-limit.ts). Fakes only: no VTC, no real sleeping.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TrustTaskError } from "@starter/vta-client";
import { RateLimitBudget, RateLimitExhausted, retryAfterMs, withRateLimitRetry } from "../lib/rate-limit.js";

const limited = (secs?: number) => new TrustTaskError(429, { error: "rate_limited", limiter: "unauth", message: "slow", ...(secs !== undefined ? { retryAfterSecs: secs } : {}) });
const harness = () => { const waits: number[] = []; const logs: string[] = []; return { waits, logs, o: { sleep: async (ms: number) => { waits.push(ms); }, log: (l: string) => { logs.push(l); } } }; };

test("retryAfterMs reads the body's retryAfterSecs, else undefined", () => {
  assert.equal(retryAfterMs(limited(7)), 7000);
  assert.equal(retryAfterMs(limited()), undefined);
  assert.equal(retryAfterMs(new Error("x")), undefined);
});

test("retries on a 429, honours the hint (plus margin), logs it, then succeeds", async () => {
  const h = harness(); const b = new RateLimitBudget(); let calls = 0;
  const r = await withRateLimitRetry("vtc/x/0.1", async () => { if (++calls < 3) throw limited(4); return "ok"; }, b, h.o);
  assert.equal(r, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(h.waits, [4500, 4500]);
  assert.equal(b.retries, 2);
  assert.equal(h.logs.length, 2);
  assert.match(h.logs[0]!, /vtc\/x\/0\.1.*retry after 4s.*retry 1\/3/);
});

test("a 429 without a hint waits the fallback", async () => {
  const h = harness(); let calls = 0;
  await withRateLimitRetry("t", async () => { if (++calls < 2) throw limited(); return 1; }, new RateLimitBudget(), h.o);
  assert.deepEqual(h.waits, [5500]);
});

test("gives up after the retry bound with a clear error (a failure, never a pass)", async () => {
  const h = harness(); let calls = 0;
  await assert.rejects(withRateLimitRetry("vtc/join-requests/status/0.1", async () => { calls++; throw limited(2); }, new RateLimitBudget(), h.o),
    (e: Error) => e instanceof RateLimitExhausted && /rate limited on vtc\/join-requests\/status\/0\.1: still refused after 3 retries/.test(e.message));
  assert.equal(calls, 4, "first try plus three retries");
  assert.equal(h.waits.length, 3);
});

test("gives up when the total wait budget (shared across calls) would be exceeded", async () => {
  const h = harness(); const b = new RateLimitBudget();
  const o = { ...h.o, maxTotalWaitMs: 100_000, maxRetries: 10 };
  await assert.rejects(withRateLimitRetry("t", async () => { throw limited(40); }, b, o), (e: Error) => e instanceof RateLimitExhausted && /total wait budget/.test(e.message));
  assert.deepEqual(h.waits, [40500, 40500]);
  assert.ok(b.spentMs <= 100_000);
  await assert.rejects(withRateLimitRetry("other", async () => { throw limited(40); }, b, o), /total wait budget/, "the budget is shared");
});

test("a single wait is capped", async () => {
  const h = harness(); let calls = 0;
  await withRateLimitRetry("t", async () => { if (++calls < 2) throw limited(900); return 1; }, new RateLimitBudget(), { ...h.o, maxTotalWaitMs: 120_000 });
  assert.deepEqual(h.waits, [60_000]);
});

test("non-429 errors fail at once, without waiting or retrying", async () => {
  for (const err of [new TrustTaskError(403, { payload: { code: "permissionDenied" } }), new TrustTaskError(500, "boom"), new Error("network down"), new TrustTaskError(404, {})]) {
    const h = harness(); let calls = 0;
    await assert.rejects(withRateLimitRetry("t", async () => { calls++; throw err; }, new RateLimitBudget(), h.o), (e) => e === err);
    assert.equal(calls, 1);
    assert.deepEqual(h.waits, []);
  }
});
