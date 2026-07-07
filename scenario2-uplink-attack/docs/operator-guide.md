# Operator Guide — Scenario 2 "Uplink Attack"

DEFCON 34 Aerospace Village. For **booth operators** running the demo. For the
card visitors follow, see `participant-guide.md`.

Message of the demo: **"Even a legitimate command becomes an attack when it is abused."**
A visitor forges a reaction-wheel torque command and uplinks it; the victim ground
station dashboard escalates to **ENERGY SUPPLY CRITICAL** and the physical solar
panel spins out of control. No real RF — the uplink is software-simulated.

## 1. Topology

```
[Attacker laptop]                                 [Victim Windows PC]
  · Command Builder web UI  http://localhost:8000    · GS dashboard  http://GS:4540
  · OpenVSA (VSA)                                     · GS backend  :4536 (uplink in)
      rotctld :4533 / rigctld :4532 / ws :4534              │
      forward → ws://GS:4536 ───────────────────────────────┘
                                                             └→ Arduino solar panel (trigger hook, TBD)
```

Software-simulated: OpenVSA validates the uplink (antenna alignment, frequency,
link margin) and forwards the decoded command to the GS over WebSocket. `GS` = the
victim PC's LAN IP.

## 2. Prerequisites
- Both machines on the same LAN. Note the victim PC's IP (referred to as `GS`).
- Attacker laptop: Python 3 + numpy, Node 20.
- Victim PC: Node 20. Modern browser in full-screen (F11).
- (Optional) Arduino reachable over HTTP for the physical panel trigger.

## 3. Startup order

**① Victim ground station (start first)**
```
cd ground-station/backend
node server.js
#   dashboard  http://localhost:4540    ·    uplink input  :4536
#   optional:  ATTACK_DELAY_MS=2500  ARDUINO_URL=http://<arduino>/trigger
```
Open `http://localhost:4540` full-screen on the audience-facing monitor.

**② OpenVSA (attacker VSA)** — drop in the plugin first:
```
cp -r openvsa-plugin/demosat/*             <OpenVSA>/satellites/demosat/
cp    openvsa-plugin/hardware-effects.json <OpenVSA>/satellites/hardware-effects.json
cd <OpenVSA>
UPLINK_DEST=ws://<GS>:4536 node server.js      # forward target = victim GS
npm start                                        # Electron VSA UI (separate process)
```
Note: `satellites/demosat/` must include `ccsds_ook.py` (the decoder imports it).

**③ Command Builder console (attacker)**
```
cd packet-generator/webapp
UPLINK_OUT_DIR=~/uplink python3 app.py
#   http://localhost:8000  — the visitor operates this
#   GENERATE writes ~/uplink/attack.cf32 (loaded into OpenVSA)
```

## 4. Reset between visitors
```
curl -X POST http://localhost:4540/api/reset      # return the GS to nominal
```
The Command Builder is stateless — no reset needed (a refresh is optional).

## 5. Tuning knobs
| Goal | Location | Value |
|---|---|---|
| Telemetry reaction delay | GS env `ATTACK_DELAY_MS` | default 4000 ms (booth: 1500–3000) |
| Safe torque threshold | `openvsa-plugin/demosat/c2protocol.json` opcode `0x21` → `safeAbsMax` | 500 |
| Battery drain / sun-track loss speed | `ground-station/backend/satellite-state.js` → `adcs_torque_magnitude` (drainRate / swingSpeed) | scales with torque magnitude |
| Arduino trigger | GS env `ARDUINO_URL` (POST on attack onset) | logs only if unset |

## 6. What "correct" looks like
- Nominal: green banner, SUN-TRACKING / STABLE / CONNECTED, battery 100%.
- After the uplink lands (~ATTACK_DELAY_MS later): red **ENERGY SUPPLY CRITICAL**
  banner, **SUN-TRACK LOST**, Power Gen collapsing toward 0 W (stays low), battery
  draining, **TUMBLING**, Comm **LOST**. A full-screen alarm flashes for ~5 s, then
  clears so the live telemetry stays visible.
- Reference screenshots: `screenshots/gs-nominal.png`, `gs-alarm-flash.png`,
  `gs-energy-critical.png`, `generator-command-builder.png`.

## 7. Troubleshooting
| Symptom | Check |
|---|---|
| Dashboard stuck on "CONNECTING…" | GS backend (:4540) not running, or firewall |
| Uplink never reaches GS | OpenVSA `UPLINK_DEST` points at the right `GS` IP; :4536 open; uplink passed OpenVSA validation (antenna aligned, freq 449.5 MHz) |
| cf32 fails to decode in OpenVSA | `ccsds_ook.py` copied alongside `decoder.py` in `satellites/demosat/` |
| No alarm | Command must be `adcs_torque` with torque above the safe threshold |

## 8. Open items
- **Arduino solar panel**: currently a trigger **hook** only (logs / HTTP POST on
  attack onset). Real firmware + motor wiring TBD (pending the Google Drive code).
  The GS is ready to emit the signal via `ARDUINO_URL`.
- **OpenVSA end-to-end** rehearsal against the procedure above still to be verified.
