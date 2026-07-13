# gpredict config — DEMOSAT / OpenVSA rotator

Prewired config so gpredict tracks **DEMOSAT** and drives the **OpenVSA rotator
(rotctld :4533)** out of the box. Copy into gpredict's config dir:

```bash
# Linux
mkdir -p ~/.config/Gpredict/{satdata,hwconf}
cp demosat.tle ~/.config/Gpredict/satdata/     # add via Edit → Update TLE if not auto-picked
cp OpenVSA.rot ~/.config/Gpredict/hwconf/
cp defcon.qth  ~/.config/Gpredict/
# macOS: same paths under ~/.config/Gpredict (or ~/Library/Application Support/Gpredict)
```

Then in gpredict: **Antenna Control → Target `DEMOSAT`, Rotator `OpenVSA` → Engage**.
gpredict streams az/el to OpenVSA's rotctld on `:4533`; OpenVSA slews and (via the GS
`/api/acquire` trigger) the physical antenna sweeps. See `../README.md`.

| File | Goes to | What |
|---|---|---|
| `demosat.tle` | `satdata/` | virtual DEMOSAT TLE (i 51.6°, ~15.5 rev/day LEO) |
| `OpenVSA.rot` | `hwconf/`  | hamlib rotator → `localhost:4533` |
| `defcon.qth`  | `~/.config/Gpredict/` | ground station @ Las Vegas |
