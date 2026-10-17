#!/bin/bash
# PoC-3 thread-pool saturation sweep (async = the engine's real call form).
POC="/mnt/d/desktop/神奇代码岛/box3-re/poc"
IMG=box-local-engine-play:v2026.1.4-linux-amd64
run () {
  echo "### N_ISO=$1 HANG_COUNT=$2 MODE=$3"
  docker run --rm -v "$POC:/poc" -w /app/services/game-server \
    -e NODE_PATH=/app/services/game-server/node_modules/.pnpm/isolated-vm@5.0.4/node_modules \
    --entrypoint node "$IMG" /poc/poc3-fairness.mjs 7000 "$1" 1500 3000 "$3" "$2" \
    > "/mnt/d/desktop/神奇代码岛/box3-re/poc/out-poc3-N${1}-H${2}-$3.txt" 2>&1
  grep -E '"victim_summary"|"hanger_summary"|"n"|"worst|"mainEventLoopDelay|"p99"|"max"' \
    "/mnt/d/desktop/神奇代码岛/box3-re/poc/out-poc3-N${1}-H${2}-$3.txt" | head -4
  sed -n '/victim_summary/,/]/p' "/mnt/d/desktop/神奇代码岛/box3-re/poc/out-poc3-N${1}-H${2}-$3.txt" | head -6
  sed -n '/mainEventLoopDelay_ms/,/}/p' "/mnt/d/desktop/神奇代码岛/box3-re/poc/out-poc3-N${1}-H${2}-$3.txt"
}
run 16 1 async
run 16 4 async
run 32 8 async
run 16 0 async
