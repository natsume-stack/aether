#!/usr/bin/env bash
# W4 lane private runner: avoids the shared _cmd.sh so parallel lanes do not clobber each other.
set -uo pipefail
TAG="${1:?tag required}"
WIN="C:/Users/Natsume/AppData/Local/Temp/box3wsl"
LINUX="/mnt/c/Users/Natsume/AppData/Local/Temp/box3wsl"
mkdir -p "$WIN"
wsl.exe -d Ubuntu-24.04 -- bash -c "bash $LINUX/${TAG}.sh" >/dev/null 2>&1 || true
cat "$WIN/${TAG}.out" 2>/dev/null
