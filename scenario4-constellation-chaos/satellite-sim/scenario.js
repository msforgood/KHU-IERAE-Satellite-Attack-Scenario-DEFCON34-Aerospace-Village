// scenario.js — shared scenario-4 constellation + sim tuning, loaded by BOTH monitors.
// Needs kepler.js first.
//
// THREE satellites: ENIGMA-1 (attacker) + two AURORA neighbours.
//   - AURORA-2 (the ANSWER): shares ENIGMA-1's orbital node (RAAN 25°) but a different
//     ALTITUDE + INCLINATION. ENIGMA-1 can only fire ALTITUDE + UP/DOWN (inclination),
//     so this is the ONLY orbit it can actually reach and collide with.
//   - AURORA-3 (a DECOY): differs in ALTITUDE, INCLINATION *and* RAAN. Because ENIGMA-1
//     cannot change its RAAN, its orbit never lines up with this one — unreachable.
// The neighbours sit a quarter-orbit from the node (nu 90 / 30), spread onto clearly
// different planes so the orbits no longer bunch together.
(function (root) {
  'use strict';
  var Re = root.SatKepler.EarthRadius;
  var ALT = 600;                                  // km, ENIGMA-1's starting altitude
  var RAAN = 25;                                  // deg, ENIGMA-1's node (only the ANSWER shares it)

  var attacker = { id: 'demosat', name: 'ENIGMA-1', role: 'attacker', color: '#eaf2ff',
                   kep: [Re + ALT * 1e3, 0, 50, RAAN, 0, 0] };
  var neighbors = [
    // ANSWER — same RAAN, different altitude + inclination (reachable with ALTITUDE + UP/DOWN)
    { id: 'aurora-2', name: 'AURORA-2', role: 'neighbor', color: '#ffb020', answer: true,
      kep: [Re + 820 * 1e3, 0, 64, RAAN, 0, 90] },
    // DECOY — different altitude, inclination AND RAAN (unreachable: ENIGMA-1 cannot change RAAN)
    { id: 'aurora-3', name: 'AURORA-3', role: 'neighbor', color: '#7fe0ff', answer: false,
      kep: [Re + 700 * 1e3, 0, 38, 95, 0, 30] }
  ];

  function satellites() {
    return [attacker].concat(neighbors).map(function (s) {
      return { id: s.id, name: s.name, role: s.role, color: s.color, answer: !!s.answer, kep: s.kep.slice() };
    });
  }

  root.Scenario4 = {
    target: {
      satellite: 'ENIGMA-1', scid: 200, modulation: 'OOK', baud: 100, sampleRate: 24000,
      uplinkFreqMHz: 450.1, notes: 'LEO satellite in the AURORA constellation (members at mixed altitudes and inclinations)',
      constellation: 'AURORA', constellationCount: neighbors.length
    },
    altKm: ALT,
    // element input ranges for the attacker console
    ranges: { altKm: [400, 1200], inc: [0, 90], raan: [0, 360] },
    demosatStart: { altKm: ALT, inc: 50, raan: 25 },
    neighborsInfo: neighbors.map(function (n) { return { name: n.name, altKm: Math.round((n.kep[0] - Re) / 1000), inc: n.kep[2], raan: n.kep[3] }; }),
    simOpts: {
      collisionThreshold: 130000,   // m — ENIGMA-1 orbit passing this close to a satellite => collision course
      impactTargetSec: 18
    },
    satellites: satellites
  };
})(typeof window !== 'undefined' ? window : this);
