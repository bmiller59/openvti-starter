# Images: pull the prebuilt ones, or build locally

Part of the [docs index](README.md). Pins and drift checks: [PINS.md](PINS.md).

> **Current state, plainly.** Prebuilt, multi-arch (amd64 and arm64) images of the VTA, VTC and mediator are published at `ghcr.io/bmiller59`
> (`vta-buildathon`, `vtc-buildathon`, `mediator-buildathon`), built by this repository's images workflow (real runs of 2026-11-20, [PINS_LOG.md](../PINS_LOG.md)).
> The packages are public and were observed to pull anonymously, and `npm run images:verify` reported VERIFIED for all three (details in [VERIFY.md](VERIFY.md)).
> `pins.json` `images.available` is `true` and records each image's index digest, so **the default path is to pull**: `npm run images:pull`, then `npm run up`.
> **Building locally stays supported** as the fallback (`npm run setup`; for an unsupported architecture, no network, or to see the build) and is the only path for a pin that has not been published yet.
> Setting `images.available` back to `false` makes `IMAGES=auto` behave like `IMAGES=local` again (use `<name>:local`, never pull).

The VTA, VTC and mediator images are Rust release builds. They are heavy once and cheap afterwards: each image is built once, later builds reuse Docker's layer cache, and after that `npm run up` starts in seconds.
The numbers are in one place, [Build requirements](#build-requirements); the other docs link here.

## Build requirements

This is the single source of truth for what a local build needs. Other documents link here instead of repeating the numbers.

| Resource | What a local build needs | Notes |
|---|---|---|
| Disk | **20 GB or more free** on Docker's data root | About 12 GB of BuildKit cache (observed), about 200 MB per image (each pin bump adds one), the VTI clone about 0.9 GB, an exported tar about 0.4 GB. `npm run clean` reclaims it ([below](#reclaiming-disk)). |
| RAM | **8 GB or more** for Docker is comfortable; **4 GB** is the floor | The build runs in a memory-capped builder (see the cap below). The mediator needs the most headroom. |
| Swap | Some, on a machine with 16 GB or less | The Rust link step (LTO) was OOM-killed on a 16 GB runner without swap ([workflow notes](../.github/workflows/images.yml)). With swap at least as large as the cap, the builder may use up to twice the cap (cap plus swap). |
| Cores | No hard minimum | The default cap is a quarter of the cores, at least 2 when the machine has 4 or more. **One core is very slow**: expect well over an hour per Rust image. |
| Time | **12 to 25 minutes per Rust image** on a 12-core desktop (measured); **about 26 to 29 minutes per build leg** on GitHub-hosted runners with a 12g cap and 16 GB swap (measured: runs 44659883519 and 44663168210); **25 to 40 minutes** on a laptop (an **unmeasured estimate**) | The mediator took about 12 minutes on the 12-core desktop. Later builds reuse the layer cache. |
| Docker Desktop | The VM limit applies, not the laptop's RAM | Docker Desktop (macOS, Windows) runs Docker in a VM; raise its memory and CPUs in Settings > Resources to at least 8 GB. `doctor` reads the VM's numbers from `docker info`. |
| arm64 / Apple silicon | Builds natively; images are per CPU architecture | An image built on arm64 runs on arm64 only. Same disk and RAM needs. |

**The build cap, exactly** (`scripts/lib/build-limits.ts`). The builds run on a resource-limited buildx builder. Default memory cap: **half of the Docker engine's RAM, rounded down to whole GB, never below 6g and never above 12g** (8 GB engine: 6g; 16 GB: 8g; 24 GB or more: 12g). Default CPUs: a quarter of the cores, **at least 2 when there are 4 or more cores**, at least 1. When the host has swap at least as large as the cap, memory-swap is twice the cap; otherwise it equals the cap (no swap). Override per run with `--memory`, `--cpus` or `--no-limits`, or with `BUILD_MEMORY` / `BUILD_CPUS` / `BUILD_LIMITS=0` in the environment or `.env`; an explicit value always wins over the defaults. The builder's name encodes the limits (and `-sw` for swap), so a change of defaults starts a fresh builder with a cold cache; `npm run clean` removes the old one.

**Checks, exactly.**

- `images:build` **refuses** (override: `--force`) when free disk on Docker's data root is under **10 GB**, or the Docker engine's memory is under **4 GB**; the message lists the fallbacks below. It **warns** when free disk is under **20 GB** (and suggests `npm run clean`), when the cap is under **8g with no swap** for the VTA or VTC, and when the build is limited to **1 CPU**. It also warns when available memory (`MemAvailable`, Linux) is under 4 GB for the VTA and VTC, or under 8 GB for the mediator.
- `npm run doctor` shows the same numbers, only when an image has to be built (not when the images exist, and not with `RUNTIME=binary` or `MODE=farm`): disk under 20 GB warns and under 10 GB fails; Docker memory under 8 GB warns and under 4 GB fails; host RAM under 8 GB warns, and no swap on 16 GB or less warns; a single-core cap warns. On macOS and Windows it makes no claim about the host's RAM (only Linux exposes `/proc/meminfo`) and uses `docker info`; the disk line reads "not measured" when Docker's data root is inside a VM or on a remote engine.

**If the machine is too small.** In order of preference:

1. **Import images built on a stronger machine** of the same CPU architecture: `npm run images:import -- buildathon-images.tar` ([Sharing images you built](#sharing-images-you-built)).
2. **`RUNTIME=binary` with `MODE=local`**: run the VTA and VTC as host binaries you already have, no Docker build ([BINARIES.md](BINARIES.md)).
3. **`MODE=farm`**: use a hosted VTA, nothing runs locally ([FARM.md](FARM.md)).
4. **Prebuilt images**: `npm run images:pull` (published, public and `images.available` is `true`; [PINS.md](PINS.md#where-the-images-come-from)). A pull is a few hundred MB, not a Rust build, so on a small machine try this first.

**GitHub-hosted runners.** `images.yml` and `pins-gate.yml` run on `ubuntu-24.04` (and `ubuntu-24.04-arm`). Per GitHub's documentation, a standard runner in a **public** repository has 4 vCPU, 16 GB RAM and 14 GB SSD; in a **private** repository it has 2 vCPU and 8 GB. These workflows assume the repository is public. Disk is freed and 16 GB of swap is added before building.

## What a participant does

```sh
npm ci
npm run doctor           # says exactly which images are missing and the command that builds each (with its time)
npm run setup            # builds what your mode needs and is not built yet: VTA + VTC (add -- --tunnel for the mediator)
npm run up
```

`npm run setup` is `images:build needed`: it builds only the missing images for the chosen mode (`-- --tunnel`, `-- --no-vtc`), one after the
other, prints the estimate first, warns if memory is low, and reports how long each took. It is safe to stop and run again. The VTA and VTC are
built from a checkout of the upstream VTI repository next to this one (`git clone ... ../verifiable-trust-infrastructure`, or add `-- --clone`
and the script does it); the mediator needs no checkout but about 8 GB of memory. Requirements, times and what to do on a small machine: [Build requirements](#build-requirements).

Local builds run on a resource-limited buildx builder so they cannot starve or crash the machine (cap, swap and CPU defaults: [Build requirements](#build-requirements); cargo is pinned to that many cores, so its parallel jobs fit in the memory cap; low CPU priority, because `nice` on the docker client alone would not reach the daemon that compiles). Change it per run with `npm run setup -- --memory 8g --cpus 4` (`--no-limits` builds unlimited), or once for all runs by putting `BUILD_MEMORY=8g` and `BUILD_CPUS=4` in `.env` (the environment works too; a flag wins over both). `--force` builds despite the small-machine refusal. Needs `docker buildx`.

To get images without building them yourself, a colleague with the same CPU architecture can send you theirs: see
[Sharing images you built](#sharing-images-you-built).

`npm run up` decides per image, in this order (`scripts/lib/images.ts`):

1. `VTA_IMAGE` / `VTC_IMAGE` / `MEDIATOR_IMAGE` set: that exact image, nothing else is tried.
2. `IMAGES=local`, **or `IMAGES` unset/`auto` while `images.available` is `false`**: only the locally built `<name>:local`. Never touches the network.
3. `IMAGES=auto` while `images.available` is `true` (**today**): the pinned registry image if it is already here, else a local build if you have one, else it **pulls** the pinned registry image (by digest).
4. `IMAGES=registry`: the pinned registry image only (pulled if absent), no fallback to a local build. It also works while `images.available` is `false` (for a fork's or a private registry; `docker login ghcr.io` first if it needs one).

| Variable | Effect |
|---|---|
| `IMAGES=local` | Only locally built images; never touches the network. |
| `IMAGES=registry` | Insist on the registry images (no fallback to a local build). |
| `IMAGE_REGISTRY=host/org` | Pull from another registry or org (a mirror, a fork's packages, a local `registry:2`). Default: `pins.json` `images.registry`. |
| `VTA_IMAGE`, `VTC_IMAGE`, `MEDIATOR_IMAGE` | An exact image (for example one loaded with `docker load`). |

These can go in `.env` or the shell. `npm run reset` removes only the keys the kit wrote to `.env`, so your own lines stay.
Bare `docker compose up` (without `npm run up`) knows nothing of the registry and uses `<name>:local`; use `npm run up`.

`npm run images:pull` pulls the pinned images by digest (`-- --by-digest` refuses anything but the pinned digest). While `images.available` is `false` it prints an explanation and pulls nothing unless `IMAGES=registry` is set.
`npm run images:pull -- --check` shows, without any network, what is present.

### Sharing images you built

Building is the slow part; copying is not. Build once on a fast machine, then share the result with `docker save` / `docker load`, with no registry:

```sh
npm run images:export -- buildathon-images.tar     # on the machine that built (add --tunnel for the mediator, --no-vtc to leave the VTC out)
npm run images:import -- buildathon-images.tar     # on the other machine, same CPU architecture
```

These run `docker save -o` and `docker load -i` on the `<name>:local` images the mode needs. **Verified here:** a `docker save | gzip` then `zcat | docker load` round trip and
the script's `save -o` then `import` on a tiny scratch image (the image ID and labels survived), and `images:export` on the real VTA image (the tar is written, 179 MB).
**Not verified:** a full export and import of all three images onto a second machine, and `up` from images loaded that way (it should be the same, as compose only needs the `:local` tags). Details
that matter: the CPU architecture must match (import warns when it does not; an amd64 tar will not run natively on Apple silicon), and the tar is **unsigned**, so it is exactly as
trustworthy as whoever made it ([VERIFY.md](VERIFY.md)). By hand the same thing is `docker save vta-buildathon:local vtc-buildathon:local | gzip > images.tar.gz` and `zcat images.tar.gz | docker load`.

## Reclaiming disk

Local builds leave things behind. `npm run clean` lists them and, only with `--apply`, removes them. It is a dry run by default, prints every item with its size and a total per scope and overall, and never touches a running container's image, `:local`, the pinned tag, or anything it did not create.

| What | Typical size | Scope |
|---|---|---|
| BuildKit cache of the resource-limited builders (`buildathon2-*`) | about 12 GB observed | `cache` |
| Each superseded image (`vta`/`vtc`/`mediator-buildathon:<old ref8>` or `:<old version>-<ref8>`) | about 180-200 MB | `images` |
| Each orphan source export `vti-XXXXXX` in `$TMPDIR` or `/tmp` (an interrupted build; `images:build` now removes its own on Ctrl-C and SIGTERM) | about 70 MB | `source` |
| The VTI clone `../verifiable-trust-infrastructure` | about 0.9 GB | `checkout` |
| `buildathon-images.tar` from `images:export` | 0.4 GB and up | `tars` |

```sh
npm run clean                       # dry run of images, cache, source
npm run clean -- --apply            # remove them (asks in a terminal; --yes skips the question)
npm run clean -- images --apply     # only the superseded images
npm run clean -- tars --path ~/Downloads --apply
npm run clean -- stack              # what `npm run reset` does (deletes keys): named explicitly, asks first
npm run clean -- checkout --include-checkout   # deletes the VTI clone; you type its directory name; refused if it has local work
```

**The cache is the expensive one to lose.** After the `cache` scope removes a builder or its cache (`--prune-current`, `--remove-current`), the next `images:build` is cold: expect the cold times in [Build requirements](#build-requirements) (12 to 40 minutes per image). By default the builder your next build would use is kept (if your current settings name a builder that does not exist yet, the most recently used one counts as current) and only the others go. `images:build` prints "N superseded images, X MB reclaimable" when old images exist.

Volumes of other checkouts (`<other-dir>_vta-data` and the like) are listed, never removed; the output gives the `docker volume rm` command to run by hand once you have checked nothing uses them. Without a terminal (CI, a pipe) nothing is asked: `--apply` then needs `--yes`, and the checkout is never deleted.

## The registry design

Everything below is how the prebuilt images work now that `images.available` is `true`.

### Image names and tags

`pins.json` stays the single source of truth. Every image has two tags, both derived from its pin (one helper, `scripts/lib/image-tags.ts`, used by `images:build`, `images:pull` and `npm run clean`):

- `<ref8>`: the first 8 characters of the pinned upstream commit.
- `<version>-<ref8>`: the pinned version plus that, e.g. `0.72.0-26d0da81`.

There is **no `latest`**: a moving tag defeats pinning. The digest in `pins.json` is the verified reference; tags are labels for people.

| Image | Name | Pin | Tags | Registry example |
|---|---|---|---|---|
| VTA | `vta-buildathon` | `vti.vta` (0.72.0) | `26d0da81`, `0.72.0-26d0da81` | `ghcr.io/bmiller59/vta-buildathon:0.72.0-26d0da81` |
| VTC | `vtc-buildathon` | `vti.vtc` (0.20.0) | `26d0da81`, `0.20.0-26d0da81` | `ghcr.io/bmiller59/vtc-buildathon:0.20.0-26d0da81` |
| mediator | `mediator-buildathon` | `messaging.mediator` (0.48.0) | `e6e2c636`, `0.48.0-e6e2c636` | `ghcr.io/bmiller59/mediator-buildathon:0.48.0-e6e2c636` |

Where each tag exists:

- **Built locally** (`images:build`): `<name>:<ref8>`, `<name>:<version>-<ref8>` and `<name>:local`. A `VTI_LOCAL=1` working-tree build is only `:local`.
- **Pulled** (`images:pull`): pulled by digest, then, only when the image reports exactly the pinned digest, tagged locally `<name>:<ref8>` and `<name>:<version>-<ref8>` (the mediator included, so it needs no hand-tagging; running the pull again re-applies the tags to an image that is already here). A pulled image is **never** tagged `:local`: that tag means "built here by `images:build`", `IMAGES=local` keeps meaning that, and a pull must not overwrite your own build. `npm run up` does not need `:local` for a pulled image: it runs the pinned digest reference. (Plain `docker compose up` outside `npm run up` falls back to `:local`; set `VTA_IMAGE=vta-buildathon:0.72.0-26d0da81` etc., or build.) A pin without a recorded digest is pulled by tag, unverified, and is not tagged locally.
- **Tags in use are never moved.** Before `images:pull` or `images:build` points a tag at a different image, the kit asks Docker (read-only: `docker image inspect`, `docker ps -a`) whether any container, running or stopped, of any compose project, was created from the image the tag points to now. If so the tag is left alone and the output names the containers (name and compose project) and the way on: use the unique `<version>-<ref8>` tag or the pinned digest, stop those containers and re-run, or pass `--force`. `images:build` refuses before it starts building; `images:pull` skips only that tag, reports it, and still succeeds, because `up` and `images:verify` use the pinned digest reference (`<registry>/<name>@sha256:...`), which does not depend on any short tag. A tag that already points at the pulled image is never a move, so re-running a pull is always fine.
- **In the registry**: the publish workflow pushes both tags on the same multi-arch index from now on. The images published on 2026-11-20 carry only the `<ref8>` tag; the next publish adds `<version>-<ref8>`. Until then, refer to a published image by its digest (what `images:pull` does) or by `<ref8>`.
- **`npm run clean`** treats both forms of the current pin as kept, and both forms of any older pin as superseded.

(The Farm portal's image names, such as `0.72.0-26d0da81`, follow the same `<version>-<ref8>` form but are the Farm's own images, see [FARM.md](FARM.md).)

`pins.json` `images.<kind>.digest` is the multi-arch index digest, recorded on 2026-11-20 from the first real publish runs (and checked against the live registry). `images:pull` and `up` pull by
digest (`<registry>/<name>@sha256:...`), so a moved tag cannot change what runs. A pin advance that has no recorded digest yet (`null`) pulls by tag and
`pins:check` warns "no digest in pins.json" (`images:pull -- --by-digest` refuses the tag fallback).

### Checks

`npm run pins:check` reads the labels of a pulled image: the upstream ref label (`org.buildathon.vti-ref` or
`org.buildathon.mediator-ref`) must equal the pin, the VTA's `org.buildathon.vta-features` must equal the pinned list (it includes
`tsp`), and, if a digest is recorded, the local copy must have that digest. Other labels the workflow sets:
`org.opencontainers.image.source` (this repository, which is what links the package to it on GHCR), `.revision` (this repo's commit that
built it), `.licenses` (Apache-2.0, the licence of the software built in), `.version`, `org.buildathon.pinned-ref` and
`org.buildathon.upstream-source`.

For a future `doctor`: `scripts/lib/images.ts` exports `imageStatus(imageSpecs(pins()), realDocker, currentMode())`, which returns
per image `ready | pullable | missing` with a fix command, and pulls nothing.

### Checking the images

Pulling is not trusting. `npm run images:verify` checks a pulled image against `pins.json` and the workflow's signature and attestations, and `npm run images:pull -- --by-digest` pulls only by the pinned digest. How, and what that does and does not prove: [VERIFY.md](VERIFY.md). The workflow attaches an SBOM, a build provenance attestation and a keyless cosign signature (jobs `attest` and `sign`); the real push runs of 2026-11-20 against `ghcr.io/bmiller59` had both succeed, and `images:verify` then reported VERIFIED for all three (digest, GitHub attestation naming this repository's `images.yml`, labels, SBOM). The `cosign` signature check was SKIPPED on that machine because `cosign` was not installed (the attestation covers the signature there); install `cosign` to run it too.

## What an organiser does: publishing

The first real publish runs were on 2026-11-20 (VTA run 44825863735, VTC run 44827253709, mediator run 44827602054; digests in [PINS_LOG.md](../PINS_LOG.md)); the packages are public under the `bmiller59` account. Publishing is only needed again after a pin advances or a fork wants its own images: run the workflow, record the new digests in `pins.json`, run `images:verify`, then commit.

Publishing happens in GitHub Actions with the built-in `GITHUB_TOKEN` (`packages: write`). No personal token is involved, and no
credential is stored in this repository. (A personal token needs the `write:packages` scope; the `gh` token on the organiser's
machine may lack it. The alternative is `gh auth refresh -s write:packages`, then a manual `docker login ghcr.io` and push. The workflow
route is preferred because the images are then built from a clean checkout, labelled, multi-arch and recorded.)

### First run

1. **Check the owner can create public packages** (Packages settings of the account or organisation; public packages on GHCR are free of charge and the repository is public). Without
   this, the first push fails with a permission error. A fork under another owner sets `IMAGE_REGISTRY` and `VERIFY_REPO`.
2. **Actions must be enabled** for the repository, and workflows may need "Read and write permissions" under Settings > Actions > General >
   Workflow permissions (the workflow requests `packages: write` itself, but an organisation policy can cap it).
3. **Dry run first.** Actions > images > Run workflow, `images` = `vta` (the quickest to learn from), `push` = **false**. This builds on the
   native amd64 and arm64 runners, runs `--version` and checks the labels, and pushes nothing.
4. **Publish.** Run it again with `push` = true and `images` = `all`, or push a tag named `images-<date>`. Expect roughly 25 to 45
   minutes per image on GitHub's 4-vCPU runners (an estimate, not measured), in parallel. See the timeout notes at the top of the workflow.
5. **Make the packages public.** New packages are **private** by default. For each of the three: GitHub > the owner's Packages > the package >
   Package settings > Change visibility > Public. Because the images carry the `org.opencontainers.image.source` label for this repository,
   the package is linked to the repository automatically on first push; if it is not, use "Connect repository" on the package page.
   (Linking is also what lets the repository's Actions keep pushing new versions.)
6. **Check the signatures, then record the digests.** First `npm run images:pull`, then `npm run images:verify` (needs `gh` or `cosign`; [VERIFY.md](VERIFY.md)): expect `INCOMPLETE` only for the missing digest, and no `FAIL`. The run's summary lists each image's digest and a `jq` command that sets it in `pins.json`; the same data is
   the `images-digests` artifact. Commit the change (`git commit -s`) so participants pull by digest, and run `images:verify` again: now it can say `VERIFIED`.
7. **Verify from a clean machine**, with no local images: `docker logout ghcr.io` (the package is public, no login should be needed), then
   `npm ci && npm run images:pull && npm run pins:check && npm run up && npm run hello`. On an arm64 machine (Apple silicon, an arm64 server)
   as well as amd64: the arm64 image is built on a native arm64 runner and is **untested** until someone does this.

### When pins advance

Advance a pin per [PINS.md](PINS.md), then re-run the workflow (tag `images-<date>`), record the new digests, and commit. The tags in the
registry change with the ref and version, so an old tag stays available for those who need it. The images are for development only: the mediator is
open-ACL by design and the VTA stores a plaintext seed ([MODES.md](MODES.md), [SECURITY.md](SECURITY.md)).

### If something fails

| Symptom | Likely cause |
|---|---|
| Push fails with 403 or "denied" at the first push | The owner cannot create public packages (step 1), or a policy caps the token's permissions (step 2). |
| `permission_denied: read_package` when pushing a package that already exists | The package was pushed by hand, so the repository's workflow token has no access to it. Either delete that package and let the workflow create it, or open the package settings, "Manage Actions access", and add this repository with the Write role. Seen on the first real run. |
| `cannot allocate memory` or "the runner has received a shutdown signal" during a Rust build | The runner ran out of memory. The build job adds 16 GB of swap before building and caps the build at 12g (a 16 GB runner without swap was OOM-killed in the Rust link step); if it still happens, build fewer images per run (`images=vta`, then `vtc`, then `mediator`). |
| arm64 jobs wait for ever | The `ubuntu-24.04-arm` runner is not available to the account. See the QEMU fallback in the workflow comments (hours, not minutes), or publish amd64 only. |
| A build leg is cancelled at its timeout | The runner was slower than the estimate. Raise `timeout` in the plan step, and record the real time in this file. |
| `fetch ... origin <sha>` fails in the VTA or VTC leg | The pinned commit is not reachable from the upstream repository (force-pushed or deleted). Re-pin ([PINS.md](PINS.md)). |
| `pull access denied` for a participant | A stale `docker login ghcr.io` token (`docker logout ghcr.io`), the package was made private again (step 5), or `IMAGE_REGISTRY` points elsewhere. Build locally as a fallback (`npm run setup`). |
| `no matching manifest for linux/...` | A CPU architecture that was not built (only amd64 and arm64 are). |
| `pins:check` reports a digest drift | The registry tag moved or the local copy is old: `npm run images:pull -- vta --force`. |

## What is verified and what is not

Verified here (no network, no registry):

- `images.available` false/true: `IMAGES=auto` resolves to the local build and never pulls while false; flipping it to true gives the earlier behaviour (unit tests, both ways); `images:pull` prints the explanation;
  `doctor` puts the local build command first; `npm run setup` plans only the missing images for the mode (unit tests; the build itself is the pre-existing `images:build`);

- the resolution logic and its fallbacks, the friendly pull errors, the label and digest checks (unit tests, `scripts/test/images.test.ts`);
- `images:verify` and `images:compare` against a mocked `docker`/`gh`/`cosign` (`scripts/test/verify.test.ts`), and live against the local images (labels only; the hand-pushed stopgap images correctly fail `label origin`);
- the workflow file parses, its permissions are read-only except `packages: write` on the publishing jobs and `id-token`/`attestations: write` only on `attest` and `sign`, every action is pinned to a
  commit SHA, no expression is interpolated into a script, and its plan step, run locally against `pins.json`, produces the expected
  six build legs (`scripts/test/images-workflow.test.ts`);
- `npm run images:pull` against an unreachable registry fails with the friendly message and the local build named; `npm run up` with
  local images starts a working VTA and `npm run hello` passes.

**Verified live on 2026-11-20 (the real publish runs):** the workflow's `attest` and `sign` jobs succeeded for all three images; the index digests in the job logs equal the live registry manifests; `gh attestation verify` (through `images:verify`) accepts each image with the identity `bmiller59/openvti-starter/.github/workflows/images.yml`; digest, label and SBOM checks pass on a pulled amd64 copy; the packages pull anonymously (observed by another agent with an empty Docker config); `images:pull -- --by-digest` pulls the pinned digest.

**Not verified:** the `cosign verify` path (`cosign` was not installed, so that check was SKIPPED; the attestation covers the signature); that the arm64 images start and work (they were built and indexed but only amd64 was run); a full `pins:verify` gate (pull, `up`, `e2e`) against the pulled images; build times of the mediator and arm64 legs on the runners (VTA and VTC legs measured at about 26 to 29 minutes); that the actions' pinned versions behave as written beyond these runs; `actionlint` was not available, so only the YAML parse and a shell syntax check stood in for it.
