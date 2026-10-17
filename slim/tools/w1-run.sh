#!/usr/bin/env bash
# Lane-private WSL runner for W1. Same contract as ../wsl-run.sh but the scratch
# command file is named _w1_cmd.sh so the other six concurrent lanes writing
# _cmd.sh cannot corrupt this one's command mid-run.
set -uo pipefail
CMD="${1:?command required}"
TAG="${2:-w1-out}"
WIN="C:/Users/Natsume/AppData/Local/Temp/box3wsl"
LINUX="/mnt/c/Users/Natsume/AppData/Local/Temp/box3wsl"
mkdir -p "$WIN"
{
  echo '#!/bin/bash'
  echo "exec > '$LINUX/${TAG}.out' 2>&1"
  printf '%s\n' "$CMD"
  echo 'printf "[exit=%s]\n" "$?"'
} > "$WIN/_w1_cmd.sh"
sed -i 's/\r$//' "$WIN/_w1_cmd.sh"
wsl.exe -d Ubuntu-24.04 -- bash -c "bash $LINUX/_w1_cmd.sh" >/dev/null 2>&1 || true
cat "$WIN/${TAG}.out"
