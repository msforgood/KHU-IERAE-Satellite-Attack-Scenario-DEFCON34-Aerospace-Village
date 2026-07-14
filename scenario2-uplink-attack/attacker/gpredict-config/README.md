# gpredict config — DEMOSAT / OpenVSA rotator

Prewired config so gpredict auto-opens the **DEMOSAT** module tracking from the
**Las Vegas** ground station and drives the **OpenVSA rotator (rotctld :4533)**
out of the box — no manual module/QTH setup. Copy into gpredict's config dir:

```bash
# Linux
mkdir -p ~/.config/Gpredict/{satdata,hwconf,modules}
cp demosat.tle 70003.sat ~/.config/Gpredict/satdata/
cp OpenVSA.rot            ~/.config/Gpredict/hwconf/
cp DEMOSAT.mod            ~/.config/Gpredict/modules/
cp defcon.qth gpredict.cfg ~/.config/Gpredict/
# macOS: same paths under ~/.config/Gpredict (or ~/Library/Application Support/Gpredict)
```

On launch gpredict reads `gpredict.cfg` (`OPEN_MODULES=DEMOSAT`) and opens
`modules/DEMOSAT.mod`, which pins QTH → `defcon.qth` (Las Vegas) and satellite →
`70003` (`satdata/70003.sat`). For the rotator: **Antenna Control → Rotator
`OpenVSA` → Engage**. gpredict streams az/el to OpenVSA's rotctld on `:4533`;
OpenVSA slews and (via the GS `/api/acquire` trigger) the physical antenna
sweeps. See `../README.md`.

> Without `gpredict.cfg` + `DEMOSAT.mod`, gpredict first-run creates its bundled
> `Amateur.mod` and opens that instead — the map then shows amateur sats and a
> QTH labelled **"Error"** (no valid ground station). These files replace that.

| File | Goes to | What |
|---|---|---|
| `demosat.tle`  | `satdata/`  | virtual DEMOSAT TLE (i 51.6°, ~15.5 rev/day LEO) |
| `70003.sat`    | `satdata/`  | DEMOSAT as a gpredict `.sat` (catnum 70003) so the module loads it |
| `DEMOSAT.mod`  | `modules/`  | module pinning QTH=`defcon.qth`, SATELLITES=`70003` |
| `gpredict.cfg` | `~/.config/Gpredict/` | `OPEN_MODULES=DEMOSAT` → auto-open our module, not Amateur |
| `OpenVSA.rot`  | `hwconf/`   | hamlib rotator → `localhost:4533` |
| `defcon.qth`   | `~/.config/Gpredict/` | ground station @ Las Vegas (36.17°N, -115.14°W) |
