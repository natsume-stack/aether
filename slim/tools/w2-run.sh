#!/usr/bin/env bash
# W2-private WSL runner.
#
# tools/wsl-run.sh writes a single shared `_cmd.sh` per call, so parallel lanes
# (W1/W3...) overwrite each other's commands mid-flight. This variant keeps one
# unique command file and one unique output file per invocation.
#
# Usage: ./w2-run.sh '<bash fragment>' <tag>
set -uo pipefail
CMD="${1:?command required}"
TAG="${2:-w2out}"
WIN="C:/Users/Natsume/AppData/Local/Temp/box3wsl/w2"
LINUX="/mnt/c/Users/Natsume/AppData/Local/Temp/box3wsl/w2"
mkdir -p "$WIN"
NAME="${TAG}-$$"
{
  echo '#!/bin/bash'
  echo "exec > '$LINUX/${NAME}.out' 2>&1"
  printf '%s\n' "$CMD"
  echo 'printf "[exit=%s]\n" "$?"'
} > "$WIN/${NAME}.sh"
sed -i 's/\r$//' "$WIN/${NAME}.sh"
wsl.exe -d Ubuntu-24.04 -- bash -c "bash $LINUX/${NAME}.sh" >/dev/null 2>&1 || true
cat "$WIN/${NAME}.out"
rm -f "$WIN/${NAME}.sh" "$WIN/${NAME}.out"
