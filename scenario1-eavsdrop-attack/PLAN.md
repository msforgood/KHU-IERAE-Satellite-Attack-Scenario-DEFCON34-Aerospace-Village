# Plan: Scenario 1, Eavesdrop Attack

## Message

A guided, booth-ready web experience that walks a visitor from "a satellite is passing
overhead" to "here is the image it was sending," using real tracking (GPredict), a real
VSA, and a real GNU Radio decode. Everything is local and reproducible.

## Decisions

| Topic | Decision |
|---|---|
| VSA | Reuse the OpenVSA fork (now `vsa/`) as-is; add only an electronAPI shim so it runs in a plain browser iframe. |
| Web guide | A single stdlib `http.server` (no pip deps), scenario-2 style: dark, monospace, cyan accent, phase tags and panels. Six phases in one page. |
| Tracking | GPredict in Docker over noVNC; a small control server resets the clock to just before a pass so a signal is always available. |
| Demod | Real GNU Radio in Docker over noVNC, running `enigma1_decoder.grc` on the uploaded recording; the recovered image is written live to `gnuradio-out/`. |
| Signal | ENIGMA-1 at 433.500 MHz, 9600 baud GFSK, AX.25 UI + G3RUH, a packetized image on a ~7.2 s loop. |
| Physical | An Arduino booth antenna that aims and locks from the VSA lock signal, bridged over a WebSocket. |

## Milestones

| Phase | Item | Status |
|---|---|---|
| 0 | Repo layout + run scripts (WSL + Docker, mirrored networking, high ports) | done |
| 1 | Web guide: six phases, stepper, pipeline banner | done |
| 2 | Satellite dossier (TARGET) from the VSA specs | done |
| 3 | TRACK: GPredict + VSA embedded, pass reset, remaining-time countdown | done |
| 4 | DEMOD PUZZLE: upload gate + block puzzle for `enigma1_decoder.grc` | done |
| 5 | GNU RADIO: run the flowgraph on the upload; live row-by-row reassembly | done |
| 6 | RESULT: recovered image + chain recap | done |
| R1 | Refactor: English-only UI, enlarged fonts, scenario-2 design alignment | done |
| R2 | Refactor: file structure toward scenario-2 naming (`web-guide/`, `vsa/`, `decoder/`, `arduino/`, `signal/`, `docs/`) and reference updates | done |
| A1 | Add a signal-analysis phase (RF analysis tools) after PHASE 4 upload | planned |

## The file-structure refactor (R2, completed)

Scenario 1 is single-role, so there is no `attacker/` vs `victim/` split. The layout now uses
scenario-2 naming while keeping each functional folder self-contained. The moves applied were:

```
web/               -> web-guide/
VSA-DEFCON2026/     -> vsa/
postProcess/       -> decoder/
booth_antenna/ + arduino_bridge.py -> arduino/
enigma34_downlink.cf32 (+ .bak)    -> signal/
(new)              -> docs/
(keep)             gpredict-web/ gpredict-config/ gnuradio-web/ run/ gnuradio-out/
```

This touched ~19 files that referenced the old paths (`web-guide/server.py`, `run/*.sh`,
`gnuradio-web/*.sh`, the VSA `server.js`, `arduino/arduino_bridge.py`, and the docker mounts),
plus the running containers. It was executed as a single controlled step with verification, not
piecemeal, to avoid breaking the live demo. After the moves the WSL and Docker Desktop file
caches were refreshed so the new bind-mount paths resolve.

## Verification

- Web: `http://localhost:8080` renders all six phases; the served HTML/JS/CSS and the
  dossier API contain no Korean, no em-dash, no middle-dot.
- Track: `run/gpredict.sh` then RESET produces a pass with a maximum elevation above the
  configured minimum; the web countdown matches gpredict.
- Decode: `run/gnuradio.sh` runs the flowgraph on the uploaded file and writes a recovered
  PNG that the web guide reassembles live.
