#!/usr/bin/env python3
"""
gpredict-web time-control server (in-container).

GET /reset-pass  -> compute ENIGMA-1's next AOS over the QTH (pyephem), set the
                   libfaketime offset so gpredict jumps to LEAD seconds before that
                   AOS, and restart gpredict (the start.sh supervisor relaunches it
                   reading the new offset). Returns the AOS time.
GET /realtime    -> reset the faketime offset to real time and restart gpredict.

The web-guide proxies these (see /api/reset-pass in web-guide/server.py); CORS is
also enabled so a browser can call it directly.
"""
import os
import json
import time
import calendar
import subprocess
import urllib.request
from urllib.parse import urlparse, parse_qs
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FT_FILE = os.environ.get("FAKETIME_FILE", "/tmp/faketime.rc")
QTH = os.environ.get("QTH_FILE", "/config/defcon.qth")
TLE = os.environ.get("TLE_FILE", "/config/enigma1.tle")
LEAD = int(os.environ.get("PASS_LEAD", "20"))           # seconds before AOS (Dockerfile ENV takes priority)
PORT = int(os.environ.get("CTRL_PORT", "6079"))


# ── Gpredict GUI automation (xdotool over the container's X display) ───────────
# start.sh pins the control windows at fixed geometry, so these screen-absolute
# hit coordinates are stable. They were calibrated against the live UI (clicking
# a downlink up-arrow moved exactly that digit by +1).
DISPLAY     = os.environ.get("DISPLAY", ":99")
ROTOR_TITLE = "Gpredict Rotator Control"
RADIO_TITLE = "Gpredict Radio Control"
ROTOR_TRACK  = (817, 1147)     # Antenna control: Track button (y +340: control windows moved down in start.sh)
ROTOR_TRACK_PROBE = (810, 1147) # a spot on the rotor Track button: ~210 pressed (tracking on), ~248 off
ROTOR_ENGAGE = (1224, 1147)    # Antenna control: Engage button
RADIO_TRACK  = (304, 1544)     # Radio control: Track (Doppler) button
RADIO_ENGAGE = (697, 1544)     # Radio control: Engage button
DL_UP_Y, DL_DOWN_Y = 1347, 1408                 # downlink knob up/down arrow rows (y +340)
DL_DIGIT_X = {                                   # place value -> arrow column x
    100000000: 75, 10000000: 112, 1000000: 148,
    100000: 190, 10000: 227, 1000: 263,
    100: 305, 10: 342, 1: 378,
}
DL_STATE   = "/tmp/downlink_hz"
DL_BASE_HZ = 433500000          # transponder DOWN_LOW gpredict loads on startup


def _xdo(*args):
    subprocess.run(["xdotool", *args],
                   env={**os.environ, "DISPLAY": DISPLAY}, check=False)


def _activate(title):
    _xdo("mouseup", "1")   # release any button left held by an interrupted action - a stuck
                           # button silently swallows every following click (knob/Engage won't move)
    r = subprocess.run(["xdotool", "search", "--name", title],
                       env={**os.environ, "DISPLAY": DISPLAY},
                       capture_output=True, text=True)
    wid = (r.stdout.split() or [""])[0]
    if wid:
        _xdo("windowactivate", wid)
        time.sleep(0.25)
    return wid


def _click(x, y, n=1):
    for _ in range(max(0, int(n))):
        _xdo("mousemove", str(x), str(y), "click", "1")   # one invocation is more reliable under load
        _xdo("mouseup", "1")                              # guarantee release: a click that races under load
        time.sleep(0.2)                                   # can leave button 1 held, which then swallows every
                                                          # following click (knob/Engage/Track stop responding)


def _park():
    _xdo("mousemove", "12", "12")


BRIDGE_HOST       = os.environ.get("ROTCTLD_HOST", "host.docker.internal")
BRIDGE_STATUS_URL = "http://%s:4535/status" % BRIDGE_HOST


def _is_engaged(port):
    """True if gpredict currently holds an ESTABLISHED TCP connection to the host
    bridge on `port` (rotctld 4533 / rigctld 4532), across IPv4 and IPv6. This is
    the real applied state (same signal the VSA shows as connected)."""
    hexport = "%04X" % port
    for path in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(path) as f:
                next(f, None)
                for line in f:
                    col = line.split()
                    if len(col) > 3 and col[2].split(":")[-1].upper() == hexport and col[3] == "01":
                        return True
        except Exception:
            pass
    return False


def _bridge_status():
    """Fetch the bridge's real applied state (engaged + tracking). Empty dict if the
    bridge is down (which itself means nothing is applied)."""
    try:
        with urllib.request.urlopen(BRIDGE_STATUS_URL, timeout=2) as r:
            return json.loads(r.read().decode())
    except Exception:
        return {}


def _ensure_engaged(title, engage_xy, port, tries=4):
    """Click Engage until gpredict actually holds a connection on `port`. Handles a
    stale UI (shows engaged but the socket is dead): the first click clears the stale
    state, the next one really connects. Returns the final engaged bool."""
    _activate(title)
    for _ in range(tries):
        if _is_engaged(port):
            return True
        _click(*engage_xy)
        time.sleep(0.7)   # allow the TCP connect to establish
    return _is_engaged(port)


def _ensure_track(title, track_xy, status_key):
    """Turn a Track toggle ON only if the bridge reports it is not already tracking,
    so re-pressing does not toggle it back off."""
    if not _bridge_status().get(status_key):
        _activate(title)
        _click(*track_xy)


def _rotor_track_on():
    """Read whether the rotor Track toggle is pressed (tracking ON) from its background shade - an
    active GtkToggleButton is drawn darker. This is the actual toggle state, independent of whether
    the satellite is currently moving (a parked pre-AOS pass would fool a movement-based check)."""
    subprocess.run(["scrot", "-o", "/tmp/_rt.png"],
                   env={**os.environ, "DISPLAY": DISPLAY}, check=False)
    try:
        from PIL import Image
        return Image.open("/tmp/_rt.png").convert("L").getpixel(ROTOR_TRACK_PROBE) < 225
    except Exception:
        return False


def _ensure_rotor_tracking():
    """Engage the rotor and make sure the Track toggle is actually ON (pixel-checked), so ONE press
    reliably starts tracking. Fixes the 'one press leaves it fixed at the initial position' bug where
    the Track toggle stayed off (the old check saw the engage's single position as 'tracking')."""
    _ensure_engaged(ROTOR_TITLE, ROTOR_ENGAGE, 4533)
    for _ in range(3):
        if _rotor_track_on():
            return True
        _activate(ROTOR_TITLE); _click(*ROTOR_TRACK); time.sleep(0.6)
    return _rotor_track_on()


def _wait_disengaged(port, tries=10):
    """After clicking Engage to disconnect, wait for the connection to actually drop."""
    for _ in range(tries):
        if not _is_engaged(port):
            return False
        time.sleep(0.25)
    return _is_engaged(port)


def dl_read():
    try:
        return int(open(DL_STATE).read().strip())
    except Exception:
        return DL_BASE_HZ


RADIO_TRACK_PROBE = (268, 1194)   # a corner of the radio Track button: ~210 pressed (Doppler on), ~240 off


def _radio_track_on():
    """Reliably read whether the radio Track (Doppler) toggle is pressed, by the button's
    background shade (an active GtkToggleButton is drawn darker)."""
    subprocess.run(["scrot", "-o", "/tmp/_tk.png"],
                   env={**os.environ, "DISPLAY": DISPLAY}, check=False)
    try:
        from PIL import Image
        return Image.open("/tmp/_tk.png").convert("L").getpixel(RADIO_TRACK_PROBE) < 225
    except Exception:
        return False


def _freq_drifting():
    """Doppler tracking adds a time-varying offset, so gpredict keeps sending a moving downlink
    freq to the rig. Sample the reported freq a few times over ~2.7s: any spread means Doppler is
    on (needs the radio engaged). Three samples catch drift a single interval could miss."""
    reads = []
    for i in range(3):
        reads.append(int(_bridge_status().get("freqHz") or 0))
        if i < 2:
            time.sleep(0.9)
    reads = [r for r in reads if r]
    return len(reads) >= 2 and (max(reads) - min(reads)) > 5


def _ensure_doppler_off(tries=4):
    """Turn Doppler tracking off so the downlink display stops drifting and digit clicks land on
    a static value. The button's pixel shade proved unreliable, so Doppler is detected by the
    reported freq actually drifting, and Track is clicked until it stops."""
    for _ in range(tries):
        if not _freq_drifting():
            return True
        _activate(RADIO_TITLE); _click(*RADIO_TRACK); time.sleep(0.6)
    return True


def _set_digits(cur, hz):
    """Click each place's up/down arrow by that place's own digit difference (each digit
    stays within 0..9, so no carry fires)."""
    _activate(RADIO_TITLE)
    for place, x in DL_DIGIT_X.items():
        d = ((hz // place) % 10) - ((cur // place) % 10)
        if d > 0:
            _click(x, DL_UP_Y, d)
        elif d < 0:
            _click(x, DL_DOWN_Y, -d)
    _park()


def _disengage_radio(tries=6):
    """Click Engage until the rig connection actually drops. gpredict LOCKS the downlink
    knob while engaged, so it must be disengaged before the digit arrows will move."""
    _activate(RADIO_TITLE)
    for _ in range(tries):
        if not _is_engaged(4532):
            return True
        _click(*RADIO_ENGAGE)
        time.sleep(0.5)
    return not _is_engaged(4532)


def dl_set(hz):
    """Set the downlink knob to an absolute value. The knob is LOCKED while the rig is
    engaged, so the true current value is read from gpredict itself (bridge freqHz while
    engaged), then the radio is disengaged to unlock the knob, the digits are clicked, and
    the radio re-engaged to re-read and verify. Loops so a dropped click / stale display
    self-corrects against gpredict's actually reported frequency."""
    hz = int(hz)
    _ensure_engaged(RADIO_TITLE, RADIO_ENGAGE, 4532)       # engaged -> gpredict reports the live downlink
    _ensure_doppler_off()                                  # stop Doppler drift once (it stays off) so reads+clicks are stable
    for _ in range(3):
        time.sleep(1.0)                                    # let gpredict report the current freq
        cur = int(_bridge_status().get("freqHz") or 0) or dl_read()
        if abs(cur - hz) <= 100:
            break
        _disengage_radio()                                 # unlock the knob (display holds cur, now static)
        _set_digits(cur, hz)                               # click from the true current value
        _ensure_engaged(RADIO_TITLE, RADIO_ENGAGE, 4532)   # re-engage to read back / verify
    with open(DL_STATE, "w") as f:
        f.write(str(hz))
    return hz


def parse_qth():
    lat = lon = alt = 0.0
    with open(QTH) as f:
        for line in f:
            if line.startswith("LAT="):
                lat = float(line.split("=", 1)[1])
            elif line.startswith("LON="):
                lon = float(line.split("=", 1)[1])
            elif line.startswith("ALT="):
                alt = float(line.split("=", 1)[1])
    return lat, lon, alt


MIN_ALT_DEG = float(os.environ.get("MIN_PASS_ALT", "25"))  # skip low grazing passes


def next_pass_aos():
    """Find the next pass whose max elevation >= MIN_ALT_DEG (skip low grazing passes)
    and return its AOS (rise) time (unix) and the pass's max-elevation (deg). Resetting
    to just before this AOS puts ENIGMA-1 at the START of the pass - the moment just
    before the ground station begins receiving the signal (not the mid-pass culmination)."""
    import ephem
    import math
    lat, lon, alt = parse_qth()
    lines = [l.rstrip("\n") for l in open(TLE) if l.strip()]
    obs = ephem.Observer()
    obs.lat = str(lat)
    obs.lon = str(lon)
    obs.elevation = alt
    obs.date = ephem.now()
    sat = ephem.readtle(lines[0], lines[1], lines[2])
    best = None
    for _ in range(20):
        info = obs.next_pass(sat)           # (rise, rise_az, max_t, max_alt, set, set_az)
        rise_t, max_alt = info[0], info[3]
        if rise_t is None:
            break
        alt_deg = float(max_alt) * 180.0 / math.pi
        rise_unix = calendar.timegm(rise_t.datetime().timetuple())
        if best is None:
            best = (rise_unix, alt_deg)
        if alt_deg >= MIN_ALT_DEG:
            return rise_unix, alt_deg
        set_t = info[4]
        if set_t is None:
            break
        obs.date = ephem.Date(set_t + ephem.minute)   # advance past this pass
    return best if best else (int(time.time()), 0.0)


def restart_gpredict():
    os.system("pkill -TERM gpredict")       # start.sh supervisor relaunches it


def read_offset_ms():
    """Current libfaketime offset (ms). The VSA polls this to compute the
    satellite position at gpredict's (faked) time so the two stay aligned."""
    try:
        s = open(FT_FILE).read().strip().rstrip("s")
        return int(float(s)) * 1000
    except Exception:
        return 0


def write_pass_offset():
    """Write the libfaketime offset as the AOS-LEAD of the next 'good pass' (max el >= MIN_ALT_DEG).
    This does not restart gpredict: because start.sh runs it with FAKETIME_TIMESTAMP_FILE + FAKETIME_NO_CACHE=1,
    the running gpredict re-reads this file in real time and its clock jumps immediately.
    Returns: (aos_unix, offset_sec, max_alt_deg)."""
    aos, max_alt = next_pass_aos()
    off = int((aos - LEAD) - time.time())        # move LEAD seconds before AOS
    with open(FT_FILE, "w") as f:
        f.write("%+ds" % off)
    return aos, off, max_alt


class Handler(BaseHTTPRequestHandler):
    def _reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/reset-pass":
            try:
                aos, off, max_alt = write_pass_offset()   # write the file only - applied in real time without a restart
                return self._reply(200, {
                    "ok": True, "offsetSec": off, "leadSec": LEAD,
                    "maxAltDeg": round(max_alt, 1),
                    "aosUnix": int(aos),
                    "aosUtc": time.strftime("%Y-%m-%d %H:%M:%SZ", time.gmtime(aos)),
                })
            except Exception as e:
                return self._reply(500, {"ok": False, "error": str(e)})
        if path == "/offset":
            return self._reply(200, {"ok": True, "offsetMs": read_offset_ms()})
        if path == "/remaining":
            # Compute the time remaining until AOS using the same source as gpredict
            # (next_pass_aos: MIN_ALT filter + faketime offset), so the web countdown matches the gpredict screen exactly.
            try:
                aos, max_alt = next_pass_aos()
                off = read_offset_ms() // 1000            # current faketime offset (seconds)
                sim_now = time.time() + off               # gpredict's current (faked) time
                return self._reply(200, {
                    "ok": True,
                    "remainingSec": int(aos - sim_now),   # <0 means the pass is in progress
                    "aosUnix": int(aos),
                    "simNowUnix": int(sim_now),
                    "leadSec": LEAD,
                    "maxAltDeg": round(max_alt, 1),
                    "aosUtc": time.strftime("%Y-%m-%d %H:%M:%SZ", time.gmtime(aos)),
                })
            except Exception as e:
                return self._reply(500, {"ok": False, "error": str(e)})
        if path == "/realtime":
            try:
                with open(FT_FILE, "w") as f:
                    f.write("+0")
                restart_gpredict()
                # gpredict reloads the transponder on relaunch, so the downlink knob
                # returns to its base value -> resync our tracked state to match.
                with open(DL_STATE, "w") as f:
                    f.write(str(DL_BASE_HZ))
                return self._reply(200, {"ok": True})
            except Exception as e:
                return self._reply(500, {"ok": False, "error": str(e)})
        if path == "/rotor-track-engage":     # TOGGLE: press engages + tracks, press again disengages
            try:
                if _is_engaged(4533):                       # currently ON -> turn OFF
                    _activate(ROTOR_TITLE); _click(*ROTOR_ENGAGE); _park()
                    return self._reply(200, {"ok": True, "engaged": _wait_disengaged(4533), "tracking": False})
                _ensure_rotor_tracking()   # OFF -> engage AND verify the antenna is actually moving (tracking)
                _park()
                return self._reply(200, {"ok": True, "engaged": _is_engaged(4533),
                                         "tracking": bool(_bridge_status().get("rotorTracking"))})
            except Exception as e:
                return self._reply(500, {"ok": False, "error": str(e)})
        if path == "/radio-apply":            # ALWAYS set the entered downlink freq + engage (not a toggle)
            try:
                q = parse_qs(urlparse(self.path).query)
                hz = int(float(q.get("hz", ["0"])[0]))
                if 1000000 <= hz <= 999999999:
                    dl_set(hz)
                _ensure_engaged(RADIO_TITLE, RADIO_ENGAGE, 4532)
                _park()
                return self._reply(200, {"ok": True, "engaged": _is_engaged(4532), "hz": dl_read()})
            except Exception as e:
                return self._reply(500, {"ok": False, "error": str(e)})
        if path == "/radio-engage":           # TOGGLE: connect / disconnect the radio device
            try:
                if _is_engaged(4532):
                    _activate(RADIO_TITLE); _click(*RADIO_ENGAGE); _park()
                    return self._reply(200, {"ok": True, "engaged": _wait_disengaged(4532)})
                _ensure_engaged(RADIO_TITLE, RADIO_ENGAGE, 4532); _park()
                return self._reply(200, {"ok": True, "engaged": _is_engaged(4532)})
            except Exception as e:
                return self._reply(500, {"ok": False, "error": str(e)})
        if path == "/radio-track":            # TOGGLE: Doppler on/off, state read from the Track button pixel
            try:
                if _radio_track_on():                       # currently ON -> turn OFF
                    _activate(RADIO_TITLE); _click(*RADIO_TRACK); _park()
                    return self._reply(200, {"ok": True, "tracking": False})
                _ensure_engaged(RADIO_TITLE, RADIO_ENGAGE, 4532)   # OFF -> Doppler needs engage, then track
                _activate(RADIO_TITLE); _click(*RADIO_TRACK); _park()
                return self._reply(200, {"ok": True, "tracking": True})
            except Exception as e:
                return self._reply(500, {"ok": False, "error": str(e)})
        if path == "/gpredict-status":        # real applied state (bridge truth) for the web-guide buttons
            st = _bridge_status()
            return self._reply(200, {
                "ok": True,
                "bridgeUp":      bool(st),
                "rotorEngaged":  bool(st.get("rotorEngaged")),
                "radioEngaged":  bool(st.get("radioEngaged")),
                "rotorTracking": bool(st.get("rotorTracking")),
                "radioTracking": _radio_track_on(),   # reliable pixel read of the Track toggle
                "downlinkHz":    dl_read(),
            })
        if path == "/radio-set-downlink":     # Radio control: set downlink freq (hz query)
            try:
                q = parse_qs(urlparse(self.path).query)
                hz = int(float(q.get("hz", ["0"])[0]))
                if hz < 1000000 or hz > 999999999:
                    return self._reply(400, {"ok": False, "error": "hz out of range (1e6..999999999)"})
                dl_set(hz)
                return self._reply(200, {"ok": True, "hz": hz})
            except Exception as e:
                return self._reply(500, {"ok": False, "error": str(e)})
        self._reply(404, {"ok": False, "error": "not found"})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    import sys
    if "--seed" in sys.argv:
        # Called by start.sh on the container's first boot - pre-writes the faketime offset so
        # gpredict starts at 'LEAD seconds before the next good pass' (does not launch the HTTP server).
        try:
            aos, off, alt = write_pass_offset()
            print("[control] seeded %+ds (AOS %s, maxAlt %.1f deg)" % (
                off, time.strftime("%H:%M:%SZ", time.gmtime(aos)), alt))
        except Exception as e:
            print("[control] seed failed: %s" % e)
            raise SystemExit(1)
        raise SystemExit(0)
    print(f"[control] time-control server on :{PORT}  (QTH={QTH}, lead={LEAD}s)")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
