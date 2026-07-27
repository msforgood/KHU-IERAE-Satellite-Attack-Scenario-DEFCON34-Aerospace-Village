// Copyright (c) 2026 SunHyuk Hwang. All Rights Reserved.

// 📡Antenna definitions for the VSA.
// Each entry defines both the RF characteristics used by the signal processing
// engine (beamwidthDeg, peakGainDb) and the 3D model geometry (buildModel).
//
//   beamwidthDeg  – Half-power beamwidth in degrees (used for Gaussian beam attenuation)
//   peakGainDb    – Peak antenna gain in dB relative to the panel baseline (10 dBi)
//                   For dish antennas this is overridden by the frequency-dependent
//                   formula G = η·(πD/λ)² in rotatorScene.js
//   noiseTemp     – Effective antenna noise temperature in Kelvin
//                   (dish sees cold sky, dipole picks up warm ground noise)
//   txPowerDbm    – Typical transmit power in dBm (antenna + matched amplifier)
//   buildModel    – Returns triangle arrays for the 3D visualisation

import { boxPart, dishPart, transformPartTriangles } from "../lib/simple3d.js";

function rod(center, size, color = "#d7e1e8") {
  return boxPart(center, size, color);
}

export const ANTENNA_TYPES = {
  yagi: {
    label: "Yagi Antenna",
    description: "",
    beamwidthDeg: 25,
    peakGainDb: 6,    // ~16 dBi absolute; +6 dB relative to panel baseline
    noiseTemp:  80,   // Kelvin — moderate ground noise from sidelobes
    txPowerDbm: 37,   // ~5W typical amateur amplifier
    polarization: "linear",
    buildModel: () => {
      const directors = [6, 24, 42, 60, 78].flatMap((offset, i) =>
        rod({ x: offset, y: 0, z: 0 }, { x: 3, y: 39 - i * 3, z: 3 }),
      );
      return [
        ...rod({ x: 39, y: 0, z: 0 }, { x: 87, y: 5, z: 5 }, "#5f7385"),
        ...directors,
        ...rod({ x: -6, y: 0, z: 0 }, { x: 3, y: 48, z: 3 }, "#c8d4dc"),
      ];
    },
  },

  dish: {
    label: "Dish Antenna (0.75m)",
    description: "75 cm parabolic dish.",
    beamwidthDeg: 3,
    peakGainDb: 24,   // ~34 dBi absolute; +24 dB relative to panel baseline
    noiseTemp:  30,   // Kelvin — narrow beam sees mostly cold sky
    txPowerDbm: 47,   // ~50W typical ground station amplifier
    polarization: "linear",
    buildModel: (state = {}) => {
      const tiltPivot = { x: 18, y: 6, z: 0 };
      const feedColors = { lband: "#4caf50", sband: "#ffc107", ku: "#d66a2d" };
      const feed = state.dishFeed || "ku";
      const lnbParts = (feed === "ku" && state.downconvEnabled) ? [
        // LNB housing body — aluminum blue-gray
        ...boxPart({ x: 50, y: 12, z: 0 }, { x: 16, y: 12, z: 10 }, "#7fa8c8"),
        // Waveguide throat — deep metallic teal
        ...boxPart({ x: 58, y: 12, z: 0 }, { x:  6, y:  8, z:  8 }, "#1a4a4a"),
        // Cable/connector stub — copper
        ...rod(    { x: 42, y: 12, z: 0 }, { x:  4, y:  4, z:  4 }, "#b87333"),
      ] : [
        // Feed point marker — color-coded by feed type
        ...boxPart({ x: 54, y: 12, z: 0 }, { x: 8, y: 8, z: 8 }, feedColors[feed] || "#d66a2d"),
      ];
      const bowlAssembly = transformPartTriangles(
        [
          ...dishPart({ x: 60, y: 15, z: 0 }, 39, 24, "#dfe6ec", "#8d9da8"),
          ...rod({ x: 36, y: 9,  z: 0 }, { x: 42, y: 5,  z: 5  }, "#74889a"),
          ...rod({ x: 44, y: 3,  z: 0 }, { x: 18, y: 5,  z: 15 }, "#8798a7"),
          ...lnbParts,
        ],
        { rotateZ: 0, pivot: tiltPivot },
      );
      return [
        ...rod({ x: 9, y: 6, z: 0 }, { x: 24, y: 6, z: 6 }, "#5d7181"),
        ...bowlAssembly,
      ];
    },
  },

  dipole: {
    label: "Dipole Antenna",
    description: "",
    beamwidthDeg: 360,
    peakGainDb: -8,   // ~2 dBi absolute; -8 dB relative to panel baseline
    noiseTemp:  200,  // Kelvin — omnidirectional, picks up ground noise from all directions
    txPowerDbm: 30,   // ~1W handheld level — too weak for most satellite uplink
    polarization: "linear",
    buildModel: () => [
      // Support mast
      ...rod({ x: 18, y: 0, z: 0 }, { x: 36, y: 5, z: 5 }, "#5d7181"),
      // Feed point
      ...boxPart({ x: 36, y: 0, z: 0 }, { x: 8, y: 8, z: 8 }, "#d66a2d"),
      // Element 1 (+y)
      ...rod({ x: 36, y: 24, z: 0 }, { x: 4, y: 40, z: 4 }, "#c8d4dc"),
      // Element 2 (-y)
      ...rod({ x: 36, y: -24, z: 0 }, { x: 4, y: 40, z: 4 }, "#c8d4dc"),
    ],
  },

  helix: {
    label: "Helix Antenna (RHCP)",
    description: "",
    beamwidthDeg: 40,
    peakGainDb: 5,    // ~15 dBi absolute; +5 dB relative to panel baseline
    noiseTemp:  60,   // Kelvin — directional, moderate ground noise
    txPowerDbm: 40,   // ~10W typical cubesat ground station
    polarization: "RHCP",
    buildModel: () => {
      // Ground plane
      const ground = boxPart({ x: 4, y: 0, z: 0 }, { x: 8, y: 56, z: 56 }, "#4d6070");
      // Central mast
      const mast = rod({ x: 35, y: 0, z: 0 }, { x: 70, y: 4, z: 4 }, "#8798a7");
      // Helix coil: small boxes placed at helix positions (4 turns, 8 steps/turn)
      const turns = 4, stepsPerTurn = 8;
      const helixRadius = 14, helixLen = 52;
      const totalSteps = turns * stepsPerTurn;
      const coils = Array.from({ length: totalSteps }, (_, i) => {
        const angle = (i / stepsPerTurn) * Math.PI * 2;
        const xPos  = 10 + (i / totalSteps) * helixLen;
        return transformPartTriangles(
          boxPart({ x: xPos, y: helixRadius, z: 0 }, { x: 5, y: 4, z: 4 }, "#c8d4dc"),
          { rotateX: angle, pivot: { x: xPos, y: 0, z: 0 } },
        );
      }).flat();
      return [...ground, ...mast, ...coils];
    },
  },
};
