# Scenario 3 — Telemetry Spoofing (Drone "I'm fine")

DEFCON 34 Aerospace Village booth demo. **"If you can't see the attack, you can't
stop it — a forged 'all-nominal' beacon hides a satellite that's already dying."**

Builds on Scenario 2. Phases ①②③ are identical (shared from `../common/`): a visitor
abuses a **reaction-wheel torque (ADCS)** command and uplinks it → the satellite tumbles
→ the solar panel loses sun-track → **power collapses** → the victim GS dashboard raises
a critical alarm and the physical solar panel spins.

**New — Phase ④ (drone spoof):** a rogue **drone impersonates the satellite** and replays
a forged *healthy* beacon at the ground station. The GS **dashboard flips back to NOMINAL
and the alarm is suppressed** — but the real satellite **keeps tumbling** (the physical
motors never stop). The deception lives only on the operator's screen. *No real RF, and
the drone is not physically wired — the spoof is software-simulated.*

## Structure (thin scenario over `common/`)
Phases ①②③ + the victim GS come from the shared **[`../common/`](../common/README.md)**
tree. This folder carries only scenario 3's delta:

| Path | Contents |
|---|---|
| `scenario.json` | `phaseCount: 4` + one extra phase pointing at `/extra/drone/index.html` |
| `extras/drone/index.html` | ④ **drone spoof console** — forged-beacon UI + `/api/spoof` toggle + embedded live GS view |
| `start-attacker.sh` | boots `../common/attacker` and passes this folder's `scenario.json` + `extras/` |
| `start-victim.sh` | boots `../common/victim` (the GS ships a dormant `/api/spoof` hook) |
| `GOAL.md` · `PLAN.md` | scenario design notes |

Nothing in `common/` is edited: phase ④ is added purely via `scenario.json` (extra phase)
+ `extras/` (the screen), and the GS's `/api/spoof` hook is dormant until the drone calls it.

## How the spoof works (the important part)
The GS backend keeps **two views of the same telemetry**:
- **`/api/state`** (Arduino bridge / physical motors) → **always the real, tumbling
  state.** The satellite keeps dying; the panel keeps spinning.
- **Dashboard WebSocket** (what the operator sees) → real state, *unless spoofing is
  on*, in which case a drone-forged **NOMINAL** beacon (battery ~98%, SUN-TRACKING,
  COMM CONNECTED, no tumbling flag) is broadcast instead.

`POST /api/spoof {on:true}` engages it; `{on:false}` (or `/api/reset`) restores the truth.
Only the browser stream is rewritten, so the alarm disappears while the crisis continues.

## End-to-end flow
```
① build → ② point antenna → ③ TRANSMIT → GS ALARM (satellite tumbling, panel spins)
                                                   │
④ drone spoof:  POST /api/spoof {on:true}  ──▶  GS dashboard → NOMINAL (alarm hidden)
                                                   └▶ /api/state + motors: STILL TUMBLING
```

## Quick start (local, without OpenVSA)
```
# terminal 1 — victim ground station (../common/victim)
./start-victim.sh                            # http://localhost:4540

# terminal 2 — attacker console (../common/attacker, phases ①–④)
./start-attacker.sh up                       # http://localhost:8000

# terminal 3 — drive it by hand (until OpenVSA/gpredict are wired in)
curl -X POST http://localhost:4540/api/inject -H 'Content-Type: application/json' \
  -d '{"command":"adcs_torque","payload":["0x03","0xe7"]}'   # ③ attack → alarm
curl -X POST http://localhost:4540/api/spoof  -d '{"on":true}'   # ④ drone spoof → alarm hidden
curl -X POST http://localhost:4540/api/spoof  -d '{"on":false}'  #    restore the truth
curl -X POST http://localhost:4540/api/reset                     #    full reset
```
In the attacker UI, phase ④ opens after TRANSMIT via the **"④ DRONE SPOOF → HIDE THE
ALARM"** button (rendered from `scenario.json`); the drone console embeds the live victim
dashboard so you watch it flip **RED → GREEN**.

Spec + guides live in `../common/docs/`.
