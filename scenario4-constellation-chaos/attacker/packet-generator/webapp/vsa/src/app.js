// Copyright (c) 2026 SunHyuk Hwang. All Rights Reserved.

import { ANTENNA_TYPES }      from "./data/antennas.js";
import { createControls }      from "./components/controls.js";
import { createRotatorScene }  from "./components/rotatorScene.js";
import { createStore }         from "./state/store.js";
import { connectRotctld }      from "./rotctld-client.js";

const store = createStore({
  antennaType:       "yagi",
  azimuth:           131,
  elevation:         47,
  autoRotate:        false,
  rotationSpeed:     12,
  bridgeConnected:   false,
  gpredictConnected: false,
  gpredictTime:      null,
  radioConnected:    false,
  radioControlled:   false,
  lat:               36.1699,     // Las Vegas GS (matches gpredict defcon.qth)
  lon:               -115.1398,
  targetSat:         "",
  frequency:         123.4,
  sampleRate:        1,
  bandwidth:         1,
  gain:              0,
  dishFeed:          "ku",
  downconvEnabled:   false,
  downconvLO:        9750,
});

createControls({
  container:    document.querySelector("#controls-root"),
  store,
  antennaTypes: ANTENNA_TYPES,
});

createRotatorScene({
  container:    document.querySelector("#scene-root"),
  store,
  antennaTypes: ANTENNA_TYPES,
});

// Connect to the rotctld bridge server (falls back gracefully if not running)
connectRotctld(store);

// Load ground station location from GPredict's .qth files on startup
if (window.electronAPI) {
  window.electronAPI.getQTH().then(stations => {
    console.log("[qth] received:", stations);
    if (stations && stations.length > 0) {
      const { lat, lon } = stations[0];
      store.setState(s => ({ ...s, lat, lon }));
    }
  }).catch(err => console.error("[qth] error:", err));

  window.electronAPI.onQTHUpdated(stations => {
    console.log("[qth] auto-updated:", stations);
    if (stations && stations.length > 0) {
      const { lat, lon } = stations[0];
      store.setState(s => ({ ...s, lat, lon }));
    }
  });
} else {
  console.warn("[qth] window.electronAPI not available");
}

// ── Booth automation ─────────────────────────────────────────────────────────
// /vsa/index.html?auto=uplink auto-selects UPLINK mode + target satellite + antenna
// + power amplifier + uplink frequency, and hides the left settings menu so only the
// scene shows. Params: sat / ant / amp / freq (all optional, sensible defaults).
(function autoConfigure() {
  const params = new URLSearchParams(location.search);
  if (params.get("auto") !== "uplink") return;
  const sat  = params.get("sat")  || "ENIGMA-1";
  const ant  = params.get("ant")  || "helix";
  const amp  = params.get("amp")  || "uhf-20w";
  const freq = params.get("freq") || "449.5";
  const root = document.querySelector("#controls-root");
  const fire = (el, type) => el && el.dispatchEvent(new Event(type, { bubbles: true }));
  let tries = 0;
  (function run() {
    const tabUplink = root && root.querySelector("#tab-uplink");
    const satSel    = root && root.querySelector("#ctrl-sat-uplink");
    if (!tabUplink || !satSel) { if (tries++ < 80) setTimeout(run, 100); return; }
    const done = {};
    tabUplink.click();                                 done.uplink = true;
    satSel.value = sat; fire(satSel, "change");        done.satellite = (satSel.value === sat);
    const typeSel = root.querySelector("#ctrl-type-uplink");
    if (typeSel) { typeSel.value = ant; fire(typeSel, "change"); }
    const ampSel = root.querySelector("#ctrl-amplifier");
    if (ampSel) { ampSel.value = amp; fire(ampSel, "change"); }
    done.antenna = !!(typeSel && typeSel.value === ant && ampSel && ampSel.value === amp);
    const freqEl = root.querySelector("#ctrl-uplink-freq");
    if (freqEl) { freqEl.value = freq; fire(freqEl, "input"); fire(freqEl, "change"); }
    done.freq = !!(freqEl && parseFloat(freqEl.value) === parseFloat(freq));
    // hide the left settings menu; let the scene fill the frame
    if (root) root.style.display = "none";
    const layout = document.querySelector(".app-layout");
    if (layout) layout.style.gridTemplateColumns = "1fr";
    try { window.parent.postMessage({ type: "vsa-auto-done", done, sat, ant, amp, freq }, "*"); } catch (e) {}
  })();
})();
