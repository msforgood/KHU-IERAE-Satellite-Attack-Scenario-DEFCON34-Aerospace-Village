# KHU-IERAE-Satellite-Attack-Scenario-DEFCON34-Aerospace-Village
KHU-IERAE Satellite Attack Scenario DEFCON34 Aerospace Village

## Layout
```
common/                      shared phases ①②③ (attacker ①②③ + victim GS + arduino + docs)
                             — single source of truth for scn2/scn3/scn4; edit here once
scenario1-eavsdrop-attack/   scn1 — eavesdrop/downlink (self-contained, separate flow)
scenario2-uplink-attack/     scn2 — uplink attack (thin: scenario.json + start scripts → common)
scenario3-spoofing/          scn3 — telemetry spoofing (thin: + extras/drone phase ④)
```
Scenarios 2·3·4 share `common/` at runtime (their `start-*.sh` reference `../common`) and
express differences only through `scenario.json` (phase config) + `extras/` (extra screens)
+ dormant runtime hooks. See [`common/README.md`](common/README.md). scn1 is a different
attack and stays self-contained.

Run a scenario from its own folder: `./start-victim.sh` + `./start-attacker.sh up`.
