// scenario.js — scenario 5 fixed two-orbit setup + sim tuning. Needs kepler.js.
//
// Redesign v2 (realistic STAGE 1). BOTH orbits are FIXED from the start:
//   ENIGMA-1 (attacker): circular LEO. The participant maneuvers THIS one.
//   AURORA-2 (victim):   a slightly ECCENTRIC orbit on a slightly different plane.
// STAGE 1 (geometry): raising ENIGMA-1's altitude until its ring crosses AURORA-2's
//   ellipse is the gate (matching radius). A small out-of-plane (cross-track) nudge
//   then chooses WHERE on the ellipse the crossing lands (perigee side = fast,
//   apogee side = slow), which sets the closing speed. Plane work is meaningful but
//   affordable; the real difficulty is STAGE 2 timing (see collision-core.js).
// AURORA-4 is a nearby constellation member for the debris-cascade view.
//
// Exports Scenario5 (and a transitional Scenario4 alias so the not-yet-rewritten
// sim/console keep loading). kep = [a(m), e, inc(deg), raan(deg), argp(deg), nu0(deg)].
(function (root) {
  'use strict';
  var Re = root.SatKepler.EarthRadius;

  // Both near-polar, but AURORA sits on a plane rotated ~125 deg in RAAN from
  // ENIGMA-1, so the two orbits cross at a steep angle: the closing speed at impact
  // is ~13 km/s (comparable to the 2009 Iridium-Cosmos collision). Because altitude
  // is the intersection gate, ENIGMA-1 still solves it cheaply despite the big plane
  // difference; it never has to pay for a plane alignment.
  var attacker = { id: 'demosat', name: 'ENIGMA-1', role: 'attacker', color: '#eaf2ff',
                   kep: [Re + 600e3, 0.0, 97.8, 25.0, 0, 0] };
  var victim   = { id: 'aurora-2', name: 'AURORA-2', role: 'neighbor', color: '#ff5a5a', target: true,
                   kep: [Re + 1200e3, 0.08, 98.6, 150.0, 0, 90] };
  // AURORA-4 is a decoy. It sits on a clearly DIFFERENT orbit (its own altitude, inclination
  // and plane) AND is parked WELL ABOVE the target's 1200 km ring (2000 km). ENIGMA-1 starts
  // at 600 km, so the only ring within an obvious, affordable reach is AURORA-2 one step up;
  // the decoy reads as far out of reach. A single decoy keeps the view uncluttered while still
  // making AURORA-2 read as the one viable answer.
  var neighbors = [
    { id: 'aurora-4', name: 'AURORA-4', role: 'neighbor', color: '#7fe0ff',
      kep: [Re + 2000e3, 0.03, 96.5, 270.0, 0, 200] }
  ];

  // TLE the Intel step hands the participant (parsed as input; propagation uses the
  // Keplerian elements above). Line-2 fields: inc, RAAN, ecc(implied decimal),
  // argp, mean anomaly, mean motion[rev/day].
  var tleText =
    'ENIGMA-1\n' +
    '1 90001U 24001A   26201.50000000  .00000000  00000-0  00000-0 0  9991\n' +
    '2 90001  97.8000  25.0000 0000000   0.0000   0.0000 14.90000000000010\n' +
    '\n' +
    'AURORA-2\n' +
    '1 90002U 24002A   26201.50000000  .00000000  00000-0  00000-0 0  9992\n' +
    '2 90002  98.6000 150.0000 0800000   0.0000  90.0000 13.40000000000025';

  function clone(s) {
    return { id: s.id, name: s.name, role: s.role, color: s.color, target: !!s.target, kep: s.kep.slice() };
  }
  function satellites() { return [attacker, victim].concat(neighbors).map(clone); }

  var Re_km = function (a) { return Math.round((a - Re) / 1000); };

  var S5 = {
    frame: 'TEME (demo ECI)',
    attacker: clone(attacker),
    victim: clone(victim),
    attackerStart: { altKm: 600, e: 0, inc: 97.8, raan: 25 },
    victimElements: { altKm: 1200, e: 0.08, inc: 98.6, raan: 150, argp: 0 },
    tleText: tleText,
    // Delta-v input ranges (m/s): prograde raises altitude (the crossing gate),
    // cross-track nudges the plane (collision-point / closing-speed control),
    // phase is the along-track phasing burst (timing).
    dvRanges: { prograde: [-500, 3000], radial: [-500, 500], cross: [-120, 120], phase: [0, 300] },
    // MOID below this (m) counts as an orbit intersection (geometry satisfied).
    moidThreshold: 20000,

    // ── spacecraft + thrusters (burn-plan actuation step) ─────────────────────
    // Default is a small monopropellant thruster typical of a ~500 kg LEO smallsat;
    // a high-thrust bipropellant apogee engine (Airbus S400 / Nammo LEROS class,
    // ~400 N / Isp ~320 s) is offered as a selectable high-thrust option. The
    // burn-plan (collision-core.js burnPlan) turns the solved delta-v into a real
    // thruster command: pointing (yaw/pitch) + burn duration + propellant.
    // ground station: a FIXED site (Las Vegas) that uplinks to ENIGMA-1. gsFixed is the
    // calibrated 3D point on the (spun) globe that sits over the US southwest; earthSpinDeg
    // rotates the Earth texture so North America faces that marker (both in simOpts below).
    groundStation: { name: 'Las Vegas', lat: 36.17, lon: -115.14 },
    spacecraft: { massKg: 500 },
    thrusters: [
      { id: 'mono22', name: 'Monoprop 22 N', thrustN: 22, ispSec: 230,
        note: 'Hydrazine monopropellant, typical for a ~500 kg LEO satellite' },
      { id: 'bip400', name: 'Bipropellant 400 N', thrustN: 400, ispSec: 320,
        note: 'S400 / LEROS-class apogee engine, high thrust (usually GEO/deep-space)' }
    ],
    defaultThruster: 'mono22',

    // ── fields the (soon-to-be-rewritten) sim/console + victim still read ──────
    target: { satellite: 'AURORA-2', constellation: 'AURORA', constellationCount: 1 + neighbors.length,
              notes: 'Eccentric LEO orbit; AURORA constellation members share the neighbourhood' },
    altKm: 600,
    demosatStart: { altKm: 600, inc: 97.8, raan: 25 },
    ranges: { altKm: [400, 1600], inc: [0, 180], raan: [0, 360] },
    neighborsInfo: [victim].concat(neighbors).map(function (n) {
      return { name: n.name, altKm: Re_km(n.kep[0]), e: n.kep[1], inc: n.kep[2], raan: n.kep[3] };
    }),
    // gsFixed = Las Vegas (36.17 N, 115.14 W) mapped onto the decorative globe. The Earth
    // texture sphere spins about the Y axis (earthSpinDeg), so the site is placed with
    //   x = -R cos(lon+180+spin) cos(lat), y = R sin(lat), z = R sin(lon+180+spin) cos(lat).
    // The old value [5160e3,3749e3,0] resolved to lon -135 (mid-Pacific); this lands it inland.
    simOpts: { collisionThreshold: 20000, impactTargetSec: 18, gsFixed: [4842648, 3764268, -1749191], earthSpinDeg: 135 },
    satellites: satellites
  };

  root.Scenario5 = S5;
  root.Scenario4 = S5;   // transitional alias
})(typeof window !== 'undefined' ? window : this);
