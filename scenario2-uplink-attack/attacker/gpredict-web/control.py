#!/usr/bin/env python3
"""gpredict-web time-control server (in-container · scenario-2 DEMOSAT).

Thin HTTP wrapper around passloop.py. On startup it finds one grazing pass of
DEMOSAT over the Las Vegas QTH and arms it (LEAD seconds before AOS); the arm
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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import passloop

FT_FILE  = os.environ.get("FAKETIME_FILE", "/tmp/faketime.rc")
QTH      = os.environ.get("QTH_FILE", "/config/defcon.qth")
TLE      = os.environ.get("TLE_FILE", "/config/demosat.tle")
LEAD     = int(os.environ.get("PASS_LEAD", "20"))            # wait before AOS (s)
INTERVAL = int(os.environ.get("RESET_INTERVAL", "300"))      # auto re-arm every (s)
MIN_ALT  = float(os.environ.get("MIN_PASS_ALT", "15"))       # grazing band floor
MAX_ALT  = float(os.environ.get("MAX_PASS_ALT", "45"))       # grazing band ceil
PORT     = int(os.environ.get("CTRL_PORT", "6079"))

# Find one nice grazing pass ONCE (fixed absolute AOS → replayed identically).
AOS, LOS, MAXALT = passloop.find_pass(QTH, TLE, MIN_ALT, MAX_ALT)
ARMER = passloop.PassArmer(FT_FILE, AOS, lead=LEAD, interval=INTERVAL)
ARMER.start()


def status():
    sec = ARMER.seconds_to_rearm()
    return {
        "armed": ARMER.enabled,
        "leadSec": LEAD,
        "intervalSec": INTERVAL,
        "secToRearm": round(sec, 1) if sec != float("inf") else None,
        "armCount": ARMER.arm_count,
        "maxAltDeg": round(MAXALT, 1),
        "passDurSec": int(LOS - AOS),
        "aosUtc": time.strftime("%Y-%m-%d %H:%M:%SZ", time.gmtime(AOS)),
        "offsetMs": passloop.read_offset_ms(FT_FILE),
    }


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
