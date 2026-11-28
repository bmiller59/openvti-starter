// A real `MediatorLink`: the agent logs in to its mediator and holds one
// WebSocket, the way `@starter/tsp-client` does (`connectMediatorSession` from
// `@openvtc/pnm-core`: the DIDComm authentication handshake with the agent's
// X25519 key, then live delivery on the socket). TSP frames go out with
// `sendBinary`; the mediator tells a TSP frame from DIDComm by its leading
// byte, so both share the one socket.
//
// Inbound: no frame is ever claimed by a pnm-core waiter, so every TSP frame
// the mediator delivers reaches `onInboundTsp`, which puts it on a bounded
// queue that `receive` drains. The mediator deletes its copy once that handler
// returns (the ack), so a frame queued here and not yet read is lost if the
// process ends; a provider re-sends a notice it has no acknowledgement for
// (`hcp/grants/revoked` delivery attempts share a `noticeId`), and the client
// de-duplicates on it.
//
// A closed socket is not reopened here: `receive` and `send` then throw, the
// carrier's loop backs off and gives up after its failure limit, and the caller
// connects again.

import {
  Identity,
  connectMediatorSession,
  didcommKeyAgreementFromSigning,
  resolveVtaTspEndpoint,
  signingIdentityFromSecret,
  type WebSocketCtor,
} from "@openvtc/pnm-core";

import type { AgentIdentity, PeerKeys } from "./identity.js";
import type { MediatorLink } from "./mediator.js";

/** The part of a mediator socket the link uses (`@openvtc/pnm-core`'s `MediatorConnection` has it). */
export interface TspSocket {
  sendBinary(bytes: Uint8Array): void;
  /** Called with each inbound TSP frame; the mediator's ack waits for the returned promise. */
  onInboundTsp(handler: (bytes: Uint8Array) => void | Promise<void>): void;
  close(): void;
  readonly isOpen: boolean;
}

export interface SocketMediatorLinkOptions {
  /** Frames kept until read (default 1000); beyond that the oldest is dropped. */
  maxQueue?: number;
  /** Called with each frame dropped for a full queue. For logs. */
  onDrop?(reason: string): void;
}

/** A `MediatorLink` over an open mediator socket. */
export class SocketMediatorLink implements MediatorLink {
  private readonly queue: Uint8Array[] = [];
  private waiter: ((frame: Uint8Array | undefined) => void) | undefined;
  private closedReason: string | undefined;
  private readonly maxQueue: number;
  private readonly onDrop: (reason: string) => void;

  constructor(
    private readonly socket: TspSocket,
    options: SocketMediatorLinkOptions = {},
  ) {
    this.maxQueue = options.maxQueue ?? 1000;
    this.onDrop = options.onDrop ?? (() => {});
    socket.onInboundTsp((bytes) => this.push(bytes));
  }

  async send(frame: Uint8Array): Promise<void> {
    this.assertOpen();
    this.socket.sendBinary(frame);
  }

  receive(timeoutMs: number): Promise<Uint8Array | undefined> {
    const next = this.queue.shift();
    if (next !== undefined) return Promise.resolve(next);
    try {
      this.assertOpen();
    } catch (e) {
      return Promise.reject(e);
    }
    if (this.waiter !== undefined) return Promise.reject(new Error("another receive is already waiting on this link"));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        resolve(undefined);
      }, Math.max(0, timeoutMs));
      this.waiter = (frame) => {
        clearTimeout(timer);
        this.waiter = undefined;
        resolve(frame);
      };
    });
  }

  /** The socket closed under the link (not through `close`): later reads and sends throw. A waiting read returns nothing. */
  socketClosed(reason = "the mediator socket closed"): void {
    this.closedReason ??= reason;
    this.waiter?.(undefined);
  }

  /** Close the socket. */
  close(): void {
    this.socketClosed("the link was closed");
    this.socket.close();
  }

  private push(bytes: Uint8Array): void {
    if (this.waiter !== undefined) return this.waiter(bytes);
    this.queue.push(bytes);
    if (this.queue.length > this.maxQueue) {
      this.queue.shift();
      this.onDrop("the link's queue is full: the oldest frame was dropped");
    }
  }

  private assertOpen(): void {
    if (this.closedReason !== undefined) throw new Error(this.closedReason);
    if (!this.socket.isOpen) throw new Error("the mediator socket is not open");
  }
}

/** How the agent logs in to the mediator: its X25519 key-agreement key, as its DID document lists it. */
export interface MediatorLogin {
  /** The key-agreement verification method id (`<did>#…`). */
  kid: string;
  jwk: { kty: "OKP"; crv: "X25519"; x: string; d: string };
}

export interface ConnectMediatorLinkOptions extends SocketMediatorLinkOptions {
  identity: AgentIdentity;
  /** The agent's mediator, resolved and authenticated against. */
  mediatorDid: string;
  /** The provider (the VTA) the agent talks to: the login resolves it. */
  providerDid: string;
  /**
   * The login key. Omit for a `did:key` identity: it is the X25519 key the `did:key` document derives from the
   * signing key. A `did:peer:2` identity passes its own (`@starter/tsp-client`'s `didPeerFromSeed` gives `keyAgreementKid` and `secretJwk`).
   */
  login?: MediatorLogin;
  /** Allow `http://` and `ws://` mediator endpoints. Local testing only. */
  allowInsecure?: boolean;
  /** WebSocket constructor; defaults to the global one (Node 22+). */
  webSocketImpl?: WebSocketCtor;
  fetch?: typeof fetch;
}

export interface MediatorConnectionLink {
  link: SocketMediatorLink;
  /** The mediator's VID and TSP keys, from its DID document: what `MediatorCarrier` needs as `mediator`. */
  mediator: PeerKeys;
  close(): void;
}

/** Log in to the mediator, open the socket, and resolve the mediator's TSP keys. */
export async function connectMediatorLink(options: ConnectMediatorLinkOptions): Promise<MediatorConnectionLink> {
  const login = options.login ?? didKeyLogin(options.identity);
  const holder = Identity.fromSecretJwk({ did: options.identity.vid, kid: login.kid, jwk: login.jwk });
  let link: SocketMediatorLink | undefined;
  let conn: Awaited<ReturnType<typeof connectMediatorSession>> | undefined;
  try {
    conn = await connectMediatorSession({
      holder,
      mediatorDid: options.mediatorDid,
      vtaDid: options.providerDid,
      onClose: () => link?.socketClosed(),
      ...(options.allowInsecure ? { allowInsecure: true } : {}),
      ...(options.webSocketImpl ? { webSocketImpl: options.webSocketImpl } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    link = new SocketMediatorLink(conn, options);
    const m = await resolveVtaTspEndpoint(options.mediatorDid);
    const mediator: PeerKeys = { vid: m.vid, signingKey: m.signingPublicKey, encryptionKey: m.encryptionPublicKey };
    const opened = link;
    return {
      link: opened,
      mediator,
      close: () => {
        opened.close();
        holder.dispose();
      },
    };
  } catch (e) {
    conn?.close();
    holder.dispose();
    throw e;
  }
}

/** The login key of a `did:key` identity: the X25519 key its DID document derives from the Ed25519 signing key. */
export function didKeyLogin(identity: AgentIdentity): MediatorLogin {
  if (!identity.vid.startsWith("did:key:")) throw new Error(`${identity.vid} is not a did:key: pass its login key`);
  const signing = signingIdentityFromSecret(identity.signingKey);
  if (signing.did !== identity.vid) throw new Error("the identity's signing key does not match its did:key");
  const ka = didcommKeyAgreementFromSigning(signing);
  return { kid: ka.keyAgreementKid, jwk: ka.secretJwk };
}
