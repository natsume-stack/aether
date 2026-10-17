#!/bin/bash
# Read-only pre-upgrade inspection: compare the installed 0.2.0 package with the
# freshly downloaded 2026.1.4 package contract, and inventory what must be preserved.
set -uo pipefail
OLD=/root/box3/BOX3-Engine-Server-0.2.0-linux-amd64
NEW=/var/tmp/box3-dl/pkg/BOX3-Engine-Server-2026.1.4-linux-amd64

echo "== whoami / paths =="
whoami
[ -d "$OLD" ] && echo "OLD ok" || echo "OLD MISSING"
[ -d "$NEW" ] && echo "NEW ok" || echo "NEW MISSING"

echo
echo "== old .env keys vs new .env.example keys =="
grep -oE '^[A-Z_][A-Z0-9_]*' "$OLD/.env" | sort -u > /tmp/old.keys
grep -oE '^[A-Z_][A-Z0-9_]*' "$NEW/.env.example" | sort -u > /tmp/new.keys
echo "old=$(wc -l < /tmp/old.keys) new=$(wc -l < /tmp/new.keys)"
echo "-- only in old:"; comm -23 /tmp/old.keys /tmp/new.keys | tr '\n' ' '; echo
echo "-- only in new:"; comm -13 /tmp/old.keys /tmp/new.keys | tr '\n' ' '; echo

echo
echo "== compose service/env-key diff (0.2.0 -> 2026.1.4) =="
grep -oE '^[A-Z_][A-Z0-9_]*|^  [a-z-]+:' "$OLD/compose.yml" | sort -u > /tmp/oc.txt
grep -oE '^[A-Z_][A-Z0-9_]*|^  [a-z-]+:' "$NEW/compose.yml" | sort -u > /tmp/nc.txt
diff /tmp/oc.txt /tmp/nc.txt | head -40

echo
echo "== env vars referenced by NEW compose but absent from OLD .env =="
grep -oE '\$\{[A-Z_][A-Z0-9_]*' "$NEW/compose.yml" | sed 's/\${//' | sort -u > /tmp/newrefs.txt
comm -23 /tmp/newrefs.txt /tmp/old.keys | tr '\n' ' '; echo

echo
echo "== data directory expectations in NEW compose =="
grep -n 'BOX_DATA_DIRECTORY' "$NEW/compose.yml" | head -20

echo
echo "== secrets in old .env (names only, never values) =="
grep -oE '^[A-Z_]*(SECRET|TOKEN|KEY|PASSWORD)[A-Z_]*' "$OLD/.env" | sort -u | tr '\n' ' '; echo

echo
echo "== data inventory (bytes + sha of manifests, NOT modified) =="
for d in apps/local-engine/projects apps/local-engine/play-worlds apps/local-engine/data apps/voxa/data; do
  if [ -d "$OLD/$d" ]; then
    printf "%-34s files=%s bytes=%s\n" "$d" "$(find "$OLD/$d" -type f | wc -l)" "$(du -sb "$OLD/$d" | cut -f1)"
  fi
done
echo "-- project manifests:"
find "$OLD/apps/local-engine/projects" -maxdepth 2 -name 'manifest.json' -printf '%p\n' 2>/dev/null | head -10

echo
echo "== named volumes =="
docker volume ls --format '{{.Name}} {{.Size}}' 2>/dev/null | head -10
echo
echo "== current tags =="
grep -n 'BOX_IMAGE_TAG' "$OLD/.env" | head -2
