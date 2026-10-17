#!/usr/bin/env bash
# Collision-free WSL runner for the 7-way cluster.
# wsl-run.sh writes a SINGLE shared _cmd.sh; concurrent agents clobber it and
# bash re-reads the mutated file mid-run. This variant uses a per-PID filename.
# Usage: ./wsl-run-iso.sh '<bash fragment>' [tag]
set -uo pipefail
CMD="${1:?command required}"
TAG="${2:-out}"
WIN="C:/Users/Natsume/AppData/Local/Temp/box3wsl"
LINUX="/mnt/c/Users/Natsume/AppData/Local/Temp/box3wsl"
mkdir -p "$WIN"
SELF="$LINUX/_cmd_$$.sh"
SELF_WIN="$WIN/_cmd_$$.sh"
{
  echo '#!/bin/bash'
  echo "exec > '$LINUX/${TAG}.$$' 2>&1"
  printf '%s\n' "$CMD"
  echo 'printf "[exit=%s]\n" "$?"'
} > "$SELF_WIN"
sed -i 's/\r$//' "$SELF_WIN"
wsl.exe -d Ubuntu-24.04 -- bash -c "bash $SELF" >/dev/null 2>&1 || true
cat "$WIN/${TAG}.$$"
rm -f "$SELF_WIN" "$WIN/${TAG}.$$"
