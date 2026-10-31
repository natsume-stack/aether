# Build with --build-arg BASE_IMAGE=box-local-engine-player-auth-portal:<engine-version>.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# Copy the default public/ folder to your build context, then customize it.
# Retain app.js to keep login, session, logout and returnUrl behavior compatible.
COPY --chown=node:node public/ /app/public/
