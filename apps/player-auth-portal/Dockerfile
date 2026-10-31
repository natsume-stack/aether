ARG NODE_IMAGE=docker.m.daocloud.io/library/node:22.17.0-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /build
COPY packages/deployment-routing ./vendor/deployment-routing
COPY internals/apis/package.json ./vendor/apis/package.json
COPY internals/apis/src ./vendor/apis/src
COPY apps/player-auth-portal/package.json apps/player-auth-portal/package-lock.json ./
COPY apps/player-auth-portal/scripts/standalone-manifest.cjs ./scripts/standalone-manifest.cjs
RUN node scripts/standalone-manifest.cjs /build /build/vendor/deployment-routing /build/vendor/apis
RUN npm ci --include=dev --ignore-scripts
COPY apps/player-auth-portal/src ./src
COPY apps/player-auth-portal/server ./server
COPY apps/player-auth-portal/public ./public
COPY apps/player-auth-portal/scripts/tasks.ts apps/player-auth-portal/scripts/mock.ts apps/player-auth-portal/scripts/standalone-manifest.d.cts ./scripts/
COPY apps/player-auth-portal/tsconfig.json apps/player-auth-portal/tsconfig.library.json ./
RUN npm run build

FROM ${NODE_IMAGE}
LABEL box.routing.base-path="runtime-v1"

ARG BOX_BUILD_VERSION=2026.1.4
ARG BOX_BUILD_COMMIT=unknown
ARG BOX_BUILD_DATE=unknown
ARG BOX_BUILD_SOURCE=local

LABEL org.opencontainers.image.title="BOX Local Engine Player Auth Portal" \
      org.opencontainers.image.description="Owner-hosted login and registration portal for BOX Local Engine" \
      org.opencontainers.image.version="${BOX_BUILD_VERSION}" \
      org.opencontainers.image.revision="${BOX_BUILD_COMMIT}" \
      org.opencontainers.image.created="${BOX_BUILD_DATE}" \
      org.opencontainers.image.source="${BOX_BUILD_SOURCE}" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    AUTH_DEMO_HOST=0.0.0.0 \
    AUTH_DEMO_PORT=3214

WORKDIR /app

COPY --from=build --chown=node:node /build/build/server.cjs ./build/server.cjs
COPY --from=build --chown=node:node /build/public ./public

COPY --chown=node:node distribution/LICENSE.txt /app/LICENSE

USER node

EXPOSE 3214

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3214/api/health-check').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "build/server.cjs"]
