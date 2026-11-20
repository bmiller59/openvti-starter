import assert from "node:assert/strict";
import { test } from "node:test";
import { builderCreateArgs, builderName, limitedBuildArgv, limitsFromEnv, parseLimitFlags } from "../lib/build-limits.js";

test("defaults: 6g and a quarter of the cores; BUILD_LIMITS=0 turns it off", () => {
  assert.deepEqual(limitsFromEnv({}, 12), { memory: "6g", cpus: 3 });
  assert.deepEqual(limitsFromEnv({}, 1), { memory: "6g", cpus: 1 });
  assert.equal(limitsFromEnv({ BUILD_LIMITS: "0" }, 12), undefined);
  assert.deepEqual(limitsFromEnv({ BUILD_MEMORY: "4096M", BUILD_CPUS: "2.5" }, 12), { memory: "4096m", cpus: 2.5 });
});

test("malformed values are rejected", () => {
  assert.throws(() => limitsFromEnv({ BUILD_MEMORY: "lots" }, 4), /BUILD_MEMORY/);
  assert.throws(() => limitsFromEnv({ BUILD_CPUS: "0" }, 4), /BUILD_CPUS/);
});

test("the builder carries memory (no swap), cpu quota and low shares, and is named after them", () => {
  const l = { memory: "6g", cpus: 2.5 };
  assert.equal(builderName(l), "buildathon2-m6g-c2_5");
  const a = builderCreateArgs(l).join(" ");
  assert.match(a, /memory=6g/);
  assert.match(a, /memory-swap=6g/);
  assert.match(a, /cpu-quota=250000/);
  assert.match(a, /cpu-shares=64/);
  assert.match(a, /cpuset-cpus=0-1\b/);
  assert.deepEqual(limitsFromEnv({ BUILD_CPUS: "64" }, 12), { memory: "6g", cpus: 12 });
});

test("builds go through the limited builder with --load, or fall back to plain niced docker build", () => {
  const l = { memory: "6g", cpus: 2 };
  assert.deepEqual(limitedBuildArgv(l, ["-t", "x", "."]), ["nice", "-n", "10", "docker", "buildx", "build", "--builder", "buildathon2-m6g-c2", "--load", "-t", "x", "."]);
  assert.deepEqual(limitedBuildArgv(undefined, ["."]), ["nice", "-n", "10", "docker", "build", "."]);
});

test("flags set the limits in both spellings and leave the other arguments alone", () => {
  const r = parseLimitFlags(["vta", "--memory", "8g", "--cpus=4", "--clone"]);
  assert.deepEqual(r.rest, ["vta", "--clone"]);
  assert.deepEqual(r.env, { BUILD_MEMORY: "8g", BUILD_CPUS: "4" });
  assert.deepEqual(parseLimitFlags(["--no-limits"]).env, { BUILD_LIMITS: "0" });
  assert.match(parseLimitFlags(["--memory"]).error!, /needs a value/);
});

import { buildPreflight, defaultCpus, defaultMemory, sizeToBytes } from "../lib/build-limits.js";
import { GIB, type HostResources } from "../lib/host-resources.js";

const host = (o: Partial<HostResources> = {}): HostResources => ({ cores: 12, hostMemBytes: 32 * GIB, hostSwapBytes: 0, dockerMemBytes: 32 * GIB, dockerCpus: 12, dockerRootFreeBytes: 100 * GIB, dockerRootDir: "/var/lib/docker", ...o });

test("sizes parse to bytes", () => {
  assert.equal(sizeToBytes("6g"), 6 * GIB);
  assert.equal(sizeToBytes("4096m"), 4 * GIB);
  assert.equal(sizeToBytes("1024"), 1024);
  assert.ok(Number.isNaN(sizeToBytes("lots")));
});

test("default memory is half of the engine RAM, 6g to 12g", () => {
  assert.equal(defaultMemory(host({ dockerMemBytes: 64 * GIB })), "12g");
  assert.equal(defaultMemory(host({ dockerMemBytes: 16 * GIB })), "8g");
  assert.equal(defaultMemory(host({ dockerMemBytes: 8 * GIB })), "6g");
  assert.equal(defaultMemory(host({ dockerMemBytes: 2 * GIB })), "6g");
  assert.equal(defaultMemory(host({ dockerMemBytes: undefined, hostMemBytes: 20 * GIB })), "10g");
  assert.equal(defaultMemory(host({ dockerMemBytes: undefined, hostMemBytes: undefined })), "6g");
  assert.equal(defaultMemory(undefined), "6g");
});

test("default cpus: a quarter, floor 2 from 4 cores, min 1", () => {
  assert.deepEqual([1, 2, 3, 4, 8, 12, 16].map(defaultCpus), [1, 1, 1, 2, 2, 3, 4]);
  assert.equal(limitsFromEnv({}, 4)!.cpus, 2);
});

test("swap: memory-swap doubles only when the host swap is at least the cap; the builder name says so", () => {
  const swapped = limitsFromEnv({}, 12, host({ hostSwapBytes: 16 * GIB }))!;
  assert.deepEqual(swapped, { memory: "12g", cpus: 3, memorySwap: "24g" });
  assert.match(builderCreateArgs(swapped).join(" "), /memory-swap=24g/);
  assert.equal(builderName(swapped), "buildathon2-m12g-c3-sw");
  assert.equal(limitsFromEnv({}, 12, host({ hostSwapBytes: 4 * GIB }))!.memorySwap, undefined);
  assert.equal(limitsFromEnv({}, 12, host({ hostSwapBytes: undefined }))!.memorySwap, undefined);
  assert.equal(builderName({ memory: "6g", cpus: 3 }), "buildathon2-m6g-c3"); // unchanged without swap: existing builders and caches are reused
});

test("explicit BUILD_MEMORY / BUILD_CPUS still win over the scaled defaults", () => {
  assert.deepEqual(limitsFromEnv({ BUILD_MEMORY: "5g", BUILD_CPUS: "1" }, 12, host()), { memory: "5g", cpus: 1 });
  assert.equal(limitsFromEnv({ BUILD_LIMITS: "0" }, 12, host()), undefined);
});

test("--force is a flag of its own and leaves the other arguments alone", () => {
  const r = parseLimitFlags(["vta", "--force"]);
  assert.deepEqual(r.rest, ["vta"]);
  assert.equal(r.force, true);
  assert.equal(parseLimitFlags(["vta"]).force, false);
});

test("preflight refuses below 10 GB free disk or 4 GB memory and names the fallbacks and --force", () => {
  const l = limitsFromEnv({}, 12, host())!;
  const disk = buildPreflight({ limits: l, res: host({ dockerRootFreeBytes: 9 * GIB }), rust: true });
  assert.equal(disk.errors.length > 0, true);
  const text = disk.errors.join("\n");
  assert.match(text, /only 9\.0 GB free on \/var\/lib\/docker/);
  assert.match(text, /npm run clean/);
  assert.match(text, /images:import/);
  assert.match(text, /RUNTIME=binary/);
  assert.match(text, /MODE=farm/);
  assert.match(text, /--force/);
  const mem = buildPreflight({ limits: l, res: host({ dockerMemBytes: 3 * GIB }), rust: true });
  assert.match(mem.errors.join("\n"), /only 3\.0 GB of memory in the Docker engine/);
  assert.equal(buildPreflight({ limits: l, res: host({ dockerRootFreeBytes: 10 * GIB, dockerMemBytes: 4 * GIB }), rust: true }).errors.length, 0);
});

test("preflight warns (never refuses) between 10 and 20 GB free, for a cap under 8g without swap, and for one CPU", () => {
  const warn = buildPreflight({ limits: { memory: "6g", cpus: 1 }, res: host({ dockerRootFreeBytes: 15 * GIB }), rust: true });
  assert.equal(warn.errors.length, 0);
  assert.equal(warn.warnings.length, 3);
  assert.match(warn.warnings.join("\n"), /15\.0 GB free/);
  assert.match(warn.warnings.join("\n"), /OOM-killed below 8g/);
  assert.match(warn.warnings.join("\n"), /well over an hour/);
  // swap, a bigger cap, or a mediator-only build silence the memory warning
  assert.equal(buildPreflight({ limits: { memory: "6g", cpus: 3, memorySwap: "12g" }, res: host(), rust: true }).warnings.length, 0);
  assert.equal(buildPreflight({ limits: { memory: "8g", cpus: 3 }, res: host(), rust: true }).warnings.length, 0);
  assert.equal(buildPreflight({ limits: { memory: "6g", cpus: 3 }, res: host(), rust: false }).warnings.length, 0);
  // unmeasured disk and unlimited builds produce nothing
  assert.deepEqual(buildPreflight({ limits: undefined, res: host({ dockerRootFreeBytes: undefined }), rust: true }), { errors: [], warnings: [] });
});
