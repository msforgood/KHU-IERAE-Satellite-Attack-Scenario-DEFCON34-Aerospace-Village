# Scenario 4 — Constellation Chaos

DEFCON 34 Aerospace Village booth demo. **"One satellite's problem cascades to many."**

A visitor abuses the delta-v of a legitimate **orbit maneuver (station-keeping)** command
and uplinks it. The satellite (DEMOSAT) raises its orbit into a neighbouring
**constellation (AURORA)**, collides with a member, and the debris cascade threatens the
rest of the fleet. The victim ground station raises a collision alarm.
*No real RF, the uplink is software-simulated (same as scenario 2).*

Two monitors:
- **Monitor 1** (laptop screen, the visitor drives): plan the burn in the orbit simulation,
  craft the command packet, and transmit the uplink.
- **Monitor 2** (external screen, observation only): the satellite simulation on top plays
  the maneuver and collision, the ground station dashboard below shows the telemetry + alarm.

## Layout

| Directory | Contents |
|---|---|
| `attacker/packet-generator/` | Monitor 1 command builder (Python stdlib server): orbit planner + orbit_maneuver packet crafting + uplink |
| `attacker/openvsa-plugin/demosat/` | CCSDS TC + OOK codec, `orbit_maneuver` opcode 0x50 (two int16 delta-v m/s), decoder, protocol table |
| `victim/backend/` | Monitor 2 ground station (pure Node): decodes the maneuver, computes the collision outcome, broadcasts to the dashboard |
| `victim/frontend/` | Monitor 2 web UI: collision simulation (top) + telemetry dashboard + alarm + debris video (bottom) |
| `satellite-sim/` | The simulation seam: dependency-free 2D canvas placeholder (kepler math + renderer + zoom). Swapped for the 3D `satellite-tracker` port later |
| `assets/orbit_demo.mp4` | Debris-cascade video (placeholder, played on collision) |

## Flow

```
[Monitor 1] plan burn (sim) -> craft orbit_maneuver packet -> TRANSMIT
      -> /api/uplink -> [victim GS /api/inject] -> decode delta-v + compute outcome
      -> broadcast "maneuver" -> [Monitor 2] sim animates the burn
      -> collision: FX + debris video + dashboard alarm   (or miss: RESET and recompute)
```

The attacker console and the ground station use the **same orbital math**
(`satellite-sim/kepler.js`), so the predicted outcome on monitor 1 always matches what
plays out on monitor 2.

## Run

```
# terminal 1 — victim ground station (monitor 2)   http://localhost:4540
./start-victim.sh

# terminal 2 — attacker console (monitor 1)         http://localhost:8000
./start-attacker.sh
```

Then on monitor 1: raise the **prograde Δv** until the orbit planner reads
**COLLISION COURSE** (around 15-30 m/s), complete the 4 build steps, GENERATE, and
TRANSMIT. Watch monitor 2 for the collision. If the burn misses, press RESET and recompute.

Manual start (no launcher):
```
cd victim/backend && node server.js                                   # :4540
cd attacker/packet-generator/webapp && GS_URL=http://localhost:4540 python3 app.py   # :8000
```

## The simulation seam

`satellite-sim/` is a placeholder. When the full 3D simulation is ported from
`../../satellite-tracker`, it drops in behind the same public API (`SatSim`,
`window.SatKepler`, `window.Scenario4`) and both monitors keep working. See
`satellite-sim/README.md` for the interface.

Plan: `PLAN.md`, Spec: `docs/command-spec.md`.
