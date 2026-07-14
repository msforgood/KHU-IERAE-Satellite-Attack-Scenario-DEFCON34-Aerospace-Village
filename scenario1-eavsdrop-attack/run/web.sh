#!/usr/bin/env bash
# [WSL] ④ 웹 가이드 server.py  → http://localhost:$WEB_PORT
#   noVNC 임베드 URL 과 control URL 을 위 컨테이너 포트에 맞춰 넘긴다.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"
command -v python3 >/dev/null 2>&1 || { err "python3 없음 — WSL 에서 실행"; exit 1; }
cd "$SCEN1" || exit 1
export PORT="$WEB_PORT"
export GPREDICT_URL="http://localhost:$GP_WEB_PORT/vnc.html?autoconnect=1&resize=remote"
export GNURADIO_URL="http://localhost:$GN_WEB_PORT/vnc.html?autoconnect=1&resize=remote"
export GPREDICT_CONTROL_URL="http://localhost:$GP_CTRL_PORT"
log "server.py 시작 → http://localhost:$WEB_PORT  (GP=$GP_WEB_PORT GN=$GN_WEB_PORT CTRL=$GP_CTRL_PORT)"
exec python3 web/server.py
