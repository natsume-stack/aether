#!/bin/bash
set -u
GS=/var/tmp/re-arch/creator-services/game-server
echo '===== A. shipped @box package.json typescript entries ====='
for p in "$GS/node_modules/@box"/*; do
  n=$(basename "$p")
  f=$(readlink -f "$p/package.json" 2>/dev/null || true)
  [ -z "$f" ] && { echo "$n no-package.json"; continue; }
  echo "$n :: $(grep -o '"typescript"[^,}]*' "$f" | tr '\n' ' ')"
done
echo '===== A2. lockfile-style: does typescript have any importer besides game-server? ====='
grep -rn '"typescript"' "$GS/package.json" | head -3
echo '===== B. KaTeX css font refs ====='
K=$(find /var/tmp/re-arch/creator-next/standalone/apps/game/.next/static/css -name '*.css' | head -50)
for c in $K; do grep -o 'static/media/KaTeX[^")]*' "$c" | sed 's/.*\.//' | sort -u | tr '\n' ' '; echo "<- $c"; done
echo '===== C. total font bytes whole creator image ====='
find /var/tmp/re-arch/creator-next -type f \( -name '*.ttf' -o -name '*.woff' -o -name '*.woff2' -o -name '*.otf' \) -printf '%s\n' | awk '{s+=$1} END {print "creator-next font bytes:", s}'
echo '===== D. woff-only vs ttf check for media dir refs in css ====='
for c in $K; do grep -o 'static/media/[A-Za-z0-9._-]*\.\(ttf\|woff2\?\)' "$c" | sort -u | head -40; done | sort -u
