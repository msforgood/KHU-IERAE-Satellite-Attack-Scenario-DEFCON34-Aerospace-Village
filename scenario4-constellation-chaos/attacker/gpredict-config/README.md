# gpredict config — DEMOSAT / OpenVSA rotator

Prewired config for the isolated gpredict container (`../gpredict-web`). On launch
`start.sh` registers **DEMOSAT** from `demosat.tle` (generates `satdata/<cat>.sat`
+ a module), pins the **Las Vegas** ground station (`defcon.qth`), and points the
rotator at the host's **OpenVSA rotctld (:4533)**. gpredict runs under
`libfaketime`; the in-container control server (`control.py`, :6079) drives time.

| File | Role |
|---|---|
| `demosat.tle`  | DEMOSAT TLE (i 51.6°, ~15.5 rev/day LEO). Registered into gpredict's DB + module at boot. |
| `defcon.qth`   | ground station @ Las Vegas (36.13°N, -115.15°W, 620 m) |
| `OpenVSA.rot`  | hamlib rotator → `Host`/`Port` rewritten to host `:4533` (group `[Rotator]`) |
| `OpenVSA.rig`  | hamlib radio → host `:4532` (group `[Radio]`); only used if radio control is added |

> The `.sat`, `.mod`, and `gpredict.cfg` files are **generated** by `start.sh` at
> container start (from `demosat.tle`), so they are not checked in here.

## Time control — "wait for the pass" (scenario-2)

Real LEO orbits can't repeat sub-minute (min period ~84 min), so the pass is faked:

- On **phase-3 entry** the console calls `GET :6079/arm`. control.py sets the
  libfaketime offset so DEMOSAT sits **`PASS_LEAD` (20 s) before** a fixed grazing
  pass AOS over Las Vegas, then time runs at **real rate** → the participant waits
  ~20 s, the satellite enters range, they TRANSMIT during the natural pass.
- It **re-arms every `RESET_INTERVAL` (300 s)** as a safety net for a missed pass.
- control.py only rewrites the offset file; gpredict reads it live
  (`FAKETIME_NO_CACHE=1`) and is **never restarted**, so the rotctld link to
  OpenVSA stays engaged across re-arms.

The pass is chosen once from the `[MIN_PASS_ALT, MAX_PASS_ALT]` (15–45°) grazing
band so DEMOSAT crosses *near* the station, not straight overhead. Logic lives in
`../gpredict-web/passloop.py` (reusable); `control.py` is the thin HTTP server.

Endpoints: `/arm`, `/realtime` (drop to real time, pause re-arm), `/status`, `/offset`.
