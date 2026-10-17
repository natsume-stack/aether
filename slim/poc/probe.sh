#!/bin/bash
# W7 PoC step 0: environment probe. Read-only; creates only ephemeral containers.
set -u
POC=/mnt/d/desktop/神奇代码岛/box3-re/poc
IMG=box-local-engine-play:v2026.1.4-linux-amd64

echo "=== hostname/uname (WSL) ==="
hostname; uname -a

echo "=== docker version ==="
docker --version

echo "=== box images ==="
docker images --format '{{.Repository}}:{{.Tag}}  {{.ID}}  {{.Size}}' | grep -i box || echo "NO BOX IMAGES"

echo "=== running containers ==="
docker ps --format '{{.Names}}  {{.Image}}  {{.Status}}'

sed -i 's/\r$//' "$POC"/*.sh "$POC"/*.mjs 2>/dev/null

echo "=== INSIDE PLAY IMAGE ==="
docker run --rm -v "$POC":/poc --entrypoint sh "$IMG" /poc/inner-probe.sh 2>&1
