// Copyright (c) 2026 SunHyuk Hwang. All Rights Reserved.

// Simulated uplink validation — checks whether a command transmission
// would physically reach the target satellite using the same physics
// as the downlink path (FSPL, beam attenuation, band limits, horizon).
//
// No IQ signal is generated. This is a logical pass/fail gate that
// validates timing, frequency, antenna alignment, and link margin.

import { SATELLITES } from "../data/satellites.js";

/**
 * Validate whether an uplink transmission would reach the satellite.
 *
 * @param {object} params
 * @param {string} params.satellite     – Target satellite name (e.g., "DEMOSAT")
 * @param {number} params.frequency     – User-set uplink frequency (MHz)
 * @param {string} params.antennaType   – Current antenna type key (e.g., "yagi")
 * @param {object} params.antenna       – Antenna config object (from antennas.js)
 * @param {object} params.amplifier     – Amplifier config object (from amplifiers.js)
 * @param {number} params.beamAttenDb   – Current beam attenuation (from computeBeamAttenuationDb)
 * @param {number} params.satRangeKm    – Current satellite range in km
 * @param {number} params.satEl         – Current satellite elevation in degrees (null if unknown)
 * @returns {{ success: boolean, reason: string }}
 */
export function validateUplink({ satellite, frequency, antennaType, antenna, amplifier, beamAttenDb, satRangeKm, satEl }) {
  const sat = SATELLITES[satellite];
  if (!sat || !sat.uplink) {
    return { success: false, reason: "Satellite does not support uplink" };
  }

  const uplink = sat.uplink;

  // 1. Satellite above horizon?
  if (satEl === null || satEl === undefined) {
    return { success: false, reason: "Satellite position unknown" };
  }
  if (satEl + 1 <= 0) {  // +1° atmospheric refraction margin
    return { success: false, reason: "Satellite below horizon" };
  }

  // 2. Antenna pointed at satellite?
  if (beamAttenDb <= -60) {
    return { success: false, reason: "Antenna not aligned — signal blocked" };
  }
  if (beamAttenDb < -30) {
    return { success: false, reason: "Antenna poorly aligned — insufficient beam coupling" };
  }

  // 3. Frequency matches satellite uplink?
  const freqDiffMHz = Math.abs(frequency - uplink.freqMHz);
  if (freqDiffMHz > 0.01) {
    return { success: false, reason: "Transmission failed" };
  }

  // 4. Antenna supports the frequency band?
  if (antennaType === "dish" && uplink.freqMHz < 1000) {
    return { success: false, hw: true, reason: "Tx failed" };
  }
  if ((antennaType === "yagi" || antennaType === "dipole") && uplink.freqMHz > 3000) {
    return { success: false, hw: true, reason: "Tx failed" };
  }

  // 5. Link margin: txPower + antennaGain - FSPL - atmLoss > rxSensitivity
  if (!amplifier) {
    return { success: false, hw: true, reason: "Tx failed" };
  }
  const txPowerDbm = amplifier.powerDbm;
  const antennaGainDbi = (antenna.peakGainDb ?? 0) + 10; // convert relative to absolute dBi
  const lambda = 299.792458 / uplink.freqMHz;
  const fspl = (satRangeKm && satRangeKm > 0)
    ? 20 * Math.log10(4 * Math.PI * satRangeKm * 1000 / lambda)
    : 200;
  const elEff = (satEl + 1) * Math.PI / 180;
  const atmLoss = 2 / Math.sin(elEff);
  const rxPower = txPowerDbm + antennaGainDbi - fspl - atmLoss;

  if (rxPower < uplink.rxSensitivityDbm) {
    return { success: false, hw: true, reason: "Tx failed" };
  }

  return { success: true };
}
