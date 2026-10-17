#!/bin/bash
set -u
SRC=/var/tmp/re-arch/creator-next/standalone
DST=/var/tmp/w3
NX=apps/game/.next

echo '===== 0. WSL tool availability ====='
for t in node python3 pyftsubset fc-scan; do command -v $t >/dev/null 2>&1 && echo "$t: $(command -v $t)" || echo "$t: MISSING"; done

echo '===== 1. byte-identity proof (md5 server copy vs static copy) ====='
for f in ChillRoundGothic-Bold.096e89c0.ttf ChillRoundGothic-Bold.af6f1f22.woff Code-New-Roman-Bold.007dc0b2.otf Code-New-Roman-Bold.8cda2b7e.woff DoulosSILR.90757c6f.ttf Rubik-Regular.6bff33d9.ttf rubik-v20-latin-regular.889af360.woff2; do
  a=$(md5sum "$SRC/$NX/static/media/$f" 2>/dev/null | cut -d' ' -f1)
  b=$(md5sum "$SRC/$NX/server/chunks/static/media/$f" 2>/dev/null | cut -d' ' -f1)
  [ "$a" = "$b" ] && echo "IDENTICAL $f ($a)" || echo "DIFFER/MISSING $f a=$a b=$b"
done

echo '===== 2. copy to /var/tmp/w3 ====='
rm -rf "$DST"
mkdir -p "$DST"
cp -a "$SRC" "$DST/standalone"
echo 'BEFORE:'
du -sb "$DST/standalone"
du -sh "$DST/standalone"
du -sb "$DST/standalone/$NX/server/chunks/static"

echo '===== 3. full list of files to be deleted ====='
find "$DST/standalone/$NX/server/chunks/static" -type f -printf '%s %p\n' | sort -rn

echo '===== 4. delete + AFTER ====='
rm -rf "$DST/standalone/$NX/server/chunks/static"
echo 'AFTER:'
du -sb "$DST/standalone"
du -sh "$DST/standalone"

exit 0
