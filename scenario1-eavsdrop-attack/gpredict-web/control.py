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
LEAD = int(os.environ.get("PASS_LEAD", "20"))           # seconds before AOS (Dockerfile ENV 우선)
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


def write_pass_offset():
    """다음 '좋은 패스'(max el ≥ MIN_ALT_DEG)의 AOS-LEAD 로 libfaketime 오프셋을 기록.
    gpredict 를 재시작하지 않는다 — start.sh 가 FAKETIME_TIMESTAMP_FILE + FAKETIME_NO_CACHE=1
    로 실행하므로 돌고 있는 gpredict 가 이 파일을 실시간 재읽기해 시계가 즉시 점프한다.
    반환: (aos_unix, offset_sec, max_alt_deg)."""
    aos, max_alt = next_pass_aos()
    off = int((aos - LEAD) - time.time())        # LEAD 초 만큼 AOS 이전으로
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
                aos, off, max_alt = write_pass_offset()   # 파일만 기록 — 재시작 없이 실시간 반영
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
            # gpredict 와 동일한 소스(next_pass_aos: MIN_ALT 필터 + faketime offset)로
            # AOS 까지 남은 시간을 계산 → 웹 카운트다운이 gpredict 화면과 정확히 일치.
            try:
                aos, max_alt = next_pass_aos()
                off = read_offset_ms() // 1000            # 현재 faketime 오프셋(초)
                sim_now = time.time() + off               # gpredict 의 현재 (가짜) 시각
                return self._reply(200, {
                    "ok": True,
                    "remainingSec": int(aos - sim_now),   # <0 이면 패스 진행 중
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
                return self._reply(200, {"ok": True})
            except Exception as e:
                return self._reply(500, {"ok": False, "error": str(e)})
        self._reply(404, {"ok": False, "error": "not found"})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    import sys
    if "--seed" in sys.argv:
        # 컨테이너 최초 기동 시 start.sh 가 호출 — gpredict 가 '다음 좋은 패스 LEAD초 전'에서
        # 시작하도록 faketime 오프셋을 미리 기록(HTTP 서버는 띄우지 않음).
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
