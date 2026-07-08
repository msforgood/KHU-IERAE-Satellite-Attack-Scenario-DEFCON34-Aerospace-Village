# Attacker 3rd screen — gpredict + OpenVSA in one web console

The **③ 위성 조준** screen. Two real, open-source tools embedded side by side in a
single web page — **no reimplementation**:

- **gpredict** (native GTK, forked from [csete/gpredict]) — satellite tracking on the
  virtual DEMOSAT TLE. Shown in the browser by streaming its window over **noVNC**.
- **OpenVSA** (Electron/web, forked from [whal-e3/OpenVSA]) — the VSA that exposes
  `rotctld :4533` (gpredict points here), a rotator view, and forwards the uplink to the
  ground station (`:4536`). Pre-patched with our `demosat` plugin + opcode/payload forward.

```
console (index.html)
 ├─ iframe ◀ noVNC ◀ gpredict      (tracks DEMOSAT, drives rotctld :4533)
 ├─ iframe ◀ OpenVSA UI            (rotator + TRANSMIT → forward :4536)
 └─ ACQUIRE button ─▶ GS /api/acquire ─▶ 🛰️ physical antenna sweeps
```

## Layout
```
attacker/
├─ openvsa/          forked OpenVSA (plugin + forward patch applied)  ← Node/Electron
├─ gpredict/         forked gpredict source                           ← C/GTK
├─ gpredict-config/  DEMOSAT TLE + rotctld:4533 rotator + QTH
├─ console/          the web 3rd screen (single static page)
├─ setup.sh          install OpenVSA deps + gpredict
├─ run-gpredict-web.sh   stream real gpredict → noVNC (Linux)
└─ launch.sh         OpenVSA + console (+ gpredict web)
```

## Run
```bash
./setup.sh                       # once: OpenVSA npm install, gpredict install/build
cp gpredict-config/* ~/.config/Gpredict/ ...   # see gpredict-config/README.md

# 1) ground station (other terminal): ../ground-station/backend  → node server.js
# 2) real gpredict in the browser (Linux):
./run-gpredict-web.sh            # → http://localhost:6080/vnc.html?autoconnect=1&resize=remote
# 3) OpenVSA + console:
GPREDICT_WEB_URL='http://localhost:6080/vnc.html?autoconnect=1&resize=remote' ./launch.sh
```
Open the printed **3rd screen** URL. In gpredict: Antenna Control → DEMOSAT → Rotator
`OpenVSA` → **Engage**. When aligned, hit **ACQUIRE LOCK** (→ antenna sweeps), then in
OpenVSA load `attack.cf32` → **TRANSMIT** (→ solar panel spins, GS alarms).

## Console config (URL query params)
`index.html?gs=http://localhost:4540&gp=<gpredict-noVNC-url>&vsa=<OpenVSA-url>`
- `gs`  — ground station base (for the ACQUIRE/RESET buttons). Default `http://localhost:4540`.
- `gp`  — gpredict noVNC URL to iframe. Empty → shows setup hint.
- `vsa` — OpenVSA UI URL to iframe. Empty → run OpenVSA as its own window.

## Notes
- `openvsa/` is a **fork we modify** (plugin + patch) → kept in-tree. Re-sync the plugin
  from `../openvsa-plugin/` if it changes.
- `gpredict/` is the **unmodified upstream source** (we only configure it). Building it
  needs GTK dev libs; `setup.sh` prefers a package install (`brew`/`apt`).
- macOS has no Xvfb — run gpredict natively in its own window (or macOS Screen Sharing →
  noVNC). The web tracker path is Linux-first.

[csete/gpredict]: https://github.com/csete/gpredict
[whal-e3/OpenVSA]: https://github.com/whal-e3/OpenVSA
