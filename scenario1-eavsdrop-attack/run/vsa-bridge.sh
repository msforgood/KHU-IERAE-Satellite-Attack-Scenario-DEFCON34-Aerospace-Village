#!/usr/bin/env bash
# [WSL] (1) VSA bridge server.js  (rotctld:4533, rigctld:4532, WS:4534)
#   GPredict rotator host=localhost:4533, radio host=localhost:4532.
#   The containerized gpredict connects to this server via host.docker.internal.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"
command -v node >/dev/null 2>&1 || { err "node not found - please run this from WSL"; exit 1; }
cd "$SCEN1/vsa" || exit 1
log "starting server.js - rotctld 4533 / rigctld 4532 / WS $WS_PORT"
exec node server.js
