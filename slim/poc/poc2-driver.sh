#!/bin/bash
# W7 PoC-2 driver: one fresh node process per isolate count, both modes.
POC="/mnt/d/desktop/神奇代码岛/box3-re/poc"
IMG=box-local-engine-play:v2026.1.4-linux-amd64
docker run --rm -v "$POC:/poc" --entrypoint sh "$IMG" -c "sed -i 's/\r\$//' /poc/*.mjs /poc/*.sh 2>/dev/null; true"
for MODE in bare loaded; do
  for K in 0 1 2 4 8 16; do
    docker run --rm \
      -v "$POC:/poc" \
      -w /app/services/game-server \
      -e NODE_PATH=/app/services/game-server/node_modules/.pnpm/isolated-vm@5.0.4/node_modules \
      --entrypoint node \
      "$IMG" --expose-gc /poc/poc2-rss.mjs "$K" "$MODE"
  done
done
