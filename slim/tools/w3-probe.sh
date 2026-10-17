#!/bin/bash
set -u
SRC=/var/tmp/re-arch
GS=$SRC/creator-services/game-server
NX=$SRC/creator-next/standalone/apps/game/.next

echo '===== 1. MEDIA DIRS ====='
for d in "$NX/static/media" "$NX/server/chunks/static/media"; do
  echo "--- $d"
  if [ -d "$d" ]; then
    du -sb "$d" | awk '{print "bytes:",$1}'
    (cd "$d" && ls -la)
  else
    echo "MISSING"
  fi
done

echo '===== 2. TYPESCRIPT IN SHIPPED GAME-SERVER ====='
echo '--- dist grep: require/from typescript'
grep -rn --include='*.js' -e 'require("typescript")' -e "require('typescript')" -e 'from "typescript"' -e 'from '"'"'typescript'"'"'' "$GS/dist" | head -20
echo "hits: $(grep -rl --include='*.js' -e 'require("typescript")' -e "require('typescript')" -e 'from "typescript"' "$GS/dist" | wc -l)"
echo '--- dist grep: ts compiler API symbols'
grep -rn --include='*.js' -e 'createProgram' -e 'transpileModule' -e 'createSourceFile' -e 'typescript/lib' "$GS/dist" | head -20
echo '--- typescript package inside node_modules'
find "$GS/node_modules" -maxdepth 4 -type d -name typescript | head -10
TS=$(find "$GS/node_modules" -maxdepth 4 -type d -name typescript -not -path '*@types*' | head -1)
[ -n "$TS" ] && du -sb "$TS"
echo '--- who declares typescript as a prod dependency (installed workspace pkgs)'
grep -rln '"dependencies"' "$GS/node_modules/@box" 2>/dev/null | head -0
for pj in "$GS/node_modules/@box"/*/package.json; do
  node -e "try{const j=require('$pj');if(j.dependencies&&j.dependencies.typescript)console.log(process.argv[1],'->',j.dependencies.typescript)}catch(e){}" "$pj" 2>/dev/null
done
ls "$GS/node_modules/@box" 2>/dev/null

echo '===== 3. FONT ASSET REFERENCES IN SHIPPED BUNDLE ====='
for name in ChillRoundGothic MiSans DoulosSILR Rubik-Regular; do
  echo "--- refs to $name in client static js/css"
  grep -rlo "$name[^\"']*ttf" "$NX/static" 2>/dev/null | head -5
  echo "  ttf-ref files above; woff:"
  grep -rlo "$name[^\"']*woff" "$NX/static" 2>/dev/null | head -5
done

echo '===== 4. MEDIA FILE BASELINE (sizes) ====='
find "$SRC" -path '*static/media*' -type f -printf '%s %p\n' 2>/dev/null | sort -rn | head -30
