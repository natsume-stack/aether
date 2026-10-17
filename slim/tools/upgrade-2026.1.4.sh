#!/bin/bash
# Upgrade the WSL BOX3 local engine from the hand-patched 0.2.0 host dir to the
# official 2026.1.4 images, reusing the existing data directory in place.
#
#   DRY_RUN=1 ./upgrade-2026.1.4.sh   # default: only print what would happen
#   DRY_RUN=0 ./upgrade-2026.1.4.sh   # actually perform it
#
# Guarantees: never deletes data; snapshots config + container state first;
# every step is reversible with the printed rollback commands.
set -uo pipefail

DRY_RUN=${DRY_RUN:-1}
OLD_DIR=/root/box3/BOX3-Engine-Server-0.2.0-linux-amd64
STAGE=/var/tmp/box3-dl
IMG_DIR=$STAGE/images
PKG=$STAGE/pkg/BOX3-Engine-Server-2026.1.4-linux-amd64
VER=2026.1.4
TAG=v${VER}-linux-amd64
NEW_DIR=/root/box3/BOX3-Engine-Server-${VER}-linux-amd64
SNAP=/root/box3/upgrade-snapshot-$(date +%Y%m%d-%H%M%S)
PROFILES=player-service,auth-portal,creator,play,voxa

run() { if [ "$DRY_RUN" = 1 ]; then echo "DRY: $*"; else echo "RUN: $*"; "$@"; fi; }

echo "== 0. preconditions =="
[ -d "$OLD_DIR" ] || { echo "missing $OLD_DIR"; exit 1; }
[ -d "$PKG" ] || { echo "missing $PKG"; exit 1; }
n=$(ls "$IMG_DIR"/*.tar.gz 2>/dev/null | wc -l)
echo "image archives present: $n/6"
[ "$n" = 6 ] || { echo "download incomplete, abort"; exit 1; }

echo
echo "== 1. verify every archive sha256 against BOX3-IMAGE-CATALOG.json =="
python3 - "$PKG/BOX3-IMAGE-CATALOG.json" "$IMG_DIR" <<'PY'
import json,sys,hashlib,os
cat=json.load(open(sys.argv[1]))
ok=True
for im in cat["images"]:
    p=os.path.join(sys.argv[2],im["archive"])
    if not os.path.exists(p):
        print("MISSING",im["image"]); ok=False; continue
    h=hashlib.sha256()
    with open(p,"rb") as f:
        for c in iter(lambda:f.read(1<<20),b""): h.update(c)
    good = h.hexdigest()==im["sha256"] and os.path.getsize(p)==im["size"]
    print(f"{im['image']:38s} {'OK ' if good else 'BAD'} {os.path.getsize(p):>12,d}")
    ok = ok and good
sys.exit(0 if ok else 1)
PY
[ $? -eq 0 ] || { echo "verification failed, abort"; exit 1; }

echo
echo "== 2. snapshot current config + runtime state to $SNAP =="
run mkdir -p "$SNAP"
for f in compose.yml .env .env.example SHA256SUMS BOX3-OFFLINE-IMAGE.json; do
  [ -f "$OLD_DIR/$f" ] && run cp -a "$OLD_DIR/$f" "$SNAP/"
done
run cp -a "$OLD_DIR/license" "$SNAP/" 2>/dev/null
run docker ps -a > "$SNAP/docker-ps-before.txt" 2>&1
for c in $(docker ps --format '{{.Names}}'); do
  run docker inspect "$c" > "$SNAP/inspect-$c.json" 2>&1
done
# data inventory (bytes + file list, cheap, no content hashing of 300MB)
run sh -c "cd '$OLD_DIR' && find apps -type f -printf '%p %s\n' | sort > '$SNAP/data-inventory.txt'; du -sb apps/* >> '$SNAP/data-inventory.txt'"
echo "snapshot: $(ls "$SNAP" 2>/dev/null | wc -l) entries"

echo
echo "== 3. load the 6 official images (docker load is additive) =="
while IFS=$'\t' read -r arc sha size name tag; do
  run docker image load -i "$IMG_DIR/$arc"
done < "$PKG/download-list.txt"
echo "images for tag $TAG:"
docker images --format '{{.Repository}}:{{.Tag}}' | grep "$TAG" || echo "(not yet loaded)"

echo
echo "== 4. create the new install dir (old dir is left untouched) =="
run mkdir -p "$NEW_DIR"
for f in compose.yml .env.example install.sh bootstrap.sh verify.sh start.sh stop.sh status.sh logs.sh README.md SHA256SUMS BOX3-IMAGE-CATALOG.json BOX3-MANAGER-IMAGE.json BOX3-PACKAGE-MODE.json; do
  [ -f "$PKG/$f" ] && run cp -a "$PKG/$f" "$NEW_DIR/"
done
run chmod +x "$NEW_DIR"/*.sh
run cp -a "$OLD_DIR/.env" "$NEW_DIR/.env"
run cp -a "$OLD_DIR/license" "$NEW_DIR/license" 2>/dev/null
# point the new package at the EXISTING data (2026.1.4 defaults BOX_DATA_DIRECTORY
# to the absolute /opt/box3-engine, which would hide the current projects)
run sed -i "s#^BOX_IMAGE_TAG=.*#BOX_IMAGE_TAG=$TAG#" "$NEW_DIR/.env"
grep -q '^BOX_DATA_DIRECTORY=' "$NEW_DIR/.env" || echo "BOX_DATA_DIRECTORY=" >> "$NEW_DIR/.env"
run sed -i "s#^BOX_DATA_DIRECTORY=.*#BOX_DATA_DIRECTORY=$OLD_DIR#" "$NEW_DIR/.env"
echo "planned .env deltas:"
grep -E '^(BOX_IMAGE_TAG|BOX_DATA_DIRECTORY)=' "$NEW_DIR/.env" 2>/dev/null || echo "(dry-run: would set tag=$TAG data=$OLD_DIR)"

echo
echo "== 5. stop the old stack (containers only; volumes and data untouched) =="
run docker compose -p box-local-engine --project-directory "$OLD_DIR" -f "$OLD_DIR/compose.yml" stop

echo
echo "== 6. bring up 2026.1.4 from the new dir with the same profiles =="
run env COMPOSE_PROFILES=$PROFILES docker compose -p box-local-engine --project-directory "$NEW_DIR" -f "$NEW_DIR/compose.yml" up -d --remove-orphans

echo
echo "== 7. health wait (up to 180s) =="
if [ "$DRY_RUN" != 1 ]; then
  for i in $(seq 1 36); do
    bad=$(docker ps --format '{{.Names}} {{.Status}}' | grep -cE 'unhealthy|restarting|Exited \(1')
    [ "$bad" = 0 ] && [ "$(docker ps -q | wc -l)" -ge 7 ] && break
    sleep 5
  done
  docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
  echo
  echo "== 8. verify data unchanged =="
  cd "$OLD_DIR" && find apps -type f -printf '%p %s\n' | sort > /tmp/after.txt
  diff -q "$SNAP/data-inventory.txt" /tmp/after.txt >/dev/null 2>&1 \
    && echo "DATA IDENTICAL (file list + sizes)" || { echo "DATA DIFF:"; diff "$SNAP/data-inventory.txt" /tmp/after.txt | head -20; }
  echo
  echo "== 9. rollback recipe (printed, not executed) =="
  cat <<EOF
# roll back to the previous state:
docker compose -p box-local-engine --project-directory "$NEW_DIR" -f "$NEW_DIR/compose.yml" stop
cp -a "$SNAP/compose.yml" "$SNAP/.env" "$OLD_DIR/"
docker compose -p box-local-engine --project-directory "$OLD_DIR" -f "$OLD_DIR/compose.yml" up -d
EOF
fi
echo
echo "done. DRY_RUN=$DRY_RUN"
