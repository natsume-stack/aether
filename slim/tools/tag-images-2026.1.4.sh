#!/bin/bash
# Non-disruptive part of the 2026.1.4 upgrade: create the version tags that the
# official archives omit, using BOX3-IMAGE-CATALOG.json. Additive only.
set -uo pipefail
PKG=/var/tmp/box3-dl/pkg/BOX3-Engine-Server-2026.1.4-linux-amd64
CAT=$PKG/BOX3-IMAGE-CATALOG.json

python3 - "$CAT" > /tmp/tagcmds.txt <<'PY'
import json, sys
cat = json.load(open(sys.argv[1]))
for im in cat["images"]:
    ids = [i.replace("sha256:", "") for i in im["imageIds"]]
    src = f"{im['image']}:launcher-content-{ids[0]}"
    dst = f"{im['image']}:{im['imageTag']}"
    print(f"{src}\t{dst}")
PY

while IFS=$'\t' read -r src dst; do
  if docker image inspect "$src" >/dev/null 2>&1; then
    docker tag "$src" "$dst" && echo "TAGGED  $dst  <-  ${src##*content-}"
  else
    echo "MISSING $src"
  fi
done < /tmp/tagcmds.txt

echo
echo "== verify identity + platform of each version tag =="
while IFS=$'\t' read -r src dst; do
  docker image inspect --format "{{.Id}} {{.Architecture}}/{{.Os}} bytes={{.Size}}  $dst" "$dst" 2>/dev/null
done < /tmp/tagcmds.txt
echo
docker images --format '{{.Repository}}:{{.Tag}}  {{.Size}}' | grep 2026
