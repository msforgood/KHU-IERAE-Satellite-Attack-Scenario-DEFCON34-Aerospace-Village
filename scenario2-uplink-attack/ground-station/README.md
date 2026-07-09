# Ground Station Web UI (②) — victim ground station

The victim ground station, running on the Windows PC. It receives the uplink command
forwarded by OpenVSA, simulates the satellite state, and raises an **energy supply**
alarm on the dashboard.

## Structure
- `backend/` — pure Node (zero dependencies; `miniws.js` implements RFC6455).
  Receives OpenVSA's `uplink-command` on `ws://0.0.0.0:4536`, runs the satellite state
  engine ported from OpenVSA (`satellite-state.js` + `hardware-effects.json`), and
  pushes state to the browser. Arduino trigger hook via `ARDUINO_URL`.
- `frontend/` — telemetry dashboard driven by `panel.json`, with a large critical
  alarm. Pure HTML/CSS/vanilla JS (no build step).

## Receive contract
OpenVSA `server.js` sends:
```json
{ "type":"uplink-command", "satellite":"DEMOSAT", "frequency":449.5,
  "command":"adcs_torque", "payload":["0x03","0xe7"], "purpose":"TT&C", "timestamp":"ISO8601" }
```
The backend calls the state engine's `applyCommand(command, payload)` → effect chain →
dashboard alarm.

## Main scenario
`adcs_torque` received → tumbling + solarAttacked → panel swings off the sun (90°→0°)
→ Power Gen collapses, Battery drains, TUMBLING → "ENERGY SUPPLY CRITICAL" alarm +
Arduino trigger hook.

## Run
```
cd backend
node server.js                 # :4540 dashboard, :4536 uplink input (zero deps)
# open http://localhost:4540
```
Env: `GS_HTTP_PORT` (default 4540), `UPLINK_PORT` (default 4536),
`ATTACK_DELAY_MS` (telemetry delay, default 4000), `ARDUINO_URL` (trigger POST target,
optional).

### Test without OpenVSA (mock inject)
```
curl -X POST http://localhost:4540/api/inject \
  -H 'Content-Type: application/json' \
  -d '{"command":"adcs_torque","payload":["0x03","0xe7"],"frequency":449.5}'
curl -X POST http://localhost:4540/api/reset   # back to nominal
```
