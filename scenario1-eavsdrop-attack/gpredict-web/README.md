# GPredict (web) - the real GPredict in a browser (Scenario 1 : ENIGMA-1)

A port of scn2 `attacker/gpredict-web/` into the ENIGMA-1 reception scenario. **This is not a
reimplementation: it runs the real gpredict GTK app inside Docker and streams it to the browser over noVNC.** The
TRACK step of web-guide takes this noVNC URL as `GPREDICT_URL` and shows it in an iframe.

```
Docker container
  Xvfb :99  - virtual X display
  openbox   - window manager
  gpredict  - the real GTK app (tracks the ENIGMA-1 TLE, runs rotctld :4533)
  x11vnc    - exports the :99 screen over VNC :5900
  websockify(noVNC) - serves VNC on the web at :6080 -> visible in the browser
        |
        +- web-guide TRACK iframe <- http://localhost:6080/vnc.html?autoconnect=1&resize=remote
```

## Running

```bash
# 0) (optional) Start the Scenario 1 VSA first so the gpredict rotator can connect
#    cd ../VSA-DEFCON2026 && node server.js         # rotctld :4533 / rigctld :4532 / ws :4534

# 1) Run gpredict via Docker+noVNC (nothing is installed on the host)
./run.sh
#    -> http://localhost:6080/vnc.html?autoconnect=1&resize=remote

# 2) Run web-guide wired to that URL -> the real gpredict shows in an iframe at the TRACK step
GPREDICT_URL='http://localhost:6080/vnc.html?autoconnect=1&resize=remote' \
  python3 ../web-guide/server.py
```

If you do not pass `GPREDICT_URL`, web-guide falls back to its own polar-tracking preview (canvas)
(so the screen is not empty even without Docker). If the Docker daemon is off, `run.sh` gives a clear message.

## Layout
- `Dockerfile` - debian-slim + `gpredict xvfb x11vnc novnc websockify openbox`
- `start.sh` - inside the container: inject TLE/QTH/rotator settings -> Xvfb -> gpredict -> x11vnc -> websockify
- `run.sh` - build the image + run (mounts `../gpredict-config` as `/config`)
- `../gpredict-config/` - `enigma1.tle`, `OpenVSA.rot` (rotctld :4533), `defcon.qth`

## Registering the TLE (local file) : opening ENIGMA-1

`../gpredict-config/enigma1.tle` is mounted into the container as `/config`, and start.sh
**automatically registers** it into the gpredict satellite DB (`satdata/90001.sat`) and module (`modules/ENIGMA-1.mod`).
As a result, ENIGMA-1 (catalog 90001) already appears in the satellite list inside gpredict.

- **Open ENIGMA-1**: open **File > (from the module list) ENIGMA-1** at the top of gpredict, or
  when creating a new module select ENIGMA-1 from the satellite list -> track it in **Antenna Control** with the Rotator `OpenVSA` (host:4533).
  (It is normal for the first gpredict launch to open with an empty window: once you open a module, it is restored automatically afterward.)
- **Register another local TLE**: place a `*.tle` file into the host's `../gpredict-config/`, and
  in gpredict choose **Edit > Update TLE data > From local files...** -> select folder `/config` -> import.
- **Antenna tracking (Antenna Control)**: module = menu > **Antenna Control** -> load rotator `OpenVSA` (host:4533),
  **Track** for automatic ENIGMA-1 tracking, **Engage** to connect to the VSA rotctld (the VSA `node server.js` must be running).
  Note: the rotator config file must be in gpredict format (a `[Rotator]` group + CamelCase keys `Host/Port/AzType...`):
  if the format is wrong, Antenna Control shows a black window with "Failed to load rotator configuration".

In short, the TLE source is a local file (no network needed), and swapping the file re-registers it as is.

## Radio (Radio Control) : Doppler
`../gpredict-config/OpenVSA.rig` (gpredict-format `[Radio]` group) is automatically registered to connect to the host's VSA
rigctld (:4532). module = menu > **Radio Control** > Device `OpenVSA` > Engage -> gpredict
**sends the Doppler-corrected frequency it computes from the orbit to the VSA rigctld** (downlink RX tuning). Requires the VSA `node server.js`.

## Reset to just before a pass (control server :6079)
gpredict is run under **libfaketime**, and on request the control server (`control.py`, :6079)
uses `pyephem` to compute ENIGMA-1's **next AOS** (pass overhead of the QTH) -> sets the libfaketime offset to `AOS - PASS_LEAD(120s)`
-> restarts gpredict (supervisor reopen) -> **jumps to just before the pass**. web-guide's **Reset to just before a pass** (with a refresh icon)
button calls it via `/api/reset-pass` (-> :6079 proxy). Directly: `curl localhost:6079/reset-pass` (return with `/realtime`).

## Environment variables
| Variable | Default | Description |
|---|---|---|
| `WEB_PORT` | 6080 | noVNC web port |
| `CTRL_PORT` | 6079 | time-control server port |
| `PASS_LEAD` | 120 | how many seconds before AOS to reset to |
| `ROTCTLD_HOST` | host.docker.internal | host address of the VSA rotctld (:4533)/rigctld (:4532) |
| `IMG` | enigma1-gpredict | Docker image tag |

## Cleanup
`docker rmi enigma1-gpredict` - delete the image. Nothing is left behind on the host.
