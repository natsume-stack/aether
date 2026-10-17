#!/bin/bash
# W5 verification round 3 (final): syntax, prettier-stable code, real launcher
# pool arithmetic, and the --print self-test outputs for the report.
set -u
SRC="/mnt/d/desktop/神奇代码岛/box3-local-engine/apps/local-engine/src"
IMG=box-local-engine-play:v2026.1.4-linux-amd64

echo "########## 1) node --check (contract form: stdin) ##########"
docker run --rm -i "$IMG" node --check < "$SRC/launcher.js" && echo "launcher.js: node --check OK (stdin)"
docker run --rm -i "$IMG" node --check --input-type=module < "$SRC/runtime-memory.mjs" 2>&1 | tail -2

echo "########## 2) node --check (file form, both) ##########"
docker run --rm -v "$SRC:/w5:ro" "$IMG" sh -c 'node --check /w5/launcher.js && echo "launcher.js: node --check OK"; node --check /w5/runtime-memory.mjs && echo "runtime-memory.mjs: node --check OK"'

echo "########## 3) real launcher, creator mode (pool = BOX_CREATOR_EDIT 6 + PLAY 4) ##########"
docker run --rm --memory=6g --network none -v "$SRC:/app/apps/local-engine/src:ro" "$IMG" sh -c 'cd /app && timeout -s TERM 30 node apps/local-engine/src/launcher.js --production --creator 2>&1 | head -6'
echo "--- creator mode, explicit 8+2 pool override ---"
docker run --rm --memory=6g --network none -e BOX_CREATOR_EDIT_MAX_RUNTIMES=8 -e BOX_CREATOR_PLAY_MAX_RUNTIMES=2 -v "$SRC:/app/apps/local-engine/src:ro" "$IMG" sh -c 'cd /app && timeout -s TERM 30 node apps/local-engine/src/launcher.js --production --creator 2>&1 | head -3'

echo "########## 4) precedence proof, real launcher under 6g ##########"
echo "--- no env (measured) ---"
docker run --rm --memory=6g --network none -v "$SRC:/app/apps/local-engine/src:ro" "$IMG" \
  sh -c 'cd /app && timeout -s TERM 30 node apps/local-engine/src/launcher.js --production --creator 2>&1 | grep "Script isolate budget"'
echo "--- compose defaults (BOX_SCRIPT_HEAP_MB=512 SCRIPT_MEMORY_LIMIT=512) ---"
docker run --rm --memory=6g --network none -e BOX_SCRIPT_HEAP_MB=512 -e SCRIPT_MEMORY_LIMIT=512 \
  -v "$SRC:/app/apps/local-engine/src:ro" "$IMG" \
  sh -c 'cd /app && timeout -s TERM 30 node apps/local-engine/src/launcher.js --production --creator 2>&1 | grep "Script isolate budget"'
echo "--- compat rollback switch, no env ---"
docker run --rm --memory=6g --network none -e BOX_SCRIPT_MEMORY_BUDGET=compat \
  -v "$SRC:/app/apps/local-engine/src:ro" "$IMG" \
  sh -c 'cd /app && timeout -s TERM 30 node apps/local-engine/src/launcher.js --production --creator 2>&1 | grep "Script isolate budget"'
echo "--- operator raises explicitly to 1024 ---"
docker run --rm --memory=6g --network none -e BOX_SCRIPT_HEAP_MB=1024 -e SCRIPT_MEMORY_LIMIT=1024 \
  -v "$SRC:/app/apps/local-engine/src:ro" "$IMG" \
  sh -c 'cd /app && timeout -s TERM 30 node apps/local-engine/src/launcher.js --production --creator 2>&1 | grep "Script isolate budget"'
echo "--- reserve override on a 16g box (reserve 8g) ---"
docker run --rm --memory=16g --network none -e BOX_RUNTIME_MEMORY_RESERVE_MB=8192 \
  -v "$SRC:/app/apps/local-engine/src:ro" "$IMG" \
  sh -c 'cd /app && timeout -s TERM 30 node apps/local-engine/src/launcher.js --production --creator 2>&1 | grep "Script isolate budget"'

echo "########## 5) --print self-test: creator shape 6g / pool 10 ##########"
docker run --rm --memory=6g --cpus=4 -v "$SRC:/w5:ro" "$IMG" node /w5/runtime-memory.mjs --print --runtimes 10
echo "########## 6) --print self-test: play shape 4g / pool 8 ##########"
docker run --rm --memory=4g -v "$SRC:/w5:ro" "$IMG" node /w5/runtime-memory.mjs --print --runtimes 8
echo "########## 7) --print self-test: 16g box / pool 10 ##########"
docker run --rm --memory=16g -v "$SRC:/w5:ro" "$IMG" node /w5/runtime-memory.mjs --print --runtimes 10
echo "########## 8) --print self-test: 1g box / pool 10 (floor + warn) ##########"
docker run --rm --memory=1g -v "$SRC:/w5:ro" "$IMG" node /w5/runtime-memory.mjs --print --runtimes 10
echo "########## 9) --print self-test: no cgroup limit (totalmem fallback) ##########"
docker run --rm -v "$SRC:/w5:ro" "$IMG" node /w5/runtime-memory.mjs --print --runtimes 10 | tail -5

echo "########## 10) missing-module fallback still equals legacy ##########"
rm -rf /tmp/w5src && cp -r "$SRC" /tmp/w5src && rm -f /tmp/w5src/runtime-memory.mjs
docker run --rm --memory=6g --network none -v "/tmp/w5src:/app/apps/local-engine/src:ro" "$IMG" sh -c 'cd /app && timeout -s TERM 30 node apps/local-engine/src/launcher.js --production --creator 2>&1 | head -4'
echo "[done]"
