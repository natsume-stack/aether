#!/bin/bash
set -u
TAG=v2026.1.4-linux-amd64
for s in creator play voxa player-service; do
  echo "########## $s"
  docker run --rm --entrypoint sh "box-local-engine-$s:$TAG" -c '
    PN=$(find /app -maxdepth 10 -type d -name ".pnpm" 2>/dev/null)
    echo "-- pnpm roots: $PN"
    for d in $PN; do
      for pat in "@swc+core*" "typescript@*" "esbuild@*" "sass@*" "@babel+*" "sql.js@*"; do
        m=$(find "$d" -maxdepth 1 -type d -name "$pat" 2>/dev/null)
        if [ -n "$m" ]; then
          for x in $m; do printf "%s\t%s\t" "$pat" "$x"; du -sb "$x" 2>/dev/null | cut -f1; done
        fi
      done
    done
    echo "-- sql.js/dist contents:"
    for d in $(find /app -maxdepth 12 -type d -path "*sql.js/dist" 2>/dev/null); do
      ls -l "$d" | tail -n +2 | awk -v D="$d" "{printf \"%s/%s %s\n\", D, $9, $5}"
    done
    echo "-- media dirs:"
    for d in $(find /app -maxdepth 14 -type d -path "*.next*static/media" -o -type d -path "*.next*chunks/static/media" 2>/dev/null | sort -u); do printf "%s\t" "$d"; du -sb "$d" 2>/dev/null | cut -f1; echo "   files=$(find "$d" -type f | wc -l)"; done
    echo "-- vs dirs:"
    for d in $(find /app -maxdepth 14 -type d -name "vs" 2>/dev/null); do printf "%s\t" "$d"; du -sb "$d" 2>/dev/null | cut -f1; done
  ' 2>&1 | head -70
done
