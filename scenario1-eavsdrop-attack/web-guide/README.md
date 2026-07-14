# ENIGMA-1 Downlink Decoder - Web Interface (Scenario 1)

A 6-step **participant web guide** that follows the webapp pattern of scenario 2 (scn2)
(a single Python stdlib server plus templates/static), with the UI written in the
scenario2 packet-generator webapp style. It brings up GPredict and VSA together inside the browser.

```
PHASE 1 MISSION   Reception is the goal - explains antenna tracking / RF synchronization / signal demodulation
PHASE 2 TARGET    ENIGMA-1 specifications to receive (values confirmed in VSA)
PHASE 3 TRACK     SAT info (top), Reset + Remaining time, GPredict (left) / VSA (right)
PHASE 4 ANALYZE   Upload the recorded IQ (.cf32); in-browser spectrum + waterfall (carrier / bandwidth / bursts)
PHASE 5 PUZZLE    enigma1_decoder.grc block puzzle (correct layout, hint button)
PHASE 6 FLOWGRAPH Run the correct flowgraph on real GNU Radio (noVNC)
PHASE 7 RESULT    Check the recovered image
```

## Components
- `web-guide/server.py` - Rendering plus static-mount server (:8080). Mounts VSA at `/vsa/` and
  injects an electronAPI shim so that, even in a regular browser, it performs **ENIGMA-1 auto-selection plus `enigma34_downlink.cf32` auto-load**.
- `web-guide/templates/index.html`, `web-guide/static/{style.css,app.js}` - 7-step SPA.
- `web-guide/static/vendor/satellite.min.js` - SGP4 for Remaining-time calculation (works offline).
- `gpredict-web/` - Real gpredict + noVNC + libfaketime + control.py (:6079). (Same as the existing scenario1.)
- `gnuradio-web/` - Real GNU Radio Companion + noVNC (:6081), with the correct flowgraph opened.
- `gpredict-config/` - `defcon.qth` (GS 36.12881986648643, -115.15156849623858),
  `enigma1.tle` (registers ENIGMA-1 only), `OpenVSA.rot/.rig`.

## Running
```bash
# 1) (optional) Real GPredict - Docker + noVNC (ENIGMA-1 auto-registration/tracking)
./gpredict-web/run.sh
#    -> http://localhost:6080/vnc.html?autoconnect=1&resize=remote   (control :6079)

# 2) (optional) Real GNU Radio - Docker + noVNC (correct flowgraph opened; image recovered when you press Run)
./gnuradio-web/run.sh
#    -> http://localhost:6081/vnc.html?autoconnect=1&resize=remote

# 3) Web interface
GPREDICT_URL='http://localhost:6080/vnc.html?autoconnect=1&resize=remote' \
GNURADIO_URL='http://localhost:6081/vnc.html?autoconnect=1&resize=remote' \
  python3 web-guide/server.py
#    -> http://localhost:8080
```

- When `GPREDICT_URL` is not set, the PHASE 3 GPredict slot is replaced with a **polar tracking preview (canvas)**.
- When `GNURADIO_URL` is not set, PHASE 6 is replaced with a **static correct-flowgraph** render.
- **Remaining time for communication with SAT** is computed in the browser with SGP4 using the GS coordinates + ENIGMA-1 TLE + gpredict
  faketime offset (`/api/offset`) (during a pass -> LOS countdown,
  outside a pass -> next AOS countdown). When Docker is not running, it operates against real time.
- The **Reset** button asks the gpredict-web control (:6079) to jump gpredict's time to just before the next pass's maximum elevation (`/api/reset-pass`).

## Environment variables
| Variable | Default | Description |
|---|---|---|
| `PORT` | 8080 | Web interface port |
| `GPREDICT_URL` | (none) | GPredict noVNC iframe URL |
| `GNURADIO_URL` | (none) | GNU Radio noVNC iframe URL |
| `VSA_URL` | `/vsa/index.html` | VSA embed URL (default: served statically by this server) |
| `GPREDICT_CONTROL_URL` | `http://localhost:6079` | reset-pass/offset proxy target |
