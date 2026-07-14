# Operator Guide: Booth Runbook

Host: Windows PC with WSL2 and Docker Desktop (mirrored networking). All services are
local. Ports use a high range (16080 range) to avoid docker-proxy leaks.

## Bring it up

```
run/start-all.sh
```

This starts, and waits on, four things:

| Service | Port | What it is |
|---|---|---|
| Web guide | 8080 | The visitor-facing page. Open `http://localhost:8080`. |
| GPredict | 16080 (noVNC), 16079 (control) | Orbit tracking, streamed to the browser. |
| GNU Radio | 16081 (noVNC) | The decoder, streamed to the browser. |
| VSA bridge | 4532 / 4533 / 4534 | rigctld / rotctld / WebSocket for the VSA and the antenna. |

Open the guide and confirm all six phases render. Tear down with `run/stop-all.sh`.

## Common operations

- Start a fresh pass: on PHASE 3, press RESET. GPredict jumps to just before the next good
  pass (maximum elevation above the configured minimum), and the countdown shows the time
  to acquisition.
- New capture as the decode input: uploading a `.cf32` on PHASE 4 stages it as the GNU
  Radio File Source. Re-run `run/gnuradio.sh` if the container needs to pick up a new file.
- Physical antenna: the Arduino bridge drives the booth antenna from the VSA lock signal.
  See `arduino/arduino_bridge.py` and the sketch under `arduino/booth_antenna/`.

## Troubleshooting

- A screen is blank in the browser. The most common cause is that Docker Desktop stopped
  (for example after an IP change), which kills the `--rm` containers. Start Docker Desktop,
  then re-run `run/gpredict.sh` and `run/gnuradio.sh`. The `localhost` URLs do not change in
  mirrored networking, so no config edits are needed.
- The decode does not complete. An off-center recording will only partially decode, which
  is expected and shown as-is. Use a capture that is close to 433.500 MHz for a full image.
- GPredict clicks do nothing. Reconnect the noVNC iframe (reload the page) after a container
  restart.
