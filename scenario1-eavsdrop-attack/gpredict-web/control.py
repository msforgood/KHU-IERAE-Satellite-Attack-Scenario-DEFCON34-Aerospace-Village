#!/usr/bin/env python3
"""
gpredict-web time-control server (in-container).

GET /reset-pass  → compute ENIGMA-1's next AOS over the QTH (pyephem), set the
                   libfaketime offset so gpredict jumps to LEAD seconds before that
                   AOS, and restart gpredict (the start.sh supervisor relaunches it
                   reading the new offset). Returns the AOS time.
GET /realtime    → reset the faketime offset to real time and restart gpredict.

The web-guide proxies these (see /api/reset-pass in web-guide/server.py); CORS is
also enabled so a browser can call it directly.
"""
import os
import json
import time
import calendar
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FT_FILE = os.environ.get("FAKETIME_FILE", "/tmp/faketime.rc")
QTH = os.environ.get("QTH_FILE", "/config/defcon.qth")
TLE = os.environ.get("TLE_FILE", "/config/enigma1.tle")
LEAD = int(os.environ.get("PASS_LEAD", "120"))          # seconds before AOS
PORT = int(os.environ.get("CTRL_PORT", "6079"))


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
    to just before this AOS puts ENIGMA-1 at the START of the pass — the moment just
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
                aos, max_alt = next_pass_aos()
                off = int((aos - LEAD) - time.time())    # LEAD 초 만큼 AOS 이전으로
                with open(FT_FILE, "w") as f:
                    f.write("%+ds" % off)
                restart_gpredict()
                return self._reply(200, {
                    "ok": True, "offsetSec": off, "leadSec": LEAD,
                    "maxAltDeg": round(max_alt, 1),
                    "aosUtc": time.strftime("%Y-%m-%d %H:%M:%SZ", time.gmtime(aos)),
                })
            except Exception as e:
                return self._reply(500, {"ok": False, "error": str(e)})
        if path == "/offset":
            return self._reply(200, {"ok": True, "offsetMs": read_offset_ms()})
        if path == "/realtime":
            try:
                with open(FT_FILE, "w") as f:
                    f.write("+0")
                restart_gpredict()
                return self._reply(200, {"ok": True})
            except Exception as e:
                return self._reply(500, {"ok": False, "error": str(e)})
        self._reply(404, {"ok": False, "error": "not found"})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print(f"[control] time-control server on :{PORT}  (QTH={QTH}, lead={LEAD}s)")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
