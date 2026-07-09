// Copyright (c) 2026 SunHyuk Hwang. All Rights Reserved.

// Satellite configuration for the OpenVSA signal processing pipeline.
//
//   centerFreqMHz  – Downlink center frequency in MHz
//   eirp           – Effective Isotropic Radiated Power in VSA-normalised units
//   iqSampleRate   – Native sample rate (Hz) of the source IQ signal file
//   uplink         – (optional) Uplink channel configuration

export const SATELLITES = {
  "ENIGMA-1": {
    // Scenario 1 — Eavesdropping (downlink-only).
    // Fictional LEO Earth-observation cubesat broadcasting a packetized image
    // over AX.25 UI / G3RUH 9600-baud FSK. Visitor tunes in, captures IQ, then
    // decodes with gr-satellites (fsk_demodulator + ax25_deframer).
    centerFreqMHz: 433.5,        // UHF
    eirp:          120,           // LEO UHF cubesat (VSA units)
    iqSampleRate:  96_000,       // Hz — matches generator (9600 baud x 10 sps)
    polarization:  "RHCP",       // helix is best; yagi gets −3 dB pol mismatch
  },

  "PUPPET-2": {
    // Scenario 2 — Uplink Command Injection (commandable toy sat, no auth).
    // Downlink beacon exists only for tracking/tuning; the challenge is the
    // 449.5 MHz TT&C uplink, which executes any well-formed CRC-8 packet.
    centerFreqMHz: 401.5,        // UHF housekeeping downlink (for tracking)
    eirp:          116,           // LEO UHF beacon (VSA units)
    iqSampleRate:  24_000,       // Hz — OOK uplink sample rate
    polarization:  "linear",
    uplink: {
      freqMHz:          449.5,   // UHF TT&C uplink
      purpose:          "TT&C",  // telemetry, tracking & command
      rxSensitivityDbm: -110,    // satellite receiver sensitivity
      sampleRate:       24_000,  // OOK command sample rate
    },
  },
};
