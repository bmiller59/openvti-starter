// Never move a tag that is in use. Other projects and sessions share this machine's image store, so a tag like
// `<name>:<ref8>` may be what somebody else's (running or stopped) container was created from. Moving it would leave
// that project's next `docker compose up` on a different image. These checks are pure apart from `realQuery`, which is
// the only thing that talks to Docker, and only read-only (`docker image inspect`, `docker ps -a`).
import { spawnSync } from "node:child_process";

export interface DockerQuery { run(args: string[]): { status: number | null; stdout: string; stderr?: string } }

export const realQuery: DockerQuery = {
  run: (args) => {
    const r = spawnSync("docker", args, { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  },
};

export interface ContainerUse { name: string; /** compose project, "" when it was not started by compose */ project: string }

/** Thrown when Docker could not be asked (daemon down, timeout): callers fail closed. */
export class DockerUnavailable extends Error {}

/**
 * The image ID (sha256:...) a reference points to now, or undefined when it does not exist. Only a genuine "No such image"
 * answer means absent; any other failure (daemon down, timeout) throws DockerUnavailable so a tag is never moved blind.
 */
export function imageId(q: DockerQuery, ref: string): string | undefined {
  const r = q.run(["image", "inspect", ref, "--format", "{{.Id}}"]);
  const id = r.stdout.trim();
  if (r.status === 0 && id) return id;
  if (r.status === 1 && /no such (image|object)/i.test(r.stderr ?? "")) return undefined;
  throw new DockerUnavailable(`could not inspect ${ref} (docker image inspect failed: ${(r.stderr ?? "").trim() || `status ${r.status}`})`);
}

/** Every container, running or stopped, of any project, created from that image ID (`docker ps -a --filter ancestor=`). */
export function containersUsing(q: DockerQuery, id: string): ContainerUse[] {
  const r = q.run(["ps", "-a", "--no-trunc", "--filter", `ancestor=${id}`, "--format", '{{.Names}}\t{{.Label "com.docker.compose.project"}}']);
  if (r.status !== 0) throw new Error("could not list containers (docker ps -a failed)");
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const [name, project] = l.split("\t");
    return { name: name ?? l, project: (project ?? "").trim() };
  });
}

/** `name (compose project p)`, for messages and for `npm run clean`. */
export const describeUse = (u: ContainerUse): string => `${u.name} (${u.project ? `compose project ${u.project}` : "not a compose project"})`;

export type MoveCheck =
  | { move: true; why: "new" | "unused" }
  | { move: false; why: "same" }
  | { move: false; why: "in-use"; users: ContainerUse[] };

/**
 * May `tag` be pointed at the image `newId`? Absent: yes. Already that image: nothing to move (always fine, so version-ref
 * and ref8 tags of a pinned digest are idempotent). A different image that any container still uses: no. `newId` undefined
 * (a build whose result is not known yet) counts as different. If Docker cannot be asked, the answer is no: the safe default.
 */
export function checkTagMove(q: DockerQuery, tag: string, newId: string | undefined): MoveCheck {
  let current: string | undefined;
  try { current = imageId(q, tag); } catch { return { move: false, why: "in-use", users: [{ name: "(unknown: docker image inspect failed)", project: "" }] }; }
  if (current === undefined) return { move: true, why: "new" };
  if (newId !== undefined && current === newId) return { move: false, why: "same" };
  let users: ContainerUse[];
  try { users = containersUsing(q, current); } catch { users = [{ name: "(unknown: docker ps -a failed)", project: "" }]; }
  return users.length ? { move: false, why: "in-use", users } : { move: true, why: "unused" };
}

/** The sentence printed when a tag is left alone. */
export function inUseMessage(tag: string, users: ContainerUse[], hint: string): string {
  return `${tag} is used by ${users.map(describeUse).join(", ")}; not moving it. ${hint}`;
}

/** Hint for images:pull. The version-ref tag is unique to this pin, so a consumer can always reference that instead. */
export const PULL_HINT = "Reference the version-ref tag (<name>:<version>-<ref8>) or the pinned digest instead, or stop those containers and re-run, or pass --force to move the tag anyway.";
/** Hint for images:build. */
export const BUILD_HINT = "Stop them first (this stack: npm run down), or pass --force to move the tag anyway; other projects keep running the old image either way.";

/** Labels the kit puts on every image it builds or publishes (scripts/lib/images.ts buildLabels, images.yml). */
export const KIT_LABELS = ["org.buildathon.build-origin", "org.buildathon.pinned-ref", "org.buildathon.vti-ref", "org.buildathon.mediator-ref"] as const;

/** Does the image carry any kit label? Unknown (Docker cannot be asked) counts as not ours: the safe answer when deciding what to overwrite or remove. */
export function hasKitLabels(labels: Record<string, string> | undefined): boolean {
  return !!labels && KIT_LABELS.some((k) => !!labels[k]);
}
export function isKitImage(q: DockerQuery, ref: string): boolean {
  const r = q.run(["image", "inspect", ref, "--format", "{{json .Config.Labels}}"]);
  if (r.status !== 0) return false;
  try { return hasKitLabels(JSON.parse(r.stdout.trim() || "null") as Record<string, string> | null ?? undefined); } catch { return false; }
}

/** images:build preflight: the tags a build is about to (re)write that are in use. Empty = go ahead. */
export function buildTagConflicts(q: DockerQuery, tags: string[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const c = checkTagMove(q, t, undefined);
    if (!c.move && c.why === "in-use") out.push(inUseMessage(t, c.users, BUILD_HINT));
    if (c.move && c.why === "new") continue;
    if (!isKitImage(q, t)) out.push(`${t} exists but was not built by this kit (it has no org.buildathon.* labels: another project's image of the same name?); not overwriting it. Pass --force to move the tag anyway.`);
  }
  return out;
}
