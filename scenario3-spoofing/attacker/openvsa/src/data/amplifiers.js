// Copyright (c) 2026 SunHyuk Hwang. All Rights Reserved.

// Power amplifier definitions for the VSA uplink simulation.
// Each amplifier operates within a specific frequency range.
// Selecting the wrong amplifier for the uplink frequency will cause
// the transmission to fail — matching amp to frequency is a required skill.
//
//   label      – Display name
//   freqRange  – [min, max] operating frequency in MHz
//   powerDbm   – Output power in dBm

export const AMPLIFIERS = {
  "vhf-5w":     { label: "VHF 5W Amp",      freqRange: [130, 170],    powerDbm: 37 },
  "uhf-5w":     { label: "UHF 5W Amp",      freqRange: [400, 470],    powerDbm: 37 },
  "uhf-20w":    { label: "UHF 20W Amp",     freqRange: [400, 470],    powerDbm: 43 },
  "sband-10w":  { label: "S-band 10W Amp",  freqRange: [2000, 2500],  powerDbm: 40 },
  "kuband-50w": { label: "Ku-band 50W Amp", freqRange: [13000, 14500], powerDbm: 47 },
};
