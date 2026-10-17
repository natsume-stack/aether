#!/bin/sh
IVMDIR=/app/services/game-server/node_modules/.pnpm/isolated-vm@5.0.4/node_modules/isolated-vm
echo "=== dir listing ==="
ls "$IVMDIR"
echo "=== .d.ts files ==="
find "$IVMDIR" -maxdepth 2 -name "*.d.ts" -o -maxdepth 2 -name "*.d.js" 2>/dev/null
echo "=== README eval/run options ==="
grep -n -A 22 "reference" "$IVMDIR/README.md" 2>/dev/null | sed -n '1,120p'
