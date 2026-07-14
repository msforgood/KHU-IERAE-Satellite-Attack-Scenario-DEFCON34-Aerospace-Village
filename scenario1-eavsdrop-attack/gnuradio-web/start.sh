#!/bin/sh
# In-container: run GNU Radio Companion with a RUNNABLE copy of the answer
# flowgraph open, streamed over noVNC. The user can hit ▶ Run to actually decode.
#
# The shipped .grc is authored for a 50 kSps capture, but the provided recording
# (enigma34_downlink.cf32) is 96 kSps (= the ENIGMA-1 SDR spec, 9600 baud x 10 sps),
# so we patch samp_rate 0.05e6 -> 0.096e6 in the opened copy. The File Source path
# and the image out_path are satisfied by bind-mounts (see run.sh), so Run writes the
# recovered PNG to the host ./gnuradio-out/ directory.
set -e
export HOME=/root DISPLAY=:99
SRC="${GRC_FILE:-/grc/enigma1_decoder.grc}"
RUN_GRC=/root/enigma1_decoder.grc
# Runnable copy: (1) samp_rate 0.05e6 -> $SAMP_RATE to match the mounted File Source
#     (run.sh passes 96000 for the built-in 96 kSps recording, or e.g. 50000 for a
#      PHASE-4-uploaded VSA capture), (2) enable the QT GUI Waterfall Sink (shipped
#     disabled) so ▶ Run shows a live spectrum window while it decodes.
SR="${SAMP_RATE:-96000}"
sed "s/value: 0.05e6/value: ${SR}/; s/state: disabled/state: enabled/" "$SRC" > "$RUN_GRC" 2>/dev/null || cp "$SRC" "$RUN_GRC"

# GRC's default xterm (x-terminal-emulator) is absent → warning on start / can
# break Run. Point it at the installed xterm.
mkdir -p /root/.gnuradio
printf '[grc]\nxterm_executable = /usr/bin/xterm\n' > /root/.gnuradio/config.conf

Xvfb :99 -screen 0 "${GEOM:-1600x1000x24}" >/dev/null 2>&1 &
sleep 1
openbox >/dev/null 2>&1 &
# GtkApplication wants a session bus — wrap in dbus-run-session.
dbus-run-session -- gnuradio-companion "$RUN_GRC" >/dev/null 2>&1 &
x11vnc -display :99 -forever -shared -nopw -rfbport "${VNC_PORT:-5900}" -quiet >/dev/null 2>&1 &
exec websockify --web=/usr/share/novnc "${WEB_PORT:-6081}" localhost:"${VNC_PORT:-5900}"
