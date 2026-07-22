# Scenario 2 — Uplink Attack

DEFCON 34 Aerospace Village booth demo. **"Even a legitimate command becomes an
attack when it is abused."**

A visitor abuses the value of a **satellite reaction-wheel torque (ADCS)** command and
uplinks it → the satellite spins out of control → the solar panel loses sun-track →
**power generation collapses** → the victim ground station dashboard raises a critical
alarm and the physical solar panel spins wildly. *No real RF — the uplink is
software-simulated.*

## Structure (thin scenario over `common/`)
Phases ①②③ live in the shared **[`../common/`](../common/README.md)** tree (Command
Builder, OpenVSA, gpredict, targeting console, victim GS). This folder carries only
scenario 2's delta:

| Path | Contents |
|---|---|
| `scenario.json` | phase descriptor — `phaseCount: 3`, no extras (the base attack) |
| `start-attacker.sh` | boots `../common/attacker` (①②③) with this scenario's config |
| `start-victim.sh` | boots `../common/victim` (GS dashboard `:4540`) |
| `GOAL.md` · `PLAN.md` | scenario design notes |

Edit the attack flow in `../common/`, not here — scn2/scn3/scn4 all share it.

## End-to-end flow
```
generate → attack.cf32 → [OpenVSA load / uplink] → ws:4536 → [GS web UI alarm]
                                                            └→ serial bridge → Arduino solar panel + antenna
```

## Quick start (local, without OpenVSA)
```
# terminal 1 — victim ground station (../common/victim)
./start-victim.sh                            # http://localhost:4540

# terminal 2 — attacker command builder (../common/attacker, phases ①②③)
./start-attacker.sh up                       # http://localhost:8000

# terminal 3 — inject a mock uplink (until OpenVSA is wired in)
curl -X POST http://localhost:4540/api/inject -H 'Content-Type: application/json' \
  -d '{"command":"adcs_torque","payload":["0x03","0xe7"]}'
```

Spec + guides live in `../common/docs/` (`command-spec.md`, `operator-guide.md`,
`participant-guide.md`).
