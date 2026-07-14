// Copyright (c) 2026 SunHyuk Hwang. All Rights Reserved.

// Read-only satellite datasheets shown in the control panel's SATELLITE tab.
// Keys MUST match the SATELLITES keys in ./satellites.js (the Target Satellite
// names) so the tab can look up SATELLITE_INFO[targetSat]. Adding one object
// here fully populates the tab for a new satellite — no code changes needed.
// Any section (identity/orbit/rf/sdr/passes/tle/notes) may be omitted; the tab
// renders only the sections that are present.
//
// Scope: only information a participant needs to SOLVE the challenge (tune,
// track, capture, decode). Identity/orbit lore and link-budget trivia are
// intentionally left out. Reference info only — never place flags or solution
// data in this file.

export const SATELLITE_INFO = {
  "ENIGMA-1": {
    status: "Active",
    tagline: "LEO Earth-observation cubesat · AX.25 image beacon (G3RUH 9600)",
    image: "satellites/enigma-1/enigma1.jpg",   // hero render, relative to index.html
    identity: {
      "NORAD Catalog ID": "90001",
    },
    rf: {
      "Downlink freq": "433.500 MHz (UHF)",
      "Modulation": "GFSK, Gaussian BT = 0.5",
      "Symbol rate": "9600 baud",
      "Deviation": "±2.4 kHz (h = 0.5)",
      "Occupied BW": "~14 kHz",
      "Polarization": "RHCP",
      "Framing": "AX.25 UI · G3RUH scrambler (1+x¹²+x¹⁷) · HDLC · CRC-16",
    },
    sdr: {
      "Center frequency": "433.500 MHz",
      "Sample rate": "0.096 MSps",
      "Display bandwidth": "0.096 MHz",
      "Gain": "20 – 30 dB",
      "Antenna": "70-cm Helix, RHCP, ≥10 dBi",
    },
    passes: {
      "Doppler shift @433.5 MHz": "±10 kHz peak",
      "Doppler rate at TCA": "~−110 Hz/s",
    },
    tle: [
      "ENIGMA-1",
      "1 90001U 26200A   26195.00000000  .00001500  00000-0  70000-4 0  1004",
      "2 90001  98.5000 100.0000 0010000  90.0000 270.0000 16.40000000  1006",
    ],
    notes: [
      "Continuous, unencrypted AX.25 UI beacon — a passive-intercept target. No uplink, no command interface.",
      "Broadcasts a packetized image across ~29 AX.25 frames on a 7.22 s loop; one capture spanning a full burst is enough to decode.",
      "Decode with gr-satellites: FSK demodulator (9600 baud) → AX.25 deframer (G3RUH scrambler on) → reassemble the Info fields by sequence number.",
      "Sun-synchronous 98.5° inclination → visible from any latitude; only the pass times differ.",
      "Its TLE is installed into GPredict by setup-gpredict.sh so GPredict can track it and drive OpenVSA over rotctld/rigctld.",
    ],
  },
  // S2-S4 satellites get appended here later; key must match the SATELLITES name.
};
