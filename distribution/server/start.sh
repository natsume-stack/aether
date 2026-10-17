#!/usr/bin/env sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$root"

if [ ! -f .env ]; then
  echo 'Missing .env. Run ./install.sh first or copy .env.example to .env.' >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo 'Docker Engine is not running or the current user cannot access it.' >&2
  exit 1
fi

docker compose --env-file .env -f compose.yml up -d --no-build --remove-orphans --wait server-manager
echo 'Linux Web manager started. Start application services from the management page.'
