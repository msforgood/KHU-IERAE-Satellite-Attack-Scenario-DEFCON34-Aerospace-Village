#!/usr/bin/env bash
# [WSL/Docker] (2) gpredict container  (noVNC:$GP_WEB_PORT - control:$GP_CTRL_PORT)
#   Connects to server.js (rotctld/rigctld) via ROTCTLD_HOST=host.docker.internal.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"
command -v docker >/dev/null 2>&1 || { err "docker not found - check that Docker Desktop is running"; exit 1; }
docker image inspect "$GP_IMG" >/dev/null 2>&1 || { log "Building image $GP_IMG"; docker build -t "$GP_IMG" "$HOSTBASE/gpredict-web" || exit 1; }
docker rm -f "$GP_NAME" >/dev/null 2>&1
log "Starting gpredict -> noVNC localhost:$GP_WEB_PORT - control localhost:$GP_CTRL_PORT (ROTCTLD_HOST=$ROTCTLD_HOST)"
docker run -d --rm --name "$GP_NAME" \
  -p "$GP_WEB_PORT:6080" -p "$GP_CTRL_PORT:6079" \
  --add-host=host.docker.internal:host-gateway \
  -e ROTCTLD_HOST="$ROTCTLD_HOST" \
  -v "$HOSTBASE/gpredict-config:/config:ro" \
  "$GP_IMG" >/dev/null || { err "docker run failed"; exit 1; }
sleep 3
check_http "$GP_WEB_PORT" "gpredict noVNC"
