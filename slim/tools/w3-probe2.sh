#!/bin/bash
set -u
SRC=/var/tmp/re-arch
GS=$SRC/creator-services/game-server
NX=$SRC/creator-next/standalone/apps/game/.next

echo '===== A. @box INSTALLED package.json typescript entries ====='
for p in "$GS/node_modules/@box"/*; do
  n=$(basename "$p")
  prod=$(node -e "const j=require('$p/package.json');console.log((j.dependencies||{}).typescript||'-')" 2>/dev/null)
  dev=$(node -e "const j=require('$p/package.json');console.log((j.devDependencies||{}).typescript||'-')" 2>/dev/null)
  echo "$n prod=$prod dev=$dev"
done
echo '--- does game-server node_modules symlink-resolve typescript from @box/build-system?'
ls -d "$GS/node_modules/@box/build-system" && readlink -f "$GS/node_modules/@box/build-system" | head -1

echo '===== B. RUSTY branch compiled form in client chunks ====='
grep -c 'RUSTY' "$NX/static/chunks/8438.0f6893bc0998f354.js" || true
grep -o '.\{120\}ChillRoundGothic-Bold.096e89c0.ttf.\{200\}' "$NX/static/chunks/8438.0f6893bc0998f354.js" | head -2
echo '--- RUSTY token context'
grep -o '.\{60\}RUSTY.\{80\}' "$NX/static/chunks/8438.0f6893bc0998f354.js" | head -5
echo '--- ttf/woff refs in SERVER chunks js (does server bundle reference media files)?'
grep -rl 'ChillRoundGothic-Bold' "$NX/server" --include='*.js' | head -10
grep -ro '.\{40\}static/media/ChillRoundGothic[^"'"'"']*' "$NX/server" --include='*.js' | head -10

echo '===== C. FULL FONT INVENTORY ACROSS IMAGE (by extension) ====='
find "$SRC/creator-next" "$SRC/creator-services" "$SRC/creator-local-engine" -type f \( -name '*.ttf' -o -name '*.woff' -o -name '*.woff2' -o -name '*.otf' \) -printf '%s %p\n' 2>/dev/null | awk '{s+=$1; print} END {print "TOTAL-FONT-BYTES:",s}' | sort -rn | head -50
