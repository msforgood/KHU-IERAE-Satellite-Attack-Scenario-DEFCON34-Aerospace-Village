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

# ── Scenario extension points (phases ④+ live outside common/) ───────────────
# A scenario supplies extra phases without editing common: point EXTRA_DIR at its
# `extras/` folder (served at /extra/…) and SCENARIO_CONFIG at its scenario.json.
# The Command Builder template reads /api/scenario and renders the extra phases
# (nav buttons + iframes) at runtime. With neither set, this is the plain 3-phase
# attack (scenario 2), so common stays scenario-agnostic.
EXTRA_DIR = os.path.abspath(os.environ["EXTRA_DIR"]) if os.environ.get("EXTRA_DIR") else ""
SCENARIO_CONFIG = os.environ.get("SCENARIO_CONFIG", "")

def load_scenario():
    cfg = {"id": "scn2", "name": "Uplink Attack", "phaseCount": 3, "extras": []}
    if SCENARIO_CONFIG and os.path.isfile(SCENARIO_CONFIG):
        try:
            with open(SCENARIO_CONFIG, encoding="utf-8") as f:
                cfg.update(json.load(f))
        except Exception as e:
            print(f"[scenario] failed to read {SCENARIO_CONFIG}: {e}")
    cfg.setdefault("extras", [])
    cfg.setdefault("phaseCount", 3 + len(cfg["extras"]))
    return cfg
_VSA_MIME = {
    ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".mjs": "application/javascript",
    ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon",
    ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".wasm": "application/wasm",
    ".map": "application/json", ".txt": "text/plain; charset=utf-8",
}
PORT = int(os.environ.get("PORT", "8000"))
# 피해 지상국(:4540). 공격은 phase③ TRANSMIT에서 targeting 콘솔이 직접 여기 /api/inject로
# 발사한다(GENERATE는 GS를 건드리지 않음). 이 값은 콘솔에 넘겨줄 GS base로 안내 로그에 쓰인다.
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
        "effect": "Spins the satellite out of control → its solar panels can't face the sun → power collapses",
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
        "effect": "Turns off the satellite's auto-balancing",
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


# NOTE: the attack is fired at phase③ TRANSMIT, straight from the targeting console in
# the browser (console → POST <gs>/api/inject). The builder deliberately does NOT alert
# the GS from GENERATE, so the victim alarm stays quiet until the participant uplinks.


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
        # GENERATE only produces the uplink IQ artifact — it must NOT alert the GS here.
        # The attack is fired later, at phase③ TRANSMIT (console → GS /api/inject), so the
        # victim alarm stays quiet until the participant actually uplinks during the pass.
        # (No per-visitor cf32 build/write; the UI shows a click-through cf32 artifact.)
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
        _p = self.path.split("?")[0]
        # phase deep-links (/1 /2 /3 /4 …) all serve the one app; client-side JS
        # reads the path and shows that phase, so refresh/deep-link stick to it.
        if _p in ("/", "/index.html") or (len(_p) > 1 and _p[1:].isdigit()):
            with open(TEMPLATE, "rb") as f:
                html = f.read()
            if RELOAD:
                html = html.replace(b"</body>", LIVERELOAD_JS.encode() + b"</body>")
            return self._send(200, "text/html; charset=utf-8", html)
        if self.path == "/api/livereload":
            return self._json({"stamp": _RELOAD_STAMP})
        if self.path == "/api/mission":
            return self._json(mission_payload())
        # scenario descriptor — the template renders extra phases (④+) from this
        if self.path == "/api/scenario":
            return self._json(load_scenario())
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
        # ④+ 시나리오 전용 화면 (EXTRA_DIR 하위) — scenarioN/extras/… 를 /extra/… 로 서빙
        pth_x = self.path.split("?")[0]
        if EXTRA_DIR and (pth_x == "/extra" or pth_x.startswith("/extra/")):
            rel = pth_x[len("/extra"):].lstrip("/") or "index.html"
            fp = os.path.normpath(os.path.join(EXTRA_DIR, rel))
            if os.path.isdir(fp):
                fp = os.path.join(fp, "index.html")
            if fp.startswith(EXTRA_DIR) and os.path.isfile(fp):
                ctype = _VSA_MIME.get(os.path.splitext(fp)[1].lower(), "application/octet-stream")
                with open(fp, "rb") as f:
                    return self._send(200, ctype, f.read())
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
    sc = load_scenario()
    print(f"DEMOSAT Command Builder → http://localhost:{PORT}")
    print(f"  scenario: {sc.get('id')} · {sc.get('name')} · {sc.get('phaseCount')} phases")
    if sc.get("extras"):
        print(f"  extra phases: {', '.join(e.get('label', e.get('id', '?')) for e in sc['extras'])}  (EXTRA_DIR={EXTRA_DIR or '—'})")
    print(f"  attack target: {GS_URL}/api/inject  (phase③ TRANSMIT fires the alert; GENERATE stays quiet)")
    if RELOAD:
        print("  live-reload: ON (edits auto-refresh the browser / restart the server)")
        threading.Thread(target=_watcher, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
