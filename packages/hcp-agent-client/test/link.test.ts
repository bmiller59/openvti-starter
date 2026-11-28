// SocketMediatorLink over a fake socket: frames out, frames in (queued or to a
// waiting read), the bounded wait, a full queue, and a closed socket. No
// network; the live run against a real mediator is live-mediator.test.ts.

import assert from "node:assert/strict";
import { test } from "node:test";

import { signerFromPrivateKey } from "@openvtc/trust-tasks-proof";

import { SocketMediatorLink, didKeyLogin, identityFromKeys, type TspSocket } from "../src/index.js";

class FakeSocket implements TspSocket {
  sent: Uint8Array[] = [];
  isOpen = true;
  closed = 0;
  handler: ((bytes: Uint8Array) => void | Promise<void>) | undefined;
  sendBinary(bytes: Uint8Array): void {
    this.sent.push(bytes);
  }
  onInboundTsp(handler: (bytes: Uint8Array) => void | Promise<void>): void {
    this.handler = handler;
  }
  close(): void {
    this.closed++;
    this.isOpen = false;
  }
  async deliver(bytes: Uint8Array): Promise<void> {
    await this.handler!(bytes);
  }
}

const frame = (n: number) => new Uint8Array([0xf8, n]);

test("send hands the frame to the socket", async () => {
  const socket = new FakeSocket();
  const link = new SocketMediatorLink(socket);
  await link.send(frame(1));
  assert.deepEqual(socket.sent, [frame(1)]);
});

test("frames delivered before a read are queued, in order", async () => {
  const socket = new FakeSocket();
  const link = new SocketMediatorLink(socket);
  await socket.deliver(frame(1));
  await socket.deliver(frame(2));
  assert.deepEqual(await link.receive(10), frame(1));
  assert.deepEqual(await link.receive(10), frame(2));
});

test("a waiting read takes the next frame as it arrives", async () => {
  const socket = new FakeSocket();
  const link = new SocketMediatorLink(socket);
  const read = link.receive(5_000);
  await socket.deliver(frame(7));
  assert.deepEqual(await read, frame(7));
});

test("a read with nothing to read returns undefined after its timeout, not later", async () => {
  const link = new SocketMediatorLink(new FakeSocket());
  const t0 = Date.now();
  assert.equal(await link.receive(30), undefined);
  assert.ok(Date.now() - t0 < 1_000);
});

test("one read at a time", async () => {
  const link = new SocketMediatorLink(new FakeSocket());
  const first = link.receive(50);
  await assert.rejects(link.receive(50), /already waiting/);
  assert.equal(await first, undefined);
});

test("a full queue drops the oldest frame and says so", async () => {
  const socket = new FakeSocket();
  const drops: string[] = [];
  const link = new SocketMediatorLink(socket, { maxQueue: 2, onDrop: (r) => drops.push(r) });
  for (const n of [1, 2, 3]) await socket.deliver(frame(n));
  assert.equal(drops.length, 1);
  assert.deepEqual(await link.receive(10), frame(2));
  assert.deepEqual(await link.receive(10), frame(3));
});

test("a closed socket ends a waiting read, and later reads and sends throw; queued frames are still read first", async () => {
  const socket = new FakeSocket();
  const link = new SocketMediatorLink(socket);
  const waiting = link.receive(5_000);
  link.socketClosed();
  assert.equal(await waiting, undefined);
  await assert.rejects(link.receive(10), /socket closed/);
  await assert.rejects(link.send(frame(1)), /socket closed/);

  const socket2 = new FakeSocket();
  const link2 = new SocketMediatorLink(socket2);
  await socket2.deliver(frame(9));
  socket2.isOpen = false;
  assert.deepEqual(await link2.receive(10), frame(9));
  await assert.rejects(link2.receive(10), /not open/);
});

test("close closes the socket", async () => {
  const socket = new FakeSocket();
  const link = new SocketMediatorLink(socket);
  link.close();
  assert.equal(socket.closed, 1);
  await assert.rejects(link.send(frame(1)), /closed/);
});

test("a did:key logs in with the X25519 key its DID document derives, under that key's id", () => {
  const seed = new Uint8Array(32).fill(0x61); // DEMO ONLY
  const identity = identityFromKeys(seed, new Uint8Array(32).fill(0x62));
  const login = didKeyLogin(identity);
  assert.ok(login.kid.startsWith(`${identity.vid}#z6LS`), login.kid);
  assert.equal(login.jwk.crv, "X25519");
  assert.throws(() => didKeyLogin({ ...identity, vid: "did:peer:2.Ez6LS" }), /not a did:key/);
  const other = signerFromPrivateKey("ed25519", new Uint8Array(32).fill(0x63)).did;
  assert.throws(() => didKeyLogin({ ...identity, vid: other }), /does not match/);
});
