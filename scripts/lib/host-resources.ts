// What this machine (and the Docker engine's VM, on Docker Desktop) has to build with: disk on the Docker data root,
// RAM, swap and cores. `gatherResources` is pure over injected probes, so tests never touch /proc, df or docker.
// Used by `npm run doctor` and `npm run images:build` (scripts/lib/build-limits.ts judges the numbers).
import { spawnSync } from "node:child_process";
import { readFileSync, statfsSync } from "node:fs";
import { cpus, platform } from "node:os";
import { dirname } from "node:path";

export const GIB = 1024 ** 3;

export interface HostResources {
  /** Cores the host reports. */
  cores: number;
  /** From /proc/meminfo (Linux only); undefined elsewhere, where only Docker's own numbers are known. */
  hostMemBytes?: number;
  hostSwapBytes?: number;
  /** `docker info` MemTotal and NCPU: the Docker VM's limits on Docker Desktop, the host's on Linux. */
  dockerMemBytes?: number;
  dockerCpus?: number;
  /** Free bytes on the filesystem holding Docker's data root. Undefined when it cannot be measured (remote or VM engine, no permission). */
  dockerRootFreeBytes?: number;
  dockerRootDir?: string;
}

export interface ProbeDeps {
  platform: string;
  cores: number;
  /** Contents of a file, or undefined when it cannot be read. */
  readFile: (path: string) => string | undefined;
  /** Free bytes (available to this user) of the filesystem holding `path`; throws with a `code` when the path is unreachable. */
  freeBytes: (path: string) => number;
  /** Stdout of `docker info --format <format>`, or undefined when docker is absent or fails. */
  dockerInfo: (format: string) => string | undefined;
  env: Record<string, string | undefined>;
  /** false skips every docker probe (podman, or no docker). */
  docker: boolean;
}

const kb = (text: string | undefined, key: string): number | undefined => {
  const m = new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(text ?? "");
  return m ? Number(m[1]) * 1024 : undefined;
};

/** Is the engine local to this host (so a path on this host's filesystem is the engine's data root)? */
export function engineIsLocal(env: Record<string, string | undefined>, platformName: string): boolean {
  if (platformName !== "linux") return false; // Docker Desktop keeps its data inside a VM
  const host = env.DOCKER_HOST;
  return !host || host.startsWith("unix://");
}

export function gatherResources(d: ProbeDeps): HostResources {
  const r: HostResources = { cores: d.cores };
  if (d.platform === "linux") {
    const mi = d.readFile("/proc/meminfo");
    r.hostMemBytes = kb(mi, "MemTotal");
    r.hostSwapBytes = kb(mi, "SwapTotal");
  }
  if (!d.docker) return r;
  const info = d.dockerInfo("{{.MemTotal}} {{.NCPU}}")?.trim().split(/\s+/).map(Number);
  if (info && info.length >= 2 && info[0] > 0 && info[1] > 0) { r.dockerMemBytes = info[0]; r.dockerCpus = info[1]; }
  const root = d.dockerInfo("{{.DockerRootDir}}")?.trim();
  if (root) {
    r.dockerRootDir = root;
    if (engineIsLocal(d.env, d.platform)) {
      // /var/lib/docker is usually unreadable for a normal user; statfs the nearest reachable parent (same filesystem in practice).
      for (let p = root; ; p = dirname(p)) {
        try { r.dockerRootFreeBytes = d.freeBytes(p); break; } catch { if (dirname(p) === p) break; }
      }
    }
  }
  return r;
}

/** Cores the build can really use: the Docker VM's, when it is smaller than the host's. */
export const effectiveCores = (r: HostResources): number => Math.max(1, Math.min(r.cores, r.dockerCpus ?? r.cores));

/** Memory the engine builds in: Docker's own figure (the VM on Docker Desktop), else the host's. */
export const engineMemBytes = (r: HostResources): number | undefined => r.dockerMemBytes ?? r.hostMemBytes;

export function realProbeDeps(docker: boolean): ProbeDeps {
  return {
    platform: platform(),
    cores: cpus().length,
    readFile: (p) => { try { return readFileSync(p, "utf8"); } catch { return undefined; } },
    freeBytes: (p) => { const s = statfsSync(p); return Number(s.bavail) * Number(s.bsize); },
    dockerInfo: (format) => {
      const r = spawnSync("docker", ["info", "--format", format], { encoding: "utf8", timeout: 20_000 });
      return r.status === 0 ? r.stdout : undefined;
    },
    env: process.env,
    docker,
  };
}

export const realResources = (docker: boolean): HostResources => gatherResources(realProbeDeps(docker));
