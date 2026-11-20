# Builds the VTC (`vtc` binary) from a verifiable-trust-infrastructure checkout.
# The VTA image does NOT contain it: the VTI Dockerfile builds only `vta-service`.
#
#   docker build -f docker/vtc.Dockerfile -t vtc:local /path/to/verifiable-trust-infrastructure
#
# Built from the vtc-service tag in pins.json (vti.vtc.tag). `tsp` MUST stay in FEATURES: re-checked at
# 0.15.0, registry/messaging.rs `tsp_envelope` still calls the tsp-gated
# outbound::seal_trust_task_tsp unconditionally, so a build without it fails (and `tsp` is in
# the crate's default features anyway).
# Features are otherwise trimmed to avoid the
# OS keyring (no secret-service in a container) and the admin SPA (needs a Node build);
# add `admin-ui` back, and a Node stage, if you want the console at /admin.
ARG VTI_REF=unknown
# Keep RUST_VERSION equal to the pinned release's rust-toolchain.toml (the upstream Dockerfile builds `FROM rust:<that>`):
# 1.100.0 since the 0.83/0.31 bump (the 0.72/0.20 release had no toolchain file and built with 1.95).
ARG RUST_VERSION=1.100.0
FROM rust:${RUST_VERSION}-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends clang cmake libdbus-1-dev libssl-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY . .
ARG FEATURES="setup,website,tsp"
RUN --mount=type=cache,target=/usr/local/cargo/registry,id=vtc-cargo-registry \
    --mount=type=cache,target=/build/target,id=vtc-cargo-target,sharing=locked \
    cargo build --release --locked --package vtc-service --no-default-features --features "${FEATURES}" \
    && cp target/release/vtc /build/vtc-bin

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 libdbus-1-3 wget \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 1000 --system --home-dir /var/lib/vtc --create-home --shell /usr/sbin/nologin vtc
COPY --from=builder /build/vtc-bin /usr/local/bin/vtc
USER vtc
EXPOSE 8200
ENTRYPOINT ["/usr/local/bin/vtc"]
