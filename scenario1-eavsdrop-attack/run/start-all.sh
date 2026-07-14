#!/usr/bin/env bash
# ⑥ 전체 일괄 실행 (WSL 에서 실행) — server.js · gpredict · gnuradio · server.py 를 백그라운드로.
#   아두이노 브릿지는 COM3(Windows) 때문에 여기서 못 띄운다 → 아래 안내대로 Windows 에서 별도 실행.
#   이미 떠 있으면 먼저:  bash run/stop-all.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

bg(){ # $1=script $2=logname : 백그라운드 실행 + PID 기록
  log "start $1  (→ logs/$2.log)"
  nohup bash "$RUN_DIR/$1" >"$LOGDIR/$2.log" 2>&1 &
  echo $! >"$LOGDIR/$2.pid"
}

bg   vsa-bridge.sh vsa-bridge      # ① 먼저(컨테이너가 붙을 대상)
sleep 2
bash "$RUN_DIR/gpredict.sh"        # ② 컨테이너(detached, 스크립트는 곧 종료)
bash "$RUN_DIR/gnuradio.sh"        # ③ 컨테이너(detached)
bg   web.sh web                    # ④ 웹 가이드
sleep 2

cat <<EOF

──────────────────────────────────────────────
 웹 가이드 : http://localhost:$WEB_PORT
 gpredict  : http://localhost:$GP_WEB_PORT   (control $GP_CTRL_PORT)
 gnuradio  : http://localhost:$GN_WEB_PORT
 아두이노  : Windows 터미널(git-bash)에서  →  bash run/arduino.sh
             (또는  python arduino_bridge.py --ws $ARDUINO_WS --baud $ARDUINO_BAUD)
 로그      : run/logs/*.log        중지 : bash run/stop-all.sh
──────────────────────────────────────────────
EOF
