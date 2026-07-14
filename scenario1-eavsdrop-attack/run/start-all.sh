#!/usr/bin/env bash
# (6) Run everything at once (run under WSL): starts server.js, gpredict, gnuradio, and server.py in the background.
#   The Arduino bridge cannot be launched here because of COM3 (Windows) -> run it separately on Windows as guided below.
#   If it is already running, first do:  bash run/stop-all.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

bg(){ # $1=script $2=logname : run in the background and record the PID
  log "start $1  (→ logs/$2.log)"
  nohup bash "$RUN_DIR/$1" >"$LOGDIR/$2.log" 2>&1 &
  echo $! >"$LOGDIR/$2.pid"
}

bg   vsa-bridge.sh vsa-bridge      # (1) first (the target the containers attach to)
sleep 2
bash "$RUN_DIR/gpredict.sh"        # (2) container (detached, the script exits shortly)
bash "$RUN_DIR/gnuradio.sh"        # (3) container (detached)
bg   web.sh web                    # (4) web guide
sleep 2

cat <<EOF

----------------------------------------------
 Web guide : http://localhost:$WEB_PORT
 gpredict  : http://localhost:$GP_WEB_PORT   (control $GP_CTRL_PORT)
 gnuradio  : http://localhost:$GN_WEB_PORT
 Arduino   : In a Windows terminal (git-bash)  ->  bash run/arduino.sh
             (or  python arduino_bridge.py --ws $ARDUINO_WS --baud $ARDUINO_BAUD)
 Logs      : run/logs/*.log        Stop : bash run/stop-all.sh
----------------------------------------------
EOF
