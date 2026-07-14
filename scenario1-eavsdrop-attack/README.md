# Scenario 1: Eavesdrop Attack (ENIGMA-1 Downlink Decoder)

Passive intercept of a satellite downlink. There is no transmitting and no victim.
The visitor tracks a low-orbit cubesat (ENIGMA-1), tunes a receiver to its signal,
demodulates the recorded IQ with GNU Radio, and recovers the image the satellite was
beaconing. Everything runs locally, streamed into one guided web page.

This scenario mirrors the layout and web-UI style of `scenario2-uplink-attack`, adapted
to a single receive-only role.

## End-to-end flow

```
① TRACK    GPredict computes ENIGMA-1's orbit from its TLE and drives the antenna (az/el)
② SYNC     The VSA confirms the RF: 433.500 MHz center, 9600 baud GFSK, Doppler
③ CAPTURE  The visitor records the downlink IQ in the VSA and downloads a .cf32
④ ASSEMBLE The demod flowgraph is rebuilt as a block puzzle (enigma1_decoder.grc)
⑤ DECODE   Real GNU Radio runs the flowgraph on the uploaded file; the image is
           reassembled row by row, live
```

The web guide walks a visitor through six phases (MISSION, TARGET, TRACK, DEMOD PUZZLE,
GNU RADIO, RESULT). A signal-analysis phase (RF analysis tools) is planned to follow the
PHASE 4 upload; the phase list is data-driven so a new phase renumbers automatically.

## Layout

| Path | Contents | Owner |
|---|---|---|
| `web-guide/` | The guided web UI: `server.py` (stdlib http.server, :8080) + `templates/` + `static/`. Renders the phases, mounts the VSA, proxies GPredict control. | ours |
| `vsa/` | The Virtual Spectrum Analyzer (forked OpenVSA). `server.js` serves rotctld :4533 / rigctld :4532 / WS :4534; `src/` is the browser renderer. | fork |
| `gpredict-web/` | Docker: GPredict + noVNC (host :16080) + a time-control server (host :16079) that resets the clock to just before a pass. | ours |
| `gpredict-config/` | Prewired GPredict config: `enigma1.tle`, `defcon.qth`, rotator/radio (`OpenVSA.rot/.rig`). | ours |
| `gnuradio-web/` | Docker: GNU Radio + noVNC (host :16081). Runs `enigma1_decoder.grc` on the uploaded file; `upload/` receives the PHASE 4 file. | ours |
| `decoder/` | The decoder: `enigma1_decoder.grc`, `reassembler_progressive.py`, the source image, and the downlink generator. | ours |
| `arduino/` | Physical booth antenna: the `arduino_bridge.py` host bridge plus the `booth_antenna/` Arduino stepper sketch it drives from the VSA lock signal. | ours |
| `signal/` | The downlink recordings, including the default `enigma34_downlink.cf32` the browser VSA auto-loads. | data |
| `tools/` | Helper utilities, such as `fake_vsa_server.py` for offline testing. | ours |
| `run/` | Launch scripts (`start-all.sh`, per-service scripts, `_common.sh`). | ours |
| `docs/` | Participant and operator guides. | ours |
| `gnuradio-out/` | Runtime output: the recovered PNG and progress files written by the flowgraph. | runtime |

The folder names follow the `scenario2-uplink-attack` convention (`web-guide/`, `vsa/`,
`decoder/`, a consolidated `arduino/`, `signal/` for the recordings, and `docs/`).

## Quick start

Everything is scripted under `run/` (WSL + Docker Desktop, mirrored networking, high
ports to avoid proxy leaks):

```
run/start-all.sh        # brings up web (:8080), gpredict (:16080), gnuradio (:16081), VSA bridge
```

Then open `http://localhost:8080` and follow the phases. Individual services:

```
run/web.sh              # the web guide only (:8080)
run/gpredict.sh         # gpredict container (noVNC :16080, control :16079)
run/gnuradio.sh         # gnuradio container (noVNC :16081)
run/vsa-bridge.sh       # the VSA rotctld/rigctld bridge (:4532/:4533/:4534)
run/stop-all.sh         # tear everything down
```

See `GOAL.md` for the scenario brief and `PLAN.md` for the build plan and milestones.
