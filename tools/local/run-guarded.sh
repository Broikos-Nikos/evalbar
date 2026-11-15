#!/bin/bash
# One local model behind tools/local/serve_openai.py, and one evalbar run against it, under the owner's
# RAM rule for this machine: start only with 5 GB of RAM and 3 GB of GPU memory free; while it runs,
# every 5 s, if free RAM falls under 1.2 GB the server's process tree and the run are killed and logged.
# One model at a time. A file named STOP in .evalbar/ ends it before the next step.
#
#   PY=<python with torch and transformers> tools/local/run-guarded.sh <model> <revision> <evalbar arguments, @URL@ for the server>
#
#   ... run-guarded.sh Qwen/Qwen2.5-Coder-1.5B-Instruct <revision> run examples/sql-refusals --base-url @URL@ --model Qwen/Qwen2.5-Coder-1.5B-Instruct --out <dir>
set -u
cd "$(dirname "$0")/../.."
PY=${PY:-python}
MODEL=$1; REVISION=$2; shift 2
PORT=8977; NEED_MB=5120; NEED_GPU_MB=3000; KILL_MB=1200
mkdir -p .evalbar
LOG=.evalbar/run-guarded.log
avail() { node -e "console.log(Math.round(require('os').freemem() / 2 ** 20))"; }
gpu_free() { nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits | head -1 | tr -d ' '; }
say() { echo "== $(date +%T) $*" | tee -a "$LOG"; }
winkill() { local w; w=$(cat "/proc/$1/winpid" 2>/dev/null); [ -n "$w" ] && taskkill //PID "$w" //T //F > /dev/null 2>&1; kill "$1" 2>/dev/null; }

while [ "$(avail)" -lt "$NEED_MB" ] || [ "$(gpu_free)" -lt "$NEED_GPU_MB" ]; do
  [ -f .evalbar/STOP ] && { say "STOP before start"; exit 3; }
  say "waiting: $(avail) MB RAM free (need $NEED_MB), $(gpu_free) MB GPU free (need $NEED_GPU_MB)"
  sleep 20
done
say "start $MODEL@$REVISION: $(avail) MB RAM, $(gpu_free) MB GPU free"
"$PY" -I tools/local/serve_openai.py --model "$MODEL" --revision "$REVISION" --port $PORT > .evalbar/serve.log 2>&1 &
SERVER=$!
low=99999
guard() { # 0 while fine, 1 after killing everything
  local a; a=$(avail); [ "$a" -lt "$low" ] && low=$a
  if [ "$a" -lt "$KILL_MB" ] || [ -f .evalbar/STOP ]; then
    say "watchdog: $a MB free or STOP; killing the server and the run"
    winkill "$SERVER"; [ -n "${RUN:-}" ] && winkill "$RUN"
    return 1
  fi
  return 0
}
for _ in $(seq 1 120); do
  curl -s "http://127.0.0.1:$PORT/health" > /dev/null 2>&1 && break
  kill -0 "$SERVER" 2>/dev/null || { say "the server died while loading"; tail -5 .evalbar/serve.log | tee -a "$LOG"; exit 2; }
  guard || exit 2
  sleep 5
done
say "serving: $(curl -s "http://127.0.0.1:$PORT/health")"
ARGS=(); for a in "$@"; do ARGS+=("${a//@URL@/http://127.0.0.1:$PORT/v1}"); done
node src/cli.ts "${ARGS[@]}" &
RUN=$!
while kill -0 "$RUN" 2>/dev/null; do guard || exit 2; sleep 5; done
wait "$RUN"; rc=$?
winkill "$SERVER"
say "done, evalbar exit $rc, lowest free RAM $low MB"
exit $rc
