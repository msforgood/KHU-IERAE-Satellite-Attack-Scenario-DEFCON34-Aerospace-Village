#!/usr/bin/env bash
# [WSL] (4) Web guide server.py  -> http://localhost:$WEB_PORT
#   Pass the noVNC embed URL and control URL to match the container ports above.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"
command -v python3 >/dev/null 2>&1 || { err "python3 not found - run inside WSL"; exit 1; }
cd "$SCEN1" || exit 1
export PORT="$WEB_PORT"
export GPREDICT_URL="http://localhost:$GP_WEB_PORT/vnc.html?autoconnect=1&resize=remote"
export GNURADIO_URL="http://localhost:$GN_WEB_PORT/vnc.html?autoconnect=1&resize=remote"
export GPREDICT_CONTROL_URL="http://localhost:$GP_CTRL_PORT"
log "server.py starting -> http://localhost:$WEB_PORT  (GP=$GP_WEB_PORT GN=$GN_WEB_PORT CTRL=$GP_CTRL_PORT)"
exec python3 web-guide/server.py
