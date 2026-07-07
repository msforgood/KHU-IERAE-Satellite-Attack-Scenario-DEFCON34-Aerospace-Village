#!/usr/bin/env python3
"""
DEMOSAT Command Builder — local web UI (stdlib http.server, no pip deps)

Runs on the attacker laptop next to OpenVSA. The visitor picks a command and
"fun real values" (e.g., reaction-wheel torque), watches the CCSDS TC frame
assemble byte-by-byte, and clicks GENERATE to write an OOK cf32 IQ file that
OpenVSA loads and uplinks.

Run:   python3 app.py               # → http://localhost:8000
Env:   UPLINK_OUT_DIR   output folder for generated .cf32 (default ~/uplink)
       PORT             default 8000

Backend logic is the canonical codec (openvsa-plugin/demosat/ccsds_ook.py);
the browser only renders. Single source of truth, no JS DSP.
"""
import os
import sys
import json
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
_PLUGIN = os.path.abspath(os.path.join(HERE, "..", "..", "openvsa-plugin", "demosat"))
sys.path.insert(0, _PLUGIN)
import ccsds_ook as codec  # noqa: E402

STATIC_DIR = os.path.join(HERE, "static")
TEMPLATE = os.path.join(HERE, "templates", "index.html")
OUT_DIR = os.environ.get("UPLINK_OUT_DIR", os.path.expanduser("~/uplink"))
PORT = int(os.environ.get("PORT", "8000"))

# UI field metadata per command (drives the browser form).
COMMAND_UI = {
    "adcs_torque": {
        "subsystem": "ADCS", "star": True, "title": "Reaction Wheel Torque",
        "blurb": "A legitimate attitude-control torque command. Abuse the value and the satellite spins out of control.",
        "fields": [{"key": "torque", "type": "slider", "min": -1000, "max": 1000, "default": 999,
                    "unit": "mNm", "safeAbsMax": 500}],
        "effect": "satellite tumbles → solar array loses sun-track → power generation collapses → energy supply alarm",
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


def protocol_payload():
    proto = codec.load_protocol()
    cmds = []
    for hexop, meta in proto["opcodes"].items():
        name = meta["name"]
        ui = COMMAND_UI.get(name)
        if not ui:
            continue
        cmds.append({"command": name, "opcode": hexop, "apid": meta["apid"],
                     "description": meta.get("description", ""), **ui})
    order = ["POWER", "ADCS", "COMM", "OBC"]
    cmds.sort(key=lambda c: (order.index(c["subsystem"]) if c["subsystem"] in order else 9,
                             0 if c.get("star") else 1))
    return {"commands": cmds, "subsystems": order}


def waveform_preview(iq_f32, points=480):
    """Downsample the OOK envelope to a small 0/1 series for the canvas."""
    data = np.asarray(iq_f32, dtype=np.float32)
    env = np.abs(data[0::2] + 1j * data[1::2])
    if env.size == 0:
        return []
    idx = np.linspace(0, env.size - 1, min(points, env.size)).astype(int)
    m = float(env.max()) or 1.0
    return [round(float(env[i] / m), 3) for i in idx]


def do_build(body, save):
    command = body.get("command")
    params = body.get("params", {})
    seq = int(body.get("seq", 0))
    iq, breakdown = codec.build_iq(command, params, seq=seq)
    resp = {"ok": True, "breakdown": breakdown, "waveform": waveform_preview(iq)}

    # safe-value advisory
    ui = COMMAND_UI.get(command, {})
    for f in ui.get("fields", []):
        if f.get("safeAbsMax") is not None and f["key"] in params:
            v = params[f["key"]]
            if isinstance(v, (int, float)) and abs(v) > f["safeAbsMax"]:
                resp["danger"] = f"⚠ {f['key']} {v} EXCEEDS SAFE ({f['safeAbsMax']}{f.get('unit','')}) — {ui.get('effect','')}"

    if save:
        os.makedirs(OUT_DIR, exist_ok=True)
        fname = "attack.cf32"
        codec.write_cf32(os.path.join(OUT_DIR, fname), iq)
        resp["saved"] = {"path": os.path.join(OUT_DIR, fname), "filename": fname}
        resp["downloadB64"] = base64.b64encode(np.asarray(iq, dtype=np.float32).tobytes()).decode()
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
        pass  # quiet

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            with open(TEMPLATE, "rb") as f:
                return self._send(200, "text/html; charset=utf-8", f.read())
        if self.path == "/api/protocol":
            return self._json(protocol_payload())
        if self.path.startswith("/static/"):
            rel = self.path[len("/static/"):].split("?")[0]
            fp = os.path.normpath(os.path.join(STATIC_DIR, rel))
            if fp.startswith(STATIC_DIR) and os.path.isfile(fp):
                ctype = ("text/css" if fp.endswith(".css")
                         else "application/javascript" if fp.endswith(".js")
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
        except Exception as e:
            return self._json({"ok": False, "error": str(e)}, 400)
        self._json({"ok": False, "error": "unknown endpoint"}, 404)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    print(f"DEMOSAT Command Builder → http://localhost:{PORT}")
    print(f"  output dir: {OUT_DIR}  (generated attack.cf32 lands here)")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
