#!/usr/bin/env bash
set -u
check() { # name port
  for path in /api/health-check /health /; do
    out=$(curl -s -o /dev/null --max-time 5 -w "%{http_code} %{time_starttransfer} %{size_download}" "http://127.0.0.1:$2${path}" 2>/dev/null)
    echo "$1 :$2 ${path} -> $out"
  done
}
check creator 3127
check play 3121
check voxa 3123
check player-service 3124
check player-auth-portal 3125
check server-manager 3130
echo "--- play also has /api/play-worlds (its healthcheck GET) ---"
curl -s -o /dev/null --max-time 5 -w "play /api/play-worlds -> %{http_code} %{time_starttransfer}\n" "http://127.0.0.1:3121/api/play-worlds"
echo "--- creator 9966/9967 raw (rpc?) ---"
for p in 9966 9967; do curl -s -o /dev/null --max-time 4 -w "creator :$p / -> %{http_code}\n" "http://127.0.0.1:$p/"; done
