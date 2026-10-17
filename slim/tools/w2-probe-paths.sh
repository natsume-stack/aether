#!/bin/bash
set -u
TAG=v2026.1.4-linux-amd64
for s in creator play voxa player-service player-auth-portal server-manager; do
  echo "########## $s"
  docker run --rm --entrypoint sh "box-local-engine-$s:$TAG" -c '
    echo "-- .pnpm roots:"; find / -maxdepth 8 -type d -name ".pnpm" 2>/dev/null | head -10
    echo "-- swc dirs:"; find / -maxdepth 12 -type d -name "@swc+core*" 2>/dev/null | head -5
    echo "-- typescript pkg dirs:"; find / -maxdepth 12 -type d -name "typescript@*" 2>/dev/null | head -5
    echo "-- sql.js dist:"; find / -maxdepth 12 -path "*sql.js/dist" -type d 2>/dev/null | head -5
    echo "-- vs dirs:"; find / -maxdepth 14 -type d -name "vs" 2>/dev/null | head -8
    echo "-- media dirs under .next:"; find / -maxdepth 14 -type d -path "*.next*media*" 2>/dev/null | head -8
  ' 2>&1 | head -60
done
