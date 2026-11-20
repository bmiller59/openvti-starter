// Pure logic behind `npm run pins:update` (scripts/pins-update.ts): discover newer upstream VTA/VTC release tags,
// decide whether pins.json may be advanced, rewrite it, and template the follow-up text. No network and no git
// here: callers inject `lsRemote` and the working-tree status, so the tests run offline.
import type { Pins } from "../pins.js";

export type LsRemote = (repo: string) => string;

export interface TagInfo { tag: string; version: string; /** the commit the tag points at */ ref: string }

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const SHA = /^[0-9a-f]{40}$/;

/** -1, 0, 1. Only plain x.y.z versions are compared; anything else is treated as unorderable (NaN-free: returns 0 only when equal). */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a), pb = SEMVER.exec(b);
  if (!pa || !pb) throw new Error(`cannot compare versions "${a}" and "${b}": both must be x.y.z`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Parse `git ls-remote --tags <repo>` output (annotated tags show a peeled `^{}` line, which wins) into tag -> commit. */
export function parseLsRemote(out: string): Map<string, string> {
  const direct = new Map<string, string>(), peeled = new Map<string, string>();
  for (const line of out.split("\n")) {
    const m = /^([0-9a-f]{40})\s+refs\/tags\/(\S+?)(\^\{\})?$/.exec(line.trim());
    if (!m) continue;
    (m[3] ? peeled : direct).set(m[2], m[1]);
  }
  const all = new Map(direct);
  for (const [t, r] of peeled) all.set(t, r);
  return all;
}

/** Release tags `<service>-v<x.y.z>` (pre-releases and other shapes are ignored), oldest first. */
export function releaseTags(out: string, service: string): TagInfo[] {
  const prefix = `${service}-v`;
  const found: TagInfo[] = [];
  for (const [tag, ref] of parseLsRemote(out)) {
    if (!tag.startsWith(prefix)) continue;
    const version = tag.slice(prefix.length);
    if (SEMVER.test(version)) found.push({ tag, version, ref });
  }
  return found.sort((a, b) => compareVersions(a.version, b.version));
}

/** Minimal structural check of the parts of pins.json this tool reads or writes. Returns problems; empty = valid. */
export function validatePins(p: unknown): string[] {
  const problems: string[] = [];
  const o = p as Record<string, any> | null;
  const str = (v: unknown, what: string, re?: RegExp) => {
    if (typeof v !== "string" || v === "" || (re && !re.test(v))) problems.push(`${what} is missing or malformed`);
  };
  if (!o || typeof o !== "object") return ["pins.json is not an object"];
  str(o.updated, "updated", /^\d{4}-\d{2}-\d{2}$/);
  str(o.vti?.repo, "vti.repo", /^https:\/\//);
  for (const k of ["vta", "vtc"] as const) {
    const i = o.vti?.[k];
    str(i?.image, `vti.${k}.image`);
    str(i?.service, `vti.${k}.service`);
    str(i?.ref, `vti.${k}.ref`, SHA);
    str(i?.version, `vti.${k}.version`, SEMVER);
    str(i?.tag, `vti.${k}.tag`);
    if (typeof i?.tag === "string" && typeof i?.service === "string" && typeof i?.version === "string" && i.tag !== `${i.service}-v${i.version}`) {
      problems.push(`vti.${k}.tag "${i.tag}" does not match service and version (${i.service}-v${i.version})`);
    }
  }
  str(o.vti?.pinnedOn, "vti.pinnedOn", /^\d{4}-\d{2}-\d{2}$/);
  str(o.messaging?.mediator?.repo, "messaging.mediator.repo", /^https:\/\//);
  str(o.messaging?.mediator?.ref, "messaging.mediator.ref", SHA);
  str(o.messaging?.mediator?.version, "messaging.mediator.version", SEMVER);
  str(o.messaging?.redis?.tag, "messaging.redis.tag");
  if (!o.npm || typeof o.npm !== "object") problems.push("npm is missing");
  else for (const [n, v] of Object.entries(o.npm)) if (typeof v !== "string" || !SEMVER.test(v)) problems.push(`npm ${n} is not an exact version`);
  return problems;
}

export interface Change { what: string; from: string; to: string }
export interface MediatorRequest { /** a tag like v0.49.0, or a 40-hex commit */ ref: string; /** required with a bare commit */ version?: string }
export interface PlanOptions {
  pins: Pins;
  lsRemote: LsRemote;
  /** `git status --porcelain` of the working tree; "" = clean */
  dirty: string;
  allowDowngrade?: boolean;
  /** pin these release tags instead of the newest ones */
  vtaTag?: string;
  vtcTag?: string;
  mediator?: MediatorRequest;
  today: string;
}
export interface Plan {
  /** Newer (or requested) things to write. Empty = nothing to do. */
  changes: Change[];
  /** Reasons --apply must refuse. Always reported, so a dry run shows what would block. */
  blockers: string[];
  /** Does upstream hold a newer VTA/VTC release than the pin? (drives the weekly workflow) */
  updateAvailable: boolean;
  vta?: TagInfo;
  vtc?: TagInfo;
  mediator?: { ref: string; version: string };
  /** The working tree being dirty blocks --apply only, so a dry run in a work-in-progress tree still reports. */
  dirty: boolean;
}

function pickTag(tags: TagInfo[], service: string, want: string | undefined, blockers: string[]): TagInfo | undefined {
  if (want) {
    const t = tags.find((x) => x.tag === want);
    if (!t) blockers.push(`tag ${want} not found upstream (${tags.length} ${service}-v* release tags seen)`);
    return t;
  }
  const t = tags[tags.length - 1];
  if (!t) blockers.push(`no ${service}-v<x.y.z> release tag found upstream`);
  return t;
}

export function plan(o: PlanOptions): Plan {
  const { pins: p } = o;
  const blockers: string[] = [];
  const changes: Change[] = [];
  const schema = validatePins(p);
  for (const s of schema) blockers.push(`pins.json schema: ${s}`);
  if (schema.length) return { changes, blockers, updateAvailable: false, dirty: o.dirty.trim() !== "" };

  let vta: TagInfo | undefined, vtc: TagInfo | undefined;
  let out = "";
  try { out = o.lsRemote(p.vti.repo); } catch (e) { blockers.push(`could not list upstream tags (${p.vti.repo}): ${(e as Error).message}`); }
  if (out !== "" || blockers.length === 0) {
    vta = pickTag(releaseTags(out, p.vti.vta.service), p.vti.vta.service, o.vtaTag, blockers);
    vtc = pickTag(releaseTags(out, p.vti.vtc.service), p.vti.vtc.service, o.vtcTag, blockers);
  }

  let updateAvailable = false;
  if (vta && vtc) {
    // The VTA and VTC are built from one commit: two tags that resolve elsewhere cannot be pinned together.
    if (vta.ref !== vtc.ref) blockers.push(`${vta.tag} (${vta.ref.slice(0, 8)}) and ${vtc.tag} (${vtc.ref.slice(0, 8)}) resolve to different commits; they are built from one commit, so wait for a matching pair or pass --vta-tag/--vtc-tag for a pair that shares a commit`);
    for (const [name, cur, next] of [["vta", p.vti.vta, vta], ["vtc", p.vti.vtc, vtc]] as const) {
      const c = compareVersions(next.version, cur.version);
      if (c > 0) updateAvailable = true;
      if (c < 0 && !o.allowDowngrade) blockers.push(`${name} ${cur.version} -> ${next.version} is a downgrade; pass --allow-downgrade if that is intended`);
      if (c === 0 && next.ref !== cur.ref) blockers.push(`${next.tag} now resolves to ${next.ref.slice(0, 8)} but pins.json has ${cur.ref.slice(0, 8)}: the tag moved upstream; investigate before pinning`);
      if (c !== 0) {
        changes.push({ what: `vti.${name}.tag`, from: cur.tag, to: next.tag });
        changes.push({ what: `vti.${name}.version`, from: cur.version, to: next.version });
      }
      if (next.ref !== cur.ref && c !== 0) changes.push({ what: `vti.${name}.ref`, from: cur.ref, to: next.ref });
    }
  }

  let mediator: Plan["mediator"];
  if (o.mediator) {
    const m = p.messaging.mediator;
    let ref = o.mediator.ref, version = o.mediator.version;
    if (SHA.test(ref)) {
      if (!version || !SEMVER.test(version)) blockers.push("--mediator <commit> also needs --mediator-version <x.y.z>");
    } else if (/^v\d+\.\d+\.\d+$/.test(ref)) {
      let mout = "";
      try { mout = o.lsRemote(m.repo); } catch (e) { blockers.push(`could not list mediator tags (${m.repo}): ${(e as Error).message}`); }
      const sha = parseLsRemote(mout).get(ref);
      if (!sha) blockers.push(`mediator tag ${ref} not found upstream`);
      else { version = ref.slice(1); ref = sha; }
    } else blockers.push(`--mediator "${ref}" is neither a vX.Y.Z tag nor a 40-character commit`);
    if (SHA.test(ref) && version && SEMVER.test(version)) {
      if (compareVersions(version, m.version) < 0 && !o.allowDowngrade) blockers.push(`mediator ${m.version} -> ${version} is a downgrade; pass --allow-downgrade if that is intended`);
      if (ref !== m.ref || version !== m.version) {
        mediator = { ref, version };
        changes.push({ what: "messaging.mediator.version", from: m.version, to: version }, { what: "messaging.mediator.ref", from: m.ref, to: ref });
      }
    }
  }
  return { changes, blockers, updateAvailable, vta, vtc, mediator, dirty: o.dirty.trim() !== "" };
}

/** Blockers that stop --apply: the plan's own, plus a dirty working tree. */
export const applyBlockers = (pl: Plan): string[] => [...pl.blockers, ...(pl.dirty ? ["the working tree is not clean; commit or stash first so the pin change is its own diff"] : [])];

const esc = (s: string) => JSON.stringify(s).slice(1, -1);

/** Replace `"key": "<old>"` at its first occurrence after the anchors (bounded: before the next `}`, i.e. a flat block); throws if the shape is not what we expect. */
function setInBlock(text: string, anchors: string[], key: string, value: string, bounded = true): string {
  let from = 0;
  for (const a of anchors) {
    const i = text.indexOf(a, from);
    if (i < 0) throw new Error(`pins.json: "${a.trim()}" not found`);
    from = i;
  }
  const end = bounded ? text.indexOf("}", from) : text.length;
  const re = new RegExp(`("${key}"\\s*:\\s*")[^"]*(")`);
  const seg = text.slice(from, end);
  if (!re.test(seg)) throw new Error(`pins.json: key "${key}" not found after ${anchors[anchors.length - 1].trim()}`);
  return text.slice(0, from) + seg.replace(re, (_m, a, b) => `${a}${esc(value)}${b}`) + text.slice(end);
}

/** Rewrite pins.json text for a plan, touching only the changed keys plus the dates and the `why` of what moved. Output is re-validated. */
export function applyPlan(text: string, pl: Plan, today: string): string {
  let t = text;
  const vti = ['"vti"'];
  const has = (w: string) => pl.changes.some((c) => c.what === w);
  for (const k of ["vta", "vtc"] as const) {
    const info = pl[k];
    if (!info) continue;
    if (has(`vti.${k}.tag`)) t = setInBlock(t, [...vti, `"${k}"`], "tag", info.tag);
    if (has(`vti.${k}.version`)) t = setInBlock(t, [...vti, `"${k}"`], "version", info.version);
    if (has(`vti.${k}.ref`)) t = setInBlock(t, [...vti, `"${k}"`], "ref", info.ref);
  }
  if (pl.vta && pl.vtc && (has("vti.vta.tag") || has("vti.vtc.tag"))) {
    t = setInBlock(t, vti, "pinnedOn", today, false);
    t = setInBlock(t, vti, "why", `Advanced to ${pl.vta.tag} and ${pl.vtc.tag} (commit ${pl.vta.ref.slice(0, 8)}) by npm run pins:update. UNVERIFIED: the gate (docs/PINS.md) has not been run yet.`, false);
  }
  if (pl.mediator) {
    t = setInBlock(t, ['"messaging"', '"mediator"'], "ref", pl.mediator.ref);
    t = setInBlock(t, ['"messaging"', '"mediator"'], "version", pl.mediator.version);
    t = setInBlock(t, ['"messaging"'], "pinnedOn", today, false);
  }
  if (t !== text) t = setInBlock(t, [], "updated", today, false);
  const bad = validatePins(JSON.parse(t));
  if (bad.length) throw new Error(`the rewritten pins.json would be invalid: ${bad.join("; ")}`);
  return t;
}

/** The commands to run after --apply, in order. */
export const GATE_COMMANDS = [
  "npm run images:build -- all",
  "WITH_VTC=1 npm run up",
  "npm run e2e",
  "npm run test:roles",
  "npm run hello",
] as const;

export const followUp = (): string =>
  ["Next, the gate (nothing is verified yet). Either run `npm run pins:verify` (needs Docker; bounded timeouts), or by hand:", ...GATE_COMMANDS.map((c) => `  ${c}`), "Then `npm test`, `npm run typecheck`, review the diff, and commit; see docs/PINS.md."].join("\n");

/** A PINS_LOG.md line for an applied-but-unverified change. */
export function unverifiedLogEntry(pl: Plan, from: { vta: string; vtc: string; mediator: string }, today: string): string {
  const parts: string[] = [];
  if (pl.vta && pl.vtc) parts.push(`VTA ${from.vta} -> ${pl.vta.version}, VTC ${from.vtc} -> ${pl.vtc.version} (commit \`${pl.vta.ref.slice(0, 8)}\`)`);
  if (pl.mediator) parts.push(`mediator ${from.mediator} -> ${pl.mediator.version} (\`${pl.mediator.ref.slice(0, 8)}\`)`);
  return `- **${today}** · Pins advanced by \`npm run pins:update\`: ${parts.join("; ")}. UNVERIFIED: the gate (images:build, up, e2e, test:roles, hello) has not been run. Replace this line with the \`pins:verify\` output once it passes.`;
}

export const appendLog = (log: string, entry: string): string => `${log.endsWith("\n") ? log : log + "\n"}${entry}\n`;
