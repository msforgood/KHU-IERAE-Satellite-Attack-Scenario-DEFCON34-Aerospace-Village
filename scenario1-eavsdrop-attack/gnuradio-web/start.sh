#!/bin/sh
# In-container: run GNU Radio Companion with a RUNNABLE copy of the answer
# flowgraph open, streamed over noVNC. The user can hit Run to actually decode.
#
# The shipped .grc is authored for a 50 kSps capture, but the provided recording
# (enigma34_downlink.cf32) is 96 kSps (= the ENIGMA-1 SDR spec, 9600 baud x 10 sps),
# so we patch samp_rate 0.05e6 to 0.096e6 in the opened copy. The File Source path
# and the image out_path are satisfied by bind-mounts (see run.sh), so Run writes the
# recovered PNG to the host ./gnuradio-out/ directory.
set -e
export HOME=/root DISPLAY=:99
SRC="${GRC_FILE:-/grc/enigma1_decoder.grc}"
RUN_GRC=/root/enigma1_decoder.grc
# Runnable copy: (1) samp_rate 0.05e6 to $SAMP_RATE to match the mounted File Source
#     (run.sh passes 96000 for the built-in 96 kSps recording, or e.g. 50000 for a
#      PHASE-4-uploaded VSA capture), (2) enable the QT GUI Waterfall Sink (shipped
#     disabled) so Run shows a live spectrum window while it decodes.
SR="${SAMP_RATE:-96000}"
sed "s/value: 0.05e6/value: ${SR}/; s/state: disabled/state: enabled/" "$SRC" > "$RUN_GRC" 2>/dev/null || cp "$SRC" "$RUN_GRC"

# Container paths for the File Source (mounted recording) and solution (output) - same as the -v mount targets in run.sh.
SIG="/home/sunhyuk/projects/vsa4lv-defcon/vsa4lv-challenges/scenario-1/signal/ENIGMA-1_433_506MHz_2026-07-08T02-25-04.cf32"
SOL="/home/sunhyuk/projects/vsa4lv-defcon/vsa4lv-challenges/scenario-1/solution"
mkdir -p "$SOL"

# B2 slant drive value: measure the recording's center-frequency offset (normalized, amplitude-weighted mean instantaneous frequency).
# The reassembly block reads solution/offset.txt to decide the slant amount - it varies per input file (~0 when centered).
cat > /tmp/measure_offset.py <<'PYOFF'
import sys, numpy as np
raw = np.fromfile(sys.argv[1], dtype=np.float32, count=12000000)
n = (raw.size // 2) * 2
iq = raw[:n].view(np.complex64)
d = iq[1:] * np.conj(iq[:-1])
w = np.abs(iq[1:]) ** 2
print("%.6f" % float(np.sum(w * np.angle(d)) / (np.sum(w) + 1e-12) / (2 * np.pi)))
PYOFF

# GRC's default xterm (x-terminal-emulator) is absent -> warning on start / can
# break Run. Point it at the installed xterm.
mkdir -p /root/.gnuradio
printf '[grc]\nxterm_executable = /usr/bin/xterm\n' > /root/.gnuradio/config.conf

# Window placement is done directly with wmctrl below (GRC flow window = fullscreen / waterfall run window = moderate size).
# Openbox auto-maximize is not enabled.
mkdir -p /root/.config/openbox
cp -f /etc/xdg/openbox/rc.xml /root/.config/openbox/rc.xml 2>/dev/null || true

Xvfb :99 -screen 0 "${GEOM:-1600x1000x24}" >/dev/null 2>&1 &
sleep 1
openbox >/dev/null 2>&1 &

# 'gnu radio flow window' = GRC editor (flowgraph). Bring this up in fullscreen.
dbus-run-session -- gnuradio-companion "$RUN_GRC" >/dev/null 2>&1 &

# Window placement loop: GRC (flow) fullscreen / waterfall (run) window at a moderate size (not fullscreen).
# When the watchdog restarts the flow, a new waterfall window appears, so reapply periodically.
( set +e   # keep the placement loop from dying on a wmctrl failure (e.g. the window is briefly missing)
  while true; do
    sleep 2
    wmctrl -r "enigma1_decoder.grc" -b add,maximized_vert,maximized_horz 2>/dev/null   # GRC flow window = fullscreen
    wmctrl -r "ENIGMA-1 Decoder" -b remove,maximized_vert,maximized_horz 2>/dev/null    # waterfall = clear fullscreen
    wmctrl -r "ENIGMA-1 Decoder" -e 0,340,220,920,560 2>/dev/null                       # waterfall = moderate size (centered)
  done ) &

# Auto-run the flow so demodulation starts the moment PHASE 5 begins (no manual Run needed).
# Measure offset -> offset.txt, generate a .py with grcc then run it headless -> the QT GUI waterfall (maximized = fullscreen) appears and
# the reassembled image is written to solution/ in real time. With File Source repeat=True it keeps looping and re-demodulating
# -> the web then continuously updates and displays it. (Left in the background so it does not block noVNC startup.)
(
  set +e   # keep the supervisor from dying when an individual command in the subshell fails (watchdog conditionals, etc.)
  rm -f "$SOL/persist.raw"   # reset the persistent image on each new container start (= new file). A watchdog restart is internal, so it is preserved
  python3 /tmp/measure_offset.py "$SIG" > "$SOL/offset.txt" 2>/dev/null || echo 0 > "$SOL/offset.txt"
  grcc -o /root "$RUN_GRC" >/tmp/grcc.log 2>&1 || true
  # No center-frequency correction is applied (freq_offset stays 0). A misaligned input simply fails or partially recovers on demodulation,
  # so it is shown honestly, "if it does not build, it does not build." (offset.txt is used only for the reassembly slant (B2) visualization)
  # Stall-detection watchdog: if the progress file mtime does not change for ~12 seconds (DSP stalled but only the QT process survives), kill the flow
  # and restart it. When running well it does not interrupt; when stalled it self-heals quickly -> real-time demodulation never permanently stops.
  # (the timeout 150s is a hard backstop just in case)
  while true; do
    if [ -f /root/enigma1_decoder.py ]; then
      timeout -k 5 150 python3 /root/enigma1_decoder.py >/tmp/flow.log 2>&1 &
      FPID=$!
      LAST=""; STALL=0
      while kill -0 "$FPID" 2>/dev/null; do
        sleep 4
        MT=$(stat -c %Y "$SOL"/*_progress.txt 2>/dev/null | sort -n | tail -1)
        if [ -n "$MT" ] && [ "$MT" = "$LAST" ]; then STALL=$((STALL+1)); else STALL=0; fi
        LAST="$MT"
        if [ "$STALL" -ge 15 ]; then pkill -9 -f enigma1_decoder.py 2>/dev/null; break; fi   # restart only on a ~60s stall (minimize window flicker; the image is preserved via persist)
      done
    fi
    sleep 2
  done
) &
x11vnc -display :99 -forever -shared -nopw -rfbport "${VNC_PORT:-5900}" -quiet >/dev/null 2>&1 &
exec websockify --web=/usr/share/novnc "${WEB_PORT:-6081}" localhost:"${VNC_PORT:-5900}"
