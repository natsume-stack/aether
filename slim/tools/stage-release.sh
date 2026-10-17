#!/usr/bin/env bash
# Stage the official BOX3 2026.1.4 release artifacts inside WSL without touching
# the running stack or the existing install directory.
set -uo pipefail
CDN=${CDN:-https://assets.box3.fun/local-engine}
VER=${VER:-2026.1.4}
ARCH=${ARCH:-amd64}
STAGE=/var/tmp/box3-dl
mkdir -p "$STAGE/pkg" "$STAGE/images"
cd "$STAGE"

echo "[stage] latest.txt = $(curl -fsSL --max-time 30 $CDN/latest.txt)"
echo "[stage] downloading server package $VER-linux-$ARCH"
curl -fL --retry 3 --max-time 300 -o "$STAGE/BOX3-Engine-Server-$VER-linux-$ARCH.zip" \
  "$CDN/BOX3-Engine-Server-$VER-linux-$ARCH.zip" || { echo "[stage] package download FAILED"; exit 1; }
unzip -o -q "$STAGE/BOX3-Engine-Server-$VER-linux-$ARCH.zip" -d "$STAGE/pkg" || { echo "[stage] unzip FAILED"; exit 1; }
ls -la "$STAGE/pkg"
PKGDIR=$(find "$STAGE/pkg" -maxdepth 2 -name BOX3-IMAGE-CATALOG.json -printf '%h\n' | head -1)
echo "[stage] catalog dir = $PKGDIR"
cat "$PKGDIR/BOX3-PACKAGE-MODE.json"; echo

python3 - "$PKGDIR/BOX3-IMAGE-CATALOG.json" "$PKGDIR" <<'PY'
import json,sys
cat=json.load(open(sys.argv[1]))
rows=[]
for im in cat["images"]:
    rows.append((im["image"],im["archive"],im["sha256"],im["size"],im.get("imageTag","")))
total=0
with open(sys.argv[2]+"/download-list.txt","w") as f:
    for name,arc,sha,size,tag in rows:
        total+=size
        f.write(f"{arc}\t{sha}\t{size}\t{name}\t{tag}\n")
print(f"[catalog] {len(rows)} images, {total} bytes = {total/1024/1024:.1f} MiB, tag={rows[0][4]}")
for name,arc,sha,size,tag in rows:
    print(f"  {name:42s} {size:>12,d}  sha256={sha[:16]}…")
PY

echo "[stage] downloading image archives (background, resumable)"
: > "$STAGE/download.log"
while IFS=$'\t' read -r arc sha size name tag; do
  (
    if [ -s "$STAGE/images/$arc" ] && [ "$(sha256sum "$STAGE/images/$arc" | cut -d' ' -f1)" = "$sha" ]; then
      echo "$name SKIP already verified" >> "$STAGE/download.log"; exit 0
    fi
    curl -fL --retry 3 -C - --max-time 3600 -o "$STAGE/images/$arc" "$CDN/$arc" >> "$STAGE/download.log" 2>&1
    got=$(sha256sum "$STAGE/images/$arc" 2>/dev/null | cut -d' ' -f1)
    if [ "$got" = "$sha" ]; then echo "$name OK $size" >> "$STAGE/download.log"; else echo "$name FAIL got=$got want=$sha" >> "$STAGE/download.log"; fi
  ) &
done < "$PKGDIR/download-list.txt"
wait
echo "[stage] all downloads finished" >> "$STAGE/download.log"
echo "[stage] summary:"; grep -c OK "$STAGE/download.log" || true; du -sh "$STAGE/images" >> "$STAGE/download.log"; tail -20 "$STAGE/download.log"
