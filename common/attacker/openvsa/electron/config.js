// Copyright (c) 2026 SunHyuk Hwang. All Rights Reserved.

// Satellite and antenna configuration for the Electron main process.
// Used for Doppler calculation and SigMF metadata.

"use strict";

const SATELLITES = {
  "DEMOSAT": {
    centerFreqHz: 401.5e6,
    iqFileHash: "ea236df4786c1eeb917ac28363d956f99cb35ed48ae059f7e861067effc23555",
  },
};

const UPLINK_FLAGS = {
  "DEMOSAT": "RF{d3m0sat_c2_h1jack3d_by_r0gu3_gr0und_stat10n}",
};

const ANT_INFO = {
  dish:   { beamwidthDeg: 3,   peakGainDb: 24 },
  yagi:   { beamwidthDeg: 25,  peakGainDb: 6  },
  panel:  { beamwidthDeg: 50,  peakGainDb: 0  },
  helix:  { beamwidthDeg: 40,  peakGainDb: 5  },
  dipole: { beamwidthDeg: 360, peakGainDb: -8 },
};

module.exports = { SATELLITES, ANT_INFO, UPLINK_FLAGS };
