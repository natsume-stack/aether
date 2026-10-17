#!/bin/bash
# Locate the CPU-fairness cliff: sweep isolate count with exactly 1 runaway isolate.
POC="/mnt/d/desktop/神奇代码岛/box3-re/poc"
OUT="/mnt/d/desktop/神奇代码岛/box3-re/poc/raw3"
IMG=box-local-engine-play:v2026.1.4-linux-amd64
mkdir -p "$OUT"
for REP in 1 2; do
  for N in 2 4 6 8 12 16 24; do
    docker run --rm -v "$POC:/poc" -w /app/services/game-server \
      -e NODE_PATH=/app/services/game-server/node_modules/.pnpm/isolated-vm@5.0.4/node_modules \
      --entrypoint node "$IMG" /poc/poc3-fairness.mjs 6000 "$N" 1200 2500 async 1 \
      > "$OUT/cliff_N${N}_rep${REP}.json" 2>&1
    echo "done N=$N rep=$REP"
  done
done
