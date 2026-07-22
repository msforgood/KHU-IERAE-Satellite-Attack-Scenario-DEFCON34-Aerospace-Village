// test-collision-core.js — M0 unit tests. Run: node test-collision-core.js
'use strict';
global.window = global;
require('./kepler.js');
require('./collision-core.js');
var K = global.SatKepler, C = global.CollisionCore;

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '   ' + extra : '')); }
}
function approx(a, b, tol) { return Math.abs(a - b) <= tol; }

var RE = K.EarthRadius;
// scenario 5 fixed orbits (from redesign-plan v2): different RAAN/inc/alt
var ATK = [RE + 600e3, 0, 97.8, 25.0, 0, 0];    // ENIGMA-1
var VIC = [RE + 820e3, 0, 98.6, 40.0, 0, 90];   // AURORA-2

console.log('--- 1. stateFromElements position matches keplerianToECI ---');
(function () {
  var worst = 0;
  [0, 37, 90, 180, 271].forEach(function (nu) {
    var s = C.stateFromElements(ATK[0], ATK[1], ATK[2], ATK[3], ATK[4], nu);
    var p = K.keplerianToECI(ATK[0], ATK[1], ATK[2], ATK[3], ATK[4], nu);
    worst = Math.max(worst, C.norm(C.sub(s.r, [p.x, p.y, p.z])));
  });
  ok('position consistent with keplerianToECI (worst < 1e-3 m)', worst < 1e-3, 'worst=' + worst.toExponential(2));
})();

console.log('--- 2. elements <-> state roundtrip (circular inclined) ---');
(function () {
  var kep = [RE + 700e3, 0, 98.6, 40.0, 0, 123];    // circular -> nu is arg of latitude
  var s = C.stateFromElements(kep[0], kep[1], kep[2], kep[3], kep[4], kep[5]);
  var el = C.elementsFromState(s.r, s.v);
  ok('a roundtrip (< 1 m)', approx(el.a, kep[0], 1), 'got a=' + el.a.toFixed(1));
  ok('e roundtrip (< 1e-5)', approx(el.e, 0, 1e-5), 'got e=' + el.e.toExponential(2));
  ok('inc roundtrip (< 1e-3 deg)', approx(el.inc, 98.6, 1e-3), 'got inc=' + el.inc.toFixed(4));
  ok('raan roundtrip (< 1e-3 deg)', approx(el.raan, 40.0, 1e-3), 'got raan=' + el.raan.toFixed(4));
  ok('nu(=u) roundtrip (< 1e-2 deg)', approx(el.nu, 123, 1e-2), 'got nu=' + el.nu.toFixed(4));
})();

console.log('--- 3. numericMOID geometry ---');
(function () {
  // (a) same ring (same plane + altitude, different phase) -> MOID ~ 0
  var same = C.numericMOID(VIC, [VIC[0], 0, VIC[2], VIC[3], 0, 200], 720);
  ok('same ring MOID ~ 0 (< 2 km)', same.moid < 2000, 'moid=' + (same.moid / 1000).toFixed(2) + ' km');

  // (b) same plane, different altitude -> MOID ~ radial gap (220 km)
  var gap = C.numericMOID([RE + 600e3, 0, 98.6, 40.0, 0, 0], VIC, 720);
  ok('coplanar altitude gap MOID ~ 220 km (+/- 3 km)', approx(gap.moid, 220000, 3000),
     'moid=' + (gap.moid / 1000).toFixed(1) + ' km');

  // (c) the actual scenario start orbits -> clearly not colliding yet (MOID large)
  var start = C.numericMOID(ATK, VIC, 720);
  ok('scenario start MOID large (> 100 km)', start.moid > 100000, 'moid=' + (start.moid / 1000).toFixed(1) + ' km');

  // collision point lies on both orbits: distance from midpoint to each ~ moid/2
  var dA = C.norm(C.sub(start.collisionPoint, start.pointA));
  var dB = C.norm(C.sub(start.collisionPoint, start.pointB));
  ok('collisionPoint is midpoint of closest pair', approx(dA, dB, 1) && approx(dA, start.moid / 2, 1),
     'dA=' + dA.toFixed(1) + ' dB=' + dB.toFixed(1));
})();

console.log('--- 4. applyManeuver3D ---');
(function () {
  // prograde raises the orbit (a increases)
  var up = C.applyManeuver3D([RE + 600e3, 0, 97.8, 25.0, 0, 0], 50, 0, 0);
  ok('prograde +50 m/s raises a', up[0] > RE + 600e3, 'a=' + ((up[0] - RE) / 1000).toFixed(1) + ' km alt');

  // cross-track burn rotates the plane (inc and/or raan change)
  var base = [RE + 600e3, 0, 97.8, 25.0, 0, 45];
  var oop = C.applyManeuver3D(base, 0, 0, 200);
  var planeChanged = Math.abs(oop[2] - 97.8) > 1e-3 || Math.abs(oop[3] - 25.0) > 1e-3;
  ok('cross-track +200 m/s rotates the plane (inc or raan changes)', planeChanged,
     'inc=' + oop[2].toFixed(3) + ' raan=' + oop[3].toFixed(3));

  // energy check: prograde burn increases specific orbital energy magnitude sanity
  ok('prograde burn keeps a finite/elliptical', isFinite(up[0]) && up[1] < 1, 'e=' + up[1].toFixed(4));
})();

console.log('--- 5. phasingManeuver ---');
(function () {
  var a0 = RE + 600e3;
  var T0 = C.period(a0);
  var ph = C.phasingManeuver(a0, a0, 0.1, 3, +1);   // advance by phi=0.1 rad over 3 revs
  ok('dtSec positive', ph.dtSec > 0, 'dt=' + ph.dtSec.toFixed(1) + ' s');
  ok('advance -> shorter phasing period (Tphase < T0)', ph.Tphase < T0,
     'Tphase=' + ph.Tphase.toFixed(1) + ' T0=' + T0.toFixed(1));
  ok('advance -> smaller phasing orbit (aPhase < a0)', ph.aPhase < a0,
     'aPhase alt=' + ((ph.aPhase - RE) / 1000).toFixed(2) + ' km');
  ok('dvTotal positive and modest (< 200 m/s for small phase)', ph.dvTotal > 0 && ph.dvTotal < 200,
     'dvTotal=' + ph.dvTotal.toFixed(3) + ' m/s');
  // delay direction reverses the sign
  var pd = C.phasingManeuver(a0, a0, 0.1, 3, -1);
  ok('delay -> larger phasing orbit (aPhase > a0)', pd.aPhase > a0,
     'aPhase alt=' + ((pd.aPhase - RE) / 1000).toFixed(2) + ' km');
})();

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail ? 1 : 0);
