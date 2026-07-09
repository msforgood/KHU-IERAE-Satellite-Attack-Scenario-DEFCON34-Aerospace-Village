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
cp demosat/*             OpenVSA/satellites/demosat/     # includes ccsds_ook.py (decoder imports it)
cp hardware-effects.json OpenVSA/satellites/hardware-effects.json
git -C OpenVSA apply /path/to/server-forward-payload.patch   # forward opcode/payload to the GS
```
To forward uplinks to the ground station, run OpenVSA as:
```
UPLINK_DEST=ws://<GS_HOST>:4536 node server.js
```

## `server-forward-payload.patch`
Adds `opcode` / `payload` to `server.js` `forwardUplinkCommand()` so the GS dashboard
can show the actual torque value (2 lines). Without it the chain still works; the GS
just falls back to the command name. `controls.js` already includes opcode/payload in
the `uplink-transmit` event — the patch only relays them onward.

## Verified (Phase 2, headless)
- `python3 satellites/demosat/decoder.py <file>.cf32 24000` decodes our generated cf32.
- cf32 → decode → OpenVSA `server.js` → forward → GS `:4536`: GS logs
  `RX adcs_torque payload=["0x03","0xe7"]`, applies the attack (torque=999, tumbling),
  and fires the Arduino hook. (Electron UI / RF path not run headlessly.)

Full spec: `../docs/command-spec.md`.
