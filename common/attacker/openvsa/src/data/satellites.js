// Copyright (c) 2026 SunHyuk Hwang. All Rights Reserved.

// Satellite configuration for the OpenVSA signal processing pipeline.
//
//   centerFreqMHz  – Downlink center frequency in MHz
//   eirp           – Effective Isotropic Radiated Power in VSA-normalised units
//   iqSampleRate   – Native sample rate (Hz) of the source IQ signal file
//   uplink         – (optional) Uplink channel configuration

export const SATELLITES = {
  "DEMOSAT": {
    centerFreqMHz: 401.5,         // UHF data collection band
    eirp:          116,            // LEO UHF beacon (VSA units)
    iqSampleRate:  24_000,        // Hz
    polarization:  "linear",
    uplink: {
      freqMHz:           449.5,   // UHF TT&C uplink
      purpose:           "TT&C",
      rxSensitivityDbm:  -110,    // satellite receiver sensitivity
    },
  },
};
