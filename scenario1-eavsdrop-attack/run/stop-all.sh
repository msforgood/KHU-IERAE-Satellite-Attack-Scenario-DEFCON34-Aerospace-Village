#!/usr/bin/env bash
# 전체 중지 — 컨테이너 제거 + 백그라운드 server.js/server.py 종료.
#   (아두이노 브릿지는 Windows 터미널에서 Ctrl+C)
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"
log "컨테이너 제거: $GP_NAME $GN_NAME"
docker rm -f "$GP_NAME" "$GN_NAME" >/dev/null 2>&1
for n in vsa-bridge web; do
  [ -f "$LOGDIR/$n.pid" ] || continue
  p="$(cat "$LOGDIR/$n.pid")"
  log "kill $n (pid $p)"
  kill "$p" 2>/dev/null; pkill -P "$p" 2>/dev/null
  rm -f "$LOGDIR/$n.pid"
done
log "완료 (아두이노 브릿지는 Windows 터미널에서 Ctrl+C)"
