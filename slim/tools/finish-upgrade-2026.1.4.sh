#!/bin/bash
# Finish the 2026.1.4 upgrade: the official image archives ship only a content
# tag (box-local-engine-<svc>:launcher-content-<imageId>); the version tag that
# compose.yml references is created by the installer. Replicate that step from
# BOX3-IMAGE-CATALOG.json, verify architecture, then bring the stack up.
set -uo pipefail
DIR=/root/box3/BOX3-Engine-Server-0.2.0-linux-amd64
PKG=/var/tmp/box3-dl/pkg/BOX3-Engine-Server-2026.1.4-linux-amd64
CAT=$PKG/BOX3-IMAGE-CATALOG.json
DRY_RUN=${DRY_RUN:-0}
run() { if [ "$DRY_RUN" = 1 ]; then echo "DRY: $*"; else echo "RUN: $*"; "$@"; fi; }

echo "== 1. create version tags from catalog imageIds =="
python3 - "$CAT" > /tmp/tagcmds.txt <<'PY'
import json,sys
cat=json.load(open(sys.argv[1]))
for im in cat["images"]:
    ids=[i.replace("sha256:","") for i in im["imageIds"]]
    content=f"{im['image']}:launcher-content-{ids[0]}"
    vers=f"{im['image']}:{im['imageTag']}"
    print(f"{content} {vers}")
PY
while read -r content vers; do
  if docker image inspect "$content" >/dev/null 2>&1; then
    run docker tag "$content" "$vers"
  else
    alt=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -F "${content%%:*}" | grep -F "${content##*-}" | head -1)
    if [ -n "${alt:-}" ]; then run docker tag "$alt" "$vers"; else echo "MISSING SOURCE for $content"; fi
  fi
done < /tmp/tagcmds.txt

echo
echo "== 2. verify tag exists + architecture/platform matches =="
python3 - "$CAT" <<'PY'
import json,sys,subprocess
cat=json.load(open(sys.argv[1]))
for im in cat["images"]:
    t=f"{im['image']}:{im['imageTag']}"
    out=subprocess.run(["docker","image","inspect","--format","{{.Id}} {{.Architecture}}/{{.Os}} {{.Size}}",t],capture_output=True,text=True)
    print(f"{t:62s} {out.stdout.strip() or out.stderr.strip()}")
PY

echo
echo "== 3. compose config sanity (no build, no pull) =="
cd "$DIR" && docker compose -p box-local-engine --project-directory "$DIR" -f "$DIR/compose.yml" \
  --profile player-service --profile auth-portal --profile creator --profile play \
  --profile voxa --profile desktop-postgres config --services 2>&1 | head -15

echo
echo "== 4. bring the stack up =="
cd "$DIR" && docker compose -p box-local-engine --project-directory "$DIR" -f "$DIR/compose.yml" \
  --profile player-service --profile auth-portal --profile creator --profile play \
  --profile voxa --profile desktop-postgres up -d --pull never 2>&1 | tail -25

echo
echo "== 5. wait for health (max 300s) =="
for i in $(seq 1 60); do
  st=$(docker ps --format '{{.Names}} {{.Status}}' | grep box-local-engine)
  bad=$(printf '%s\n' "$st" | grep -cE 'unhealthy|Restarting|Exited \([1-9]')
  up=$(printf '%s\n' "$st" | grep -c ' Up')
  if [ "${bad:-1}" = 0 ] && [ "${up:-0}" -ge 7 ]; then echo "healthy after $((i*5))s"; break; fi
  sleep 5
done
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | grep box-local-engine

echo
echo "== 6. data integrity check =="
now=$(cd "$DIR" && printf "files=%s bytes=%s" "$(find apps -type f | wc -l)" "$(du -sb apps | cut -f1)")
snap=$(ls -d /root/box3/upgrade-snapshot-* | tail -1)
echo "now: $now"
echo "pre-upgrade inventory: $(wc -l < "$snap/data-inventory.txt" 2>/dev/null) file rows"
cd "$DIR" && find apps -type f -printf '%p %s\n' | sort > /tmp/now-inv.txt
diff -q "$snap/data-inventory.txt" /tmp/now-inv.txt >/dev/null 2>&1 && echo "DATA IDENTICAL to pre-upgrade inventory" || { echo "DIFF (first 10):"; diff "$snap/data-inventory.txt" /tmp/now-inv.txt | head -10; }

echo
echo "== 7. endpoints =="
for u in http://127.0.0.1:3127/api/health-check http://127.0.0.1:3121/api/health-check http://127.0.0.1:3124/api/health-check http://127.0.0.1:3123/ http://127.0.0.1:8080/api/health-check http://127.0.0.1:3130/api/health; do
  printf "%-48s %s\n" "$u" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$u")"
done
echo
echo "== 8. projects visible inside creator =="
docker exec box-local-engine-creator-1 ls /app/apps/local-engine/projects 2>&1 | head -6
