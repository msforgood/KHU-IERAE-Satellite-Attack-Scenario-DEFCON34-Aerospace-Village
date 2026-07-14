#!/usr/bin/env bash
# [WSL] ① VSA 브릿지 server.js  (rotctld:4533 · rigctld:4532 · WS:4534)
#   GPredict rotator host=localhost:4533, radio host=localhost:4532.
#   컨테이너 gpredict 는 host.docker.internal 로 이 서버에 붙는다.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"
command -v node >/dev/null 2>&1 || { err "node 없음 — WSL 에서 실행하세요"; exit 1; }
cd "$SCEN1/VSA-DEFCON2026" || exit 1
log "server.js 시작 — rotctld 4533 / rigctld 4532 / WS $WS_PORT"
exec node server.js
