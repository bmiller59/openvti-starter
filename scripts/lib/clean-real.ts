// The real docker / filesystem / git runners for `npm run clean`. The planning code (clean.ts) never imports this,
// so its tests use fakes. Every docker call is bounded by a timeout.
import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseSize, supersededHint, pinnedImages, type CleanDocker, type CleanFs, type Git, type Result } from "./clean.js";
import { pins } from "../pins.js";
import { isKitImage, realQuery } from "./image-guard.js";

const docker = (args: string[], timeout = 60_000) => spawnSync("docker", args, { encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
const out = (args: string[], timeout?: number): string => {
  const r = docker(args, timeout);
  if (r.status !== 0) throw new Error((r.stderr || r.error?.message || `docker ${args[0]} failed`).trim());
  return r.stdout;
};
const result = (r: ReturnType<typeof docker>): Result => (r.status === 0 ? { ok: true } : { ok: false, message: (r.stderr || r.error?.message || "failed").trim() });
const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

export const realCleanDocker: CleanDocker = {
  images: () => lines(out(["image", "ls", "--format", "{{json .}}"])).map((l) => {
    const j = JSON.parse(l) as { Repository: string; Tag: string; ID: string; Size: string };
    return { repo: j.Repository, tag: j.Tag, id: j.ID, bytes: parseSize(j.Size) };
  }),
  containers: () => {
    const ids = lines(out(["ps", "-a", "-q", "--no-trunc"]));
    if (!ids.length) return [];
    return lines(out(["inspect", "--format", '{{.Name}}\t{{.Image}}\t{{.Config.Image}}\t{{index .Config.Labels "com.docker.compose.project"}}', ...ids])).map((l) => {
      const [name = "", imageId = "", imageRef = "", project = ""] = l.split("\t");
      return { name: name.replace(/^\//, ""), imageId, imageRef, project: project === "<no value>" ? "" : project };
    });
  },
  isKit: (id) => isKitImage(realQuery, id),
  builders: () => lines(out(["buildx", "ls", "--format", "json"])).map((l) => {
    const j = JSON.parse(l) as { Name: string; Nodes?: { Name: string }[]; LastActivity?: string };
    return { name: j.Name, nodes: (j.Nodes ?? []).map((n) => n.Name), lastActivity: j.LastActivity };
  }),
  volumes: () => {
    const j = JSON.parse(out(["system", "df", "-v", "--format", "{{json .Volumes}}"], 120_000) || "[]") as { Name: string; Size: string }[];
    return j.map((v) => ({ name: v.Name, bytes: parseSize(v.Size) }));
  },
  imageRm: (ref) => result(docker(["image", "rm", ref])),
  builderRm: (name) => result(docker(["buildx", "rm", name], 120_000)),
  builderPrune: (name) => result(docker(["buildx", "prune", "--builder", name, "--all", "--force"], 600_000)),
};

const dirSize = (p: string): number => {
  const st = lstatSync(p);
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const e of readdirSync(p)) { try { n += dirSize(join(p, e)); } catch { /* vanished */ } }
  return n;
};

export const realCleanFs: CleanFs = {
  list: (d) => readdirSync(d),
  stat: (p) => {
    try { const s = lstatSync(p); return { isDir: s.isDirectory(), isFile: s.isFile(), isSymlink: s.isSymbolicLink(), mtimeMs: s.mtimeMs, uid: s.uid }; } catch { return undefined; }
  },
  exists: (p) => { try { lstatSync(p); return true; } catch { return false; } },
  sizeOf: (p) => { try { return dirSize(p); } catch { return 0; } },
  rm: (p) => rmSync(p, { recursive: true, force: true }),
  uid: process.getuid?.(),
};

export const realGit: Git = (repo, args) => {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 60_000 });
  return { status: r.status, stdout: r.stdout ?? "" };
};

/** For the hint after a build: undefined when Docker cannot be asked or nothing is superseded. Never throws. */
export function supersededHintNow(): string | undefined {
  try { return supersededHint(realCleanDocker.images(), pinnedImages(pins()), realCleanDocker.containers(), (id) => realCleanDocker.isKit(id)); } catch { return undefined; }
}
