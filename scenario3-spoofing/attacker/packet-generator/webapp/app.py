#!/usr/bin/env python3
"""
DEMOSAT Command Builder — local web UI (stdlib http.server, no pip deps)

A booth "puzzle": to generate the uplink IQ file the visitor must assemble every
element of a valid uplink, matching the target satellite's dossier:
  STEP 1  Compose command    — a Scratch-style block: click a subsystem block, then
                               TYPE the real command name + payload value into it
  STEP 2  RF config          — modulation / baud / sample rate (satellite RX)
Only when both are correct does GENERATE unlock and write attack.cf32.

Run:   python3 app.py               # → http://localhost:8000
Env:   UPLINK_OUT_DIR   output folder for generated .cf32 (default ~/uplink)
       PORT             default 8000

Backend logic is the canonical codec (attacker/openvsa/satellites/demosat/ccsds_ook.py);
the browser only renders. Single source of truth, no JS DSP.
"""
import os
import sys
import json
import time
import base64
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
_PLUGIN = os.path.abspath(os.path.join(HERE, "..", "..", "openvsa", "satellites", "demosat"))
sys.path.insert(0, _PLUGIN)
import ccsds_ook as codec  # noqa: E402

STATIC_DIR = os.path.join(HERE, "static")
TEMPLATE = os.path.join(HERE, "templates", "index.html")
OUT_DIR = os.environ.get("UPLINK_OUT_DIR", os.path.expanduser("~/uplink"))
# ③ 위성 조준(phase 3)을 이 앱 안에서 서빙 — 별도 :8090 프록시 없이 단일 포트로 통합.
#   /targeting → 콘솔 페이지, /vsa/… → OpenVSA 정적 렌더러(gpredict는 :6080 직접 iframe).
OPENVSA_DIR = os.path.abspath(os.path.join(HERE, "..", "..", "openvsa"))
CONSOLE_DIR = os.path.abspath(os.path.join(HERE, "..", "..", "console"))
# ④ 드론 스푸핑(phase 4, scenario 3) — 이 앱이 /drone 으로 서빙.
DRONE_DIR = os.path.abspath(os.path.join(HERE, "..", "..", "drone"))
_VSA_MIME = {
    ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".mjs": "application/javascript",
    ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon",
    ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".wasm": "application/wasm",
    ".map": "application/json", ".txt": "text/plain; charset=utf-8",
}
PORT = int(os.environ.get("PORT", "8000"))
# 피해 지상국(:4540). generate 시 cf32를 방문자마다 굽지 않고 여기 /api/inject로 공격 경보만 발사.
GS_URL = os.environ.get("GS_URL", "http://localhost:4540").rstrip("/")

# ── Dev live-reload (opt-in: DEV_RELOAD=1 or --reload) ───────────────────────
# Zero-dep: a watcher thread restarts the process on backend edits and bumps a
# stamp on frontend edits; an injected poller reloads the browser. Off for booth.
RELOAD = os.environ.get("DEV_RELOAD", "").lower() in ("1", "true", "yes") or "--reload" in sys.argv
_PY_FILES = [os.path.abspath(__file__), os.path.join(_PLUGIN, "ccsds_ook.py")]
_PY_BASE = {f: os.path.getmtime(f) for f in _PY_FILES if os.path.exists(f)}
_RELOAD_STAMP = 0.0

LIVERELOAD_JS = """<script>
(function(){let last=null;async function poll(){try{
  const r=await fetch('/api/livereload',{cache:'no-store'});const j=await r.json();
  if(last===null)last=j.stamp;else if(j.stamp!==last){location.reload();return;}
}catch(e){}setTimeout(poll,800);}poll();})();
</script>"""


def _asset_stamp():
    m = 0.0
    files = [TEMPLATE] + _PY_FILES
    for root, _dirs, fs in os.walk(STATIC_DIR):
        files += [os.path.join(root, f) for f in fs]
    for f in files:
        try:
            m = max(m, os.path.getmtime(f))
        except OSError:
            pass
    return m


def _watcher():
    global _RELOAD_STAMP
    _RELOAD_STAMP = _asset_stamp()
    while True:
        time.sleep(0.5)
        try:
            for f, base in _PY_BASE.items():
                if os.path.getmtime(f) > base:
                    print(f"[reload] {os.path.basename(f)} changed — restarting server", flush=True)
                    sys.stdout.flush()
                    os.execv(sys.executable, [sys.executable] + sys.argv)
            _RELOAD_STAMP = _asset_stamp()
        except OSError:
            pass

# ── Target satellite dossier — the "answers" the visitor must match ──────────
TARGET = {
    "satellite": "DEMOSAT",
    "scid": 200,               # Spacecraft ID — fixed frame addressing (no longer a puzzle step)
    "modulation": "OOK",
    "baud": 100,
    "sampleRate": 24000,
    "notes": "LEO cubesat · UHF TT&C uplink",
}

# Decoy-laden option sets so STEP 3 (RF) is a real choice (defaults unset).
OPTIONS = {
    "modulation": ["OOK", "BPSK", "FSK"],
    "baud":       [50, 100, 200, 1200],
    "sampleRate": [8000, 24000, 48000],
}

# UI field metadata per command (drives STEP 2's form).
COMMAND_UI = {
    "adcs_torque": {
        "subsystem": "ADCS", "star": True, "title": "Reaction Wheel Torque",
        "blurb": "A legitimate attitude-control torque command. Abuse the value and the satellite spins out of control.",
        "fields": [{"key": "torque", "type": "slider", "min": -1000, "max": 1000, "default": 999,
                    "unit": "mNm", "safeAbsMax": 500}],
        "effect": "Spins the satellite out of control → its solar panels can't face the sun → power collapses → energy alarm",
    },
    "solar_panel": {
        "subsystem": "POWER", "title": "Solar Panel Angle",
        "blurb": "Set the solar panel angle (0-255°).",
        "fields": [{"key": "angle", "type": "slider", "min": 0, "max": 255, "default": 0,
                    "unit": "°", "safeRange": [80, 100]}],
        "effect": "Turns the solar panel away from the sun → it stops generating → power drops fast",
    },
    "antenna_gimbal": {
        "subsystem": "COMM", "title": "Antenna Gimbal",
        "blurb": "Set the antenna pointing direction (az/el offset).",
        "fields": [{"key": "az", "type": "slider", "min": 0, "max": 255, "default": 120, "unit": "°"},
                   {"key": "el", "type": "slider", "min": 0, "max": 255, "default": 30, "unit": "°"}],
        "effect": "Swings the antenna away from the ground station → the radio link drops",
    },
    "subsystem_ctrl": {
        "subsystem": "ADCS", "title": "Subsystem Control",
        "blurb": "bit0=stabilization, bit1=transponder.",
        "fields": [{"key": "bitmask", "type": "number", "min": 0, "max": 3, "default": 0, "unit": ""}],
        "effect": "Turns off the satellite's auto-balancing → it starts to tumble",
    },
    "transponder_ctrl": {
        "subsystem": "COMM", "title": "Transponder Control",
        "blurb": "Turn the transponder on/off.",
        "fields": [{"key": "on", "type": "toggle", "default": False}],
        "effect": "Turns off the satellite's radio → it can no longer send data down to Earth",
    },
    "obc_reboot": {
        "subsystem": "OBC", "title": "OBC Reboot",
        "blurb": "Hard-reboot the on-board computer (no payload).",
        "fields": [],
        "effect": "Restarts the satellite's main computer → it goes silent for a while",
    },
}


def mission_payload():
    proto = codec.load_protocol()
    cmds = []
    for hexop, meta in proto["opcodes"].items():
        name = meta["name"]
        ui = COMMAND_UI.get(name)
        if not ui:
            continue
        cmds.append({"command": name, "opcode": hexop, "apid": meta["apid"],
                     "description": meta.get("description", ""), **ui})
    order = ["ADCS", "COMM", "OBC"]
    cmds.sort(key=lambda c: (order.index(c["subsystem"]) if c["subsystem"] in order else 9,
                             0 if c.get("star") else 1))
    return {"target": TARGET, "options": OPTIONS, "commands": cmds, "subsystems": order}


def waveform_preview(iq_f32, points=480):
    data = np.asarray(iq_f32, dtype=np.float32)
    env = np.abs(data[0::2] + 1j * data[1::2])
    if env.size == 0:
        return []
    idx = np.linspace(0, env.size - 1, min(points, env.size)).astype(int)
    m = float(env.max()) or 1.0
    return [round(float(env[i] / m), 3) for i in idx]


def validate(body):
    """Server-authoritative check of every puzzle step."""
    command = body.get("command")
    rf = body.get("rf") or {}
    value_confirmed = bool(body.get("valueConfirmed"))
    known = command in COMMAND_UI
    no_payload = known and not COMMAND_UI[command]["fields"]
    return {
        "command": known,
        "value": known and (value_confirmed or no_payload),
        "rf": (rf.get("modulation") == TARGET["modulation"]
               and rf.get("baud") == TARGET["baud"]
               and rf.get("sampleRate") == TARGET["sampleRate"]),
    }


def send_gs_alert(command, params):
    """Fire the attack at the victim ground station (:4540 /api/inject) instead of
    writing a per-visitor cf32. The generate button is client-gated to the correct
    attack, so we assume the command here is valid and just raise the alarm."""
    payload_bytes, _ = codec.build_payload(command, params or {})
    body = json.dumps({
        "command": command,
        "payload": [f"0x{b:02x}" for b in payload_bytes],
    }).encode()
    req = urllib.request.Request(GS_URL + "/api/inject", data=body,
                                 headers={"Content-Type": "application/json"}, method="POST")
    urllib.request.urlopen(req, timeout=2).read()


def do_build(body, save):
    v = validate(body)
    all_valid = all(v.values())
    resp = {"ok": True, "validation": v, "allValid": all_valid}

    command = body.get("command")
    if command in COMMAND_UI:
        params = body.get("params", {})
        rf = body.get("rf") or {}
        # reflect the participant's picks in the preview (fall back so it still
        # renders before RF is chosen); only correct values will decode.
        # SCID is fixed frame addressing now (no puzzle step) → always TARGET's.
        baud = rf.get("baud") or TARGET["baud"]
        sr = rf.get("sampleRate") or TARGET["sampleRate"]
        iq, breakdown = codec.build_iq(command, params, scid=TARGET["scid"], baud=baud, sample_rate=sr)
        resp["breakdown"] = breakdown
        resp["waveform"] = waveform_preview(iq)

        ui = COMMAND_UI[command]
        for f in ui.get("fields", []):
            if f.get("safeAbsMax") is not None and f["key"] in params:
                val = params[f["key"]]
                if isinstance(val, (int, float)) and abs(val) > f["safeAbsMax"]:
                    resp["danger"] = f"⚠ {f['key']} {val} EXCEEDS SAFE ({f['safeAbsMax']}{f.get('unit','')}) — {ui.get('effect','')}"

    if save:
        if not all_valid:
            return {"ok": False, "error": "Uplink incomplete — all systems must be configured", "validation": v, "allValid": False}
        # No per-visitor cf32 build/write/download (disk + browser load). Fire the attack
        # straight at the victim GS (:4540); the UI shows a click-through cf32 artifact.
        try:
            send_gs_alert(command, body.get("params", {}))
            resp["alertSent"] = True
        except Exception as e:
            resp["alertSent"] = False
            resp["alertError"] = str(e)
        resp["saved"] = {"filename": "attack.cf32"}
    return resp


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, ctype, body):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, "application/json", json.dumps(obj).encode())

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.split("?")[0] in ("/", "/index.html"):
            with open(TEMPLATE, "rb") as f:
                html = f.read()
            if RELOAD:
                html = html.replace(b"</body>", LIVERELOAD_JS.encode() + b"</body>")
            return self._send(200, "text/html; charset=utf-8", html)
        if self.path == "/api/livereload":
            return self._json({"stamp": _RELOAD_STAMP})
        if self.path == "/api/mission":
            return self._json(mission_payload())
        if self.path.startswith("/static/"):
            rel = self.path[len("/static/"):].split("?")[0]
            fp = os.path.normpath(os.path.join(STATIC_DIR, rel))
            if fp.startswith(STATIC_DIR) and os.path.isfile(fp):
                ctype = ("text/css" if fp.endswith(".css")
                         else "application/javascript" if fp.endswith(".js")
                         else "image/svg+xml" if fp.endswith(".svg")
                         else "application/octet-stream")
                with open(fp, "rb") as f:
                    return self._send(200, ctype, f.read())
        # ③ 위성 조준 콘솔 페이지 (phase 3 iframe이 여기를 연다)
        if self.path.split("?")[0] == "/targeting":
            with open(os.path.join(CONSOLE_DIR, "index.html"), "rb") as f:
                return self._send(200, "text/html; charset=utf-8", f.read())
        # ④ 드론 스푸핑 콘솔 페이지 (phase 4 iframe이 여기를 연다)
        if self.path.split("?")[0] == "/drone":
            with open(os.path.join(DRONE_DIR, "index.html"), "rb") as f:
                return self._send(200, "text/html; charset=utf-8", f.read())
        # ③ OpenVSA 렌더러 정적 서빙 (/vsa/… → attacker/openvsa/…)
        pth = self.path.split("?")[0]
        if pth == "/vsa" or pth.startswith("/vsa/"):
            rel = pth[len("/vsa"):].lstrip("/") or "index.html"
            fp = os.path.normpath(os.path.join(OPENVSA_DIR, rel))
            if os.path.isdir(fp):
                fp = os.path.join(fp, "index.html")
            if fp.startswith(OPENVSA_DIR) and os.path.isfile(fp):
                ctype = _VSA_MIME.get(os.path.splitext(fp)[1].lower(), "application/octet-stream")
                with open(fp, "rb") as f:
                    return self._send(200, ctype, f.read())
        self._send(404, "text/plain", b"not found")

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self._json({"ok": False, "error": "bad json"}, 400)
        try:
            if self.path == "/api/build":
                return self._json(do_build(body, save=False))
            if self.path == "/api/generate":
                return self._json(do_build(body, save=True))
        except Exception as e:
            return self._json({"ok": False, "error": str(e)}, 400)
        self._json({"ok": False, "error": "unknown endpoint"}, 404)


def main():
    print(f"DEMOSAT Command Builder → http://localhost:{PORT}")
    print(f"  attack target: {GS_URL}/api/inject  (GENERATE fires the alert here)")
    if RELOAD:
        print("  live-reload: ON (edits auto-refresh the browser / restart the server)")
        threading.Thread(target=_watcher, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
