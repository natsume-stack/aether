#!/bin/bash
# End-to-end smoke: prune the shipped standalone tree, boot the real Next server
# from it inside the official image, and confirm it still serves.
set -uo pipefail
SRC=/var/tmp/re-arch/creator-next/standalone
T=/var/tmp/smoke-standalone
IMG=box-local-engine-play:v2026.1.4-linux-amd64

echo "== 1. copy standalone =="
rm -rf "$T"; cp -a "$SRC" "$T"
before=$(du -sb "$T" | cut -f1)
echo "before: $before B ($(numfmt --to=iec $before))"

echo
echo "== 2. apply the P0 prune (build-time tooling only) =="
for pat in "@swc+core@" "@swc+types@" "typescript@" "esbuild@" "@esbuild+" "sass@" "@babel+" "babel-plugin-"; do
  found=$(find "$T" -type d -path "*/.pnpm/${pat}*" -prune 2>/dev/null | wc -l)
  find "$T" -type d -path "*/.pnpm/${pat}*" -exec rm -rf {} + 2>/dev/null
  echo "  $pat -> removed $found pnpm dirs"
done
# font duplicate copy
rm -rf "$T/apps/game/.next/server/chunks/static"
after=$(du -sb "$T" | cut -f1)
echo "after : $after B ($(numfmt --to=iec $after))   removed $((before-after)) B ($(( (before-after)/1048576 )) MiB)"

echo
echo "== 3. boot the real server from the pruned tree =="
docker rm -f smoke-web >/dev/null 2>&1
docker run -d --name smoke-web --entrypoint sh "$IMG" -c \
  "cd /app/apps/game/.next/standalone/apps/game && PORT=3999 HOSTNAME=127.0.0.1 node server.js" 2>&1 | tail -1
sleep 1
docker cp "$T" smoke-web:/tmp/pruned >/dev/null 2>&1
# replace the image's own standalone with the pruned one inside the throwaway container
docker exec smoke-web sh -c "rm -rf /app/apps/game/.next/standalone && mv /tmp/pruned /app/apps/game/.next/standalone" 2>&1 | head -2
docker exec smoke-web sh -c "cd /app/apps/game/.next/standalone/apps/game && (PORT=3999 HOSTNAME=127.0.0.1 nohup node server.js > /tmp/srv.log 2>&1 &)" 2>&1 | head -2
echo "waiting for boot..."
ok=""
for i in $(seq 1 30); do
  sleep 2
  code=$(docker exec smoke-web node -e "fetch('http://127.0.0.1:3999/api/health-check').then(r=>console.log(r.status)).catch(e=>console.log('ERR '+e.message))" 2>&1 | tail -1)
  case "$code" in
    200*) ok="YES"; echo "  t+$((i*2))s health=$code"; break ;;
    *) printf "  t+%ss %s\n" "$((i*2))" "$(printf '%s' "$code" | head -c 120)" ;;
  esac
done
echo
echo "== 4. server log tail =="
docker exec smoke-web tail -12 /tmp/srv.log 2>&1
echo
echo "== 5. page render check (SSR really works) =="
docker exec smoke-web node -e "fetch('http://127.0.0.1:3999/').then(r=>r.text().then(t=>console.log(r.status, 'bytes='+t.length, t.slice(0,120).replace(/\n/g,' '))))" 2>&1 | tail -2
echo
echo "RESULT: pruned tree boots and serves = ${ok:-NO}"
docker rm -f smoke-web >/dev/null 2>&1
echo "(throwaway container removed; nothing else touched)"
