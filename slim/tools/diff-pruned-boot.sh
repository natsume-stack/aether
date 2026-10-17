#!/bin/bash
# Differential test: same image, same env, only the mounted standalone tree differs.
# If the pruned tree behaves identically to the shipped tree, the prune is neutral.
set -uo pipefail
IMG=box-local-engine-play:v2026.1.4-linux-amd64
SRC=/var/tmp/re-arch/creator-next/standalone
PRUNED=/var/tmp/pruned-standalone
PATH_IN_IMG=/app/apps/game/.next/standalone

probe () {  # $1=name  $2=volume-source-or-empty
  local name="$1" src="$2"
  docker rm -f "diff-$name" >/dev/null 2>&1
  if [ -n "$src" ]; then
    docker run -d --name "diff-$name" --entrypoint sh \
      -v "$src:$PATH_IN_IMG" "$IMG" \
      -c "cd $PATH_IN_IMG/apps/game && exec env PORT=3999 HOSTNAME=127.0.0.1 node server.js" >/dev/null 2>&1
  else
    docker run -d --name "diff-$name" --entrypoint sh "$IMG" \
      -c "cd $PATH_IN_IMG/apps/game && exec env PORT=3999 HOSTNAME=127.0.0.1 node server.js" >/dev/null 2>&1
  fi
  for i in $(seq 1 25); do
    sleep 2
    up=$(docker exec "diff-$name" node -e "fetch('http://127.0.0.1:3999/').then(r=>console.log('LISTEN '+r.status)).catch(()=>console.log('down'))" 2>/dev/null | tail -1)
    case "$up" in LISTEN*) break ;; esac
  done
  echo "  [$name] boot: ${up:-TIMEOUT}"
  docker exec "diff-$name" node -e '
    const u=[ "/api/health-check", "/", "/_next/static/chunks/main-277ff2fbd803da65.js", "/logo512.png" ];
    (async()=>{ for (const p of u) { try { const r = await fetch("http://127.0.0.1:3999"+p); const b = await r.arrayBuffer();
      const d=new Uint8Array(b); let h=0; for (let i=0;i<d.length;i++) h=(h*31+d[i])>>>0;
      console.log(String(r.status).padStart(3), String(d.length).padStart(9),"B", "cksum="+h.toString(16).padStart(8,"0"), p);
    } catch(e) { console.log("ERR", p, e.message.slice(0,60)); } } })()' 2>&1
  echo "  [$name] server stderr (Cannot find module 检查):"
  docker logs "diff-$name" 2>&1 | grep -iE "cannot find module|MODULE_NOT_FOUND|Error:" | head -3 | sed 's/^/     /'
  docker rm -f "diff-$name" >/dev/null 2>&1
}

echo "== build the pruned tree =="
rm -rf "$PRUNED"; cp -a "$SRC" "$PRUNED"
b=$(du -sb "$PRUNED" | cut -f1)
for pat in "@swc+core@" "@swc+types@" "typescript@" "esbuild@" "@esbuild+" "sass@" "@babel+" "babel-plugin-"; do
  find "$PRUNED" -type d -path "*/.pnpm/${pat}*" -exec rm -rf {} + 2>/dev/null
done
rm -rf "$PRUNED/apps/game/.next/server/chunks/static"
a=$(du -sb "$PRUNED" | cut -f1)
echo "  control tree = $(numfmt --to=iec $b)B ; pruned tree = $(numfmt --to=iec $a)B ; removed $((b-a))B ($(( (b-a)/1048576 )) MiB)"
echo

echo "== CONTROL (image's own shipped standalone) =="
probe control ""
echo
echo "== PRUNED (same image, pruned standalone mounted over it) =="
probe pruned "$PRUNED"
echo
echo "== 判定：两组 status/字节数/checksum 全一致 => 裁剪对运行时中性 =="
