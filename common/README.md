# common/ — shared phases ①②③ for scenarios 2·3·4

DEFCON 34 Aerospace Village booth. This directory is the **single source of truth**
for the uplink-attack flow (phases ①②③) shared by every scenario that builds on it
(scn2 Uplink Attack, scn3 Telemetry Spoofing, scn4 …). Edit the attack logic **here,
once** — the scenario folders only carry their own deltas.

```
common/
  attacker/
    packet-generator/   ① Command Builder (Python webapp + CCSDS/OOK codec)
    openvsa/            OpenVSA fork — satellites/demosat/ = single source of truth
    gpredict*/ console/ ③ targeting: gpredict (noVNC) + OpenVSA renderer + console
  victim/
    backend/            GS dashboard server (+ dormant /api/spoof hook)
    frontend/           GS dashboard UI
  arduino/              solar-panel + antenna sketches + serial bridge
  docs/                 command spec + operator/participant guides (shared base)
```

## How scenarios plug in (no edits to common)
A scenario folder (e.g. `../scenario3-spoofing/`) references this tree at runtime via
its `start-*.sh` (which `cd ../common/...`) and expresses its differences through **two
generic extension points** — never by forking a common file:

1. **`scenario.json`** → passed as `SCENARIO_CONFIG`. The Command Builder serves it at
   `/api/scenario`; the template renders any **extra phases (④+)** — a nav button on the
   `enterFrom` phase plus a full-screen iframe — from its `extras[]`. No extras ⇒ the
   plain 3-phase attack.
   ```json
   { "id":"scn3", "phaseCount":4,
     "extras":[{ "id":"phase4", "label":"④ DRONE SPOOF …",
                 "path":"/extra/drone/index.html", "enterFrom":"phase3" }] }
   ```
2. **`extras/`** → passed as `EXTRA_DIR`, served at **`/extra/…`**. A scenario drops its
   own screens here (e.g. `extras/drone/index.html`).

Runtime hooks on the victim side follow the same rule: the GS backend ships a **dormant
`/api/spoof`** endpoint. scn2 never calls it; scn3's drone console does. Adding a
scenario means adding a folder + config + screens — not touching `common/`.

## Run
Don't run from here — run from a scenario folder, which points its start scripts at this
tree:
```
cd ../scenario3-spoofing && ./start-victim.sh   # GS   (../common/victim)
cd ../scenario3-spoofing && ./start-attacker.sh # ①②③ (../common/attacker) + scn3 extras
```
