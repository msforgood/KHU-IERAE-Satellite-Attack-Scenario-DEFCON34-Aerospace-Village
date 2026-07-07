# Scenario 2 "Uplink Attack" — Development Plan

## Message

DEFCON 34 Aerospace Village booth demo: **"Even a legitimate command becomes an attack
when it is abused."** A visitor abuses the value of a satellite **reaction-wheel torque
(ADCS)** command and uplinks it → the satellite spins out of control → the solar panel
loses sun-track → **power generation collapses (energy supply failure)** → the victim
ground station dashboard alarms and the physical solar panel spins. No real RF — the
uplink is software-simulated.

Scope we build = ① Python packet generator, ② victim GS web UI. OpenVSA (the attacker
VSA tool) is reused with its core untouched. Command structure = CCSDS TC frame + OOK
physical layer.

## Decisions
| Item | Decision |
|---|---|
| VSA (attacker tool) | OpenVSA (github whal-e3/OpenVSA), used as-is, core untouched |
| VSA→GS transport | Software-simulated (WebSocket) — no real RF/HackRF |
| Command structure | CCSDS TC frame + OOK; we author a satellite plugin (protocol + decoder) |
| OpenVSA forward patch | Adopt a small patch to include opcode/payload (to show the torque value on the dashboard) |
| Build order | Build the GS first (mock injection); OpenVSA integration later |
| Reliability principle | Avoid build tooling / external deps — generator = numpy only, GS backend = pure Node (RFC6455 hand-rolled), frontends = plain HTML/CSS/vanilla JS |
| Arduino solar panel | Trigger hook only for now (`ARDUINO_URL`); firmware TBD |

## Integration interface (from reading OpenVSA; no core edit)
- `server.js` `forwardUplinkCommand()` → on a validated uplink, sends
  `{type:"uplink-command", satellite, frequency, command, payload, purpose, timestamp}`
  to `ws://localhost:4536` (env `UPLINK_DEST`). The GS just listens on :4536.
- `electron/main.js` decode-uplink → runs `satellites/<sat>/decoder.py`.
- Reused assets: `src/lib/satellite-state.js` (state engine), `hardware-effects.json`
  (attack effects), `satellites/<sat>/panel.json` (dashboard layout).

## Milestones
| Phase | Content | Deliverables | Status |
|---|---|---|---|
| 0 | Spec + scaffolding | `docs/command-spec.md`, satellite plugin, repo layout | ✅ done |
| 1 | Python generator + matching decoder.py | codec `ccsds_ook.py`, `decoder.py`, web UI, roundtrip test | ✅ done, verified |
| 2 | OpenVSA integration | cf32 load → decode → validate → :4536 forward + forward payload patch | ⏳ pending (needs OpenVSA checkout) |
| 3 | GS backend | pure Node, miniws, ported state engine + Arduino hook | ✅ done, verified |
| 4 | GS frontend | `panel.json` dashboard + ENERGY SUPPLY CRITICAL alarm | ✅ done, browser-verified |
| 5 | E2E + booth tuning + guides | operator & participant guides, screenshots, visual tuning | ◑ GS side done (alarm auto-dismiss, physics fix); OpenVSA E2E pending Phase 2 |
| 6 (TBD) | Arduino trigger | hook ready (`ARDUINO_URL`); firmware after the Drive code | ⏳ TBD |

## Key implementation notes
- Main command `adcs_torque` (opcode 0x21): the effect sets tumbling + solarAttacked;
  the tick() tumbling block reuses `adcs_target` physics (panel drift + cosineDropoff
  power collapse). `adcs_torque_magnitude` payload handler surfaces the torque value
  and scales drain / sun-track loss by magnitude.
- Physics fix (Phase 5): tumbling panel drift used `(state[key] || 90)`, so an angle
  driven to exactly 0° (a valid off-sun state) reset to 90° and power recovered. Fixed
  to `?? 90`. Power now collapses to ~0 W and stays.
- Alarm UX (Phase 5): full-screen alarm flashes ~5 s then clears; the red banner + red
  panels + collapsing graphs persist so the live telemetry stays visible.

## Verification
- Phase 1: `python3 packet-generator/tests/test_roundtrip.py` → ALL PASSED. Web UI:
  `cd packet-generator/webapp && python3 app.py`.
- Phase 3/4: `node ground-station/backend/server.js`, inject a mock uplink, observe the
  dashboard escalate to ENERGY SUPPLY CRITICAL. Verified headless with Playwright +
  Chromium; reference screenshots in `docs/screenshots/`.
- Phase 2 (pending): drop the plugin into OpenVSA, run `UPLINK_DEST=ws://<GS>:4536 node
  server.js`, and confirm the uplink reaches the GS end-to-end.

## Open decisions
- Arduino trigger: hook only vs full integration (after reviewing the Drive firmware).
- OpenVSA end-to-end rehearsal against `docs/operator-guide.md`.
