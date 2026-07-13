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
