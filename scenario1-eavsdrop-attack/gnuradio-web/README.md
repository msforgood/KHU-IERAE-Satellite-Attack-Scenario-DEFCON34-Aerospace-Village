# GNU Radio (web) - the real GNU Radio Companion in your browser (Scenario 1)

Uses the **same approach** as `gpredict-web/`. This is not a reimplementation. It runs **the real GNU Radio Companion (GRC) inside Docker
and streams it to the browser over noVNC**, with the correct flowgraph `enigma1_decoder.grc` already open.
The FLOWGRAPH (PHASE 5) step of web-guide takes this noVNC URL as `GNURADIO_URL` and shows it in an iframe.

```
Docker container
  Xvfb :99  - virtual X display
  openbox   - window manager
  gnuradio-companion enigma1_decoder.grc  - the real GRC (correct flowgraph open)
    - gr-satellites: provides the FSK Demodulator / AX.25 Deframer blocks
  x11vnc    - exports the :99 screen as VNC :5900
  websockify(noVNC) - serves VNC on web :6081 -> visible in the browser
        |
        - web-guide FLOWGRAPH iframe <- http://localhost:6081/vnc.html?autoconnect=1&resize=remote
```

## Running

```bash
# 1) Run GNU Radio via Docker+noVNC (nothing gets installed on the host)
./run.sh
#    -> http://localhost:6081/vnc.html?autoconnect=1&resize=remote

# 2) Point web-guide at that URL -> the real GRC appears in an iframe at the FLOWGRAPH step
GNURADIO_URL='http://localhost:6081/vnc.html?autoconnect=1&resize=remote' \
  python3 ../web-guide/server.py
```

## Actual run (Run) -> image recovery

`run.sh` mounts the provided recording (`../enigma34_downlink.cf32`) at the File Source path,
and mounts the output folder (`../gnuradio-out/`) at the image out_path. So when you press **Run** in GRC,
the flowgraph actually runs, demodulates and deframes the downlink, and the **recovered image is
saved to `../gnuradio-out/enigma1_recovered0708.png`** (verified byte-identical against the reference).

The running copy created by start.sh **enables the QT GUI Waterfall Sink**, which is disabled in the shipped state,
so pressing Run brings up the "ENIGMA-1 433.5 MHz" waterfall window that shows the FSK signal in real time (visual proof that it is running).
The xterm warning is removed by writing `xterm_executable = /usr/bin/xterm` into `~/.gnuradio/config.conf`.

> Warning on sample rate: the provided recording is **96 kSps** (ENIGMA-1 SDR spec 0.096 MSps, 9600 baud x 10 sps),
> so `samp_rate 0.05e6` in the `.grc` will not decode. The running copy that start.sh opens
> is auto-patched to `0.096e6` (the original `.grc` is left untouched). If you want the canonical `.grc` set to 96k as well,
> change `value: 0.05e6` -> `0.096e6` in `postProcess/enigma1_decoder.grc`.

To use it together with gpredict-web, pass both URLs:
```bash
GPREDICT_URL='http://localhost:6080/vnc.html?autoconnect=1&resize=remote' \
GNURADIO_URL='http://localhost:6081/vnc.html?autoconnect=1&resize=remote' \
  python3 ../web-guide/server.py
```

When `GNURADIO_URL` is unset, web-guide falls back to a static canvas render of the correct flowgraph
(so the screen is not blank even without Docker).

## Layout
- `Dockerfile` - debian-slim + `gnuradio` + `gr-satellites`(pip) + `xvfb x11vnc novnc websockify openbox`
- `start.sh` - inside the container: Xvfb -> openbox -> `gnuradio-companion /grc/enigma1_decoder.grc` -> x11vnc -> websockify
- `run.sh` - build the image + run (mounts `../postProcess` as `/grc` to provide the .grc)

## Environment variables
| Variable | Default | Description |
|---|---|---|
| `WEB_PORT` | 6081 | noVNC web port (kept separate so it does not clash with gpredict-web 6080) |
| `GRC_FILE` | /grc/enigma1_decoder.grc | Path of the flowgraph GRC should open (inside the container) |
| `IMG` | enigma1-gnuradio | Docker image tag |

## Notes
- The base is **ubuntu:24.04** (GNU Radio 3.10.9.2, gr-satellites 5.5). Debian bookworm (GR 3.10.5) does not know
  the `blocks_throttle2` used in the `.grc` (authored on 3.10.7) and shows it as "Missing Block", so we moved to ubuntu.
- GRC is a GTK3 GUI, so `gir1.2-gtk-3.0`+`python3-gi` are **strictly required**. Without them
  it fails with `Namespace Gtk not available`, the window does not appear, and noVNC shows only a **black screen** (this image includes them).
  Also, `GtkApplication` wants a session bus, so we wrap the run in `dbus-run-session` (start.sh).
- The File Source absolute path and output path in the flowgraph do not need to exist in the container. They are **for display purposes**, so GRC still opens fine (it just does not run).
- The first `docker build` can take a while because of the apt installs. To clean up: `docker rmi enigma1-gnuradio`.
