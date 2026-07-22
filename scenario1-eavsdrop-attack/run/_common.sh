#!/usr/bin/env bash
# Shared settings and functions: each run script sources this at the top (do not run it directly).
#
# Where things run (based on this boot session):
#   - server.js / server.py / Docker containers  -> run in WSL (Docker publishes to Windows localhost)
#   - arduino_bridge.py                           -> run on Windows (COM3)  (run/arduino.sh)
#   - browser access                              -> http://localhost:8080   (not the WSL IP!)
set -o pipefail

RUN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SCEN1="$(cd "$RUN_DIR/.." && pwd)"
export LOGDIR="$RUN_DIR/logs"; mkdir -p "$LOGDIR"

# -- Ports/hosts (can be overridden with environment variables before running) --------------
# In this boot, 6079-6081 are not routable, so high ports are the defaults. (If the 6080 range
#   comes back, run with GP_WEB_PORT=6080 GP_CTRL_PORT=6079 GN_WEB_PORT=6081)
: "${GP_WEB_PORT:=16080}"   # gpredict noVNC
: "${GP_CTRL_PORT:=16079}"  # gpredict control (reset/offset)
: "${GN_WEB_PORT:=16081}"   # gnuradio noVNC
: "${WEB_PORT:=8080}"       # web guide server.py
: "${ROTCTLD_HOST:=host.docker.internal}"    # host the container gpredict reaches for server.js (rotctld/rigctld)
: "${WS_PORT:=4534}"                          # server.js WebSocket
: "${ARDUINO_WS:=ws://127.0.0.1:${WS_PORT}}"  # fixed IPv4 (avoids IPv6 handshake timeout under mirrored networking)
: "${ARDUINO_BAUD:=115200}"
export GP_WEB_PORT GP_CTRL_PORT GN_WEB_PORT WEB_PORT ROTCTLD_HOST WS_PORT ARDUINO_WS ARDUINO_BAUD

export GP_IMG=enigma1-gpredict GP_NAME=gpredict-run
export GN_IMG=enigma1-gnuradio GN_NAME=gnuradio-run

# Docker -v host path: on git-bash (MSYS) use C:/..., on WSL keep /mnt/c/... as is.
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|*NT*) export MSYS_NO_PATHCONV=1; HOSTBASE="$(cygpath -m "$SCEN1" 2>/dev/null || echo "$SCEN1")" ;;
  *) HOSTBASE="$SCEN1" ;;
esac
export HOSTBASE

log(){ printf '\033[36m[run]\033[0m %s\n' "$*"; }
err(){ printf '\033[31m[run:ERR]\033[0m %s\n' "$*" >&2; }

check_http(){  # $1=port $2=label
  local c; c="$(curl -s -m4 -o /dev/null -w '%{http_code}' "http://localhost:$1/" 2>/dev/null)"
  if [ "$c" = "000" ]; then err "localhost:$1 ($2) no response - check port publishing / zombie docker-proxy"; return 1
  else log "localhost:$1 ($2) OK (HTTP $c)"; fi
}
