#!/bin/bash
# Host driver: run a PoC .mjs inside the play image with /poc bind mount.
# Usage: run-node.sh <script.mjs> [extra node args...]
set -u
POC="/mnt/d/desktop/神奇代码岛/box3-re/poc"
IMG=box-local-engine-play:v2026.1.4-linux-amd64
SCRIPT="$1"; shift || true

# Strip CRLF from everything we just wrote from Windows.
docker run --rm -v "$POC:/poc" --entrypoint sh "$IMG" -c "sed -i 's/\r\$//' /poc/*.mjs /poc/*.sh 2>/dev/null; true"

docker run --rm \
  -v "$POC:/poc" \
  -w /app/services/game-server \
  -e NODE_PATH=/app/services/game-server/node_modules/.pnpm/isolated-vm@5.0.4/node_modules \
  --entrypoint node \
  "$IMG" /poc/"$SCRIPT" "$@"
