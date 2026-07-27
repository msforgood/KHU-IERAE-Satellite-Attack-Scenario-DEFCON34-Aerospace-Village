// Copyright (c) 2026 SunHyuk Hwang. All Rights Reserved.

// Satellite configuration for the OpenVSA signal processing pipeline.
//
//   centerFreqMHz  – Downlink center frequency in MHz
//   eirp           – Effective Isotropic Radiated Power in VSA-normalised units
//   iqSampleRate   – Native sample rate (Hz) of the source IQ signal file
//   uplink         – (optional) Uplink channel configuration

export const SATELLITES = {
  "ENIGMA-1": {
    // Identity from scenario 1 (LEO UHF cubesat). In scenario 4 it is the RF target
    // and also exposes a TT&C uplink so the orbit_maneuver command can be transmitted.
    centerFreqMHz: 433.5,         // UHF downlink (tracking / Doppler)
    eirp:          118,            // LEO UHF cubesat (VSA units)
    iqSampleRate:  96_000,        // Hz
    polarization:  "RHCP",        // helix is best; yagi gets -3 dB pol mismatch
    uplink: {
      freqMHz:           449.5,   // UHF TT&C uplink
      purpose:           "TT&C",
      rxSensitivityDbm:  -110,    // satellite receiver sensitivity
      sampleRate:        24_000,  // OOK command sample rate
    },
  },
};
