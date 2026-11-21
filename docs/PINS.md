# Pins

Part of the [docs index](README.md). How the pieces fit: [ARCHITECTURE.md](ARCHITECTURE.md).

`pins.json` records the versions this kit was last validated against: the
verifiable-trust-infrastructure (VTI) refs that the VTA and VTC images are built from, and exact npm versions (no `^`; `.npmrc` sets
`save-exact`, `package-lock.json` is committed). Upstream moves fast; without pins a
participant's or organiser's rebuild silently changes the wire behaviour.

```sh
npm run setup                        # build the images your mode needs and that are missing (= images:build needed); the usual first command
npm run images:build [vta|vtc|mediator|all]   # build each image from its own pinned ref; tags <image>:<ref8>, <image>:<version>-<ref8> and :local (`all` = vta + vtc; the mediator is for MODE=tunnel only)
npm run images:pull [vta|vtc|mediator|all]   # the prebuilt, signed images from ghcr.io/bmiller59, by the digest in pins.json (images.available is true); then tagged locally <image>:<ref8> and <image>:<version>-<ref8>, never :local
npm run images:verify [-- vta|vtc|mediator|all]   # is it the pinned, signed image? see VERIFY.md
npm run pins:check [-- --strict]     # report drift; changes nothing
```

**Pull first; build locally as the fallback.** `pins.json` `images.available` is `true`: the 0.83/0.31 images are published under the new names (vta, vtc, mediator; published and attested 2026-11-20; live-gated in MODE=local the same day). The images are published at `ghcr.io/bmiller59` (public, signed and attested by this repository's workflow, digests recorded in `pins.json`), so `npm run up` pulls the pinned image by digest when no image is present and `npm run images:pull` fetches them ahead of time ([IMAGES.md](IMAGES.md)).
The tags come from the pin: `<ref8>` (the first 8 characters of the pinned ref) and `<version>-<ref8>`; a bump changes both ([IMAGES.md](IMAGES.md#image-names-and-tags)). Building locally (the commands below) remains supported, for an unsupported CPU architecture, no network, or a pin that has not been published yet.

`images:build` exports each pinned ref from a VTI checkout (`VTI_PATH`, default
`../verifiable-trust-infrastructure`) with `git archive`, so whatever is checked out
there is irrelevant. `VTI_LOCAL=1` builds that checkout's working tree instead (for
development; tagged `:local` only). Images carry the label `org.buildathon.vti-ref`.
**Digests.** They are in use whenever `images.available` is `true` (it is `false` between a pin bump and the next publish, with every digest `null`, which is the designed state): `images:pull` and `up` pull by digest, and `pins:check` compares a pulled copy's digest and labels with the pin. If a digest is `null` (a pin advance that has not been published yet), the image is pulled by a movable tag and `pins:check` prints a `WARN`. After a workflow run, record the digests, and `images:verify` can check them against the signature ([VERIFY.md](VERIFY.md)).

`pins:check` compares, per image, the label, the binary's own `--version`, that the release tag still resolves to the pinned ref, a running VTC's
`/health` version, the lockfile against `pins.json`, and the newest upstream
`vta-service-v*` / `vtc-service-v*` tags and `npm outdated`. It is read-only.

## Where the images come from

**Current decision: pull the prebuilt images; build locally as the fallback.** The images are published at `ghcr.io/bmiller59` (public). `pins.json` `images.available` (`true`, with a one-line `why`) is the single switch: while it is `true`, `IMAGES=auto` uses the pinned registry image if present, else a local build, else pulls it by digest; set to `false`, `IMAGES=auto` means local and nothing is pulled.
The publish workflow (`.github/workflows/images.yml`; real push runs on 2026-11-20 built and pushed all three images with attest and sign succeeding; [PINS_LOG.md](../PINS_LOG.md)), the verification tooling (`npm run images:verify`) and the digest fields are in use. After advancing a pin, re-run the workflow, record the new digests, and run `images:verify`; until then the new pin has no prebuilt image and everyone builds it locally ([IMAGES.md](IMAGES.md)). This is the one place that says so; the other docs link here, so if the status changes, change this section, the `images.available` switch and the `Prerequisites` bullet in the README.

The local-build cold path, exactly (Linux, 12 cores, Docker; the times below were measured on a 12-core desktop; requirements and laptop estimates are in [IMAGES.md](IMAGES.md#build-requirements)):

```sh
# 1. The upstream repository, next to this one (the URL is `vti.repo` in pins.json). `images:build` asks before cloning in a terminal,
#    prints these two commands otherwise, and does it for you only with `npm run images:build -- --clone`.
git clone https://github.com/OpenVTC/verifiable-trust-infrastructure ../verifiable-trust-infrastructure
git -C ../verifiable-trust-infrastructure fetch --tags origin     # the pinned refs must be present
# 2. Build what you need, in one command: `npm run setup` (local: VTA + VTC; `-- --tunnel` adds the mediator). Or one at a time (each image is exported from its own pinned ref; niced; the first build is the slow one)
npm run images:build vta        # 12 to 25 min cold on a 12-core desktop (Rust); local mode needs this
npm run images:build vtc        # about 8 min with warm caches, about 23 min cold; only for WITH_VTC=1 and the community
npm run images:build mediator   # about 12 min cold, tunnel mode only; also needs `cloudflared`
```

Budget disk, RAM and cores as in [Build requirements](IMAGES.md#build-requirements) (20 GB or more free disk; the build warns below 4 GB of available memory for the VTA and VTC and below 8 GB for the mediator, and refuses below 10 GB free disk or 4 GB engine memory unless `--force`). If the checkout is somewhere else, set `VTI_PATH`.
The mediator comes from its own repository (`messaging.mediator.repo` in pins.json), which the Dockerfile fetches itself, so no checkout is needed for it.
`npm run doctor` lists which images and which VTI checkout are missing, with the exact build command and its time first. Images you built can be copied to another machine of the same CPU architecture
with `npm run images:export` / `images:import` (`docker save` / `docker load`; [IMAGES.md](IMAGES.md#sharing-images-you-built), [EVENT.md](EVENT.md)).

## What is pinned now

One ref: the 0.83 release commit (`3ee07a12`) is both `vta-service-v0.83.0` and `vtc-service-v0.31.0` (the earlier pins were two refs, matched to the Farm):

| Image | Tag | Ref | Why |
|---|---|---|---|
| `vta` | `vta-service-v0.83.0` | `3ee07a12` | Advanced from 0.72.0 on 2026-11-20 by `pins:update`. Verified 2026-11-20: `pins:verify -- --images pull` passed in MODE=local (not MODE=tunnel, not `farm:*`) after the `acl/grant/0.3` client change (see below). Not what the Farm ran when last observed (0.65.0). |
| `vtc` | `vtc-service-v0.31.0` | `3ee07a12` | The VTC cut from the same release commit as the VTA (was 0.20.0). The VTC Trust Task surface the kit uses is unchanged in this range (additive only). |

For `MODE=tunnel` ([MODES.md](MODES.md)) there are more pins, in `pins.json` under `messaging`:

| What | Pin | Why |
|---|---|---|
| `mediator` | affinidi-messaging-mediator `e6e2c636` (tag v0.48.0; pins.json is authoritative), features `tsp,secrets-aws` | The mediator release the VTA 0.72.0 lockfile names (was v0.45.0 `7e378c03` for VTA 0.65.0); it reads TSP 1.0 like the VTA and VTC (the earlier pin, affinidi-tdk-rs `55580615` / v0.33.1, read only Rev 3); built from `docker/mediator.Dockerfile` (heavy: see MODES.md). |
| `redis` | `7.4.6-alpine` | In-memory queue store for the mediator. |
| `cloudflared` | validated 2024.6.1 (host binary, not pinned) | Quick tunnels. |
| VTA build features | `setup,rest,didcomm,tsp,cli-synthesis,aws-secrets,webvh` | The VTI default has no `tsp`; the VTA then refuses `services.tsp = true`. |

Farm participants must pick an image the Farm offers that matches the pin; the last verified Farm image is `0.72.0-26d0da81` (ic3, 2026-11-08), which is **no longer this kit's pin** (the kit now targets 0.83.0), so the Farm path is unverified for this pin. Never the portal default (0.56.0).
`npm run farm:check` and `farm:canary` compare the deployed agent's `/openapi.json` `info.version` with this pin and warn loudly.

## To do: version negotiation in the clients

The clients hard-code Trust Task versions (`vta-client`: `acl/grant/0.3`, `trust-task-discovery/0.3` (moved from 0.1 for the 0.72 pin, so it no longer works against a 0.65 VTA such as the Farm's), `auth/*`;
`vtc-client`: manifest 0.4 with a 0.3 fallback, list 0.2 with a 0.1 fallback). They should ask the peer what it serves
(trust-task discovery, or the OpenAPI document) and pick the highest common version, so one kit works across Farm
releases (a 0.67 VTA already drops `acl/grant/0.1` and `trust-task-discovery/0.1`) instead of being fixed to one pin.
Until then, the pins plus the canary's version warning are the guard.

## Bump to 0.83/0.31: expected breakage

**Outcome (2026-11-20).** Finding 1 (and 2) was a real hard break and is fixed: the clients send `acl/grant/0.3` with `purposes: {scope:"any"}` on every entry; the live gate (MODE=local: provisioning, the `vtc:up` hand-off grant, e2e, test:roles, hello) then passed against VTA 0.83.0 / VTC 0.31.0. Findings 12 (rooms) and 13 (mediator 0.52.0, `messaging/wake`) were NOT exercised: the local stack has no room and no mediator, so they stay unverified until a MODE=tunnel run. The text below is the original static survey.

Static survey only (nothing was run): this repo's hard-coded versions and config against the upstream source at the old and new pin
(`git archive` of `26d0da81` and `3ee07a12`; dispatch tables in `vta-service/src/trust_tasks/mod.rs`, the `vti-specs-*` locks and bundles,
the setup `from_toml.rs` files). **Hard break** = will fail; **additive** = new things only; **needs live verification** = a wire-protocol change
in a client that was deliberately not guessed.

| # | Finding | This repo | Upstream | Kind |
|---|---|---|---|---|
| 1 | The VTA no longer dispatches `acl/grant/0.2` (nor `acl/list/0.3`, `show`, `update`, `revoke`, `change-role` 0.2); only `acl/grant/0.3`, `list/0.4`, `show|update|revoke|change-role/0.3` | `packages/vta-client/src/client.ts:27` (`aclGrant`), `grantAcl` at :277, `grantHandoff` at :295, the approvals-demo grant at :318; `packages/status-panel/src/parse.ts:99` (doc example only) | `vta-service/src/trust_tasks/mod.rs:2607-2617` (old `:3837` served 0.2); `vti-specs-core/trust-tasks/acl/grant/0.3.bundle.json` | **Hard break, needs live verification.** Every `grantAcl` / `grantHandoff` (provisioning, `vtc:up`) fails with an unsupported-version refusal. In the 0.3 schema `AclEntry` gains a **required** `purposes` field (`{scope:"any"}` or `{scope:"listed", purposes:[...]}`), plus `purposes` error details. **Fixed 2026-11-20:** `TASK.aclGrant` is 0.3 and every entry carries `purposes: {scope:"any"}` (any purpose except `modelTraining`; confirmed by the live gate), with fakes in `packages/vta-client/test/client.test.ts`. |
| 2 | `vtc-up.ts` grants the VTC's setup key with the hand-off marker over the same `acl/grant` | `scripts/vtc-up.ts:45`, `packages/vta-client/src/client.ts:296` | `acl.rs:330` (hand-off rollover rides `acl/grant`, now also behind the central PDP gate) | Same fix as 1 (live gate: `vtc:up` hand-off granted and the VTC finished setup); the hand-off `ext["org.openvtc.handoff"]` semantics need a live check |
| 3 | VTC Dockerfile pinned `rust:1.95`; upstream now builds with a root `rust-toolchain.toml` (`1.100.0`, MSRV still 1.95.0) | `docker/vtc.Dockerfile` (`RUST_VERSION`) | `rust-toolchain.toml`, `Dockerfile:45` | **Fixed here** (`RUST_VERSION=1.100.0`, test in `scripts/test/bump-survey.test.ts`). Without it rustup would fetch 1.100.0 anyway at build time, slowly. |
| 4 | New default VTA feature `webs` (did:webs, alpha); the kit's `features` list is explicit and does not include it | `pins.json vti.vta.features` | `vta-service/Cargo.toml` `default = [..., "webs"]` | Additive. Left out on purpose (the kit does not use did:webs); every feature in the list still exists. |
| 5 | The VTA's own `FEATURES` default now reads `setup,rest,didcomm,cli-synthesis,aws-secrets,webvh` and `cli-synthesis` pulls `vta-cli-common`/`dialoguer` | `scripts/images-build.ts:143` | upstream `Dockerfile:80` | Additive, no change. |
| 6 | VTA/VTC first-boot setup files: no key the entrypoints write was removed or renamed (`vta_name`, `admin_did`, `admin_label`, `[server] rate_limit_*`/`cors_origins`, `[secrets] backend = "plaintext"` (still sets `allow_plaintext`), `[messaging]`, `[services]`, `[vta_did]`; VTC `provision_transport`, `single_admin_mode`, `setup_key_file`, `[messaging]`) | `vta-entrypoint.sh:56-95`, `vtc-entrypoint.sh:60-80` | `vta-service/src/setup/from_toml.rs`, `vtc-service/src/setup/from_toml.rs` | Additive only (VTA `create_webs` DID kind, VTC `identity_method`, default `webvh`). `vtc setup --from`, `vtc acl add --did --role --label` and the `[cors]`/`[policy]` lines the entrypoints edit are unchanged. |
| 7 | `vtc setup --from` no longer prints the admin key in non-interactive mode (prints `admin_key_file=`) | not used by the kit (the key is the kit's own) | `vtc-service/src/setup/from_toml.rs` (#2703) | Additive. |
| 8 | VTA REST routes for acl/audit/config/contexts/did_templates/keys, `/bootstrap/provision-integration` and the `/api/trust-tasks` spelling were deleted | the kit's clients use `/trust-tasks` (VTA), `/v1/trust-tasks` (VTC), `/health`, `/.well-known/did.jsonl`, `/openapi.json` | `vta-service/src/deprecation.rs`, `routes/mod.rs:321` | None of the routes the kit calls is among them. `farm-lib.ts` still probes `/api/health`; it is a Farm-only fallback. |
| 9 | `trust-task-discovery` is served at 0.3 and 0.4 | `packages/vta-client/src/client.ts:21` (0.3) | `mod.rs:2796-2798` | OK (additive). |
| 10 | `task-consent/decision/0.2`, `task-consent/request/0.1`, `auth/authenticate/0.3`, `auth/whoami/0.1`, `vta/contexts/*/1.0`, `vta/webvh/*`, `keys/sign-document/0.1`, `vta/memory/{put,list}/0.1`, `rooms/keys/act/0.8`, `rooms/keys/{list,open,seal,present,key-package,welcome,commit}`, `messaging/ping/0.2` | `packages/vta-client`, `scripts/lib/tasks.ts`, `packages/rooms-client/src/tasks.ts`, `packages/tsp-client/src/ping.ts` | still dispatched in the new VTA (`mod.rs`) | Unchanged; newer versions added beside them (`memory/*` 0.2/0.3, `rooms/keys/act` 0.9-0.12, `rooms/keys/{list,open,seal}` 0.3). Additive. |
| 11 | `vtc/*` tasks the kit sends (`join-requests`, `members`, `groups`, `directory`, `community`, `relationships`, `rooms/offers|memberships`) | `packages/vtc-client/src/index.ts:25-72` | `vti-specs-vtc/trust-tasks.lock`: every version pinned at 0.72/0.20 is still pinned; the additions are `vtc/badges/*` and similar (`vtc/networks/*` 0.1 no longer appears in the VTC source, which the kit does not use) | Additive for what the kit uses (the kit does not use `vtc/networks/*`). |
| 12 | `rooms/*` (create, info, records, blobs, epoch, keys) gained versions (`create/0.3`, `info/0.4-0.5`, `records/get 0.3-0.4`, `list 0.6-0.8`, `put 0.5`, `keys/act 0.9-0.12`) and the room host marks older versions deprecated (`#[allow(deprecated)]` on `records/put/0.3`) | `packages/rooms-client/src/tasks.ts:8-34`, `packages/rooms-client/src/vta-keys.ts:59` (the 0.72.0 epoch quirk), `docs/ROOMS.md` | `room-host/src/files.rs`, `vti-specs-rooms` lock | **Needs live verification.** Old versions are still pinned, but deprecation can turn into removal; the 0.72 "commit tracker one epoch behind" workaround may be fixed or changed. |
| 13 | The mediator: the 0.83 VTA lockfile names `affinidi-messaging-mediator` **0.52.0** (0.72 named 0.48.0, the kit's pin), `affinidi-tdk` 0.45, trust-tasks 0.39; new `messaging/wake/*` and `messaging/receipt/0.1` tasks (delivery receipts, mediator wake) | `pins.json messaging.mediator` (0.48.0, ref `e6e2c636`), `docker/mediator.Dockerfile`, `packages/tsp-client` | `Cargo.lock`, `vta-service/CHANGELOG.md` (#2741) | **Needs live verification (MODE=tunnel).** `pins:update` did not propose a mediator change, so it is unchanged; moving to 0.52.0 needs a commit pin and a tunnel run. TSP stays 1.0 (`affinidi-tsp` 0.3.0). |
| 14 | New policy/approval machinery (central PDP gate on `acl/grant`, step-up) | `vta-entrypoint.sh:101-125` (the approvals demo edits `[policy]`) | `vta-config/src/lib.rs`, `trust_tasks/policy_gate.rs` | The `[policy]` field names used by the demo (`taskType`, `requires`, `approverSet`, `minApprovals`, `excludeRequester`) are unchanged. Whether the default policy gates the kit's own `acl/grant` needs the live gate. |
| 15 | `@openvtc/trust-tasks` is 0.28.1 here; the upstream Rust crate is 0.39 | `pins.json npm` | `Cargo.lock` | Not comparable (different packages). Not changed. |

What the gate will do: `images.available` is `false`, so `pins:verify --images auto` (and `.github/workflows/pins-gate.yml`) builds the VTA and VTC
from the pinned refs; an explicit `--images pull` fails closed (null digests). The build should succeed; expect the gate to fail first at
`vta:provision` / `vtc:up` on finding 1, which is the intended signal.

## Advancing (never automatic)

Advancing is scripted but always deliberate: nothing changes a pin unless a person runs `--apply`, and nothing is logged as verified until the live gate has passed.

```sh
npm run pins:check                        # 1. report drift and the newest upstream tags; read the upstream changes you would take
npm run pins:update                       # 2. dry run (default): prints the proposed pins.json changes and anything that would block them
npm run pins:update -- --apply [--log]    # 3. write pins.json; --log also appends an UNVERIFIED entry to PINS_LOG.md
npm run pins:verify                       # 4. the live gate (Docker): build, up, e2e, cooldown, test:roles, hello; prints a PINS_LOG line only if all pass
                                          #    (CI runs the same gate on the pull request: see "The gate in CI" below)
```

`pins:update` finds the newest `vta-service-v*` and `vtc-service-v*` release tags (`git ls-remote` on `vti.repo`), resolves each to its commit and proposes `tag`, `version` and `ref` for both, plus `pinnedOn`, `updated` and an "unverified" `why`.
Options: `--vta-tag` / `--vtc-tag` pin specific release tags; `--mediator <vX.Y.Z | commit>` (a bare commit also needs `--mediator-version`) moves the mediator pin; `--allow-downgrade`; `--json` prints the plan for tooling.
The npm exact pins and the redis tag are not touched by the script: change them by hand in `pins.json`, then `npm install` (keep them exact).
`--apply` **refuses** (exit 1, `pins.json` untouched) when: the working tree is dirty; the VTA and VTC tags resolve to different commits (they are built from one commit); a tag is not found upstream (or a released tag has moved); it is a downgrade without `--allow-downgrade`; or `pins.json` fails its schema check. A dry run prints the same `BLOCKED:` lines.
After `--apply` it prints the gate commands, so you cannot forget them:

```sh
npm run images:build -- all
WITH_VTC=1 npm run up
npm run e2e
npm run test:roles
npm run hello
```

`pins:verify` runs exactly those, with one addition: a `cooldown` pause (`sleep 60`) between `e2e` and `test:roles` (niced, each with a hard timeout, stops at the first failure, always runs `npm run down` afterwards) and needs Docker; `--plan` lists the steps without running anything. The pause exists because e2e leaves the VTC's per-address admission budget spent (anonymous bucket: burst 10, then one token per 5 s, so 50 s to refill; observed: `test:roles` failed within a second of e2e with `rate limited ... the pacing is too fast`). `--cooldown <secs>` or `PINS_COOLDOWN_SECS` changes it (0 removes it). `test:roles` also retries a 429 itself, per the VTC's `retryAfterSecs` (at most 3 retries a call, 120 s waited in all, logged, any other error fails at once), so a slow or shared VTC does not flake the gate but a stuck limiter still fails it. `--images pull|auto` replaces the build with pulling the pinned VTA and VTC by digest plus `images:verify` (see below); the default stays `build`. It never edits files: on all-pass it prints one ready-to-paste line for [PINS_LOG.md](../PINS_LOG.md), which replaces the UNVERIFIED line `--log` wrote.
The gate covers `MODE=local` only; `MODE=tunnel` (mediator) and `farm:*` still need the manual checks below when you move those pins.

Then, by hand:

1. `npm test` and `npm run typecheck`; fix whatever broke (this is where the starter's scripts and docs change), and update the verified/unverified notes in [VTC.md](VTC.md) and [STATUS.md](STATUS.md).
2. `npm run farm:probe` and read the [farm note](FARM.md#farm-versions-observed).
3. Review the diff, commit (pin change, log line and doc changes together).
4. Rebuild and republish the images: run the `images` workflow and record the new digests in `pins.json` ([IMAGES.md](IMAGES.md), [EVENT.md](EVENT.md)). Until a digest is recorded, `pins:check` says so.

## Reclaiming disk after a bump

Each pin bump builds new images and leaves the old ones (about 180-200 MB each) beside them, plus the BuildKit cache (about 12 GB observed). After `pins:update` and `pins:verify` (which prints a "N superseded images" hint when there are any), run `npm run clean` to see them and `npm run clean -- images --apply` to remove the superseded images; the current pin's two tags (`<ref8>` and `<version>-<ref8>`) and `:local` stay. Clearing the build cache makes the next build cold ([times](IMAGES.md#build-requirements)), so it is not part of a routine clean. All scopes and sizes: [IMAGES.md](IMAGES.md#reclaiming-disk).

## The gate in CI

`.github/workflows/pins-gate.yml` runs `npm run pins:verify` on every pull request that changes `pins.json`, `docker/**`, `docker-compose.yml`, `scripts/pins-*.ts`, `scripts/lib/pins-*.ts` or the workflow itself (and on demand, `workflow_dispatch`). A pin bump therefore cannot merge without e2e proof once the check is required. Status: written and statically checked, never run on GitHub; the first run is the real test.

- **Required-check safe.** There is no path filter on the trigger (a required check skipped by a filter never reports and blocks the merge). A cheap `changes` job decides, and the final `pins-gate` job always runs: it passes when the live gate passed, or when nothing the gate covers changed; it fails when the gate failed, was cancelled, or was skipped although needed. Mark **`pins-gate`** as the required check (below).
- **Where the images come from** (`pins:verify --images auto`, printed in the job summary): when `pins.json` `images.available` is `true`, the VTA and VTC are pulled **by the digests in `pins.json`** and checked with `npm run images:verify` (GitHub attestation and cosign keyless signature) before anything starts, and the stack runs with `IMAGES=registry`; a missing digest or a failed verification fails the gate (no fallback to a tag or a build). While `available` is `false` (today) the gate builds from the pinned upstream refs (`images:build`, amd64 only) from a checkout of the VTI repository at the pinned commit. Cold build, no layer cache: expect a long run (the job timeout is 170 minutes; the build step alone is capped at 90).
- **Runner limits.** A GitHub-hosted `ubuntu-24.04` runner in a public repository has 4 vCPU, 16 GB RAM and 14 GB SSD (per GitHub's documentation; a private repository gets 2 vCPU and 8 GB), below the 20 GB of free disk a comfortable build wants ([Build requirements](IMAGES.md#build-requirements)). The job removes preinstalled toolchains to free disk, adds 16 GB of swap on `/mnt` (as `images.yml` does) and raises `images:build`'s cap to `BUILD_MEMORY=12g`, `BUILD_CPUS=4`. The Rust LTO links are shown to fit this setup (12g cap, 16 GB swap) for the VTA and VTC by two `images.yml` dry runs (44659883519 and 44663168210, about 26 to 29 minutes per leg); this workflow itself has not run.
- **After a run.** Failure uploads `pins-gate-logs` (gate output, `docker ps`, container logs); `npm run down` always runs. The PINS_LOG line the gate prints is in the job log: paste it into the PR (it names the image source used).
- **One-time manual step (needs repo admin; not done by any workflow).** After the first green run, require the check on `main`. This replaces the protection settings, so read the current ones first (`gh api repos/bmiller59/openvti-starter/branches/main/protection`); if none exist, the simplest form is:

  ```sh
  gh api -X PATCH repos/bmiller59/openvti-starter/branches/main/protection/required_status_checks \
    -F strict=true -f 'contexts[]=test' -f 'contexts[]=pins-gate'
  ```

  The `contexts` list is replaced, not appended: `test` is the `ci` workflow's job, `pins-gate` the new one (check names are job names). That PATCH only works when `main` already has required status checks configured; otherwise create the protection with `gh api -X PUT repos/bmiller59/openvti-starter/branches/main/protection` and a JSON body that includes `required_status_checks` (`{"strict":true,"contexts":["test","pins-gate"]}`), `enforce_admins`, `required_pull_request_reviews` and `restrictions` (use `null` for the ones you do not want).  For a repository ruleset use "Require status checks" with `pins-gate`.

**Weekly reminder.** `.github/workflows/pins-bump.yml` runs `pins:update` as a dry run every Monday (and on demand) and opens one issue when a newer VTA/VTC release exists (the issue points at the gate above). It never edits `pins.json`, opens a pull request or merges.

**Known gap: base images.** The Dockerfiles' base images (the Rust and runtime stages, in `docker/*.Dockerfile` and the VTI Dockerfile they build from) are not pinned by digest and are not covered by `pins.json` or `pins:update`. A rebuild can pick up a newer base image. Pin them by digest if you need bit-for-bit rebuilds.

Pins are what was last validated, advance deliberately and say why.
