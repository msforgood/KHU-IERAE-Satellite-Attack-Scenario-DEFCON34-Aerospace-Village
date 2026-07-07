# Packet Generator (①)

A Python tool that lets a visitor build a forged/legitimate command and export it as
a **cf32 IQ file** that OpenVSA's `decoder.py` can decode (CCSDS TC + OOK). Spec:
`../docs/command-spec.md`.

## Web UI (recommended — the booth console)
```
cd webapp
UPLINK_OUT_DIR=~/uplink python3 app.py       # http://localhost:8000
```
Pick a command, set the values (e.g. the torque slider), watch the CCSDS frame
assemble byte-by-byte, then GENERATE → writes `~/uplink/attack.cf32`. Zero build
step; the only dependency is numpy. See `../docs/operator-guide.md`.

## CLI
```
python3 generate.py adcs_torque --torque 999 -o attack.cf32   # ★ main scenario
python3 generate.py solar_panel --angle 0    -o attack.cf32
python3 generate.py obc_reboot               -o attack.cf32
```

## Structure
- `webapp/` — local web UI (stdlib `http.server`, no pip deps): `app.py`,
  `templates/index.html`, `static/`
- `generate.py` — CLI (thin wrapper over the shared codec)
- `tests/test_roundtrip.py` — generate → `decoder.py` roundtrip contract

The shared CCSDS/OOK codec lives at `../openvsa-plugin/demosat/ccsds_ook.py` (it ships
with the OpenVSA plugin so the decoder is self-contained); the generator imports it.
