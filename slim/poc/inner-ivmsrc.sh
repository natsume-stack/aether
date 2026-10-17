#!/bin/sh
IVMDIR=/app/services/game-server/node_modules/.pnpm/isolated-vm@5.0.4/node_modules/isolated-vm
echo "=== include.js (the JS wrapper: defines option semantics) ==="
cat "$IVMDIR/include.js"
echo "=== isolated-vm.js head ==="
head -40 "$IVMDIR/isolated-vm.js"
echo "=== grep option keys in src (transferIn/reference) ==="
grep -rn "transferIn\|\"reference\"\|'reference'" "$IVMDIR/src" 2>/dev/null | head -25
