#!/usr/bin/env python3
"""gpredict-web time-control server (in-container · scenario-2 ENIGMA-1).

Thin HTTP wrapper around passloop.py. On startup it finds one grazing pass of
ENIGMA-1 over the Las Vegas QTH and arms it (LEAD seconds before AOS); the arm
then re-fires every RESET_INTERVAL seconds. The attacker console hits /arm when
the participant reaches phase 3 so the ~LEAD-second wait starts from THAT moment.

Endpoints (CORS open so the console at :8000 can call directly):
  GET /arm      → (re)arm: jump to LEAD s before the pass AOS, reset the timer.
  GET /realtime → drop faketime to real time and pause auto re-arm.
  GET /status   → { armed, leadSec, intervalSec, secToRearm, maxAltDeg, aosUtc, offsetMs }
  GET /offset   → { offsetMs }   (VSA/clock alignment)
"""
import os
import json
import time
import subprocess
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import passloop

FT_FILE   = os.environ.get("FAKETIME_FILE", "/tmp/faketime.rc")
QTH       = os.environ.get("QTH_FILE", "/config/defcon.qth")
TLE       = os.environ.get("TLE_FILE", "/config/enigma1.tle")
LEAD      = int(os.environ.get("PASS_LEAD", "20"))           # wait before AOS (s)
INTERVAL  = int(os.environ.get("RESET_INTERVAL", "300"))     # auto re-arm every (s)
MIN_ALT   = float(os.environ.get("MIN_PASS_ALT", "15"))      # grazing band floor
MAX_ALT   = float(os.environ.get("MAX_PASS_ALT", "45"))      # grazing band ceil
IN_RANGE  = float(os.environ.get("IN_RANGE_ELEV", "0"))      # "in range" elevation (deg)
AUTOPILOT = os.environ.get("AUTOPILOT", "/autopilot.sh")     # xdotool gpredict driver
PORT      = int(os.environ.get("CTRL_PORT", "6079"))

# Find one nice grazing pass ONCE (fixed absolute AOS → replayed identically).
AOS, LOS, MAXALT = passloop.find_pass(QTH, TLE, MIN_ALT, MAX_ALT)
ARMER = passloop.PassArmer(FT_FILE, AOS, lead=LEAD, interval=INTERVAL)
ARMER.start()


def status():
    sec = ARMER.seconds_to_rearm()
    offset_ms = passloop.read_offset_ms(FT_FILE)
    faked_now = time.time() + offset_ms / 1000.0
    try:
        el, az, rng = passloop.look_angles(QTH, TLE, faked_now)
    except Exception:
        el = az = rng = None
    return {
        "armed": ARMER.enabled,
        "leadSec": LEAD,
        "intervalSec": INTERVAL,
        "secToRearm": round(sec, 1) if sec != float("inf") else None,
        "armCount": ARMER.arm_count,
        "maxAltDeg": round(MAXALT, 1),
        "passDurSec": int(LOS - AOS),
        "aosUtc": time.strftime("%Y-%m-%d %H:%M:%SZ", time.gmtime(AOS)),
        "offsetMs": offset_ms,
        # live look-angles at gpredict's faked time (for the wait/approach guide)
        "elevDeg": round(el, 6) if el is not None else None,
        "azimDeg": round(az, 6) if az is not None else None,
        "rangeKm": round(rng) if rng is not None else None,
        "secToAos": round(AOS - faked_now, 1),
        "inRange": bool(el is not None and el >= IN_RANGE),
    }


def run_autopilot(action):
    """Drive the real gpredict UI via xdotool (autopilot.sh). Returns (ok, detail)."""
    try:
        env = dict(os.environ, DISPLAY=os.environ.get("DISPLAY", ":99"))
        p = subprocess.run([AUTOPILOT, action], env=env, capture_output=True,
                           text=True, timeout=30)
        return p.returncode == 0, (p.stdout + p.stderr).strip()[-400:]
    except Exception as e:
        return False, str(e)


BRIDGE_HOST        = os.environ.get("ROTCTLD_HOST", "host.docker.internal")
BRIDGE_STATUS_PORT = os.environ.get("BRIDGE_STATUS_PORT", "4545")   # scenario-4 dedicated bridge
BRIDGE_STATUS_URL  = "http://%s:%s/status" % (BRIDGE_HOST, BRIDGE_STATUS_PORT)


def bridge_status():
    """The rotctld bridge's real applied state (rotorEngaged/rotorTracking/...).
    Empty dict if the bridge is down."""
    try:
        with urllib.request.urlopen(BRIDGE_STATUS_URL, timeout=2) as r:
            return json.loads(r.read().decode())
    except Exception:
        return {}


def _tracking_now():
    """True iff the antenna (rotctld bridge) is actively pointing at the sat.

    The bridge's rotorTracking flag FLICKERS and a stale az/el can look 'off park',
    so neither is reliable. The trustworthy signal is a POSITION MATCH: when Track
    is on and the sat is up, gpredict streams the sat's az/el to the rotor, so the
    bridge az/el track the sat's az/el within a few degrees."""
    st = status()
    bs = bridge_status()
    sa, se = st.get("azimDeg"), st.get("elevDeg")
    ba, be = bs.get("az"), bs.get("el")
    if None in (sa, se, ba, be):
        return False
    daz = abs(((sa - ba + 180) % 360) - 180)
    dele = abs(se - be)
    return daz < 12 and dele < 6


def _settle_tracking(polls=5, gap=2.0):
    """Poll for a position match for up to polls*gap seconds; True once matched."""
    for _ in range(polls):
        time.sleep(gap)
        if _tracking_now():
            return True
    return False


def ensure_rotor_tracking():
    """Ensure the rotctld link is up AND the antenna is following the pass.

    Engage first: check the reliable rotorEngaged flag and click Engage only while
    it is still off, so a live connection is never toggled back down.

    Track uses SINGLE-CLICK discipline. The click coordinates are calibrated to the
    real Track button (window origin + fixed offset), so ONE click reliably flips
    Track on. Clicking repeatedly is what used to break tracking: each extra click is
    a toggle, so an even count lands back on 'off' and the antenna freezes. So we:
      1. If already tracking (bridge az/el matches the sat) -> done, no click.
      2. Else click Track ONCE and poll the position match for a few seconds.
      3. Only if that still fails (e.g. Track was already on and the click turned it
         off) click ONE more time and poll again.
    Track can only be verified while the sat is above the horizon; satUp is returned
    so the caller can ask the user to retry once the pass begins.
    Returns (rotorEngaged, tracking, satUp)."""
    run_autopilot("rotor-open")
    for _ in range(4):
        if bridge_status().get("rotorEngaged"):
            break
        run_autopilot("rotor-engage")
        time.sleep(1.2)                       # let the rotctld TCP connect + register

    sat_el = status().get("elevDeg")
    sat_up = sat_el is not None and sat_el > 3
    tracking = False
    if sat_up:
        if _tracking_now():
            tracking = True
        else:
            run_autopilot("rotor-track")      # single toggle: Track on
            tracking = _settle_tracking()
            if not tracking:                  # fallback: undo an accidental toggle-off
                run_autopilot("rotor-track")
                tracking = _settle_tracking()
    return bool(bridge_status().get("rotorEngaged")), tracking, sat_up


def _radio_changing(gap=2.0):
    """True iff the rig frequency is moving right now (Doppler tracking active).

    Engaging the radio alone sends the base frequency ONCE, which briefly sets the
    bridge's radioTracking flag even with Track off, so that flag can't tell Doppler
    tracking from a single set. A frequency that KEEPS changing over a couple of
    seconds is the trustworthy signal: only with Track on does gpredict re-send the
    Doppler-shifted frequency every cycle."""
    f1 = bridge_status().get("freqHz")
    time.sleep(gap)
    f2 = bridge_status().get("freqHz")
    return f1 is not None and f2 is not None and f1 != f2


def ensure_radio_tracking():
    """Engage the radio (rigctld link) and turn Doppler tracking on.

    Mirrors the rotor discipline: check radioEngaged first and click Engage only
    while it is still off; then confirm Track by a MOVING frequency (Doppler) rather
    than the flicker-prone radioTracking flag, clicking Track at most once (plus one
    fallback) so the single-click toggle converges to on. Doppler is present at any
    elevation, so unlike the rotor this does not need the sat above the horizon.
    Returns (radioEngaged, tracking)."""
    run_autopilot("radio-open")
    for _ in range(4):
        if bridge_status().get("radioEngaged"):
            break
        run_autopilot("radio-engage")
        time.sleep(1.2)

    tracking = False
    if bridge_status().get("radioEngaged"):
        if _radio_changing():
            tracking = True
        else:
            run_autopilot("radio-track")      # single toggle: Doppler track on
            tracking = _radio_changing() or _radio_changing()
            if not tracking:                  # fallback: undo an accidental toggle-off
                run_autopilot("radio-track")
                tracking = _radio_changing() or _radio_changing()
    return bool(bridge_status().get("radioEngaged")), tracking


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
        if path == "/arm":
            ARMER.enabled = True
            ARMER.arm()
            return self._reply(200, {"ok": True, **status()})
        if path == "/realtime":
            ARMER.enabled = False
            ARMER._next = float("inf")           # pause auto re-arm
            passloop.write_offset(FT_FILE, 0)
            return self._reply(200, {"ok": True, **status()})
        if path == "/engage":
            # bring up BOTH links: antenna (az/el tracking) and radio (Doppler).
            try:
                eng, trk, sat_up = ensure_rotor_tracking()
                rd_eng, rd_trk = ensure_radio_tracking()
                return self._reply(200, {"ok": bool(trk), "rotorEngaged": eng,
                                         "rotorTracking": trk, "satUp": bool(sat_up),
                                         "radioEngaged": rd_eng, "radioTracking": rd_trk,
                                         **status()})
            except Exception as e:
                return self._reply(500, {"ok": False, "error": str(e), **status()})
        if path == "/status":
            return self._reply(200, {"ok": True, **status()})
        if path == "/offset":
            return self._reply(200, {"ok": True, "offsetMs": passloop.read_offset_ms(FT_FILE)})
        return self._reply(404, {"ok": False, "error": "not found"})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print(f"[control] :{PORT}  pass AOS={status()['aosUtc']} maxAlt={MAXALT:.1f}° "
          f"lead={LEAD}s reset={INTERVAL}s")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
