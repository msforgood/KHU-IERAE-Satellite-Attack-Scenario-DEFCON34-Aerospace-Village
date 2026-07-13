# Scenario 2 — Uplink Attack

DEFCON 34 Aerospace Village booth demo. **"Even a legitimate command becomes an
attack when it is abused."**

A visitor abuses the value of a **satellite reaction-wheel torque (ADCS)** command and
uplinks it → the satellite spins out of control → the solar panel loses sun-track →
**power generation collapses (energy supply failure)** → the victim ground station
dashboard raises a critical alarm and the physical solar panel spins wildly.
*No real RF — the uplink is software-simulated.*

## Layout
| Directory | Contents | Ownership |
|---|---|---|
| `docs/` | Command spec (CCSDS TC + OOK), operator & participant guides | — |
| `attacker/packet-generator/` | ① Python command generator + web UI (cf32 output) | ours |
| `attacker/openvsa/` | Forked OpenVSA (VSA) — demosat plugin + forward patch applied; `satellites/demosat/` is the single source for satellite config + CCSDS codec | fork |
| `attacker/gpredict/` + `attacker/console/` | ③ gpredict fork + web console (3rd screen) | fork/ours |
| `victim/` | ② Victim GS web UI (alarm dashboard) | ours |
| `arduino/` | ③ Physical solar panel + antenna sketches + serial bridge | ours |

## End-to-end flow
```
generate → attack.cf32 → [OpenVSA load / uplink] → ws:4536 → [GS web UI alarm]
                                                            └→ serial bridge → Arduino solar panel + antenna
```

## Quick start (local, without OpenVSA)
```
# terminal 1 — victim ground station
cd victim/backend && node server.js         # http://localhost:4540

# terminal 2 — attacker command builder
cd attacker/packet-generator/webapp && python3 app.py   # http://localhost:8000

# terminal 3 — inject a mock uplink (until OpenVSA is wired in)
curl -X POST http://localhost:4540/api/inject -H 'Content-Type: application/json' \
  -d '{"command":"adcs_torque","payload":["0x03","0xe7"]}'
```

Plan: `PLAN.md` · Spec: `docs/command-spec.md` · Guides: `docs/operator-guide.md`,
`docs/participant-guide.md`.
