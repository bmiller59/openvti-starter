import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveCores, engineIsLocal, engineMemBytes, gatherResources, GIB, type ProbeDeps } from "../lib/host-resources.js";

const MEMINFO = "MemTotal:       32768000 kB\nMemFree: 1 kB\nMemAvailable:   16000000 kB\nSwapTotal:      16384000 kB\n";
const deps = (o: Partial<ProbeDeps> = {}): ProbeDeps => ({
  platform: "linux", cores: 12, env: {}, docker: true,
  readFile: (p) => (p === "/proc/meminfo" ? MEMINFO : undefined),
  freeBytes: () => 50 * GIB,
  dockerInfo: (f) => (f.includes("MemTotal") ? "33554432000 12\n" : "/var/lib/docker\n"),
  ...o,
});

test("Linux: meminfo, docker info and statfs are combined", () => {
  const r = gatherResources(deps());
  assert.equal(r.hostMemBytes, 32768000 * 1024);
  assert.equal(r.hostSwapBytes, 16384000 * 1024);
  assert.equal(r.dockerMemBytes, 33554432000);
  assert.equal(r.dockerCpus, 12);
  assert.equal(r.dockerRootDir, "/var/lib/docker");
  assert.equal(r.dockerRootFreeBytes, 50 * GIB);
});

test("an unreadable data root falls back to the nearest reachable parent", () => {
  const tried: string[] = [];
  const r = gatherResources(deps({ freeBytes: (p) => { tried.push(p); if (p === "/var/lib" ) return 7 * GIB; throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } }));
  assert.deepEqual(tried, ["/var/lib/docker", "/var/lib"]);
  assert.equal(r.dockerRootFreeBytes, 7 * GIB);
});

test("non-Linux makes no /proc claims and does not statfs the host for a VM data root", () => {
  let statfs = 0;
  const r = gatherResources(deps({ platform: "darwin", readFile: () => { throw new Error("must not read /proc"); }, freeBytes: () => { statfs++; return 1; } }));
  assert.equal(r.hostMemBytes, undefined);
  assert.equal(r.hostSwapBytes, undefined);
  assert.equal(statfs, 0);
  assert.equal(r.dockerRootFreeBytes, undefined);
  assert.equal(r.dockerMemBytes, 33554432000);
});

test("a remote engine is not statfs'd; podman or no docker skips docker probes", () => {
  assert.equal(engineIsLocal({ DOCKER_HOST: "ssh://box" }, "linux"), false);
  assert.equal(engineIsLocal({ DOCKER_HOST: "unix:///run/docker.sock" }, "linux"), true);
  assert.equal(gatherResources(deps({ env: { DOCKER_HOST: "tcp://x:2375" } })).dockerRootFreeBytes, undefined);
  const r = gatherResources(deps({ docker: false, dockerInfo: () => { throw new Error("no docker calls"); } }));
  assert.equal(r.dockerMemBytes, undefined);
  assert.equal(r.hostMemBytes !== undefined, true);
});

test("failed or garbled docker info leaves the numbers unknown", () => {
  const r = gatherResources(deps({ dockerInfo: () => undefined }));
  assert.equal(r.dockerMemBytes, undefined);
  assert.equal(r.dockerRootFreeBytes, undefined);
  assert.equal(gatherResources(deps({ dockerInfo: () => "oops" })).dockerCpus, undefined);
});

test("effective cores follow the Docker VM; engine memory prefers Docker's figure", () => {
  assert.equal(effectiveCores({ cores: 12, dockerCpus: 4 }), 4);
  assert.equal(effectiveCores({ cores: 2, dockerCpus: 8 }), 2);
  assert.equal(effectiveCores({ cores: 8 }), 8);
  assert.equal(engineMemBytes({ cores: 1, hostMemBytes: 8, dockerMemBytes: 4 }), 4);
  assert.equal(engineMemBytes({ cores: 1, hostMemBytes: 8 }), 8);
});
