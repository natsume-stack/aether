#!/bin/sh
IVMDIR=/app/services/game-server/node_modules/.pnpm/isolated-vm@5.0.4/node_modules/isolated-vm
echo "=== strings.h option table ==="
sed -n '50,120p' "$IVMDIR/src/isolate/strings.h"
echo "=== eval options parsing (context) ==="
grep -rn "ReadOption" "$IVMDIR/src/isolate/handle_scope.cc" "$IVMDIR/src/context/*.cc" 2>/dev/null | head -30
echo "=== files under src ==="
ls -R "$IVMDIR/src" | head -60
