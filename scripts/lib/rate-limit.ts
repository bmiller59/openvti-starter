// Bounded retry for a VTC rate-limit refusal, used by test:roles (scripts/test-roles.ts). Pure: sleep and log are injected.
// The VTC answers every limiter refusal with HTTP 429, a `Retry-After` header and the body
// {"error":"rate_limited","limiter":"unauth","message":"...","retryAfterSecs":N} (routing/rate_limit.rs, vtc-service v0.20.0).
// The client surfaces the body (TrustTaskError.body), not the headers, so `retryAfterSecs` is what we read.
// Only a 429 is ever retried; any other error is rethrown at once, and running out of the bound throws a RateLimitExhausted
// (a failure), never a pass.

export interface RateLimitOpts {
  /** Retries per call (default 3). */
  maxRetries?: number;
  /** Total time spent waiting across every call sharing this budget (default 120 s). */
  maxTotalWaitMs?: number;
  /** Wait used when the 429 carries no retry hint (default 5.5 s: the anonymous bucket refills one token per 5 s). */
  fallbackWaitMs?: number;
  /** Added to the server's hint (default 500 ms). */
  marginMs?: number;
  /** One wait never exceeds this (default 60 s). */
  maxSingleWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export class RateLimitExhausted extends Error {
  constructor(message: string) { super(message); this.name = "RateLimitExhausted"; }
}

/** Shared across calls so the total wait is bounded for the whole run. */
export class RateLimitBudget {
  spentMs = 0;
  retries = 0;
}

export function isRateLimited(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { status?: unknown }).status === 429;
}

/** The server's retry hint in ms, from the body's retryAfterSecs (or a retry-after header map when present), else undefined. */
export function retryAfterMs(e: unknown): number | undefined {
  const body = (e as { body?: unknown })?.body as Record<string, unknown> | string | undefined;
  const fromBody = typeof body === "object" && body !== null ? (body.retryAfterSecs ?? (body.payload as any)?.retryAfterSecs) : undefined;
  const n = typeof fromBody === "number" ? fromBody : typeof fromBody === "string" ? Number(fromBody) : NaN;
  return Number.isFinite(n) && n > 0 ? n * 1000 : undefined;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withRateLimitRetry<T>(label: string, fn: () => Promise<T>, budget: RateLimitBudget, opts: RateLimitOpts = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const maxTotal = opts.maxTotalWaitMs ?? 120_000;
  const sleep = opts.sleep ?? realSleep;
  const log = opts.log ?? ((l: string) => console.log(l));
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (e) {
      if (!isRateLimited(e)) throw e;
      const hint = retryAfterMs(e);
      const wait = Math.min(opts.maxSingleWaitMs ?? 60_000, (hint ?? opts.fallbackWaitMs ?? 5_500) + (hint !== undefined ? (opts.marginMs ?? 500) : 0));
      const detail = `${hint !== undefined ? `server says retry after ${hint / 1000}s` : "no retry hint"}`;
      if (attempt >= maxRetries) {
        throw new RateLimitExhausted(`rate limited on ${label}: still refused after ${maxRetries} retries (${budget.spentMs / 1000}s waited in total; ${detail}). The pacing is too fast for this VTC, or its admission budget is spent: wait a minute and re-run.`);
      }
      if (budget.spentMs + wait > maxTotal) {
        throw new RateLimitExhausted(`rate limited on ${label}: the ${maxTotal / 1000}s total wait budget would be exceeded (${budget.spentMs / 1000}s used, next wait ${wait / 1000}s; ${detail}).`);
      }
      budget.spentMs += wait;
      budget.retries++;
      log(`  rate limited on ${label} (${detail}); waiting ${(wait / 1000).toFixed(1)}s, retry ${attempt + 1}/${maxRetries} (${(budget.spentMs / 1000).toFixed(0)}s of ${maxTotal / 1000}s used)`);
      await sleep(wait);
    }
  }
}
