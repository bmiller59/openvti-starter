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

**Pull first; build locally as the fallback.** `pins.json` `images.available` is `true`: the images are published at `ghcr.io/bmiller59` (public, signed and attested by this repository's workflow, digests recorded in `pins.json`), so `npm run up` pulls the pinned image by digest when no image is present and `npm run images:pull` fetches them ahead of time ([IMAGES.md](IMAGES.md)).
The tags come from the pin: `<ref8>` (the first 8 characters of the pinned ref) and `<version>-<ref8>`; a bump changes both ([IMAGES.md](IMAGES.md#image-names-and-tags)). Building locally (the commands below) remains supported, for an unsupported CPU architecture, no network, or a pin that has not been published yet.

`images:build` exports each pinned ref from a VTI checkout (`VTI_PATH`, default
`../verifiable-trust-infrastructure`) with `git archive`, so whatever is checked out
there is irrelevant. `VTI_LOCAL=1` builds that checkout's working tree instead (for
development; tagged `:local` only). Images carry the label `org.buildathon.vti-ref`.
**Digests.** They are in use now (`images.available` is `true`): `images:pull` and `up` pull by digest, and `pins:check` compares a pulled copy's digest and labels with the pin. If a digest is `null` (a pin advance that has not been published yet), the image is pulled by a movable tag and `pins:check` prints a `WARN`. After a workflow run, record the digests, and `images:verify` can check them against the signature ([VERIFY.md](VERIFY.md)).

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

One ref: the 0.72 release commit is both `vta-service-v0.72.0` and `vtc-service-v0.20.0` (the earlier pins were two refs, matched to the Farm):

| Image | Tag | Ref | Why |
|---|---|---|---|
| `vta` | `vta-service-v0.72.0` | `26d0da81` | Advanced from 0.65.0 on 2026-11-04. **Not yet re-validated end to end, and not what the Farm ran when last observed (0.65.0).** |
| `vtc` | `vtc-service-v0.20.0` | `26d0da81` | The VTC cut from the same release commit as the VTA. Previously 0.15.0 (`93d36996`), which a Farm VTC ran when observed. |

For `MODE=tunnel` ([MODES.md](MODES.md)) there are more pins, in `pins.json` under `messaging`:

| What | Pin | Why |
|---|---|---|
| `mediator` | affinidi-messaging-mediator `e6e2c636` (tag v0.48.0; pins.json is authoritative), features `tsp,secrets-aws` | The mediator release the VTA 0.72.0 lockfile names (was v0.45.0 `7e378c03` for VTA 0.65.0); it reads TSP 1.0 like the VTA and VTC (the earlier pin, affinidi-tdk-rs `55580615` / v0.33.1, read only Rev 3); built from `docker/mediator.Dockerfile` (heavy: see MODES.md). |
| `redis` | `7.4.6-alpine` | In-memory queue store for the mediator. |
| `cloudflared` | validated 2024.6.1 (host binary, not pinned) | Quick tunnels. |
| VTA build features | `setup,rest,didcomm,tsp,cli-synthesis,aws-secrets,webvh` | The VTI default has no `tsp`; the VTA then refuses `services.tsp = true`. |

Farm participants must pick the image `0.72.0-26d0da81` (offered on ic3, verified 2026-11-08), never the portal default (0.56.0).
`npm run farm:check` and `farm:canary` compare the deployed agent's `/openapi.json` `info.version` with this pin and warn loudly.

## To do: version negotiation in the clients

The clients hard-code Trust Task versions (`vta-client`: `acl/grant/0.2`, `trust-task-discovery/0.3` (moved from 0.1 for the 0.72 pin, so it no longer works against a 0.65 VTA such as the Farm's), `auth/*`;
`vtc-client`: manifest 0.4 with a 0.3 fallback, list 0.2 with a 0.1 fallback). They should ask the peer what it serves
(trust-task discovery, or the OpenAPI document) and pick the highest common version, so one kit works across Farm
releases (a 0.67 VTA already drops `acl/grant/0.1` and `trust-task-discovery/0.1`) instead of being fixed to one pin.
Until then, the pins plus the canary's version warning are the guard.

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
