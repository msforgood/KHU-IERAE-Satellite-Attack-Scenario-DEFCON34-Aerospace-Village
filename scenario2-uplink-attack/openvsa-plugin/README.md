# OpenVSA Plugin — DEMOSAT (CCSDS TC over OOK)

A satellite plugin that **drops into** OpenVSA (the attacker VSA tool). OpenVSA's core
is not modified; we reuse the existing **DEMOSAT slot** (no edit to
`src/data/satellites.js`).

## Contents
- `demosat/c2protocol.json` — command / frame spec (source of truth for generator + decoder)
- `demosat/ccsds_ook.py` — shared CCSDS/OOK codec (build + decode); ships here so the decoder is self-contained
- `demosat/decoder.py` — cf32 → command decoder (called by OpenVSA)
- `demosat/hardware.json` — hardware defaults / specs (incl. reaction-wheel torque)
- `demosat/panel.json` — victim dashboard layout (emphasizes the energy-supply alarm)
- `hardware-effects.json` — shared attack effects (adds `adcs_torque`)

## Deploy
Relative to an OpenVSA checkout (`OpenVSA/`):
```
cp demosat/*             OpenVSA/satellites/demosat/
cp hardware-effects.json OpenVSA/satellites/hardware-effects.json
```
To forward uplinks to the ground station, run OpenVSA as:
```
UPLINK_DEST=ws://<GS_HOST>:4536 node server.js
```

Full spec: `../docs/command-spec.md`.
