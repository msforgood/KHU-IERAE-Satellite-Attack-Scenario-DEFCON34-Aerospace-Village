# Operator Guide, Scenario 4 "Constellation Chaos"

DEFCON 34 Aerospace Village. For **booth operators** running the demo. For the card
visitors follow, see `participant-guide.md`.

Message of the demo: **"One satellite's problem cascades to many."** A visitor abuses a
legitimate orbit maneuver command and uplinks it; DEMOSAT raises its orbit into the AURORA
constellation ring, collides with a member, and the debris cascade threatens the fleet.
The victim ground station dashboard raises a collision alarm and plays a debris video. No
real RF, the uplink is software-simulated.

## 1. Topology

One laptop, two monitors. Both web apps run on the same machine.

```
[One laptop]
  Monitor 1 (laptop screen)     Attacker console   http://localhost:8000
    - orbit planner (find a burn that hits AURORA)
    - orbit_maneuver packet crafting
    - TRANSMIT (software uplink)
                     │  HTTP POST /api/inject
                     ▼
  Monitor 2 (external screen)   Victim ground station   http://localhost:4540
    - collision simulation (top)
    - ground station dashboard + alarm + debris video (bottom)

  (optional) OpenVSA / VSA ── WS ──▶ GS :4536   (RF-flavored rehearsal only)
```

Software-simulated: TRANSMIT on monitor 1 builds the validated IQ file, decodes its own
frame, and POSTs the resulting `{command, payload}` to the ground station, which decodes
the delta-v and computes the collision outcome with the same orbital math the sim uses.

## 2. Prerequisites
- One laptop with an external monitor attached (extended display, not mirrored).
- Python 3 + numpy (attacker console), Node 20 (ground station).
- A modern browser. Two windows, one per monitor, each in full-screen (F11).
- No HackRF, antenna, or toy satellite in this scenario.

## 3. Startup order

**Step 1, victim ground station (start first), monitor 2**
```
cd victim/backend
node server.js
#   dashboard    http://localhost:4540   (open on the external monitor, full-screen)
#   uplink WS    :4536   (optional OpenVSA input)
#   env:  GS_HTTP_PORT=4540   UPLINK_PORT=4536
```
Or use the launcher: `./start-victim.sh`.

**Step 2, attacker console, monitor 1**
```
cd attacker/packet-generator/webapp
GS_URL=http://localhost:4540 python3 app.py
#   http://localhost:8000   (open on the laptop screen, this is what the visitor drives)
#   env:  GS_URL (uplink + reset target)   PORT=8000   UPLINK_OUT_DIR (~/uplink)
```
Or use the launcher: `./start-attacker.sh` (first run installs numpy in a venv, then runs
a codec roundtrip check before starting).

The visitor drives the console through two phases:
- **Phase 1, briefing:** read the concept, tick the acknowledgement, press PLAN THE ATTACK.
- **Phase 2, plan and build:** raise the **prograde delta-v** in the orbit planner until
  the status reads **COLLISION COURSE** (around 15 to 30 m/s), then complete the 4-step
  uplink assembly (SCID, command, value, RF config), GENERATE, and TRANSMIT.

If a visitor is stuck on the assembly, point them at the **TARGET INTEL** dossier on the
left of the console; every field (SCID 200, OOK, 100 bps, 24 kSa/s) must match.

## 4. Reset between visitors
Press **RESET SIMULATION (monitor 2)** on the attacker console after a run. It returns
both the simulation and the dashboard to nominal. Equivalent from a terminal:
```
curl -X POST http://localhost:4540/api/reset
```
The console itself is stateless; a browser refresh is optional.

## 5. Tuning knobs
| Goal | Location | Value |
|---|---|---|
| Safe station-keeping threshold | `attacker/openvsa-plugin/demosat/c2protocol.json` opcode `0x50` -> `safeAbsMax` | 2 (m/s) |
| Suggested aim shown to the visitor | `satellite-sim/scenario.js` -> `aimHintDv` | 22 (m/s) |
| Collision course band (how forgiving the hit is) | `satellite-sim/scenario.js` -> `simOpts.courseLo` / `courseHi` | ring radius minus 25 km to plus 65 km |
| Playback pacing (how long the burn takes on screen) | `satellite-sim/scenario.js` -> `simOpts.impactTargetSec` / `playbackSpeed` | 20 s / 320x |
| Constellation size / ring altitude | `satellite-sim/scenario.js` -> ring loop, `RING_ALT_KM` | 45 satellites, 560 km |

## 6. What "correct" looks like
- **Nominal (before TRANSMIT):** green banner, "NOMINAL, all satellites separated and
  station-keeping". DEMOSAT apoapsis and periapsis both 500 km, ring 560 km, orbit tag
  STATION-KEEPING, AURORA 45 of 45 operational, threat NONE.
- **Maneuver in progress (right after TRANSMIT):** amber banner "MANEUVER IN PROGRESS",
  orbit tag MANEUVERING, the sim animates DEMOSAT's orbit rising toward the ring. The
  planner on monitor 1 and the sim on monitor 2 agree on the outcome.
- **Collision (abused burn on a collision course):** red banner "COLLISION, DEMOSAT struck
  AURORA-xx", orbit tag DESTROYED, threat DEBRIS CASCADE (blinking), closest approach
  "0 km, IMPACT". A full-screen alarm flashes for about 5 seconds then clears so the live
  telemetry stays visible, the debris video overlay plays, and the operational count drops
  below 45 of 45.
- **Miss (burn too small or too large):** amber banner "Maneuver complete, DEMOSAT missed
  the constellation (no collision). Awaiting reset.", orbit tag OFF-NOMINAL ORBIT. Press
  RESET and have the visitor recompute the angle.
- Reference screenshots: `screenshots/` (regenerate for scenario 4, see section 8).

## 7. Troubleshooting
| Symptom | Check |
|---|---|
| Dashboard stuck on "CONNECTING..." | GS backend (:4540) not running |
| TRANSMIT says "ground station unreachable" | `GS_URL` on the console points at the running GS (default `http://localhost:4540`); the GS is up |
| GENERATE stays locked | All 4 assembly steps must be correct: SCID 200, command orbit_maneuver, value confirmed, RF = OOK / 100 bps / 24 kSa/s |
| Burn always misses | Prograde too small (falls short of the ring) or too large (overshoots); aim for roughly 15 to 30 m/s so apoapsis reaches 560 km |
| No debris video | `assets/orbit_demo.mp4` present; browser allows muted autoplay (the clip is muted) |
| Monitors mirrored | Set the OS display to extend, not mirror, so the visitor and audience see different screens |

## 8. Open items
- **Screenshots:** `docs/screenshots/` still holds scenario 2 captures (ground station
  energy alarm). Recapture the scenario 4 states: nominal dashboard, maneuver in progress,
  collision with the debris video, and the attacker console planner reading COLLISION
  COURSE.
- **3D simulation:** the `satellite-sim/` view is a 2D placeholder; the `satellite-tracker`
  3D port drops in behind the same API later.
- **Debris video:** `assets/orbit_demo.mp4` is a placeholder clip; swap in the final
  debris-cascade video when it is ready.
- **OpenVSA rehearsal:** the optional RF path (forward to :4536) is available but not
  required for the booth.
