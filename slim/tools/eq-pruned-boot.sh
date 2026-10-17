#!/bin/bash
# Equivalence test against the tree pruned by scripts/prune-standalone.mjs --apply.
# Both containers get identical env (the shipped compose sets NEXT_PUBLIC_APP_ENV etc.),
# only the mounted standalone tree differs.
set -uo pipefail
IMG=box-local-engine-play:v2026.1.4-linux-amd64
SA=/app/apps/game/.next/standalone
PRUNED=/var/tmp/w1b/standalone
ENVV='-e NEXT_PUBLIC_APP_ENV=development -e NEXT_PUBLIC_APP_EDITION=createra -e NEXT_PUBLIC_APP_REGION=cn -e NODE_ENV=production'

run () { # $1 name  $2 pruned-dir-or-empty
  docker rm -f "eq-$1" >/dev/null 2>&1
  if [ -n "$2" ]; then
    docker run -d --name "eq-$1" --user root --entrypoint sh -v "$2:$SA" $IMG -c 'sleep 1800' >/dev/null 2>&1
  else
    docker run -d --name "eq-$1" --user root --entrypoint sh $IMG -c 'sleep 1800' >/dev/null 2>&1
  fi
  docker exec -d $ENVV "eq-$1" sh -c "cd $SA/apps/game && PORT=3999 HOSTNAME=127.0.0.1 nohup node server.js > /tmp/s.log 2>&1"
  for i in $(seq 1 30); do
    sleep 2
    up=$(docker exec "eq-$1" node -e "fetch('http://127.0.0.1:3999/api/health-check').then(r=>console.log('UP '+r.status)).catch(()=>console.log('down'))" 2>/dev/null | tail -1)
    case "$up" in UP*) break ;; esac
  done
  echo "  [$1] tree=$(docker exec "eq-$1" du -sb $SA 2>/dev/null | cut -f1) B  boot=${up:-TIMEOUT}"
  docker exec "eq-$1" node -e '
    const ps=["/api/health-check","/","/login-required","/api/play-worlds","/_next/static/chunks/main-277ff2fbd803da65.js","/_next/static/chunks/framework-7c5d5949242e9ab4.js","/logo512.png"];
    (async()=>{for(const p of ps){try{const r=await fetch("http://127.0.0.1:3999"+p);const b=new Uint8Array(await r.arrayBuffer());let h=0;for(let i=0;i<b.length;i++)h=(h*31+b[i])>>>0;console.log(String(r.status).padStart(3),String(b.length).padStart(9),"B ck="+h.toString(16).padStart(8,"0"),p);}catch(e){console.log("ERR",p,e.message.slice(0,40));}}})()' 2>&1 | sed 's/^/    /'
  echo "    MODULE_NOT_FOUND hits: $(docker exec "eq-$1" sh -c "grep -cE 'MODULE_NOT_FOUND|Cannot find module' /tmp/s.log" 2>/dev/null)"
  docker exec "eq-$1" sh -c "grep -E 'MODULE_NOT_FOUND|Cannot find module' /tmp/s.log | head -2" | sed 's/^/      /'
  docker rm -f "eq-$1" >/dev/null 2>&1
}

echo "=== CONTROL（出厂未裁剪）==="; run control ""
echo
echo "=== PRUNED（prune-standalone.mjs --apply 之后）==="; run pruned "$PRUNED"
