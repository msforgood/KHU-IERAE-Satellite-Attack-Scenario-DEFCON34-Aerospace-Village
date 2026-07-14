# Scenario 3 — Telemetry Spoofing (Drone "I'm fine")

DEFCON 34 Aerospace Village booth demo. **"If you can't see the attack, you can't
stop it — a forged 'all-nominal' beacon hides a satellite that's already dying."**

Builds directly on Scenario 2. Phases ①②③ are identical: a visitor abuses a
**reaction-wheel torque (ADCS)** command and uplinks it → the satellite tumbles →
the solar panel loses sun-track → **power collapses** → the victim ground-station
dashboard raises a critical alarm and the physical solar panel spins.

**New in Scenario 3 — Phase ④ (drone spoof):** a rogue **drone impersonates the
satellite** and replays a forged *healthy* beacon at the ground station. The GS
**dashboard flips back to NOMINAL and the alarm is suppressed** — but the real
satellite **keeps tumbling** (the physical motors never stop). The deception lives
only on the operator's screen. *No real RF, and the drone is not physically wired —
the spoof is software-simulated.*

## Layout
| Directory | Contents | Ownership |
|---|---|---|
| `docs/` | Command spec (CCSDS TC + OOK), operator & participant guides | — |
| `attacker/packet-generator/` | ① Python command generator + web UI (phases ①–④ host) | ours |
| `attacker/openvsa/` | Forked OpenVSA (VSA) — demosat plugin + forward patch applied | fork |
| `attacker/gpredict/` + `attacker/console/` | ③ gpredict fork + targeting web console | fork/ours |
| `attacker/drone/` | ④ **Drone spoof console** (forged-beacon UI, `/api/spoof` toggle) | ours |
| `victim/` | Victim GS web UI — alarm dashboard + `/api/spoof` deception hook | ours |
| `arduino/` | Physical solar panel + antenna sketches + serial bridge | ours |

## How the spoof works (the important part)
The GS backend keeps **two views of the same telemetry**:
- **`/api/state`** (Arduino bridge / physical motors) → **always the real, tumbling
  state.** The satellite keeps dying; the panel keeps spinning.
- **Dashboard WebSocket** (what the operator sees) → real state, *unless spoofing is
  on*, in which case a drone-forged **NOMINAL** beacon (battery ~98%, SUN-TRACKING,
  COMM CONNECTED, no tumbling flag) is broadcast instead.

`POST /api/spoof {on:true}` engages it; `{on:false}` (or `/api/reset`) restores the
truth. Because only the browser stream is rewritten, the alarm disappears while the
crisis continues underneath — exactly the point of the demo.

## End-to-end flow
```
① build → ② point antenna → ③ TRANSMIT → GS ALARM (satellite tumbling, panel spins)
                                                   │
④ drone spoof:  POST /api/spoof {on:true}  ──▶  GS dashboard → NOMINAL (alarm hidden)
                                                   └▶ /api/state + motors: STILL TUMBLING
```

## Quick start (local, without OpenVSA)
```
# terminal 1 — victim ground station
cd victim/backend && node server.js         # http://localhost:4540

# terminal 2 — attacker console (phases ①–④)
cd attacker/packet-generator/webapp && python3 app.py   # http://localhost:8000

# terminal 3 — drive it by hand (until OpenVSA/gpredict are wired in)
curl -X POST http://localhost:4540/api/inject -H 'Content-Type: application/json' \
  -d '{"command":"adcs_torque","payload":["0x03","0xe7"]}'   # ③ attack → alarm
curl -X POST http://localhost:4540/api/spoof  -d '{"on":true}'   # ④ drone spoof → alarm hidden
curl -X POST http://localhost:4540/api/spoof  -d '{"on":false}'  #    restore the truth
curl -X POST http://localhost:4540/api/reset                     #    full reset
```
In the attacker UI, phase ④ opens after TRANSMIT via the **"④ DRONE SPOOF → HIDE THE
ALARM"** button; the drone console embeds the live victim dashboard so you watch it
flip **RED → GREEN**.

Plan: `PLAN.md` · Spec: `docs/command-spec.md` · Guides: `docs/operator-guide.md`,
`docs/participant-guide.md`.
