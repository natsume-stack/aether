#!/usr/bin/env bash
# Robust WSL runner: writes a self-redirecting script (ASCII path) into
# %TEMP%\box3wsl and runs it in Ubuntu-24.04, then prints the UTF-8 output.
# Usage: ./wsl-run.sh '<bash command>' [tag]
set -uo pipefail
CMD="${1:?command required}"
TAG="${2:-out}"
WIN="C:/Users/Natsume/AppData/Local/Temp/box3wsl"
LINUX="/mnt/c/Users/Natsume/AppData/Local/Temp/box3wsl"
mkdir -p "$WIN"
{
  echo '#!/bin/bash'
  echo "exec > '$LINUX/${TAG}.out' 2>&1"
  printf '%s\n' "$CMD"
  echo 'printf "[exit=%s]\n" "$?"'
} > "$WIN/_cmd.sh"
sed -i 's/\r$//' "$WIN/_cmd.sh"
wsl.exe -d Ubuntu-24.04 -- bash -c "bash $LINUX/_cmd.sh" >/dev/null 2>&1 || true
cat "$WIN/${TAG}.out"
