#!/bin/bash
# Measure what a browser actually downloads on v2026.1.4 (compressed over the wire)
# for (a) a player's map page on Play and (b) the Creator editor.
# Read-only HTTP GETs against the running containers. No state is mutated.
set -uo pipefail
JAR=$(mktemp)
ENVF=/root/box3/BOX3-Engine-Server-0.2.0-linux-amd64/.env

pay() {
  prefix="$1"; path="$2"; label="$3"
  url="$prefix$path"
  html="/tmp/pl_$label.html"
  code=$(curl -s -c "$JAR" -b "$JAR" -L --max-time 30 -o "$html" -w '%{http_code}' "$url")
  if [ ! -s "$html" ]; then echo "== $label : HTTP $code, empty body"; return; fi
  htmlB=$(stat -c %s "$html")
  : > "/tmp/pl_$label.bytes"
  { grep -o 'src="[^"]*"' "$html" | sed 's/src="//; s/"$//';
    grep -o 'href="[^"]*"' "$html" | sed 's/href="//; s/"$//'; } | sort -u > "/tmp/pl_$label.refs"
  while read -r ref; do
    u=""
    case "$ref" in
      http://*|https://*) u="$ref" ;;
      /*) u="$prefix$ref" ;;
    esac
    [ -z "$u" ] && continue
    res=$(curl -s -o /dev/null --compressed -b "$JAR" -L --max-time 30 -w '%{size_download} %{http_code}' "$u")
    bytes=$(printf '%s' "$res" | cut -d' ' -f1)
    st=$(printf '%s' "$res" | cut -d' ' -f2)
    case "$st" in
      200|203|204|206) printf '%s %s\n' "$bytes" "$u" >> "/tmp/pl_$label.bytes" ;;
    esac
  done < "/tmp/pl_$label.refs"
  sum=$(awk '{s+=$1} END{print s+0}' "/tmp/pl_$label.bytes")
  cnt=$(wc -l < "/tmp/pl_$label.bytes")
  tot=$((htmlB + sum))
  echo "== $label : HTTP $code | HTML $htmlB B | assets OK $cnt | 浏览器总下载 $tot B = $((tot/1024)) KiB"
  echo "   top assets:"
  sort -rn "/tmp/pl_$label.bytes" | head -8 | while read -r b u; do printf "     %10s B  %s\n" "$b" "$(printf '%s' "$u" | tail -c 78)"; done
  echo "   by type:"
  for ext in js css woff2 woff ttf otf png jpg jpeg wasm svg json map; do
    t=$(grep -c "\.$ext" "/tmp/pl_$label.bytes" || true)
    s=$(grep "\.$ext" "/tmp/pl_$label.bytes" | awk '{a+=$1} END{print a+0}')
    if [ "${s:-0}" -gt 0 ]; then printf "     .%-6s count=%-4s %12s B\n" "$ext" "$t" "$s"; fi
  done
}

TOK=$(grep -m1 '^BOX_PLAY_ADMIN_TOKEN=' "$ENVF" | cut -d= -f2)
WORLD=$(curl -s -m 10 -H "Authorization: Bearer $TOK" http://127.0.0.1/api/play-worlds | grep -o '"publicId":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "first map publicId = ${WORLD:-NONE}"
echo
echo "### PLAY（玩家进图要下的字节）"
if [ -n "${WORLD:-}" ]; then pay http://127.0.0.1 "/p/$WORLD" playmap; fi
pay http://127.0.0.1 / playroot
echo
echo "### CREATOR（编辑器要下的字节）"
pay http://127.0.0.1:3127 / creator
