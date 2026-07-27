#!/usr/bin/env bash
# run-gpredict-web.sh — stream the REAL gpredict into the attacker web console.
#
# gpredict is a native GTK app, so we run it on a headless X display and expose
# that display over the web with noVNC. The console then iframes it — no
# reimplementation, the actual gpredict UI in the browser.
#
#   Xvfb :99 ── gpredict ── x11vnc :5900 ── websockify/noVNC :6080 ── <iframe>
#
# Linux. Requires: gpredict xvfb x11vnc novnc websockify  (see setup.sh).
# macOS: gpredict runs natively in its own window — either use macOS Screen
# Sharing → noVNC, or just place the gpredict window on the 3rd monitor.
set -e
D=${DISPLAY_NUM:-99}; GEOM=${GEOM:-1280x900x24}; VNC=${VNC_PORT:-5900}; WEB=${WEB_PORT:-6080}
export DISPLAY=:$D
NOVNC=${NOVNC_DIR:-/usr/share/novnc}

Xvfb :$D -screen 0 "$GEOM" >/dev/null 2>&1 &  P1=$!
sleep 1
gpredict >/dev/null 2>&1 &                    P2=$!
x11vnc -display :$D -forever -shared -nopw -rfbport "$VNC" -quiet >/dev/null 2>&1 &  P3=$!
websockify --web="$NOVNC" "$WEB" localhost:"$VNC" >/dev/null 2>&1 &  P4=$!
trap 'kill $P1 $P2 $P3 $P4 2>/dev/null' EXIT

URL="http://localhost:$WEB/vnc.html?autoconnect=1&resize=remote"
echo "gpredict (web)  →  $URL"
echo "open console    →  attacker/console/index.html?gp=$URL"
wait
