// Carrying the client's messages through the agent's mediator, and the loop
// that receives what the provider pushes.
//
// The client seals every document as a Direct TSP 1.0 message to the provider
// (`@openvtc/trust-tasks-tsp`). A mediator only forwards what is addressed to
// it, so on the way out each Direct message is wrapped in a Routed message to
// the mediator with the provider as the remaining hop, as `@starter/tsp-client`
// does with `packRouted`. On the way in, a frame is either the provider's
// Direct message as the mediator delivered it (what mediator 0.48 does), or
// the same message wrapped by the mediator in a Nested message (or a Routed
// one with no hops left); it is unwrapped to the provider's Direct message
// before anything reads it.
//
// The socket itself is a seam (`MediatorLink`): login, the WebSocket and
// reconnects belong to whatever opens it (for example `@openvtc/pnm-core`).
// Nothing here waits without a bound: every wait has a timeout, failures back
// off, and the loop stops on a signal, a deadline, or too many failures in a
// row.

import { decodeEnvelope, nextHop, packInvite, packRouted, unpack, type PackKeys } from "@openvtc/vti-tsp-js";
import { unpackTrustTask } from "@openvtc/trust-tasks-tsp";

import { systemClock, type Clock } from "./clock.js";
import type { AgentIdentity, PeerKeys } from "./identity.js";
import type { Carrier, CarrierContext } from "./transport.js";

/** The agent's connection to its mediator: one frame out, one frame in. */
export interface MediatorLink {
  /** Send one frame to the mediator. */
  send(frame: Uint8Array): Promise<void>;
  /** The next inbound frame, or `undefined` when none arrives within `timeoutMs`. Must not wait longer. */
  receive(timeoutMs: number): Promise<Uint8Array | undefined>;
}

/** What the loop does with a message the provider pushed (a notice): usually `client.receive`. Returns the reply to send back, if any. */
export type InboundHandler = (direct: Uint8Array) => Promise<Uint8Array | undefined>;

export interface MediatorCarrierOptions {
  identity: AgentIdentity;
  /** The agent's mediator: its VID and TSP public keys. */
  mediator: PeerKeys;
  /** The provider (the person's VTA), reached through the mediator. */
  provider: PeerKeys;
  link: MediatorLink;
  clock?: Clock;
  /** How long a request waits for its reply (default 30 000 ms). */
  replyTimeoutMs?: number;
  /** The longest single `link.receive` wait (default 5 000 ms). */
  pollTimeoutMs?: number;
  /** Pushed messages kept for the loop while it is not running (default 100); the oldest is dropped beyond that. */
  maxInbox?: number;
  /** Called with each inbound frame that was dropped, and why. For logs. */
  onDrop?(reason: string): void;
}

export interface ReceiveLoopOptions {
  /** Handles each pushed message; its result is wrapped and sent back. */
  onInbound: InboundHandler;
  /** Stops the loop. */
  signal?: AbortSignal;
  /** Stop after this many milliseconds (by the carrier's clock). Default: run until the signal. */
  runForMs?: number;
  /** First backoff after a link failure (default 500 ms); doubles up to `maxBackoffMs` (default 30 000 ms). */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Give up after this many link failures in a row (default 5). The loop then rejects with the last error. */
  maxConsecutiveFailures?: number;
}

export interface ReceiveLoopResult {
  /** Why it stopped. */
  stopped: "signal" | "deadline";
  /** Frames handed to `onInbound`. */
  delivered: number;
  /** Frames dropped (unreadable, from someone else, a reply nobody waits for). */
  dropped: number;
}

interface Pending {
  settle(result: { frame: Uint8Array } | { error: Error }): void;
  settled: boolean;
}

/**
 * The client's `Carrier` through a mediator, the provider's TSP relationship
 * invite, and the receive loop. Requests and the loop share one link: whoever
 * is reading hands each frame to whoever it is for.
 */
export class MediatorCarrier {
  private readonly identity: AgentIdentity;
  private readonly mediator: PeerKeys;
  private readonly provider: PeerKeys;
  private readonly link: MediatorLink;
  private readonly clock: Clock;
  private readonly replyTimeoutMs: number;
  private readonly pollTimeoutMs: number;
  private readonly maxInbox: number;
  private readonly onDrop: (reason: string) => void;
  /** Requests waiting for a reply, by `threadId`. */
  private readonly replies = new Map<string, Pending>();
  /** Invites waiting for an accept, by the invite's digest (hex). */
  private readonly accepts = new Map<string, Pending>();
  /** Pushed messages read by a request's wait, for the loop to handle. */
  private readonly inbox: Uint8Array[] = [];
  /** Serialises `link.receive`: one reader at a time. */
  private reading: Promise<unknown> = Promise.resolve();
  private dropped = 0;

  constructor(options: MediatorCarrierOptions) {
    this.identity = options.identity;
    this.mediator = options.mediator;
    this.provider = options.provider;
    this.link = options.link;
    this.clock = options.clock ?? systemClock;
    this.replyTimeoutMs = options.replyTimeoutMs ?? 30_000;
    this.pollTimeoutMs = options.pollTimeoutMs ?? 5_000;
    this.maxInbox = options.maxInbox ?? 100;
    this.onDrop = options.onDrop ?? (() => {});
  }

  /** The `Carrier` to give `HcpAgentClient`. */
  readonly carrier: Carrier = async (wire: Uint8Array, context?: CarrierContext) => {
    if (context === undefined) throw new Error("the mediator carrier needs the request's threadId to match its reply");
    if (this.replies.has(context.threadId)) throw new Error(`a request on thread ${context.threadId} is already waiting`);
    const pending = this.expect(this.replies, context.threadId);
    await this.sendOrForget(pending, wire);
    return this.await(pending, `no reply on thread ${context.threadId} within ${this.replyTimeoutMs} ms`);
  };

  /**
   * Form the TSP relationship with the provider (TSP §7.2: a peer drops
   * application messages from a VID it has no relationship with): send an
   * invite through the mediator and wait, bounded, for the accept.
   */
  async relate(): Promise<void> {
    const invite = await packInvite(this.identity.vid, this.provider.vid, this.toProvider(), { route: [this.mediator.vid, this.identity.vid] });
    const pending = this.expect(this.accepts, hex(invite.threadDigest));
    await this.sendOrForget(pending, invite.bytes);
    await this.await(pending, `no relationship accept from ${this.provider.vid} within ${this.replyTimeoutMs} ms`);
  }

  /** Wrap a Direct message to the provider in a Routed message to the mediator. */
  async wrap(direct: Uint8Array): Promise<Uint8Array> {
    const keys: PackKeys = { senderSigningKey: this.identity.signingKey, receiverEncryptionKey: this.mediator.encryptionKey };
    return (await packRouted(direct, [this.provider.vid], this.identity.vid, this.mediator.vid, keys)).bytes;
  }

  /**
   * The provider's Direct message out of an inbound frame: the frame itself
   * when the provider sealed it to the agent, or the inner message of a Nested
   * message from the mediator (or a Routed one with no hops left). Throws on
   * anything else.
   */
  async unwrap(frame: Uint8Array): Promise<Uint8Array> {
    const { sender, receiver } = decodeEnvelope(frame).envelope;
    if (receiver !== this.identity.vid) throw new Error(`frame addressed to ${receiver || "no one"}`);
    if (sender === this.provider.vid) return frame;
    if (sender !== this.mediator.vid) throw new Error(`frame from ${sender}, neither the mediator nor the provider`);
    const outer = await unpack(frame, { receiverDecryptionKey: this.identity.decryptionKey, senderSigningKey: this.mediator.signingKey });
    if (outer.control !== undefined) throw new Error(`a ${outer.control.controlType} control message from the mediator`);
    const step = nextHop(outer.hops, outer.payload);
    if (step.kind !== "deliver") throw new Error(`the mediator asked the agent to forward to ${step.next}`);
    const inner = decodeEnvelope(step.inner).envelope;
    if (inner.sender !== this.provider.vid || inner.receiver !== this.identity.vid) throw new Error(`routed message from ${inner.sender}, not the provider`);
    return step.inner;
  }

  /**
   * Receive what the provider pushes until stopped: each message goes to
   * `onInbound` and its reply goes back through the mediator. Each read waits
   * at most `pollTimeoutMs`; a link failure backs off (doubling, capped) and
   * the loop rejects after `maxConsecutiveFailures` in a row. A frame that
   * cannot be read, or that `onInbound` throws on, is dropped, never retried.
   */
  async run(options: ReceiveLoopOptions): Promise<ReceiveLoopResult> {
    const minBackoff = options.minBackoffMs ?? 500;
    const maxBackoff = options.maxBackoffMs ?? 30_000;
    const maxFailures = options.maxConsecutiveFailures ?? 5;
    const deadline = options.runForMs === undefined ? Infinity : this.clock.now() + options.runForMs;
    const droppedBefore = this.dropped;
    let delivered = 0;
    let failures = 0;
    for (;;) {
      if (options.signal?.aborted) return { stopped: "signal", delivered, dropped: this.dropped - droppedBefore };
      const left = deadline - this.clock.now();
      if (left <= 0) return { stopped: "deadline", delivered, dropped: this.dropped - droppedBefore };
      try {
        const queued = this.inbox.shift();
        if (queued === undefined) await this.readOnce(Math.min(this.pollTimeoutMs, left));
        else {
          let reply: Uint8Array | undefined;
          try {
            reply = await options.onInbound(queued);
            delivered++;
          } catch (e) {
            this.drop(`the handler refused a pushed message: ${(e as Error).message}`);
          }
          if (reply !== undefined) await this.link.send(await this.wrap(reply));
        }
        failures = 0;
      } catch (e) {
        if (++failures >= maxFailures) throw new Error(`the receive loop stopped after ${failures} failures in a row: ${(e as Error).message}`);
        const wait = Math.min(maxBackoff, minBackoff * 2 ** (failures - 1), Math.max(0, deadline - this.clock.now()));
        if (wait > 0) await this.clock.sleep(wait / 1000);
      }
    }
  }

  // ── Inbound dispatch ───────────────────────────────────────────────────────

  /** Wrap and send; if that fails, the wait is dropped before the error goes up. */
  private async sendOrForget(pending: Pending, direct: Uint8Array): Promise<void> {
    try {
      await this.link.send(await this.wrap(direct));
    } catch (e) {
      pending.settle({ error: e as Error });
      throw e;
    }
  }

  private expect(map: Map<string, Pending>, key: string): Pending & { result: Promise<{ frame: Uint8Array } | { error: Error }> } {
    let settle!: Pending["settle"];
    const result = new Promise<{ frame: Uint8Array } | { error: Error }>((resolve) => (settle = resolve));
    const pending: Pending & { result: typeof result } = {
      settled: false,
      result,
      settle: (r) => {
        if (pending.settled) return;
        pending.settled = true;
        map.delete(key);
        settle(r);
      },
    };
    map.set(key, pending);
    return pending;
  }

  /** Read frames, bounded by the reply timeout, until `pending` is settled. */
  private async await(pending: Pending & { result: Promise<{ frame: Uint8Array } | { error: Error }> }, timeoutMessage: string): Promise<Uint8Array> {
    const deadline = this.clock.now() + this.replyTimeoutMs;
    while (!pending.settled) {
      const left = deadline - this.clock.now();
      if (left <= 0) {
        pending.settle({ error: new Error(timeoutMessage) });
        break;
      }
      try {
        await this.readOnce(Math.min(this.pollTimeoutMs, left), () => !pending.settled);
      } catch (e) {
        pending.settle({ error: e as Error });
      }
    }
    const r = await pending.result;
    if ("error" in r) throw r.error;
    return r.frame;
  }

  /** One bounded `link.receive`, serialised with any other reader, and the frame dispatched. Skipped once `wanted` says no. */
  private readOnce(timeoutMs: number, wanted: () => boolean = () => true): Promise<void> {
    const run = this.reading.then(async () => {
      if (!wanted()) return;
      const frame = await this.link.receive(timeoutMs);
      if (frame !== undefined) await this.dispatch(frame);
    });
    this.reading = run.catch(() => {});
    return run;
  }

  /** A reply goes to the request on its thread, an accept to its invite; anything else the provider sends is pushed. */
  private async dispatch(frame: Uint8Array): Promise<void> {
    let direct: Uint8Array;
    try {
      direct = await this.unwrap(frame);
      const opened = await unpack(direct, { receiverDecryptionKey: this.identity.decryptionKey, senderSigningKey: this.provider.signingKey });
      if (opened.control !== undefined) {
        const digest = opened.control.inReplyTo;
        const pending = opened.control.controlType === "accept" && digest !== undefined ? this.accepts.get(hex(digest)) : undefined;
        if (pending === undefined) return this.drop(`a ${opened.control.controlType} control message nobody waits for`);
        return pending.settle({ frame: direct });
      }
      const { document } = await unpackTrustTask(direct, {
        recipientVid: this.identity.vid,
        keys: { receiverDecryptionKey: this.identity.decryptionKey, senderSigningKey: this.provider.signingKey },
      });
      const thread = typeof document.threadId === "string" ? document.threadId : undefined;
      const pending = thread === undefined ? undefined : this.replies.get(thread);
      if (pending !== undefined && !isPushedRequest(document.type)) return pending.settle({ frame: direct });
      if (!isPushedRequest(document.type)) return this.drop(`a ${document.type} nobody waits for`);
      this.inbox.push(direct);
      if (this.inbox.length > this.maxInbox) {
        this.inbox.shift();
        this.drop("the inbox is full: the oldest pushed message was dropped");
      }
    } catch (e) {
      this.drop((e as Error).message);
    }
  }

  private drop(reason: string): void {
    this.dropped++;
    this.onDrop(reason);
  }

  private toProvider(): PackKeys {
    return { senderSigningKey: this.identity.signingKey, receiverEncryptionKey: this.provider.encryptionKey };
  }
}

/** A request the provider pushes (a notice), as opposed to a reply to one of the client's requests. */
function isPushedRequest(type: string): boolean {
  return type.endsWith("#request");
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
