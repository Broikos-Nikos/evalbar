#!/bin/bash
# The README's promise, timed: a fresh clone, `npm ci`, and the two commands that need no model and
# no key, each timed, with the clock from the shell. Writes measurements/five-minutes.txt.
#
#   bash tools/five-minutes.sh                                            # a clone of this repository's HEAD
#   bash tools/five-minutes.sh https://github.com/Broikos-Nikos/evalbar   # a clone of what a stranger gets
#
# The time depends on the machine and on npm's cache, so this is not rerun by check:measure; the file
# records the date, where the clone came from, its commit, Node's and npm's versions, and each step's seconds.
set -u
cd "$(dirname "$0")/.."
REPO=$(pwd)
SRC=${1:-$REPO}
FROM=${1:+ from $1}
STARTED=$(date '+%Y-%m-%d %H:%M')
DIR=$(mktemp -d)
OUT="$REPO/measurements/five-minutes.txt"
secs() { node -e "console.log((Number(process.argv[2]) - Number(process.argv[1])).toFixed(1))" "$1" "$2"; }
step() { # step <label> <command...>
  local label=$1; shift
  local t0; t0=$(date +%s.%N)
  "$@" > "$DIR/step.log" 2>&1; local rc=$?
  local t1; t1=$(date +%s.%N)
  printf '%-58s %6.1f s  exit %s\n' "$label" "$(secs "$t0" "$t1")" "$rc" >> "$OUT.tmp"
  return $rc
}
: > "$OUT.tmp"
T0=$(date +%s.%N)
step "git clone" git clone -q "$SRC" "$DIR/evalbar" || exit 1
cd "$DIR/evalbar"
HEAD=$(git rev-parse --short HEAD)
step "npm ci (installs two dev packages, builds the command)" npm ci --no-audit --no-fund || exit 1
step "npx evalbar report <the recorded SQL run>" npx evalbar report examples/sql-refusals/runs/qwen2.5-coder-1.5b
step "npx evalbar run examples/semantic-cache" npx evalbar run examples/semantic-cache --out "$DIR/run"
T1=$(date +%s.%N)
printf '%-58s %6.1f s\n' "from the clone to the second number" "$(secs "$T0" "$T1")" >> "$OUT.tmp"
cd "$REPO"
rm -rf "$DIR"
{ echo "a fresh clone of $HEAD$FROM, $STARTED, node $(node --version), npm $(npm --version)"; cat "$OUT.tmp"; } > "$OUT"
rm -f "$OUT.tmp"
cat "$OUT"
