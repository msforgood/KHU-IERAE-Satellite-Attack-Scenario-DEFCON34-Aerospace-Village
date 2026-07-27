#!/usr/bin/env bash
# launch.sh — bring up the attacker 3rd screen: OpenVSA + console (+ gpredict web).
set -e
cd "$(dirname "$0")"
GS=${GS_URL:-http://localhost:4540}
CONSOLE_PORT=${CONSOLE_PORT:-8090}
GP=${GPREDICT_WEB_URL:-}          # e.g. http://localhost:6080/vnc.html?autoconnect=1&resize=remote
VSA=${OPENVSA_URL:-}              # OpenVSA UI url to embed (optional)

echo "[openvsa] rotctld :4533 / ws :4534 → forward ${UPLINK_DEST:-ws://localhost:4536}"
( cd openvsa && UPLINK_DEST=${UPLINK_DEST:-ws://localhost:4536} node server.js ) &  P1=$!
( cd openvsa && npm run electron ) >/dev/null 2>&1 &                                P2=$!
( cd console && python3 -m http.server "$CONSOLE_PORT" ) >/dev/null 2>&1 &          P3=$!
trap 'kill $P1 $P2 $P3 2>/dev/null' EXIT
sleep 1

Q="gs=$GS"; [ -n "$GP" ] && Q="$Q&gp=$GP"; [ -n "$VSA" ] && Q="$Q&vsa=$VSA"
echo "───────────────────────────────────────────────"
echo " 3rd screen → http://localhost:$CONSOLE_PORT/?$Q"
echo " gpredict web: run ./run-gpredict-web.sh, then set GPREDICT_WEB_URL"
echo "───────────────────────────────────────────────"
wait
