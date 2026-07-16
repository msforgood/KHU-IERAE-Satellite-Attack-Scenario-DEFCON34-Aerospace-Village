# Scenario 4 "Constellation Chaos", Development Plan

## Message

DEFCON 34 Aerospace Village booth demo: **"One satellite's problem cascades to many."**
A visitor abuses the delta-v of a legitimate satellite **orbit maneuver (station-keeping)**
command and uplinks it. DEMOSAT (a 500 km satellite) raises its orbit into the
neighbouring **AURORA constellation** ring (560 km, 45 satellites), **collides** with a
member, and the debris cascade threatens the rest of the fleet. The victim ground station
dashboard raises a collision alarm and plays a debris-cascade video. No real RF, the
uplink is software-simulated (same as scenario 2).

The demo runs on one laptop with two monitors:
- **Monitor 1** (laptop screen, the visitor drives): orbit planner + `orbit_maneuver`
  packet crafting + software uplink. Attacker console on port 8000.
- **Monitor 2** (external screen, observation only): the collision simulation on top, the
  ground station dashboard + alarm + debris video below. Victim GS on port 4540.

Scope we build = the attacker console (orbit planner and packet generator) and the victim
GS web UI (collision sim and dashboard). OpenVSA is reused untouched for an optional
RF-flavored rehearsal, but the default uplink is a plain HTTP POST from monitor 1 to
monitor 2. Command structure = CCSDS TC frame + OOK physical layer, developed from
scenario 2.

## Decisions
| Item | Decision |
|---|---|
| Two monitors, one laptop | Monitor 1 = laptop screen (attacker, :8000); monitor 2 = external screen (victim GS, :4540) |
| Uplink transport | Software-simulated. TRANSMIT POSTs the decoded command to the GS `/api/inject`. No real RF/HackRF |
| Main command | `orbit_maneuver`, opcode 0x50, apid 0x050, 4-byte payload = two signed int16 BE delta-v in m/s (prograde, then radial) |
| Shared orbital math | Both monitors load `satellite-sim/kepler.js` + `scenario.js`, so the predicted outcome on monitor 1 always matches monitor 2 |
| Command structure | CCSDS TC frame + OOK, reused and extended from scenario 2; we author the DEMOSAT plugin (protocol + decoder) |
| OpenVSA path | Optional. Drop the plugin in and forward to the GS on :4536 for an RF rehearsal; not needed for the booth |
| Reliability principle | Avoid build tooling and external deps: generator = Python stdlib + numpy, GS backend = pure Node (hand-rolled WebSocket in `miniws.js`), sim + frontends = plain HTML/CSS/vanilla JS |
| Simulation seam | `satellite-sim/` is a dependency-free 2D canvas placeholder behind a stable public API (`SatSim`, `SatKepler`, `Scenario4`); the 3D `satellite-tracker` port drops in later without touching either monitor |

## Integration interface
- **Attacker to GS (default):** monitor 1 TRANSMIT calls `POST /api/uplink` on its own
  server, which builds the validated `attack.cf32`, reads `{command, payload}` from the
  frame breakdown, and forwards `{type:"uplink-command", satellite, command, payload,
  frequency, params}` to `GS_URL/api/inject` (default `http://localhost:4540`).
- **GS decode + outcome:** `server.js` decodes the 4-byte payload into (prograde, radial),
  runs `computeOutcome()` with the same math the sim uses, and broadcasts a `maneuver`
  event (with the outcome) to every dashboard client over WebSocket.
- **Reset:** monitor 1's RESET button calls `POST /api/reset-target`, which POSTs
  `/api/reset` on the GS; the GS broadcasts `reset` and both the sim and dashboard return
  to nominal. `curl -X POST http://localhost:4540/api/reset` does the same directly.
- **OpenVSA (optional):** `server.js` also listens for `uplink-command` on WS port 4536,
  so an OpenVSA forward reaches the same `handleUplink()` path as `/api/inject`.

## Milestones
| Phase | Content | Deliverables | Status |
|---|---|---|---|
| 0 | Spec + scaffolding | `docs/command-spec.md`, DEMOSAT plugin (`orbit_maneuver` 0x50), repo layout | done |
| 1 | Codec + generator + roundtrip | `ccsds_ook.py`, `generate.py`, `decoder.py`, roundtrip test | code done |
| 2 | Simulation seam | `satellite-sim/` kepler math + 2D renderer + shared constellation, stable public API | code done |
| 3 | Attacker console (monitor 1) | orbit planner + 4-step packet crafting + GENERATE + software uplink (`webapp/app.py`) | code done |
| 4 | Victim GS backend (monitor 2) | pure Node `server.js`, `miniws.js`, payload decode + deterministic collision outcome + broadcast | code done |
| 5 | Victim GS frontend (monitor 2) | collision sim (top) + dashboard + collision alarm + debris video (bottom) | code done |
| 6 | E2E + booth tuning + guides | operator and participant guides, run-through, visual/pacing tuning | in progress |
| 7 | 3D simulation port | swap the `satellite-sim/` placeholder for the `satellite-tracker` Three.js port behind the same API | pending |

## Key implementation notes
- **Main command `orbit_maneuver` (opcode 0x50):** the 4-byte payload is two signed int16
  big-endian values in m/s, prograde then radial. `decodeManeuver()` in `server.js` is the
  exact inverse of the generator's encoder. A safe station-keeping burn is at most 2 m/s
  (`safeAbsMax`); the console flags anything larger as beyond a normal burn.
- **Deterministic outcome:** `computeOutcome()` applies the delta-v with
  `SatKepler.applyManeuver2D`, checks whether the new apoapsis lands in the collision
  course band (`courseLo..courseHi` around the ring), and finds the earliest closest
  approach against every AURORA member. Because monitor 1's planner and monitor 2's GS use
  the same functions, the preview and the playback never disagree.
- **Collision course tuning:** the AURORA ring is dense (45 satellites, one every 8
  degrees), so DEMOSAT collides once its apoapsis reaches the ring altitude. A prograde
  burn of roughly 15 to 30 m/s lands in the band; smaller falls short, larger overshoots.
  The suggested aim (`aimHintDv`) is 22 m/s.
- **Miss path and reset:** if the burn misses, monitor 2 shows "no collision, reset to
  retry" and monitor 1 exposes RESET. RESET returns both monitors to nominal so the next
  visitor (or the same one) can recompute the angle.
- **Sim seam:** `satellite-sim/` is a 2D coplanar placeholder (`inc=raan=0`). The public
  API (`SatSim`, `SatKepler`, `Scenario4`) is what the 3D port must preserve; only the
  internals change.

## Verification
- Codec roundtrip: `python3 attacker/packet-generator/tests/test_roundtrip.py`.
  Console: `cd attacker/packet-generator/webapp && python3 app.py` (port 8000).
- GS: `node victim/backend/server.js` (dashboard on 4540, uplink WS on 4536). Inject a
  maneuver with `curl -X POST http://localhost:4540/api/inject` and watch the dashboard
  animate the burn and, on a collision course, raise the alarm and play the debris video.
- End-to-end: run both start scripts, raise the prograde delta-v on monitor 1 until the
  planner reads COLLISION COURSE, GENERATE and TRANSMIT, and confirm monitor 2 collides.

## Open decisions / remaining work
- Replace the `satellite-sim/` 2D placeholder with the 3D `satellite-tracker` port (Phase
  7) behind the same public API.
- Swap the placeholder `assets/orbit_demo.mp4` for the final debris-cascade video.
- Booth pacing tuning: `impactTargetSec` / `playbackSpeed` in `scenario.js`, and the
  collision course band, tuned against a live run-through.
- Optional OpenVSA live end-to-end rehearsal (Electron UI + forward to :4536); the default
  software uplink path is what the booth uses.
- The `victim/backend/satellite-state.js` file is a leftover from the scenario 2 port and
  is not loaded by scenario 4's `server.js`; it can be removed in cleanup.
