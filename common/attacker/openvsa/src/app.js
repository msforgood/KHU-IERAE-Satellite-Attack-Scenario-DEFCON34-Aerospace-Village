// Copyright (c) 2026 SunHyuk Hwang. All Rights Reserved.

import { ANTENNA_TYPES }      from "./data/antennas.js";
import { createControls }      from "./components/controls.js";
import { createRotatorScene }  from "./components/rotatorScene.js";
import { createStore }         from "./state/store.js";
import { connectRotctld }      from "./rotctld-client.js";

const store = createStore({
  antennaType:       "yagi",
  azimuth:           206,   // initial antenna pose — a "nice looking" angle so the
  elevation:         31,    // dish sits pretty before ENGAGE sets it (206°/30°)
  autoRotate:        false,
  rotationSpeed:     12,
  bridgeConnected:   false,
  gpredictConnected: false,
  gpredictTime:      null,
  radioConnected:    false,
  radioControlled:   false,
  lat:               37.241917,
  lon:               127.081127,
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

// External preset from the attacker console's ENGAGE button (same-origin iframe):
// aim the antenna + select the uplink target + set the uplink frequency in one shot.
window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m || m.type !== "vsa-preset") return;
  store.setState((s) => ({
    ...s,
    ...(Number.isFinite(m.azimuth)   ? { azimuth: m.azimuth }         : {}),
    // elevation is the LAST value STEP 1's ENGAGE sends → mark the aim complete so the
    // "Load generated IQ file" CTA only starts pulsing after the FULL aim, not earlier.
    ...(Number.isFinite(m.elevation) ? { elevation: m.elevation, engageAimComplete: true } : {}),
    ...(m.targetSat                  ? { targetSat: m.targetSat }      : {}),
    ...(m.antennaType                ? { antennaType: m.antennaType }  : {}),
  }));
  // uplink target/freq/antenna are plain inputs (not store-bound): set the target
  // first (enables the panel), then the rest.
  if (m.targetSat) {
    const sel = document.querySelector("#ctrl-sat-uplink");
    if (sel) { sel.value = m.targetSat; sel.dispatchEvent(new Event("change")); }
  }
  if (m.antennaType) {
    const ut = document.querySelector("#ctrl-type-uplink");
    if (ut) { ut.value = m.antennaType; ut.dispatchEvent(new Event("change")); }
  }
  if (Number.isFinite(m.uplinkFreq)) {
    const f = document.querySelector("#ctrl-uplink-freq");
    if (f) { f.value = m.uplinkFreq; f.dispatchEvent(new Event("change")); }
  }
  // Elevation lands LAST and isn't tied to an uplink input, so nothing would otherwise
  // re-run the uplink panel. Nudge it now that engageAimComplete is set, so the
  // load-IQ CTA re-evaluates and only starts pulsing after the full aim is done.
  if (Number.isFinite(m.elevation)) {
    const ut = document.querySelector("#ctrl-type-uplink");
    if (ut) ut.dispatchEvent(new Event("change"));
  }
  // Aim-by-hand: the console sends the TARGET az/el (not the value) so the
  // participant must drag the slider onto it. Store the goal on the slider as
  // data-target (1 dp) and re-run its input handler so the green match re-evaluates.
  if (Number.isFinite(m.targetAzimuth)) {
    const az = document.querySelector("#ctrl-az-uplink");
    if (az) { az.dataset.target = m.targetAzimuth.toFixed(1); az.dispatchEvent(new Event("input")); }
  }
  if (Number.isFinite(m.targetElevation)) {
    const el = document.querySelector("#ctrl-el-uplink");
    if (el) { el.dataset.target = m.targetElevation.toFixed(1); el.dispatchEvent(new Event("input")); }
    // elevation target is the LAST aim value → the full aim is now specified.
    store.setState((s) => ({ ...s, engageAimComplete: true }));
    const ut = document.querySelector("#ctrl-type-uplink");
    if (ut) ut.dispatchEvent(new Event("change")); // re-eval load-IQ CTA
  }
  // Uplink frequency is entered by hand in the gated wizard: store the goal as
  // data-target (don't fill the value) and nudge the input so the gate re-evaluates.
  if (Number.isFinite(m.targetFreq)) {
    const f = document.querySelector("#ctrl-uplink-freq");
    if (f) { f.dataset.target = String(m.targetFreq); f.dispatchEvent(new Event("input")); }
  }
});

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
