# Operator Guide — Scenario 2 "Uplink Attack"

DEFCON 34 Aerospace Village. For **booth operators** running the demo. For the
card visitors follow, see `participant-guide.md`.

> 🇰🇷 **부스 담당자용 상세 실행 매뉴얼(스크린샷 포함)은 `operator-guide-kr.md`** 를 보세요 —
> 설치부터 간편 모드(노트북 1대) 시연, 관람객 응대 스크립트까지 단계별로 정리되어 있습니다.
> 이 영어 문서는 간결한 운영 레퍼런스입니다.

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
                                                             └→ serial bridge → Arduino solar panel + antenna
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
git -C <OpenVSA> apply openvsa-plugin/server-forward-payload.patch   # relay opcode/payload to GS
cd <OpenVSA>
UPLINK_DEST=ws://<GS>:4536 node server.js      # forward target = victim GS
npm start                                        # Electron VSA UI (separate process)
```
Note: `satellites/demosat/` must include `ccsds_ook.py` (the decoder imports it).
The forward patch is optional (2 lines); without it the GS shows the command name
but not the torque value.

**③ Command Builder console (attacker)**
```
cd packet-generator/webapp
UPLINK_OUT_DIR=~/uplink python3 app.py
#   http://localhost:8000  — the visitor operates this
#   GENERATE writes ~/uplink/attack.cf32 (loaded into OpenVSA)
```
The visitor must assemble a valid uplink as a 4-step puzzle before GENERATE unlocks:
**1** Spacecraft ID (SCID) · **2** command · **3** command value · **4** RF config
(modulation/baud/sample rate). The answers are on the **TARGET INTEL** dossier
(left panel); the intended attack is `adcs_torque` at 999 mNm. If a visitor is stuck,
point them at the dossier — every field must match.

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

**Nominal** — green banner, SUN-TRACKING / STABLE / CONNECTED, battery 100%:

![Ground station nominal](screenshots/gs-nominal.png)

**Attack lands** (~ATTACK_DELAY_MS later) — a full-screen alarm flashes for ~5 s:

![Energy supply critical alarm flash](screenshots/gs-alarm-flash.png)

**Sustained critical** — after the flash clears, live telemetry keeps showing the
collapse: red **ENERGY SUPPLY CRITICAL** banner, **SUN-TRACK LOST**, Power Gen graph
plunging toward 0 W (stays low), battery draining, ADCS **TUMBLING**, Comm **LOST**,
and `ACCEPTED · adcs_torque [0x03 0xe7]` in UPLINK ACTIVITY:

![Sustained energy supply critical](screenshots/gs-energy-critical.png)

**Command Builder** — the visitor's attacker console; GENERATE unlocks only at 4/4:

![Command Builder armed at 4/4](screenshots/generator-command-builder.png)

## 7. Troubleshooting
| Symptom | Check |
|---|---|
| Dashboard stuck on "CONNECTING…" | GS backend (:4540) not running, or firewall |
| Uplink never reaches GS | OpenVSA `UPLINK_DEST` points at the right `GS` IP; :4536 open; uplink passed OpenVSA validation (antenna aligned, freq 449.5 MHz) |
| cf32 fails to decode in OpenVSA | `ccsds_ook.py` copied alongside `decoder.py` in `satellites/demosat/` |
| No alarm | Command must be `adcs_torque` with torque above the safe threshold |

## 8. Open items
- **Arduino solar panel + antenna**: firmware **written** — `arduino/solar_panel_uno`
  (SG90 servo) and `arduino/antenna_gimbal` (28BYJ-48 stepper), driven live by
  `arduino/bridge/bridge.js` polling `/api/state`. Sketch + bridge code done and
  self-testable over the serial monitor; **physical wiring bring-up and booth motor
  tuning (speed/travel) on real hardware still to be done.** See `arduino/README.md`.
- **OpenVSA end-to-end**: headless path verified (cf32 decode → :4536 forward → GS
  applies the effect). Full **Electron UI + real uplink** rehearsal against the
  procedure above still to be run live.
