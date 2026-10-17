#!/bin/sh
# Runs INSIDE the play image. Read-only probe.
echo "--- node ---"; node -v || echo "NO NODE"
echo "--- uname ---"; uname -a
echo "--- glibc ---"; /lib/x86_64-linux-gnu/libc.so.6 2>/dev/null | head -1
echo "--- /app top level ---"; ls /app
echo "--- /app/services ---"; ls /app/services 2>/dev/null
echo "--- find isolated_vm.node ---"
find / -name "isolated_vm.node" 2>/dev/null
echo "--- find isolated-vm package dirs ---"
find / -type d -name "isolated-vm" 2>/dev/null | head -20
echo "--- find package.json of isolated-vm ---"
find / -path "*isolated-vm*/package.json" -not -path "*/node_modules/*/node_modules/*" 2>/dev/null | head -20
echo "--- ivmp entry file ---"
find / -name "ivmp-process-entry*" 2>/dev/null | head -20
