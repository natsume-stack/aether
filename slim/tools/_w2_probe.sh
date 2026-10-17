#!/bin/bash
set -u
echo "=== docker binary linkage ==="
ls -l /usr/bin/docker 2>/dev/null; readlink -f /usr/bin/docker
ldd "$(readlink -f /usr/bin/docker)" 2>&1 | head -5
file "$(readlink -f /usr/bin/docker)" 2>/dev/null
echo "=== docker socket ==="
ls -l /var/run/docker.sock
echo "=== node in image? ==="
docker run --rm box-local-engine-creator:v2026.1.4-linux-amd64 node -v 2>&1 | tail -2
echo "=== docker cli inside image? ==="
docker run --rm box-local-engine-server-manager:v2026.1.4-linux-amd64 sh -c 'command -v docker || echo NO-DOCKER-CLI' 2>&1 | tail -2
echo "=== net check ==="
timeout 12 curl -sI https://npmmirror.com/mirrors/node/v22.14.0/node-v22.14.0-linux-x64.tar.xz 2>&1 | head -3
echo "=== windows node.exe from wsl ==="
ls -l "/mnt/c/Program Files/nodejs/node.exe" 2>/dev/null | head -2
