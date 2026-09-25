#!/usr/bin/env bash
# Separate lifecycle for the recorded-downlink demo (1) and local simulator (4).
# Called by run-booth.sh; existing scenario 2/3 supervision is not used or changed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCENARIO="${1:-}"
MODE="${2:-all}"
case "$SCENARIO" in
  scn1) SCENARIO_DIR="$ROOT/scenario1-eavsdrop-attack" ;;
  scn4) SCENARIO_DIR="$ROOT/scenario4-constellation-chaos" ;;
  *) echo "Use run-booth.sh scn1 or scn4." >&2; exit 1 ;;
esac
case "$MODE" in install|check|up|all) ;; *) echo "Mode must be install, check, up or all." >&2; exit 1 ;; esac
[ "$#" -le 2 ] || { echo "Too many arguments." >&2; exit 1; }

die() { echo "[booth:$SCENARIO] $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "Missing $1. Install it inside the Linux/WSL environment running this script."; }
for tool in python3 node; do need "$tool"; done
python3 -c 'import os, sys; sys.exit(os.name != "posix")' || die "Use Linux/WSL Python, not native Windows Python."
if [ "$SCENARIO" = scn1 ]; then
  . "$SCENARIO_DIR/run/_common.sh"
  need docker
  docker info >/dev/null 2>&1 || die "Docker is not ready. Start Docker and enable integration with this WSL distribution."
else
  export GS_HTTP_PORT="${GS_HTTP_PORT:-4540}"
  export BUILDER_PORT="${BUILDER_PORT:-8000}"
  export GS_URL="${GS_URL:-http://localhost:$GS_HTTP_PORT}"
fi

prepare() {
  if [ "$SCENARIO" = scn4 ]; then
    bash "$SCENARIO_DIR/start-attacker.sh" install
    return
  fi
  # Only the runtime modules are needed; do not install the Electron desktop app.
  if ! (cd "$SCENARIO_DIR/vsa" && node -e "require('ws'); require('satellite.js')") >/dev/null 2>&1; then
    need npm
    (cd "$SCENARIO_DIR/vsa" && npm ci --omit=dev --no-audit --no-fund)
  fi
  docker image inspect "$GP_IMG" >/dev/null 2>&1 || docker build -t "$GP_IMG" "$HOSTBASE/gpredict-web"
  docker image inspect "$GN_IMG" >/dev/null 2>&1 || docker build -t "$GN_IMG" "$HOSTBASE/gnuradio-web"
  [ -s "$SCENARIO_DIR/signal/enigma34_downlink.cf32" ] || die "Missing bundled recording: signal/enigma34_downlink.cf32"
}

check_setup() {
  if [ "$SCENARIO" = scn4 ]; then
    node --check "$SCENARIO_DIR/victim/backend/server.js"
    bash "$SCENARIO_DIR/start-attacker.sh" check
  else
    (cd "$SCENARIO_DIR/vsa" && node -e "require('ws'); require('satellite.js')")
    node --check "$SCENARIO_DIR/vsa/server.js"
    python3 -c 'import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))' "$SCENARIO_DIR/web-guide/server.py"
    docker image inspect "$GP_IMG" "$GN_IMG" >/dev/null
    [ -s "$SCENARIO_DIR/signal/enigma34_downlink.cf32" ] || die "Missing bundled recording."
  fi
  echo "[booth:$SCENARIO] Setup check passed."
}

case "$MODE" in
  install) prepare; echo "[booth:$SCENARIO] Preparation complete."; exit 0 ;;
  check) check_setup; exit 0 ;;
  all) prepare ;;
esac
need curl

# Own only the children started here. Never use scenario 2/3's global name/port cleanup.
CHILDREN=()
CONTAINERS=()
LAUNCHING=0
STOP_STATUS=0
request_stop() {
  if [ "$LAUNCHING" = 1 ]; then STOP_STATUS="$1"; else exit "$1"; fi
}
cleanup() {
  local pid name
  trap '' INT TERM HUP
  # Each Python supervisor terminates its own session, then reaps descendants.
  for pid in "${CHILDREN[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  for pid in "${CHILDREN[@]}"; do wait "$pid" 2>/dev/null || true; done
  # Startup commands must finish stopping before removing what they may create.
  for name in "${CONTAINERS[@]}"; do docker rm -f "$name" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT
trap 'request_stop 130' INT
trap 'request_stop 143' TERM
trap 'request_stop 129' HUP
start_child() {
  # Defer cancellation until the newly launched supervisor is registered.
  LAUNCHING=1
  python3 "$ROOT/common/booth-process.py" bash "$@" & CHILDREN+=("$!")
  LAUNCHING=0
  [ "$STOP_STATUS" = 0 ] || exit "$STOP_STATUS"
}
run_startup() {
  local pid status=0 last
  start_child "$@"
  last=$((${#CHILDREN[@]} - 1)); pid="${CHILDREN[$last]}"
  wait "$pid" || status=$?
  unset 'CHILDREN[last]'
  return "$status"
}
check_children() {
  local pid
  for pid in "${CHILDREN[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" || true
      die "A service exited. See its output above; stopping this scenario."
    fi
  done
}
wait_http() {
  local url="$1" attempt
  for attempt in {1..60}; do
    check_children
    curl --fail --silent --max-time 2 "$url" >/dev/null 2>&1 && return 0
    sleep 1
  done
  die "Service did not become ready: $url"
}
open_browser() {
  local url="$1"
  [ "${NO_OPEN:-0}" = 1 ] && return 0
  if command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -NonInteractive -Command "Start-Process -FilePath '$url' -ErrorAction Stop" >/dev/null 2>&1 && return 0
  elif command -v open >/dev/null 2>&1; then
    open "$url" >/dev/null 2>&1 && return 0
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 && return 0
  fi
  echo "Open in your browser: $url"
}
port_number() { [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ] || die "Invalid port: $1"; }

if [ "$SCENARIO" = scn1 ]; then
  for port in "$WEB_PORT" "$GP_WEB_PORT" "$GP_CTRL_PORT" "$GN_WEB_PORT" "$WS_PORT"; do port_number "$port"; done
  # Use the existing per-service scripts, retaining PIDs so Ctrl-C also stops the servers.
  start_child "$SCENARIO_DIR/run/vsa-bridge.sh"
  CONTAINERS+=("$GP_NAME")
  run_startup "$SCENARIO_DIR/run/gpredict.sh"
  CONTAINERS+=("$GN_NAME")
  run_startup "$SCENARIO_DIR/run/gnuradio.sh"
  start_child "$SCENARIO_DIR/run/web.sh"
  wait_http "http://localhost:$WEB_PORT/"
  wait_http "http://localhost:$GP_WEB_PORT/"
  wait_http "http://localhost:$GN_WEB_PORT/"
  echo "[booth:scn1] Guide: http://localhost:$WEB_PORT"
  echo "Arduino hardware, if used: run run/arduino.sh separately on Windows."
  open_browser "http://localhost:$WEB_PORT/"
else
  port_number "$GS_HTTP_PORT"; port_number "$BUILDER_PORT"
  # Wait for the victim before exposing the console. Browser opening is coordinated here.
  NO_OPEN=1 start_child "$SCENARIO_DIR/start-victim.sh"
  wait_http "http://localhost:$GS_HTTP_PORT/api/state"
  NO_OPEN=1 start_child "$SCENARIO_DIR/start-attacker.sh" up
  wait_http "http://localhost:$BUILDER_PORT/"
  echo "[booth:scn4] Victim: http://localhost:$GS_HTTP_PORT  Console: http://localhost:$BUILDER_PORT"
  open_browser "http://localhost:$GS_HTTP_PORT/"
  open_browser "http://localhost:$BUILDER_PORT/"
fi
echo "[booth:$SCENARIO] Ready. Keep this terminal open; Ctrl-C stops this scenario."
# Both scenarios already handle participant resets in their own applications.
# Do not consume the RESTART_FLAG used exclusively by the original scn2/scn3 supervisor.
while true; do check_children; sleep 1; done
