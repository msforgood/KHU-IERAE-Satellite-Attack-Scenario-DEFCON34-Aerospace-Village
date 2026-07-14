#!/usr/bin/env bash
# 공통 설정/함수 — 각 실행 스크립트가 맨 위에서 source 한다(직접 실행 X).
#
# 실행 위치 (이 부팅 세션 기준):
#   · server.js / server.py / 도커 컨테이너 → WSL 에서 실행 (docker 가 Windows localhost 로 발행)
#   · arduino_bridge.py                      → Windows(COM3) 에서 실행  (run/arduino.sh)
#   · 브라우저 접속                          → http://localhost:8080   (WSL IP 아님!)
set -o pipefail

RUN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SCEN1="$(cd "$RUN_DIR/.." && pwd)"
export LOGDIR="$RUN_DIR/logs"; mkdir -p "$LOGDIR"

# ── 포트/호스트 (실행 전 환경변수로 덮어쓰기 가능) ─────────────────────────
# 이번 부팅에서 6079~6081 이 라우팅 불가라 고포트가 기본값. (6080대가 되살아나면
#   GP_WEB_PORT=6080 GP_CTRL_PORT=6079 GN_WEB_PORT=6081 로 실행하면 됨)
: "${GP_WEB_PORT:=16080}"   # gpredict noVNC
: "${GP_CTRL_PORT:=16079}"  # gpredict control (reset/offset)
: "${GN_WEB_PORT:=16081}"   # gnuradio noVNC
: "${WEB_PORT:=8080}"       # 웹 가이드 server.py
: "${ROTCTLD_HOST:=host.docker.internal}"    # 컨테이너 gpredict → server.js(rotctld/rigctld) 도달 호스트
: "${WS_PORT:=4534}"                          # server.js WebSocket
: "${ARDUINO_WS:=ws://127.0.0.1:${WS_PORT}}"  # IPv4 고정(미러드 네트워킹 IPv6 핸드셰이크 타임아웃 회피)
: "${ARDUINO_BAUD:=115200}"
export GP_WEB_PORT GP_CTRL_PORT GN_WEB_PORT WEB_PORT ROTCTLD_HOST WS_PORT ARDUINO_WS ARDUINO_BAUD

export GP_IMG=enigma1-gpredict GP_NAME=gpredict-run
export GN_IMG=enigma1-gnuradio GN_NAME=gnuradio-run

# 도커 -v 호스트경로: git-bash(MSYS)면 C:/... 로, WSL 이면 /mnt/c/... 그대로.
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|*NT*) export MSYS_NO_PATHCONV=1; HOSTBASE="$(cygpath -m "$SCEN1" 2>/dev/null || echo "$SCEN1")" ;;
  *) HOSTBASE="$SCEN1" ;;
esac
export HOSTBASE

log(){ printf '\033[36m[run]\033[0m %s\n' "$*"; }
err(){ printf '\033[31m[run:ERR]\033[0m %s\n' "$*" >&2; }

check_http(){  # $1=port $2=label
  local c; c="$(curl -s -m4 -o /dev/null -w '%{http_code}' "http://localhost:$1/" 2>/dev/null)"
  if [ "$c" = "000" ]; then err "localhost:$1 ($2) 응답 없음 — 포트 발행/좀비 docker-proxy 확인"; return 1
  else log "localhost:$1 ($2) OK (HTTP $c)"; fi
}
