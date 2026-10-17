#!/bin/bash
set -u
TAG=v2026.1.4-linux-amd64
for s in creator play voxa player-service player-auth-portal server-manager; do
  echo "########## $s"
  docker run --rm --entrypoint sh "box-local-engine-$s:$TAG" -c '
    echo "-- /app top:"; ls /app 2>/dev/null | head -20
    echo "-- node_modules/.pnpm exists:"; ls -d /app/node_modules/.pnpm 2>/dev/null || echo none
    echo "-- dirs:"; du -sh /app/* 2>/dev/null | sort -h | tail -12
  ' 2>&1 | head -50
done
