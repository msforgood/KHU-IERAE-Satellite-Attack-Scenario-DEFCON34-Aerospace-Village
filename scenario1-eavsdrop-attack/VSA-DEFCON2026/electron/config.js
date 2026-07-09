// Copyright (c) 2026 SunHyuk Hwang. All Rights Reserved.

// Satellite and antenna configuration for the Electron main process.
// Used for Doppler calculation and SigMF metadata.

"use strict";

const SATELLITES = {
  "ENIGMA-1": {
    centerFreqHz: 433.5e6,
    iqFileHash:   "64bec42a909c5120d3e51634d3dce6fdfb732def7d0ec6f4a81d2d86838d4b68",
  },
  "PUPPET-2": {
    // Scenario 2 — uplink command injection. Downlink beacon (tracking only);
    // no iqFileHash because the player never loads a downlink IQ for this sat.
    centerFreqHz: 401.5e6,
  },
};

const UPLINK_FLAGS = {
  // Booth flags (per scenario, opcode-keyed where applicable).
  // Revealed by VSA's in-app operator overlay when a valid unauthenticated
  // command is injected and the downlink drops.
  "PUPPET-2": "DEFCON{unauthenticated_c2_wreaks_havoc}",
};

const ANT_INFO = {
  dish:   { beamwidthDeg: 3,   peakGainDb: 24 },
  yagi:   { beamwidthDeg: 25,  peakGainDb: 6  },
  panel:  { beamwidthDeg: 50,  peakGainDb: 0  },
  helix:  { beamwidthDeg: 40,  peakGainDb: 5  },
  dipole: { beamwidthDeg: 360, peakGainDb: -8 },
};

module.exports = { SATELLITES, ANT_INFO, UPLINK_FLAGS };
