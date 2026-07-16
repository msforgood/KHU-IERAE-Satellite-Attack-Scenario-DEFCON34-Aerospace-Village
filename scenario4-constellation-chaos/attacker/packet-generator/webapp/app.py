#!/usr/bin/env python3
"""
ENIGMA-1 Command Builder — local web UI (stdlib http.server, no pip deps)

A booth "puzzle": to generate the uplink IQ file the visitor must assemble every
element of a valid uplink, matching the target satellite's dossier:
  STEP 1  Target addressing — Spacecraft ID (SCID)
  STEP 2  Command select    — subsystem + opcode
  STEP 3  Command value      — payload (e.g. reaction-wheel torque)
  STEP 4  RF config          — modulation / baud / sample rate (satellite RX)
Only when all four are correct does GENERATE unlock and write attack.cf32.

Run:   python3 app.py               # → http://localhost:8000
Env:   UPLINK_OUT_DIR   output folder for generated .cf32 (default ~/uplink)
       PORT             default 8000

Backend logic is the canonical codec (openvsa-plugin/demosat/ccsds_ook.py);
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
_PLUGIN = os.path.abspath(os.path.join(HERE, "..", "..", "openvsa-plugin", "demosat"))
sys.path.insert(0, _PLUGIN)
import ccsds_ook as codec  # noqa: E402

STATIC_DIR = os.path.join(HERE, "static")
TEMPLATE = os.path.join(HERE, "templates", "index.html")
# shared satellite-sim module (the sim seam), served at /sim/*
SIM_DIR = os.path.abspath(os.path.join(HERE, "..", "..", "..", "satellite-sim"))
# OpenVSA static renderer (the VSA panel), served at /vsa/*
VSA_DIR = os.path.join(HERE, "vsa")
OUT_DIR = os.environ.get("UPLINK_OUT_DIR", os.path.expanduser("~/uplink"))
PORT = int(os.environ.get("PORT", "8000"))
# victim ground station (monitor 2) — the software uplink forwards the decoded command here
GS_URL = os.environ.get("GS_URL", "http://localhost:4540")

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
    "satellite": "ENIGMA-1",
    "scid": 200,               # Spacecraft ID
    "modulation": "OOK",
    "baud": 100,
    "sampleRate": 24000,
    "uplinkFreqMHz": 450.1,    # set on the VSA, shown here for context
    "notes": "LEO cubesat · member of the AURORA constellation · TT&C uplink",
}

# Decoy-laden option sets so STEP 1 / STEP 4 are real choices (defaults unset).
OPTIONS = {
    "scid":       [199, 200, 201, 210],
    "modulation": ["OOK", "BPSK", "FSK"],
    "baud":       [50, 100, 200, 1200],
    "sampleRate": [8000, 24000, 48000],
}

# UI field metadata per command (drives STEP 3's form).
COMMAND_UI = {
    "orbit_maneuver": {
        "subsystem": "AOCS", "star": True, "title": "Orbit Maneuver",
        "blurb": "A legitimate orbit-adjustment command (target altitude, inclination, RAAN). Abuse the elements to swing ENIGMA-1's orbit onto a neighbouring AURORA satellite.",
        "fields": [
            {"key": "altKm", "type": "number", "min": 400, "max": 1200, "default": 600, "unit": " km"},
            {"key": "inc",   "type": "number", "min": 0,   "max": 90,   "default": 50,  "unit": " deg"},
            {"key": "raan",  "type": "number", "min": 0,   "max": 360,  "default": 25,  "unit": " deg"},
        ],
        "effect": "orbit swings onto a constellation satellite → collision → debris cascade",
    },
    "adcs_torque": {
        "subsystem": "ADCS", "title": "Reaction Wheel Torque",
        "blurb": "A legitimate attitude-control torque command. Abuse the value and the satellite spins out of control.",
        "fields": [{"key": "torque", "type": "slider", "min": -1000, "max": 1000, "default": 999,
                    "unit": "mNm", "safeAbsMax": 500}],
        "effect": "satellite tumbles → solar array loses sun-track → power generation collapses",
    },
    "solar_panel": {
        "subsystem": "POWER", "title": "Solar Panel Angle",
        "blurb": "Set the solar panel angle (0-255°).",
        "fields": [{"key": "angle", "type": "slider", "min": 0, "max": 255, "default": 0,
                    "unit": "°", "safeRange": [80, 100]}],
        "effect": "panel turns off the sun → power drops sharply",
    },
    "antenna_gimbal": {
        "subsystem": "COMM", "title": "Antenna Gimbal",
        "blurb": "Set the antenna pointing direction (az/el offset).",
        "fields": [{"key": "az", "type": "slider", "min": 0, "max": 255, "default": 120, "unit": "°"},
                   {"key": "el", "type": "slider", "min": 0, "max": 255, "default": 30, "unit": "°"}],
        "effect": "antenna slews off the ground station → link lost",
    },
    "subsystem_ctrl": {
        "subsystem": "ADCS", "title": "Subsystem Control",
        "blurb": "bit0=stabilization, bit1=transponder.",
        "fields": [{"key": "bitmask", "type": "number", "min": 0, "max": 3, "default": 0, "unit": ""}],
        "effect": "attitude stabilization disabled → tumbling",
    },
    "transponder_ctrl": {
        "subsystem": "COMM", "title": "Transponder Control",
        "blurb": "Turn the transponder on/off.",
        "fields": [{"key": "on", "type": "toggle", "default": False}],
        "effect": "downlink lost",
    },
    "obc_reboot": {
        "subsystem": "OBC", "title": "OBC Reboot",
        "blurb": "Hard-reboot the on-board computer (no payload).",
        "fields": [],
        "effect": "satellite temporarily unresponsive (rebooting)",
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
    order = ["AOCS", "POWER", "ADCS", "COMM", "OBC"]
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
    scid = body.get("scid")
    command = body.get("command")
    rf = body.get("rf") or {}
    value_confirmed = bool(body.get("valueConfirmed"))
    known = command in COMMAND_UI
    no_payload = known and not COMMAND_UI[command]["fields"]
    return {
        "addressing": scid == TARGET["scid"],
        "command": known,
        "value": known and (value_confirmed or no_payload),
        "rf": (rf.get("modulation") == TARGET["modulation"]
               and rf.get("baud") == TARGET["baud"]
               and rf.get("sampleRate") == TARGET["sampleRate"]),
    }


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
        scid = body.get("scid") if body.get("scid") is not None else 0
        baud = rf.get("baud") or TARGET["baud"]
        sr = rf.get("sampleRate") or TARGET["sampleRate"]
        iq, breakdown = codec.build_iq(command, params, scid=scid, baud=baud, sample_rate=sr)
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
        # build with the validated (correct) values
        iq, _ = codec.build_iq(command, body.get("params", {}),
                               scid=TARGET["scid"], baud=TARGET["baud"], sample_rate=TARGET["sampleRate"])
        os.makedirs(OUT_DIR, exist_ok=True)
        fname = "attack.cf32"
        codec.write_cf32(os.path.join(OUT_DIR, fname), iq)
        resp["saved"] = {"path": os.path.join(OUT_DIR, fname), "filename": fname}
        resp["downloadB64"] = base64.b64encode(np.asarray(iq, dtype=np.float32).tobytes()).decode()
    return resp


def _gs_post(path, obj):
    """POST JSON to the victim ground station (software uplink / reset)."""
    req = urllib.request.Request(GS_URL.rstrip("/") + path,
                                 data=json.dumps(obj).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=4) as r:
        return json.loads(r.read() or b"{}")


def _gs_get(path):
    """GET JSON from the victim ground station."""
    with urllib.request.urlopen(GS_URL.rstrip("/") + path, timeout=4) as r:
        return json.loads(r.read() or b"{}")


def do_observe_status():
    """Poll the victim ground station so phase 4 knows whether the collision was
    REALLY seen: videoPlayed flips true once monitor 2 plays the debris video."""
    try:
        st = (_gs_get("/api/state") or {}).get("state") or {}
        out = st.get("outcome") or {}
        return {"ok": True, "status": st.get("status"),
                "videoPlayed": bool(st.get("videoPlayed")),
                "collided": bool(out.get("collided")),
                "victim": out.get("victim"), "distKm": out.get("distKm")}
    except Exception as e:
        return {"ok": False, "error": "ground station unreachable: %s" % e}


def do_uplink(body):
    """Generate the validated cf32, then forward the decoded command to the GS.
    This is the software-simulated uplink (no real RF): the VSA would decode the
    IQ and deliver the same {command, payload} to the ground station."""
    res = do_build(body, save=True)
    if not res.get("ok") or not res.get("saved"):
        return res  # carries validation + error so the UI can explain what's missing
    bd = res.get("breakdown") or {}
    payseg = next((s for s in bd.get("segments", []) if s.get("field") == "payload"), None)
    payload_hex = ["0x%02x" % b for b in (payseg.get("bytes", []) if payseg else [])]
    msg = {"type": "uplink-command", "satellite": TARGET["satellite"],
           "command": body.get("command"), "payload": payload_hex,
           "frequency": TARGET["uplinkFreqMHz"], "params": body.get("params", {})}
    try:
        res["uplink"] = {"ok": True, "gs": _gs_post("/api/inject", msg)}
    except Exception as e:
        res["uplink"] = {"ok": False, "error": "ground station unreachable: %s" % e}
    return res


def do_reset_target(_body):
    """Reset the victim ground station + its simulation (monitor 2)."""
    try:
        return {"ok": True, "gs": _gs_post("/api/reset", {})}
    except Exception as e:
        return {"ok": False, "error": "ground station unreachable: %s" % e}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, ctype, body):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
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
        if self.path == "/api/observe-status":
            return self._json(do_observe_status())
        if self.path.startswith("/static/"):
            rel = self.path[len("/static/"):].split("?")[0]
            fp = os.path.normpath(os.path.join(STATIC_DIR, rel))
            if fp.startswith(STATIC_DIR) and os.path.isfile(fp):
                ctype = ("text/css" if fp.endswith(".css")
                         else "application/javascript" if fp.endswith(".js")
                         else "application/octet-stream")
                with open(fp, "rb") as f:
                    return self._send(200, ctype, f.read())
        if self.path.startswith("/sim/"):
            rel = self.path[len("/sim/"):].split("?")[0]
            fp = os.path.normpath(os.path.join(SIM_DIR, rel))
            if fp.startswith(SIM_DIR) and os.path.isfile(fp):
                ctype = ("application/javascript" if fp.endswith(".js")
                         else "image/jpeg" if fp.endswith((".jpg", ".jpeg"))
                         else "image/png" if fp.endswith(".png")
                         else "text/markdown" if fp.endswith(".md")
                         else "application/octet-stream")
                with open(fp, "rb") as f:
                    return self._send(200, ctype, f.read())
        if self.path == "/vsa" or self.path == "/vsa/":
            self.path = "/vsa/index.html"
        if self.path.startswith("/vsa/"):
            rel = self.path[len("/vsa/"):].split("?")[0]
            fp = os.path.normpath(os.path.join(VSA_DIR, rel))
            if fp.startswith(VSA_DIR) and os.path.isfile(fp):
                ctype = ("text/html; charset=utf-8" if fp.endswith(".html")
                         else "text/css" if fp.endswith(".css")
                         else "application/javascript" if fp.endswith((".js", ".mjs"))
                         else "application/json" if fp.endswith(".json")
                         else "image/png" if fp.endswith(".png")
                         else "image/svg+xml" if fp.endswith(".svg")
                         else "image/jpeg" if fp.endswith((".jpg", ".jpeg"))
                         else "application/octet-stream")
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
            if self.path == "/api/uplink":
                return self._json(do_uplink(body))
            if self.path == "/api/reset-target":
                return self._json(do_reset_target(body))
        except Exception as e:
            return self._json({"ok": False, "error": str(e)}, 400)
        self._json({"ok": False, "error": "unknown endpoint"}, 404)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    print(f"ENIGMA-1 Command Builder -> http://localhost:{PORT}")
    print(f"  output dir: {OUT_DIR}  (generated attack.cf32 lands here)")
    if RELOAD:
        print("  live-reload: ON (edits auto-refresh the browser / restart the server)")
        threading.Thread(target=_watcher, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
