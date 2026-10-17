#!/bin/bash
# W5 verification round 2: real launcher.js top level inside the shipped image,
# corrected --print labels, and a prettier availability probe.
set -u
SRC="/mnt/d/desktop/神奇代码岛/box3-local-engine/apps/local-engine/src"
IMG=box-local-engine-play:v2026.1.4-linux-amd64

echo "########## A) launcher.js top level, runtime-memory.mjs present (creator-shaped 6g) ##########"
docker run --rm --memory=6g -v "$SRC:/app/apps/local-engine/src:ro" "$IMG" sh -c 'cd /app && node apps/local-engine/src/launcher.js --creator --play 2>&1 | head -6'
echo "--- explicit compose-style env (BOX_SCRIPT_HEAP_MB=512, SCRIPT_MEMORY_LIMIT=512) ---"
docker run --rm --memory=6g -e BOX_SCRIPT_HEAP_MB=512 -e SCRIPT_MEMORY_LIMIT=512 -v "$SRC:/app/apps/local-engine/src:ro" "$IMG" sh -c 'cd /app && node apps/local-engine/src/launcher.js --creator --play 2>&1 | head -4'
echo "--- compat rollback (BOX_SCRIPT_MEMORY_BUDGET=compat, no env) ---"
docker run --rm --memory=6g -e BOX_SCRIPT_MEMORY_BUDGET=compat -v "$SRC:/app/apps/local-engine/src:ro" "$IMG" sh -c 'cd /app && node apps/local-engine/src/launcher.js --creator --play 2>&1 | head -3'
echo "--- 16 GiB private box, no env: measured raise ---"
docker run --rm --memory=16g -v "$SRC:/app/apps/local-engine/src:ro" "$IMG" sh -c 'cd /app && node apps/local-engine/src/launcher.js --creator --play 2>&1 | head -3'
echo "--- simulated 1 GiB box (small-org floor) ---"
docker run --rm --memory=1g -v "$SRC:/app/apps/local-engine/src:ro" "$IMG" sh -c 'cd /app && node apps/local-engine/src/launcher.js --creator --play 2>&1 | head -3'

echo "########## B) same, but runtime-memory.mjs removed from the mounted tree (image ships no COPY for it) ##########"
rm -rf /tmp/w5src && cp -r "$SRC" /tmp/w5src && rm -f /tmp/w5src/runtime-memory.mjs
docker run --rm --memory=6g -v "/tmp/w5src:/app/apps/local-engine/src:ro" "$IMG" sh -c 'cd /app && ls apps/local-engine/src/runtime-memory.mjs 2>&1 | tail -1; node apps/local-engine/src/launcher.js --creator --play 2>&1 | head -4'

echo "########## C) play-pool shape (8 runtimes, 4g) ##########"
docker run --rm --memory=4g -e BOX_PLAY_MAX_RUNTIMES=8 -v "$SRC:/app/apps/local-engine/src:ro" "$IMG" sh -c 'cd /app && node apps/local-engine/src/launcher.js --play --creator 2>&1 | head -3'
echo "--- and with BOX_PLAY_MAX_RUNTIMES=2 on the same 4g limit ---"
docker run --rm --memory=4g -e BOX_PLAY_MAX_RUNTIMES=2 -v "$SRC:/app/apps/local-engine/src:ro" "$IMG" sh -c 'cd /app && node apps/local-engine/src/launcher.js --play --creator 2>&1 | head -3'

echo "########## D) --print self-test with corrected preset labels (6g / pool 10) ##########"
docker run --rm --memory=6g -v "$SRC:/w5:ro" "$IMG" node /w5/runtime-memory.mjs --print --runtimes 10
echo "########## E) --print on a 16g box ##########"
docker run --rm --memory=16g -v "$SRC:/w5:ro" "$IMG" node /w5/runtime-memory.mjs --print --runtimes 10

echo "########## F) node --check both files (final) ##########"
docker run --rm -i "$IMG" node --check < "$SRC/launcher.js" && echo "launcher.js --check OK"
docker run --rm -v "$SRC:/w5:ro" "$IMG" sh -c 'node --check /w5/runtime-memory.mjs && echo "runtime-memory.mjs --check OK"'

echo "########## G) prettier / eslint availability in the runtime image ##########"
docker run --rm "$IMG" sh -c 'ls /app/node_modules/.bin 2>/dev/null | grep -iE "prettier|eslint" || echo "no prettier/eslint in the runtime image"'
echo "[done]"
