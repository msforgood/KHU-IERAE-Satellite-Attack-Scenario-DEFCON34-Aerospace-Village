# Packet Generator (①)

A Python tool that lets a visitor build a forged/legitimate command and export it as
a **cf32 IQ file** that OpenVSA's `decoder.py` can decode (CCSDS TC + OOK). Spec:
`../docs/command-spec.md`.

## Web UI (recommended — the booth console)
```
cd webapp
UPLINK_OUT_DIR=~/uplink python3 app.py       # http://localhost:8000
```
A 2-system puzzle: the visitor must assemble a valid uplink to match the on-screen
**TARGET INTEL** dossier — **1** compose the command in a **Scratch-style block editor**
(click a subsystem block to load it into the script, then **type the real command name and its
value** into the block's slots — no click-to-pick shortcut), **2** RF config
(modulation/baud/sample rate). Only when both lock does GENERATE unlock and write
`~/uplink/attack.cf32`. The CCSDS frame assembles byte-by-byte as they go. Zero build
step; the only dependency is numpy.
Validation is server-authoritative (see `app.py` `validate()`). See
`../docs/operator-guide.md` / `../docs/participant-guide.md`.

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

The shared CCSDS/OOK codec lives at `../openvsa/satellites/demosat/ccsds_ook.py` — the
single source of truth in the OpenVSA fork (so the decoder is self-contained); the
generator imports it from there.
