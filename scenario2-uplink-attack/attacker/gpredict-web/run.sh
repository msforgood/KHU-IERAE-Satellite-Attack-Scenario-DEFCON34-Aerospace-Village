#!/usr/bin/env bash
# Build + run the isolated gpredict-in-Docker. Nothing installs on the host.
# gpredict UI → http://localhost:6080/vnc.html?autoconnect=1&resize=remote
set -e
cd "$(dirname "$0")"
IMG=${IMG:-demosat-gpredict}
PORT=${WEB_PORT:-6080}

docker build -t "$IMG" .
URL="http://localhost:$PORT/vnc.html?autoconnect=1&resize=remote"
echo "───────────────────────────────────────────────"
echo " gpredict (web) → $URL"
echo " console        → attacker/console/index.html?gp=$URL"
echo "───────────────────────────────────────────────"
exec docker run --rm -p "$PORT:6080" \
  --add-host=host.docker.internal:host-gateway \
  -e ROTCTLD_HOST="${ROTCTLD_HOST:-host.docker.internal}" \
  -v "$(cd .. && pwd)/gpredict-config:/config:ro" \
  "$IMG"
