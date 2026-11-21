import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pins } from "../pins.js";

// The 0.72 -> 0.83 / 0.20 -> 0.31 bump: the mechanical fixes and the recorded (not guessed) wire-protocol risks.
const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");

test("the pin is the matched 0.83/0.31 pair from one commit", () => {
  const { vta, vtc } = pins().vti;
  assert.equal(vta.version, "0.83.0");
  assert.equal(vtc.version, "0.31.0");
  assert.equal(vta.tag, "vta-service-v0.83.0");
  assert.equal(vtc.tag, "vtc-service-v0.31.0");
  assert.equal(vta.ref, vtc.ref);
  assert.equal(vta.ref.slice(0, 8), "3ee07a12");
});

test("the VTC Dockerfile builds with the Rust the pinned release's rust-toolchain.toml names (1.100.0)", () => {
  assert.match(read("docker/vtc.Dockerfile"), /^ARG RUST_VERSION=1\.100\.0$/m);
  assert.match(read("docker/vtc.Dockerfile"), /FROM rust:\$\{RUST_VERSION\}-bookworm/);
});

test("every feature in the VTA features list is still named, tsp stays", () => {
  const f = pins().vti.vta.features!.split(",");
  for (const need of ["setup", "rest", "didcomm", "tsp", "cli-synthesis", "aws-secrets", "webvh"]) assert.ok(f.includes(need), need);
});

test("docs/PINS.md records the expected breakage, including the wire-protocol items that need a live check", () => {
  const d = read("docs/PINS.md");
  assert.match(d, /^## Bump to 0\.83\/0\.31: expected breakage$/m);
  assert.match(d, /acl\/grant\/0\.2/);
  assert.match(d, /acl\/grant\/0\.3/);
  assert.match(d, /purposes/);
  assert.match(d, /needs live verification/i);
  assert.match(d, /0\.52\.0/);
});

test("the kit's clients send acl/grant 0.3 (the 0.83 VTA dispatches no other version)", () => {
  assert.match(read("packages/vta-client/src/client.ts"), /aclGrant: `\$\{TT\}\/acl\/grant\/0\.3`/);
});
