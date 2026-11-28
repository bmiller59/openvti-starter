// Time and identifiers, injected so the client is deterministic under test.
//
// Every instant the client writes into a document goes through `iso()`: whole
// seconds, `YYYY-MM-DDTHH:MM:SSZ`. Never `toISOString()` (it carries
// milliseconds) and never the system time formatted directly.

import { randomUUID } from "node:crypto";

/** An instant as documents write it: whole seconds, `YYYY-MM-DDTHH:MM:SSZ`. */
export function iso(ms: number): string {
  if (ms % 1000 !== 0) throw new Error("instants are whole seconds");
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}T${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}Z`;
}

export interface Clock {
  /** Now, in milliseconds since the epoch: used for checks (freshness, `useUntil`, waits). */
  now(): number;
  /** The `issuedAt` of a document being issued now, whole seconds. */
  issue(): string;
  /** Wait `seconds` (a resubmission's `retryAfter`). */
  sleep(seconds: number): Promise<void>;
}

/** The system clock, truncated to whole seconds when it stamps a document. */
export const systemClock: Clock = {
  now: () => Date.now(),
  issue: () => iso(Math.floor(Date.now() / 1000) * 1000),
  sleep: (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
};

/** Mints a document or payload identifier. */
export type NewId = () => string;

/** A random `urn:uuid` (RFC 9562 version 4). */
export const randomId: NewId = () => `urn:uuid:${randomUUID()}`;
