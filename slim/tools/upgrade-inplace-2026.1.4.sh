#!/bin/bash
# In-place upgrade of the WSL BOX3 local engine 0.2.0(host dir, hand-patched)
# to the official 2026.1.4 images, keeping the same install path so the Windows
# side manager, the bind-mounted data and every secret stay exactly where they are.
#
#   DRY_RUN=1 ./upgrade-inplace-2026.1.4.sh   # default, prints only
#   DRY_RUN=0 ./upgrade-inplace-2026.1.4.sh   # performs it
#
# Never deletes data. Snapshots config + runtime state first. Prints rollback.
set -uo pipefail

DRY_RUN=${DRY_RUN:-1}
DIR=/root/box3/BOX3-Engine-Server-0.2.0-linux-amd64
STAGE=/var/tmp/box3-dl
IMG=$STAGE/images
PKG=$STAGE/pkg/BOX3-Engine-Server-2026.1.4-linux-amd64
VER=2026.1.4
TAG=v${VER}-linux-amd64
SNAP=/root/box3/upgrade-snapshot-$(date +%Y%m%d-%H%M%S)
PROJECT=box-local-engine

run() { if [ "$DRY_RUN" = 1 ]; then echo "DRY: $*"; else echo "RUN: $*"; "$@"; fi; }
fail() { echo "ABORT: $*"; exit 1; }

echo "== 0. preconditions =="
[ -d "$DIR" ] || fail "no install dir"
[ -d "$PKG" ] || fail "no staged package"
[ "$(ls "$IMG"/*.tar.gz 2>/dev/null | wc -l)" = 6 ] || fail "archives incomplete"

echo
echo "== 1. verify sha256 + byte size of all six archives against the catalog =="
python3 - "$PKG/BOX3-IMAGE-CATALOG.json" "$IMG" <<'PY' || fail "catalog verification failed"
import json,sys,hashlib,os
cat=json.load(open(sys.argv[1])); ok=True
for im in cat["images"]:
    p=os.path.join(sys.argv[2],im["archive"])
    if not os.path.exists(p): print("MISSING",im["image"]); ok=False; continue
    h=hashlib.sha256()
    with open(p,"rb") as f:
        for c in iter(lambda:f.read(1<<20),b""): h.update(c)
    good = h.hexdigest()==im["sha256"] and os.path.getsize(p)==im["size"]
    print(f"{im['image']:38s} {'OK ' if good else 'BAD'} {os.path.getsize(p):>12,d}  {im['imageIds'][0][7:19]}")
    ok = ok and good
sys.exit(0 if ok else 1)
PY

echo
echo "== 2. snapshot config + runtime state -> $SNAP =="
run mkdir -p "$SNAP"
for f in compose.yml .env .env.example SHA256SUMS BOX3-OFFLINE-IMAGE.json .runtime.env; do
  [ -f "$DIR/$f" ] && run cp -a "$DIR/$f" "$SNAP/"
done
[ -d "$DIR/patches" ] && run cp -a "$DIR/patches" "$SNAP/patches"
run cp -a "$DIR/license" "$SNAP/license"
run sh -c "docker ps -a > '$SNAP/docker-ps-before.txt' 2>&1"
for c in $(docker ps --format '{{.Names}}'); do
  run sh -c "docker inspect '$c' > '$SNAP/inspect-$c.json' 2>&1"
done
run sh -c "cd '$DIR' && find apps -type f -printf '%p %s\n' | sort > '$SNAP/data-inventory.txt'"
echo "snapshot entries: $(ls "$SNAP" 2>/dev/null | wc -l)"

echo
echo "== 3. load official 2026.1.4 images (additive; old tags kept for rollback) =="
while IFS=$'\t' read -r arc sha size name tag; do
  [ -f "$IMG/$arc" ] && run docker image load -i "$IMG/$arc"
done < "$PKG/download-list.txt"

echo
echo "== 4. record data fingerprint BEFORE (file count + total bytes + top-level checksums) =="
pre() { cd "$DIR" && printf "files=%s bytes=%s\n" "$(find apps -type f | wc -l)" "$(du -sb apps | cut -f1)"; \
        find apps -type f -name '*.json' -printf '%p\n' | sort | head -20 | xargs -r md5sum; }
if [ "$DRY_RUN" != 1 ]; then pre > "$SNAP/data-before.txt"; cat "$SNAP/data-before.txt"; else echo "DRY: would record data fingerprint"; fi

echo
echo "== 5. swap package files in place (data, .env, license, patches, runtime env are NOT touched) =="
for f in compose.yml .env.example install.sh bootstrap.sh verify.sh start.sh stop.sh status.sh logs.sh README.md SHA256SUMS BOX3-IMAGE-CATALOG.json BOX3-MANAGER-IMAGE.json BOX3-PACKAGE-MODE.json; do
  [ -f "$PKG/$f" ] && run cp -a "$PKG/$f" "$DIR/$f"
done
run chmod +x "$DIR"/*.sh
run sed -i "s#^BOX_IMAGE_TAG=.*#BOX_IMAGE_TAG=$TAG#" "$DIR/.env"
run sed -i "s#^COMPOSE_PROFILES=.*#COMPOSE_PROFILES=player-service,auth-portal,creator,play,voxa,desktop-postgres#" "$DIR/.env"
echo "planned .env deltas: BOX_IMAGE_TAG=$TAG ; COMPOSE_PROFILES=...desktop-postgres"

echo
echo "== 6. stop the running stack (containers stopped only; volumes and files untouched) =="
run docker compose -p "$PROJECT" --project-directory "$DIR" -f "$DIR/compose.yml" --profile player-service --profile auth-portal --profile creator --profile play --profile voxa --profile desktop-postgres --profile desktop-redis stop

echo
echo "== 7. start 2026.1.4 with the same profile set the manager used, plus managed postgres =="
if [ "$DRY_RUN" != 1 ]; then
  docker compose -p "$PROJECT" --project-directory "$DIR" -f "$DIR/compose.yml" \
    --profile player-service --profile auth-portal --profile creator --profile play \
    --profile voxa --profile desktop-postgres up -d 2>&1 | tail -25
else
  echo "DRY: docker compose -p $PROJECT -f $DIR/compose.yml --profile player-service --profile auth-portal --profile creator --profile play --profile voxa --profile desktop-postgres up -d"
fi

echo
echo "== 8. wait for health (max 240s) and verify =="
if [ "$DRY_RUN" != 1 ]; then
  for i in $(seq 1 48); do
    st=$(docker ps --format '{{.Names}} {{.Status}}' | grep -E 'box-local-engine' )
    bad=$(printf '%s\n' "$st" | grep -cE 'unhealthy|Restarting|Exited \([1-9]')
    up=$(printf '%s\n' "$st" | grep -c 'Up')
    if [ "$bad" = 0 ] && [ "$up" -ge 7 ]; then break; fi
    sleep 5
  done
  docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | grep box-local-engine
  echo
  echo "-- data fingerprint AFTER:"
  post=$(cd "$DIR" && printf "files=%s bytes=%s\n" "$(find apps -type f | wc -l)" "$(du -sb apps | cut -f1)")
  echo "$post"
  grep -q "$post" "$SNAP/data-before.txt" && echo "DATA UNCHANGED" || echo "DATA DIFFERS - investigate"
  echo
  echo "-- projects visible to the creator container:"
  docker exec box-local-engine-creator-1 sh -c 'ls /app/apps/local-engine/projects' 2>&1 | head -6
  echo
  echo "-- health endpoints:"
  for u in http://127.0.0.1:3127/api/health-check http://127.0.0.1:3121/api/health-check http://127.0.0.1:3124/api/health-check http://127.0.0.1:3130/api/health; do
    printf "%-46s %s\n" "$u" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$u")"
  done
  echo
  echo "== rollback recipe =="
  cat <<EOF
cp -a $SNAP/compose.yml $SNAP/.env $DIR/
docker compose -p $PROJECT --project-directory $DIR -f $DIR/compose.yml \
  --profile player-service --profile auth-portal --profile creator --profile play \
  --profile voxa --profile desktop-postgres up -d
EOF
fi
echo
echo "done (DRY_RUN=$DRY_RUN) snapshot=$SNAP"
