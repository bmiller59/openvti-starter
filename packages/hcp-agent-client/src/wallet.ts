// What the client holds under each grant: the grant, every token issued under
// it, and the copies of context disclosed under it, each with its `useUntil`.
//
// Tokens never leave this module except to the client that builds documents
// (`tokenFor`). Every view handed out (`view`, `list`) carries no token.

import type { HcpGrantsRequest_v0_1 } from "./trust-tasks/index.js";

export type GrantObject = HcpGrantsRequest_v0_1.Response["grant"];

/** A copy of one disclosed entry, as the client keeps it. */
export interface Copy {
  ref: string;
  /** The entry's text, when its content carries a string `value`. */
  text?: string;
  categories: string[];
  /** The latest instant the client may use the copy: the provider's `useUntil`, capped (see `client.ts`). */
  useUntil: string;
  purpose: string;
  retrievalId: string;
}

interface Held {
  grantId: string;
  threadId: string;
  grant: GrantObject;
  tokenExpiresAt: string;
  /** Every token issued under the grant, oldest first. All stay valid until the grant ends. */
  tokens: string[];
  copies: Copy[];
  /** The directives the last query returned, for the host to apply in code (HCP 6.4, 10.5). */
  directives: unknown[];
}

/** A grant as code outside the client may see it: no token. */
export interface GrantView {
  grantId: string;
  threadId: string;
  grant: GrantObject;
  tokenExpiresAt: string;
  /** How many tokens the client holds under the grant (never the tokens). */
  tokenCount: number;
  copies: readonly Copy[];
  directives: readonly unknown[];
}

export class Wallet {
  private readonly held = new Map<string, Held>();

  /** Record a token issued under `grant` (a first grant response, or a resubmission's new token). */
  addToken(threadId: string, grant: GrantObject, token: string, tokenExpiresAt: string): void {
    const existing = this.held.get(grant.grantId);
    if (existing === undefined) {
      this.held.set(grant.grantId, { grantId: grant.grantId, threadId, grant, tokenExpiresAt, tokens: [token], copies: [], directives: [] });
      return;
    }
    existing.grant = grant;
    existing.tokenExpiresAt = tokenExpiresAt;
    if (!existing.tokens.includes(token)) existing.tokens.push(token);
  }

  has(grantId: string): boolean {
    return this.held.has(grantId);
  }

  /** The token the client presents under `grantId`: the newest one. */
  tokenFor(grantId: string): string | undefined {
    const h = this.held.get(grantId);
    return h?.tokens[h.tokens.length - 1];
  }

  /** Every token held, across grants: what a tool's output is checked against. */
  allTokens(): string[] {
    return [...this.held.values()].flatMap((h) => h.tokens);
  }

  addCopies(grantId: string, copies: Copy[], directives: unknown[]): void {
    const h = this.held.get(grantId);
    if (h === undefined) return;
    h.copies.push(...copies);
    h.directives = directives;
  }

  /**
   * Stop using a grant: drop its tokens and every copy disclosed under it
   * (HCP 6.2.2, 7.6). Returns whether the client held it.
   */
  forget(grantId: string): boolean {
    return this.held.delete(grantId);
  }

  /** Drop every copy whose `useUntil` has passed (HCP 7.6). Returns how many were dropped. */
  purgeExpired(nowMs: number): number {
    let dropped = 0;
    for (const h of this.held.values()) {
      const keep = h.copies.filter((c) => Date.parse(c.useUntil) > nowMs);
      dropped += h.copies.length - keep.length;
      h.copies = keep;
    }
    return dropped;
  }

  view(grantId: string): GrantView | undefined {
    const h = this.held.get(grantId);
    if (h === undefined) return undefined;
    return {
      grantId: h.grantId,
      threadId: h.threadId,
      grant: h.grant,
      tokenExpiresAt: h.tokenExpiresAt,
      tokenCount: h.tokens.length,
      copies: [...h.copies],
      directives: [...h.directives],
    };
  }

  list(): GrantView[] {
    return [...this.held.keys()].map((id) => this.view(id)!);
  }
}
