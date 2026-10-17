#!/usr/bin/env bash
# W2 format harness: reproduces the repository's effective prettier settings
# (tools/repo-tooling prettier 3.6.2 + .prettierrc.cjs + owned-code overrides)
# without installing into the repo. Rush is never invoked.
# Usage: ./w2-fmt.sh [--write]
set -uo pipefail
REPO="D:/desktop/神奇代码岛/box3-local-engine"
PRETTIER="D:/desktop/神奇代码岛/box3-re/tools/w2-prettier/node_modules/prettier/bin/prettier.cjs"
WRITE="${1:-}"
status=0

check() {
  local parser="$1"
  shift
  local file="$1"
  shift
  local tmp
  tmp=$(mktemp)
  if [ "$WRITE" = "--write" ]; then
    node "$PRETTIER" --no-config --no-editorconfig --parser "$parser" "$@" --write "$file" >/dev/null || status=1
    return
  fi
  node "$PRETTIER" --no-config --no-editorconfig --parser "$parser" "$@" --end-of-line lf "$file" \
    > "$tmp" 2> /dev/null || { echo "prettier failed: $file"; status=1; rm -f "$tmp"; return; }
  if diff --strip-trailing-cr -q "$tmp" "$REPO/$file" > /dev/null; then
    echo "OK   $file"
  else
    echo "DIFF $file"
    diff --strip-trailing-cr "$tmp" "$REPO/$file" | head -40
    status=1
  fi
  rm -f "$tmp"
}

cd "$REPO" || exit 1
JS_ARGS=(--tab-width 4 --semi --single-quote --trailing-comma all --print-width 100)
JSON_ARGS=(--print-width 100)
YAML_ARGS=(--single-quote --print-width 100)

check babel "${JS_ARGS[@]}" scripts/lib/budget.mjs
check babel "${JS_ARGS[@]}" scripts/check-image-budget.mjs
check babel "${JS_ARGS[@]}" scripts/check-image-blacklist.mjs
check json "${JSON_ARGS[@]}" common/config/box3-image-budget.json
check json "${JSON_ARGS[@]}" common/config/box3-image-blacklist.json
check yaml "${YAML_ARGS[@]}" .github/workflows/verify.yml

exit "$status"
