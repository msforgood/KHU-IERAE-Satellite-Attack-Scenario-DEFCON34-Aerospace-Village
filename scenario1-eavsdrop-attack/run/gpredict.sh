#!/usr/bin/env bash
# [WSL/Docker] ② gpredict 컨테이너  (noVNC:$GP_WEB_PORT · control:$GP_CTRL_PORT)
#   ROTCTLD_HOST=host.docker.internal 로 server.js(rotctld/rigctld)에 연결.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"
command -v docker >/dev/null 2>&1 || { err "docker 없음 — Docker Desktop 실행 확인"; exit 1; }
docker image inspect "$GP_IMG" >/dev/null 2>&1 || { log "이미지 빌드 $GP_IMG"; docker build -t "$GP_IMG" "$HOSTBASE/gpredict-web" || exit 1; }
docker rm -f "$GP_NAME" >/dev/null 2>&1
log "gpredict 시작 → noVNC localhost:$GP_WEB_PORT · control localhost:$GP_CTRL_PORT (ROTCTLD_HOST=$ROTCTLD_HOST)"
docker run -d --rm --name "$GP_NAME" \
  -p "$GP_WEB_PORT:6080" -p "$GP_CTRL_PORT:6079" \
  --add-host=host.docker.internal:host-gateway \
  -e ROTCTLD_HOST="$ROTCTLD_HOST" \
  -v "$HOSTBASE/gpredict-config:/config:ro" \
  "$GP_IMG" >/dev/null || { err "docker run 실패"; exit 1; }
sleep 3
check_http "$GP_WEB_PORT" "gpredict noVNC"
