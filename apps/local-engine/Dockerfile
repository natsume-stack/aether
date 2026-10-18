ARG NODE_IMAGE=docker.m.daocloud.io/library/node:22.17.0-bookworm-slim
ARG BOX_BUILD_VERSION=2026.1.4
ARG BOX_BUILD_COMMIT=unknown
ARG BOX_BUILD_DATE=unknown
ARG BOX_BUILD_SOURCE=local

FROM ${NODE_IMAGE} AS source-base

ENV CI=true \
    NEXT_TELEMETRY_DISABLED=1 \
    RUSH_PNPM_STORE_PATH=/pnpm/store \
    NODE_OPTIONS=--max-old-space-size=8192

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ARG BOX_RUNTIME_BUILD_NONCE=source
RUN test -n "$BOX_RUNTIME_BUILD_NONCE"
COPY . .

FROM source-base AS engine-build-base

RUN --mount=type=cache,id=box-local-engine-pnpm,target=/pnpm/store \
    npm_config_registry=https://registry.npmmirror.com \
    node common/scripts/install-run-rush.js install \
      --to @box/game \
      --to @box/player-admin \
      --to @box/game-server \
      --to @box/local-engine

# Build all workspace dependencies before any Next/runtime compilation. Clean
# image contexts contain source, not env/iframe/schema/script API dist outputs.
# Exclude the applications themselves: each following stage selects its mode.
RUN node common/scripts/install-run-rush.js rebuild \
      --to-except @box/game \
      --to-except @box/player-admin \
      --to-except @box/game-server \
      --to-except @box/local-engine \
      --parallelism 2

# Deploy only the generated API runtime and production dependencies; source
# documents and Swagger tooling remain outside the compact runtime images.
RUN --mount=type=cache,id=box-local-engine-pnpm,target=/pnpm/store \
    node common/scripts/install-run-rush-pnpm.js --rush-skip-checks deploy \
      --filter @box/apis --prod --legacy /opt/apis-runtime

# Generated content-addressed runtime resources are intentionally excluded
# from Git. Rebuild them inside the shared build stage so clean CI checkouts
# and local Docker builds produce the same Creator/Play runtime data.
RUN cd apps/local-engine && node ../../common/scripts/install-run-rushx.js prepare-assets

FROM engine-build-base AS creator-build

RUN cd packages/cli && node ../../common/scripts/install-run-rushx.js build \
    && cd ../../apps/local-engine && node ../../common/scripts/install-run-rushx.js build:creator
RUN node apps/local-engine/src/stage-runtime-data.js /opt/runtime-data
# Creator preview console streaming depends on better-sse. Verify it survives
# the production-only deploy before the compact runtime is assembled.
RUN --mount=type=cache,id=box-local-engine-pnpm,target=/pnpm/store \
    npm_config_registry=https://registry.npmmirror.com \
    npm_config_sharp_libvips_binary_host=https://npmmirror.com/mirrors/sharp-libvips \
    node common/scripts/install-run-rush-pnpm.js --rush-skip-checks deploy --filter @box/game-server --prod --legacy /opt/game-server \
    && mkdir -p /opt/game-server/player \
    && cp services/game-server/src/player/default-avatar.json /opt/game-server/player/default-avatar.json \
    && rm -rf /opt/game-server/src /opt/game-server/scripts /opt/game-server/dist/scripts \
    && find /opt/game-server -type f \( \
      -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' \
      -o -name '*.map' -o -name '*.ts' -o -name '*.tsx' -o -name '*.nft.json' \
    \) -delete \
    && find /opt/game-server -depth -type d \( \
      -name '.github' -o -name '.circleci' -o -name '.vscode' \
      -o -name 'test' -o -name 'tests' -o -name '__tests__' \
      -o -name 'docs' -o -name 'examples' -o -name 'example' \
      -o -name 'benchmark' -o -name 'benchmarks' -o -name 'coverage' -o -name 'man' \
    \) -exec rm -rf {} + \
    && find /opt/game-server -type f \( \
      -iname 'README*' -o -iname 'CHANGELOG*' -o -iname 'HISTORY*' \
      -iname 'CONTRIBUTING*' -o -iname '*.md' \
      -o -iname '*.markdown' -o -name 'yarn.lock' -o -name 'package-lock.json' \
    \) ! \( -iname 'LICENSE*' -o -iname 'LICENCE*' -o -iname 'COPYING*' \
      -o -iname 'NOTICE*' -o -iname 'COPYRIGHT*' -o -iname 'AUTHORS*' -o -iname 'PATENTS*' \) -delete \
    && rm -rf /opt/game-server/node_modules/@types \
      /opt/game-server/node_modules/.pnpm/node_modules/@types \
    && find /opt/game-server/node_modules/.pnpm -mindepth 1 -maxdepth 1 -type d \
      -name '@types+*' -exec rm -rf {} + \
    && rm -f /opt/game-server/node_modules/.modules.yaml \
    && cd /opt/game-server \
    && node -e "const fs=require('node:fs'),path=require('node:path');const env=require.resolve('@box/env');const yaml=require.resolve('yaml',{paths:[path.dirname(env)]});const directives=path.join(path.dirname(yaml),'doc','directives.js');if(!fs.existsSync(directives))throw new Error('Incomplete yaml runtime: '+directives)" \
    && node -e "require.resolve('better-sse')" \
    && cd /app/services/game-server \
    && node scripts/compact-runtime-javascript.js /opt/game-server/dist /app/apps/local-engine/src

FROM engine-build-base AS play-build

RUN cd packages/cli && node ../../common/scripts/install-run-rushx.js build \
    && cd ../../apps/local-engine && node ../../common/scripts/install-run-rushx.js build:play
RUN node apps/local-engine/src/stage-runtime-data.js /opt/runtime-data
RUN --mount=type=cache,id=box-local-engine-pnpm,target=/pnpm/store \
    npm_config_registry=https://registry.npmmirror.com \
    npm_config_sharp_libvips_binary_host=https://npmmirror.com/mirrors/sharp-libvips \
    node common/scripts/install-run-rush-pnpm.js --rush-skip-checks deploy --filter @box/game-server --prod --legacy /opt/game-server \
    && mkdir -p /opt/game-server/player \
    && cp services/game-server/src/player/default-avatar.json /opt/game-server/player/default-avatar.json \
    && rm -rf /opt/game-server/src /opt/game-server/scripts /opt/game-server/dist/scripts \
      /opt/game-server/dist/src/edit /opt/game-server/dist/src/deploy \
      /opt/game-server/node_modules/@ai-sdk \
      /opt/game-server/node_modules/@openrouter \
      /opt/game-server/node_modules/ai \
      /opt/game-server/node_modules/.pnpm/node_modules/@ai-sdk \
      /opt/game-server/node_modules/.pnpm/node_modules/@openrouter \
      /opt/game-server/node_modules/.pnpm/node_modules/ai \
    && find /opt/game-server/node_modules/.pnpm -mindepth 1 -maxdepth 1 -type d \( \
      -name '@ai-sdk+*' -o -name '@openrouter+*' -o -name 'ai@*' \
    \) -exec rm -rf {} + \
    && find /opt/game-server -type f \( \
      -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' \
      -o -name '*.map' -o -name '*.ts' -o -name '*.tsx' -o -name '*.nft.json' \
    \) -delete \
    && find /opt/game-server -depth -type d \( \
      -name '.github' -o -name '.circleci' -o -name '.vscode' \
      -o -name 'test' -o -name 'tests' -o -name '__tests__' \
      -o -name 'docs' -o -name 'examples' -o -name 'example' \
      -o -name 'benchmark' -o -name 'benchmarks' -o -name 'coverage' -o -name 'man' \
    \) -exec rm -rf {} + \
    && find /opt/game-server -type f \( \
      -iname 'README*' -o -iname 'CHANGELOG*' -o -iname 'HISTORY*' \
      -iname 'CONTRIBUTING*' -o -iname '*.md' \
      -o -iname '*.markdown' -o -name 'yarn.lock' -o -name 'package-lock.json' \
    \) ! \( -iname 'LICENSE*' -o -iname 'LICENCE*' -o -iname 'COPYING*' \
      -o -iname 'NOTICE*' -o -iname 'COPYRIGHT*' -o -iname 'AUTHORS*' -o -iname 'PATENTS*' \) -delete \
    && rm -rf /opt/game-server/node_modules/@types \
      /opt/game-server/node_modules/.pnpm/node_modules/@types \
    && find /opt/game-server/node_modules/.pnpm -mindepth 1 -maxdepth 1 -type d \
      -name '@types+*' -exec rm -rf {} + \
    && rm -f /opt/game-server/node_modules/.modules.yaml \
    && cd /opt/game-server \
    && node -e "const fs=require('node:fs'),path=require('node:path');const env=require.resolve('@box/env');const yaml=require.resolve('yaml',{paths:[path.dirname(env)]});const directives=path.join(path.dirname(yaml),'doc','directives.js');if(!fs.existsSync(directives))throw new Error('Incomplete yaml runtime: '+directives)" \
    && cd /app/services/game-server \
    && node scripts/compact-runtime-javascript.js /opt/game-server/dist /app/apps/local-engine/src

FROM engine-build-base AS player-service-build

# Keep a bounded heap for Next while allowing a cold dependency-complete build.
# Hosts with a different build memory budget can override this argument.
ARG BOX_PLAYER_SERVICE_BUILD_HEAP_MB=4096
RUN rm -rf apps/game/public/player-admin \
    && cd apps/player-admin \
    && node ../../common/scripts/install-run-rushx.js build \
    && cd ../.. \
    && NODE_OPTIONS="--max-old-space-size=${BOX_PLAYER_SERVICE_BUILD_HEAP_MB}" \
    BOX_DEPLOYMENT_MODE=player-service \
    NEXT_PUBLIC_APP_ENV=development \
    NEXT_PUBLIC_APP_EDITION=createra \
    NEXT_PUBLIC_APP_REGION=cn \
    sh -c 'cd apps/game && node ../../common/scripts/install-run-rushx.js build-next'
RUN node apps/local-engine/src/prune-player-build.js --player-service \
      apps/game/.next \
      apps/game/.next/standalone/apps/game/.next \
    && rm -rf apps/game/.next/standalone/apps/local-engine \
    && find \
      apps/game/.next/standalone \
      apps/game/.next/static \
      apps/game/public \
      -type f \( \
      -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' \
      -o -name '*.p12' -o -name '*.pfx' -o -name '*.map' \
      -o -name '*.ts' -o -name '*.tsx' -o -name '*.nft.json' \
    \) -delete \
    && find apps/game/.next/standalone -type f \( \
      -name '*.test.js' -o -name '*.spec.js' \
    \) -not -path '*/node_modules/*' -delete

FROM source-base AS voxa-build

RUN --mount=type=cache,id=box-local-engine-pnpm,target=/pnpm/store \
    node common/scripts/install-run-rush.js install --to @box/voxa
RUN cd apps/voxa && node ../../common/scripts/install-run-rushx.js build

FROM ${NODE_IMAGE} AS runtime-base

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

# The slim image has no system CA bundle yet. Bootstrap HTTPS using Node's
# bundled trusted roots, then let Debian's ca-certificates own the final bundle.
# Keep TLS verification and repository signature validation enabled.
RUN node -e "const fs=require('node:fs');fs.mkdirSync('/etc/ssl/certs',{recursive:true});fs.writeFileSync('/etc/ssl/certs/ca-certificates.crt',require('node:tls').rootCertificates.join('\\n'))" \
    && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=2 -o Acquire::https::Timeout=30 -o APT::Update::Error-Mode=any update \
    && apt-get -o Acquire::Retries=2 -o Acquire::https::Timeout=30 install -y --no-install-recommends tini ca-certificates iproute2 iptables \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --chown=node:node packages/deployment-routing /app/packages/deployment-routing
LABEL box.routing.base-path="runtime-v1"
COPY --chown=node:node distribution/LICENSE.txt /app/LICENSE
ENTRYPOINT ["tini", "--"]

FROM runtime-base AS creator

ARG BOX_BUILD_VERSION
ARG BOX_BUILD_COMMIT
ARG BOX_BUILD_DATE
ARG BOX_BUILD_SOURCE
LABEL org.opencontainers.image.title="BOX Local Engine Creator" \
      org.opencontainers.image.version="${BOX_BUILD_VERSION}" \
      org.opencontainers.image.revision="${BOX_BUILD_COMMIT}" \
      org.opencontainers.image.created="${BOX_BUILD_DATE}" \
      org.opencontainers.image.source="${BOX_BUILD_SOURCE}" \
      org.opencontainers.image.licenses="MIT"

ENV BOX_DEPLOYMENT_MODE=creator \
    BOX_BUILD_VERSION=${BOX_BUILD_VERSION} \
    BOX_BUILD_COMMIT=${BOX_BUILD_COMMIT} \
    BOX_BUILD_DATE=${BOX_BUILD_DATE} \
    BOX_BUILD_SOURCE=${BOX_BUILD_SOURCE} \
    BOX_WEB_HOST=0.0.0.0 \
    BOX_WEB_PORT=3000 \
    BOX_PLAY_RUNTIME_HOST=0.0.0.0 \
    BOX_PLAY_RUNTIME_PORT=9966 \
    BOX_EDIT_RUNTIME_HOST=0.0.0.0 \
    BOX_EDIT_RUNTIME_PORT=9967 \
    BOX_LOCAL_TEMPLATE_DATA_PATH=/opt/box3-template-data \
    HOSTNAME=0.0.0.0 \
    PORT=3000

RUN if ! command -v tar >/dev/null || ! command -v gzip >/dev/null; then \
      apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 update \
      && apt-get install -y --no-install-recommends tar gzip \
      && rm -rf /var/lib/apt/lists/*; \
    fi \
    && command -v tar && command -v gzip

COPY --from=creator-build --chown=node:node /app/apps/game/.next/standalone /app/apps/game/.next/standalone
RUN node /app/packages/deployment-routing/src/standalone.cjs /app/apps/game/.next/standalone/apps/game/server.js creator
COPY --from=creator-build --chown=node:node /opt/game-server /app/services/game-server
COPY --from=creator-build --chown=node:node /opt/apis-runtime /app/node_modules/@box/apis
COPY --from=creator-build --chown=node:node /app/apps/local-engine/src/launcher.js /app/apps/local-engine/src/launcher.js
COPY --from=creator-build --chown=node:node /app/apps/local-engine/src/runtime-data-permissions.js /app/apps/local-engine/src/runtime-data-permissions.js
COPY --from=creator-build --chown=node:node /app/apps/local-engine/src/runtime-readiness.js /app/apps/local-engine/src/runtime-readiness.js
COPY --from=creator-build --chown=node:node /app/apps/local-engine/src/runtime-storage-namespace.js /app/apps/local-engine/src/runtime-storage-namespace.js
COPY --from=creator-build --chown=node:node /app/apps/local-engine/src/map-runtime-profiles.js /app/apps/local-engine/src/map-runtime-profiles.js
COPY --from=creator-build --chown=node:node /app/apps/local-engine/src/runtime-upstream.js /app/apps/local-engine/src/runtime-upstream.js
COPY --from=creator-build --chown=node:node /app/apps/local-engine/src/runtime-container-client.js /app/apps/local-engine/src/runtime-container-client.js
# The launcher requires this measured memory-budget module from every
# deployment mode; without it the container silently falls back to the
# historical voxel ladder and the budget feature is not deployed.
COPY --from=creator-build --chown=node:node /app/apps/local-engine/src/runtime-memory.mjs /app/apps/local-engine/src/runtime-memory.mjs
COPY --from=creator-build --chown=node:node /app/apps/local-engine/src/edit-library.js /app/apps/local-engine/src/edit-library.js
COPY --from=creator-build --chown=node:node /app/apps/local-engine/src/teleport-room-manager.js /app/apps/local-engine/src/teleport-room-manager.js
COPY --from=creator-build --chown=node:node /app/apps/local-engine/src/map-identity.js /app/apps/local-engine/src/map-identity.js
COPY --from=creator-build --chown=node:node /app/apps/local-engine/src/runtime-lifecycle.js /app/apps/local-engine/src/runtime-lifecycle.js
COPY --from=creator-build --chown=node:node /app/apps/local-engine/src/moderation-credential.js /app/apps/local-engine/src/moderation-credential.js
COPY --from=creator-build --chown=node:node /app/apps/local-engine/src/moderation-runtime-launch.js /app/apps/local-engine/src/moderation-runtime-launch.js
COPY --from=creator-build --chown=node:node /app/apps/local-engine/src/project-manager.js /app/apps/local-engine/src/project-manager.js
COPY --from=creator-build --chown=node:node /app/apps/local-engine/src/asset-distribution.js /app/apps/local-engine/src/asset-distribution.js
COPY --from=creator-build --chown=node:node /app/apps/local-engine/src/distribution-metadata.js /app/apps/local-engine/src/distribution-metadata.js
COPY --from=creator-build --chown=node:node /app/apps/local-engine/src/map-group-manager.js /app/apps/local-engine/src/map-group-manager.js
COPY --from=creator-build --chown=node:node /app/apps/local-engine/src/project-compatibility.js /app/apps/local-engine/src/project-compatibility.js
COPY --from=creator-build --chown=node:node /app/apps/local-engine/src/play-image.js /app/apps/local-engine/src/play-image.js
COPY --from=creator-build --chown=node:node /app/apps/local-engine/config /app/apps/local-engine/config
COPY --from=creator-build --chown=node:node /app/distribution/play/.env.example /app/distribution/play/.env.example
COPY --from=creator-build --chown=node:node /app/distribution/LICENSE.txt /app/distribution/LICENSE.txt
# Keep the blank-map template outside /app/apps/local-engine/data. Deployments
# bind-mount that path for mutable policies, which otherwise hides the runtime
# assets baked into the image and makes every newly created map incomplete.
COPY --from=creator-build --chown=node:node /opt/runtime-data /opt/box3-template-data
RUN cp -al /opt/box3-template-data /app/apps/local-engine/data

# The production deploy above is copied wholesale, including runtime-only
# dependencies. Verify the final layer still contains the SSE implementation.
RUN node -e "require.resolve('better-sse', { paths: ['/app/services/game-server'] })"

RUN mkdir -p /app/apps/local-engine/projects /app/apps/local-engine/dist \
    && chown -R node:node /app/apps/local-engine

USER node

EXPOSE 3000 9966 9967
VOLUME ["/app/apps/local-engine/projects", "/app/apps/local-engine/dist"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health-check').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["node", "apps/local-engine/src/launcher.js", "--production", "--creator"]

FROM runtime-base AS play

ARG BOX_BUILD_VERSION
ARG BOX_BUILD_COMMIT
ARG BOX_BUILD_DATE
ARG BOX_BUILD_SOURCE
LABEL org.box.local-engine.play-format="7" \
      org.opencontainers.image.title="BOX Local Engine Play" \
      org.opencontainers.image.version="${BOX_BUILD_VERSION}" \
      org.opencontainers.image.revision="${BOX_BUILD_COMMIT}" \
      org.opencontainers.image.created="${BOX_BUILD_DATE}" \
      org.opencontainers.image.source="${BOX_BUILD_SOURCE}" \
      org.opencontainers.image.licenses="MIT"

# The Play Library control endpoint is private to the Compose network.
# Isolated map/room containers use it for signed teleport allocation;
# docker-compose publishes only port 3000 to the host.
ENV BOX_DEPLOYMENT_MODE=play \
    BOX_BUILD_VERSION=${BOX_BUILD_VERSION} \
    BOX_BUILD_COMMIT=${BOX_BUILD_COMMIT} \
    BOX_BUILD_DATE=${BOX_BUILD_DATE} \
    BOX_BUILD_SOURCE=${BOX_BUILD_SOURCE} \
    BOX_WEB_HOST=0.0.0.0 \
    BOX_WEB_PORT=3000 \
    BOX_PLAY_RUNTIME_HOST=0.0.0.0 \
    BOX_PLAY_RUNTIME_PORT=9966 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

COPY --from=play-build --chown=node:node /app/apps/game/.next/standalone /app/apps/game/.next/standalone
RUN node /app/packages/deployment-routing/src/standalone.cjs /app/apps/game/.next/standalone/apps/game/server.js play
COPY --from=play-build --chown=node:node /opt/game-server /app/services/game-server
COPY --from=play-build --chown=node:node /opt/apis-runtime /app/node_modules/@box/apis
COPY --from=play-build --chown=node:node /app/apps/local-engine/src/launcher.js /app/apps/local-engine/src/launcher.js
COPY --from=play-build --chown=node:node /app/apps/local-engine/src/runtime-data-permissions.js /app/apps/local-engine/src/runtime-data-permissions.js
COPY --from=play-build --chown=node:node /app/apps/local-engine/src/runtime-readiness.js /app/apps/local-engine/src/runtime-readiness.js
COPY --from=play-build --chown=node:node /app/apps/local-engine/src/runtime-storage-namespace.js /app/apps/local-engine/src/runtime-storage-namespace.js
COPY --from=play-build --chown=node:node /app/apps/local-engine/src/map-runtime-profiles.js /app/apps/local-engine/src/map-runtime-profiles.js
COPY --from=play-build --chown=node:node /app/apps/local-engine/src/runtime-upstream.js /app/apps/local-engine/src/runtime-upstream.js
COPY --from=play-build --chown=node:node /app/apps/local-engine/src/runtime-container-client.js /app/apps/local-engine/src/runtime-container-client.js
# The launcher requires this measured memory-budget module from every
# deployment mode; without it the container silently falls back to the
# historical voxel ladder and the budget feature is not deployed.
COPY --from=play-build --chown=node:node /app/apps/local-engine/src/runtime-memory.mjs /app/apps/local-engine/src/runtime-memory.mjs
COPY --from=play-build --chown=node:node /app/apps/local-engine/src/project-compatibility.js /app/apps/local-engine/src/project-compatibility.js
COPY --from=play-build --chown=node:node /app/apps/local-engine/src/play-image.js /app/apps/local-engine/src/play-image.js
COPY --from=play-build --chown=node:node /app/apps/local-engine/src/play-library.js /app/apps/local-engine/src/play-library.js
COPY --from=play-build --chown=node:node /app/apps/local-engine/src/play-derived-resources.js /app/apps/local-engine/src/play-derived-resources.js
COPY --from=play-build --chown=node:node /app/apps/local-engine/src/teleport-room-manager.js /app/apps/local-engine/src/teleport-room-manager.js
COPY --from=play-build --chown=node:node /app/apps/local-engine/src/map-identity.js /app/apps/local-engine/src/map-identity.js
COPY --from=play-build --chown=node:node /app/apps/local-engine/src/runtime-lifecycle.js /app/apps/local-engine/src/runtime-lifecycle.js
COPY --from=play-build --chown=node:node /app/apps/local-engine/src/moderation-credential.js /app/apps/local-engine/src/moderation-credential.js
COPY --from=play-build --chown=node:node /app/apps/local-engine/src/moderation-runtime-launch.js /app/apps/local-engine/src/moderation-runtime-launch.js
COPY --from=play-build --chown=node:node /app/apps/local-engine/config /app/apps/local-engine/config
COPY --from=play-build --chown=node:node /opt/runtime-data /app/apps/local-engine/data

RUN node -e "require('/app/apps/local-engine/src/play-library.js')" \
    && mkdir -p /app/play-runtime-cache \
    && chown -R node:node /app/play-runtime-cache

USER node

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=5 \
  CMD node -e "Promise.all([fetch('http://127.0.0.1:3000/api/health-check'),fetch('http://127.0.0.1:3000/api/play-worlds')]).then(rs=>{if(rs.some(r=>!r.ok))process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["node", "apps/local-engine/src/launcher.js", "--production", "--play"]

FROM runtime-base AS player-service

ARG BOX_BUILD_VERSION
ARG BOX_BUILD_COMMIT
ARG BOX_BUILD_DATE
ARG BOX_BUILD_SOURCE
LABEL org.box.local-engine.player-service-format="7" \
      org.box.local-engine.play-format="7" \
      org.opencontainers.image.title="BOX Local Engine Player Service" \
      org.opencontainers.image.version="${BOX_BUILD_VERSION}" \
      org.opencontainers.image.revision="${BOX_BUILD_COMMIT}" \
      org.opencontainers.image.created="${BOX_BUILD_DATE}" \
      org.opencontainers.image.source="${BOX_BUILD_SOURCE}" \
      org.opencontainers.image.licenses="MIT"

ENV BOX_DEPLOYMENT_MODE=player-service \
    NEXT_PUBLIC_APP_ENV=development \
    NEXT_PUBLIC_APP_EDITION=createra \
    NEXT_PUBLIC_APP_REGION=cn \
    HOSTNAME=0.0.0.0 \
    PORT=3213

COPY --from=player-service-build --chown=node:node /app/apps/game/.next/standalone /app/apps/game/.next/standalone
RUN node /app/packages/deployment-routing/src/standalone.cjs /app/apps/game/.next/standalone/apps/game/server.js player-service
COPY --from=player-service-build --chown=node:node /app/apps/game/.next/static /app/apps/game/.next/standalone/apps/game/.next/static
COPY --from=player-service-build --chown=node:node /app/apps/game/public /app/apps/game/.next/standalone/apps/game/public

USER node

EXPOSE 3213

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3213/api/health-check').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["node", "apps/game/.next/standalone/apps/game/server.js"]

FROM runtime-base AS voxa

ARG BOX_BUILD_VERSION
ARG BOX_BUILD_COMMIT
ARG BOX_BUILD_DATE
ARG BOX_BUILD_SOURCE
LABEL org.opencontainers.image.title="BOX Local Engine VOXA" \
      org.opencontainers.image.version="${BOX_BUILD_VERSION}" \
      org.opencontainers.image.revision="${BOX_BUILD_COMMIT}" \
      org.opencontainers.image.created="${BOX_BUILD_DATE}" \
      org.opencontainers.image.source="${BOX_BUILD_SOURCE}" \
      org.opencontainers.image.licenses="MIT"

ENV BOX_BUILD_VERSION=${BOX_BUILD_VERSION} \
    BOX_BUILD_COMMIT=${BOX_BUILD_COMMIT} \
    BOX_BUILD_DATE=${BOX_BUILD_DATE} \
    BOX_BUILD_SOURCE=${BOX_BUILD_SOURCE} \
    VOXA_DATA_PATH=/app/apps/voxa/data \
    HOSTNAME=0.0.0.0 \
    PORT=3001

COPY --from=voxa-build --chown=node:node /app/apps/voxa/.next/standalone /app/apps/voxa/.next/standalone
RUN node /app/packages/deployment-routing/src/standalone.cjs /app/apps/voxa/.next/standalone/apps/voxa/server.js voxa
COPY --from=voxa-build --chown=node:node /app/apps/voxa/.next/static /app/apps/voxa/.next/standalone/apps/voxa/.next/static
COPY --from=voxa-build --chown=node:node /app/apps/voxa/public /app/apps/voxa/.next/standalone/apps/voxa/public

RUN mkdir -p /app/apps/voxa/data \
    && find /app/apps/voxa/.next/standalone -type f \( \
      -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' \
      -o -name '*.map' -o -name '*.ts' -o -name '*.tsx' -o -name '*.nft.json' \
    \) -delete \
    && chown -R node:node /app/apps/voxa

USER node

EXPOSE 3001
VOLUME ["/app/apps/voxa/data"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health-check').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["node", "apps/voxa/.next/standalone/apps/voxa/server.js"]
