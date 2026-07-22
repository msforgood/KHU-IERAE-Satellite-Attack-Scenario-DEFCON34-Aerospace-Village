#!/usr/bin/env bash
# start-attacker.sh — scenario 4 attacker console (monitor 1): the orbit-maneuver
# command builder + orbit planner, on a single port (:8000).
#
#   http://localhost:8000  Command Builder (Python, stdlib http.server)
#     - orbit planner (satellite-sim): plan a thrust that collides with AURORA
#     - packet crafting: assemble the orbit_maneuver CCSDS/OOK uplink
#     - TRANSMIT: software uplink -> victim ground station (monitor 2)
#
# No gpredict / OpenVSA app here: scenario 4's uplink is software-simulated —
# TRANSMIT forwards the decoded command to the victim GS (/api/inject).
#
# Usage (from this folder):
#   ./start-attacker.sh            # install + check + run
#   ./start-attacker.sh install    # first-time setup only (python venv + numpy)
#   ./start-attacker.sh check      # verify setup (numpy + codec roundtrip)
#   ./start-attacker.sh up         # run only (after install)
#
# Env (optional):
#   GS_URL          victim ground station base (TRANSMIT/RESET target). Default http://localhost:4540
#   BUILDER_PORT    command builder port. Default 8000
#   UPLINK_OUT_DIR  attack.cf32 output folder. Default ~/uplink
#   NO_OPEN         1 = do not auto-open the browser
#   ENABLE_GPREDICT 1 = also start the phase-3 gpredict container (:6080). OFF by default:
#                   scenario 5's uplink is software-simulated and the console never
#                   embeds gpredict, so starting it just wastes time (docker info stall +
#                   container spin-up).
#   ENABLE_BRIDGE   1 = also start the antenna/Doppler node bridge (:4542-4545). OFF by
#                   default for the same reason.
#
# Fast start: 'all' skips the codec roundtrip test and re-installing numpy when the venv
# already has it, so a warm launch is a couple of seconds instead of ~20s. Run
# './start-attacker.sh check' when you want the full codec verification.

set -uo pipefail
cd "$(dirname "$0")/attacker"

MODE="${1:-all}"
GS_URL="${GS_URL:-http://localhost:4540}"
BUILDER_PORT="${BUILDER_PORT:-8000}"
UPLINK_OUT_DIR="${UPLINK_OUT_DIR:-$HOME/uplink}"

BUILDER_DIR="packet-generator/webapp"
VENV="$BUILDER_DIR/.venv"

say()    { printf "\033[36m> %s\033[0m\n" "$*"; }
c_ok()   { printf "\033[32m  ok %s\033[0m\n" "$*"; }
c_warn() { printf "\033[33m  ! %s\033[0m\n" "$*"; }
c_err()  { printf "\033[31m  x %s\033[0m\n" "$*"; }
die()    { c_err "$*" >&2; exit 1; }
have()   { command -v "$1" >/dev/null 2>&1; }
open_url() {
  [ "${NO_OPEN:-0}" = "1" ] && return 0
  case "$(uname)" in
    Darwin) open "$1" ;;
    Linux)  xdg-open "$1" >/dev/null 2>&1 || true ;;
    *)      command -v powershell >/dev/null 2>&1 && powershell.exe start "$1" || true ;;
  esac
}
pick_python() { if [ -x "$VENV/bin/python" ]; then echo "$VENV/bin/python"; else echo "python3"; fi; }
free_port() {
  local port="$1" pids
  have lsof || return 0
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null)" || true
  [ -z "$pids" ] && return 0
  c_warn ":$port in use -> clearing previous instance: $(echo "$pids" | tr '\n' ' ')"
  echo "$pids" | xargs kill 2>/dev/null || true; sleep 1
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null)" || true
  [ -n "$pids" ] && { echo "$pids" | xargs kill -9 2>/dev/null || true; sleep 1; }
}

install() {
  say "1/3  first-time setup"
  have python3 || die "python3 not found"
  if [ ! -d "$VENV" ]; then
    echo "[1/1] creating venv -> $VENV"
    python3 -m venv "$VENV" || die "venv creation failed (Debian: 'sudo apt install python3-venv')"
  fi
  # Fast path: numpy already present -> skip the ~20s network pip round trip entirely.
  if "$VENV/bin/python" -c "import numpy" 2>/dev/null; then
    c_ok "numpy $("$VENV/bin/python" -c 'import numpy;print(numpy.__version__)') already present -> skip pip"
    echo "setup done."
    return 0
  fi
  echo "[1/1] installing Command Builder python deps (numpy) -> $VENV"
  "$VENV/bin/python" -m pip install --quiet --upgrade pip \
    && "$VENV/bin/python" -m pip install --quiet numpy \
    || die "numpy install failed"
  c_ok "numpy ready"
  echo "setup done."
}

check() {
  say "2/3  verify setup"
  local ok=1 py; py="$(pick_python)"
  if "$py" -c "import numpy" 2>/dev/null; then
    c_ok "numpy $("$py" -c 'import numpy;print(numpy.__version__)') ($py)"
  else
    c_err "numpy import failed -> run './start-attacker.sh install' first"; ok=0
  fi
  if "$py" packet-generator/tests/test_roundtrip.py 2>/dev/null | grep -q "ALL PASSED"; then
    c_ok "codec roundtrip ALL PASSED"
  else
    c_err "codec roundtrip failed (check path/numpy)"; ok=0
  fi
  [ "$ok" -eq 1 ] && echo "check passed." || die "check failed — fix the above and retry"
}

up() {
  say "3/3  run attacker console (monitor 1)"
  local py; py="$(pick_python)"
  "$py" -c "import numpy" 2>/dev/null || die "numpy missing -> run './start-attacker.sh install' first"
  local PY_ABS
  if [ -x "$VENV/bin/python" ]; then PY_ABS="$(cd "$VENV/bin" && pwd)/python"; else PY_ABS="$(command -v python3)"; fi

  free_port "$BUILDER_PORT"
  mkdir -p "$UPLINK_OUT_DIR"

  # Antenna/Doppler node bridge (:4542-4545) and the gpredict container (:6080) are
  # scenario-4 leftovers. Scenario 5's uplink is software-simulated and the console never
  # embeds them, so they stay OFF by default (checking/starting them adds a docker-info
  # stall plus a container spin-up for nothing). Opt in with ENABLE_BRIDGE=1 / ENABLE_GPREDICT=1.
  if [ "${ENABLE_BRIDGE:-0}" = "1" ]; then
    if have node; then
      if ! curl -fsS --max-time 2 "http://localhost:4545/status" >/dev/null 2>&1; then
        say "starting antenna bridge (rot 4543 / rig 4542 / ws 4544 / status 4545)"
        ( node rotctld-bridge/server.js ) >/tmp/scn4-bridge.log 2>&1 &
      else
        c_ok "antenna bridge already running on :4545"
      fi
    else
      c_warn "node not found -> antenna bridge skipped"
    fi
  fi

  if [ "${ENABLE_GPREDICT:-0}" = "1" ]; then
    if have docker && docker info >/dev/null 2>&1; then
      if ! curl -fsS --max-time 2 "http://localhost:6080/" >/dev/null 2>&1; then
        say "starting gpredict container (:6080)"
        ( cd gpredict-web && ./run.sh ) >/tmp/scn4-gpredict.log 2>&1 &
      else
        c_ok "gpredict already running on :6080"
      fi
    else
      c_warn "docker not available -> gpredict embed skipped"
    fi
  fi

  local URL="http://localhost:$BUILDER_PORT/"
  ( cd "$BUILDER_DIR" && UPLINK_OUT_DIR="$UPLINK_OUT_DIR" GS_URL="$GS_URL" PORT="$BUILDER_PORT" "$PY_ABS" app.py )
}

case "$MODE" in
  install) install ;;
  check)   check ;;
  up)      up ;;
  all)     install
           say "opening the console"
           ( sleep 1.5; open_url "http://localhost:$BUILDER_PORT/" ) &
           up ;;
  *) die "unknown mode '$MODE' (use: install | check | up | all)";;
esac
