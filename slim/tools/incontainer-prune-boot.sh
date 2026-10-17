#!/bin/bash
# In-container prune + boot: reproduce what the Dockerfile change actually does.
# Root inside a throwaway container, delete build-time tooling from the shipped
# standalone tree, then boot the real Next server and diff its responses against
# an unmodified control container.
set -uo pipefail
IMG=box-local-engine-play:v2026.1.4-linux-amd64
SA=/app/apps/game/.next/standalone

start () {  # $1=name  $2=prune(1/0)
  docker rm -f "b-$1" >/dev/null 2>&1
  docker run -d --name "b-$1" --user root --entrypoint sh "$IMG" -c 'sleep 3600' >/dev/null 2>&1
  if [ "$2" = 1 ]; then
    docker exec "b-$1" sh -c "cd $SA && for p in '@swc+core@' '@swc+types@' 'typescript@' 'esbuild@' '@esbuild+' 'sass@' '@babel+' 'babel-plugin-'; do find . -type d -path \"*/.pnpm/\$p*\" -exec rm -rf {} + 2>/dev/null; done; rm -rf $SA/apps/game/.next/server/chunks/static" 2>&1 | head -2
    echo "  [$1] pruned tree size: $(docker exec "b-$1" du -sb $SA 2>/dev/null | cut -f1) B"
  else
    echo "  [$1] control tree size: $(docker exec "b-$1" du -sb $SA 2>/dev/null | cut -f1) B"
  fi
}

boot_and_probe () {  # $1=name
  docker exec -d "b-$1" sh -c "cd $SA/apps/game && PORT=3999 HOSTNAME=127.0.0.1 NODE_ENV=production NEXT_PUBLIC_APP_ENV=development nohup node server.js > /tmp/s.log 2>&1"
  local up=""
  for i in $(seq 1 25); do
    sleep 2
    up=$(docker exec "b-$1" node -e "fetch('http://127.0.0.1:3999/api/health-check').then(r=>console.log('UP '+r.status)).catch(()=>console.log('down'))" 2>/dev/null | tail -1)
    case "$up" in UP*) break ;; esac
  done
  echo "  [$1] boot: ${up:-TIMEOUT}  ($(docker exec "b-$1" du -sb $SA 2>/dev/null | cut -f1) B tree)"
  docker exec "b-$1" node -e '
    const ps=["/api/health-check","/","/_next/static/chunks/main-277ff2fbd803da65.js","/logo512.png","/createra-favicon.ico"];
    (async()=>{for(const p of ps){try{const r=await fetch("http://127.0.0.1:3999"+p);const b=new Uint8Array(await r.arrayBuffer());let h=0;for(let i=0;i<b.length;i++)h=(h*31+b[i])>>>0;console.log(String(r.status).padStart(3),String(b.length).padStart(9),"B","ck="+h.toString(16).padStart(8,"0"),p);}catch(e){console.log("ERR",p,e.message.slice(0,50));}}})()' 2>&1 | sed 's/^/     /'
  echo "     MODULE_NOT_FOUND / 崩溃检查:"
  docker exec "b-$1" sh -c "grep -icE 'cannot find module|MODULE_NOT_FOUND' /tmp/s.log 2>/dev/null || echo 0" | sed 's/^/       hits=/'
  docker exec "b-$1" sh -c "grep -iE 'cannot find module|MODULE_NOT_FOUND' /tmp/s.log 2>/dev/null | head -2" | sed 's/^/       /'
}

echo "=== CONTROL (未裁剪) ==="; start control 0; boot_and_probe control
echo; echo "=== PRUNED (裁剪后) ==="; start pruned 1; boot_and_probe pruned
echo; echo "=== 清理 ==="; docker rm -f b-control b-pruned >/dev/null 2>&1; echo "done"
