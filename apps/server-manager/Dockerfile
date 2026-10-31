ARG DOCKER_CLI_IMAGE=docker.m.daocloud.io/library/docker:27.5.1-cli
ARG NODE_IMAGE=docker.m.daocloud.io/library/node:22.17.0-bookworm-slim
ARG RUST_IMAGE=docker.m.daocloud.io/library/rust:1.93-bookworm

FROM ${DOCKER_CLI_IMAGE} AS docker-cli

FROM ${NODE_IMAGE} AS console-build
ENV CI=true RUSH_PNPM_STORE_PATH=/pnpm/store
WORKDIR /source
COPY . .
RUN --mount=type=cache,id=box-local-engine-pnpm,target=/pnpm/store \
    node common/scripts/install-run-rush.js install --to @box/deployment-manager
RUN cd apps/deployment-manager && node ../../common/scripts/install-run-rushx.js build

FROM ${RUST_IMAGE} AS rust-build
ARG BOX_BUILD_VERSION=2026.1.4
ARG BOX_BUILD_COMMIT=unknown
ARG BOX_BUILD_DATE=unknown
ARG BOX_BUILD_SOURCE=local
ARG CARGO_REGISTRIES_CRATES_IO_INDEX=sparse+https://rsproxy.cn/index/
ENV BOX_BUILD_VERSION=${BOX_BUILD_VERSION} \
    BOX_BUILD_COMMIT=${BOX_BUILD_COMMIT} \
    BOX_BUILD_DATE=${BOX_BUILD_DATE} \
    BOX_BUILD_SOURCE=${BOX_BUILD_SOURCE} \
    CARGO_REGISTRIES_CRATES_IO_INDEX=${CARGO_REGISTRIES_CRATES_IO_INDEX}
WORKDIR /source
COPY apps/server-manager-rust ./apps/server-manager-rust
COPY apps/manager-core ./apps/manager-core
COPY distribution/LICENSE.txt ./distribution/
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/source/apps/server-manager-rust/target \
    cargo build --manifest-path apps/server-manager-rust/Cargo.toml --release \
    && cp apps/server-manager-rust/target/release/box-local-engine-server-manager /server-manager

FROM debian:bookworm-slim

ARG BOX_BUILD_VERSION=2026.1.4
ARG BOX_BUILD_COMMIT=unknown
ARG BOX_BUILD_DATE=unknown
ARG BOX_BUILD_SOURCE=local

LABEL org.opencontainers.image.title="BOX Local Engine Server Manager" \
      org.opencontainers.image.version="${BOX_BUILD_VERSION}" \
      org.opencontainers.image.revision="${BOX_BUILD_COMMIT}" \
      org.opencontainers.image.created="${BOX_BUILD_DATE}" \
      org.opencontainers.image.source="${BOX_BUILD_SOURCE}" \
      org.opencontainers.image.licenses="MIT"

ENV BOX_SERVER_MANAGER_HOST=0.0.0.0 BOX_SERVER_MANAGER_PORT=3130
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*
COPY distribution/LICENSE.txt /app/LICENSE
COPY distribution/server/bootstrap.sh /app/bootstrap.sh
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose

COPY --from=console-build /source/apps/deployment-manager/dist ./public
COPY --from=rust-build /server-manager /app/server-manager

EXPOSE 3130

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/app/server-manager", "--healthcheck"]

CMD ["/app/server-manager"]
