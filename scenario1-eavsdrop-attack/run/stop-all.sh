#!/usr/bin/env bash
# Stop everything: remove the containers and terminate the background server.js/server.py processes.
#   (Stop the Arduino bridge with Ctrl+C in the Windows terminal.)
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"
log "Removing containers: $GP_NAME $GN_NAME"
docker rm -f "$GP_NAME" "$GN_NAME" >/dev/null 2>&1
for n in vsa-bridge web; do
  [ -f "$LOGDIR/$n.pid" ] || continue
  p="$(cat "$LOGDIR/$n.pid")"
  log "kill $n (pid $p)"
  kill "$p" 2>/dev/null; pkill -P "$p" 2>/dev/null
  rm -f "$LOGDIR/$n.pid"
done
log "Done (stop the Arduino bridge with Ctrl+C in the Windows terminal)"
