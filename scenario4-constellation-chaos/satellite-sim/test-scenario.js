// test-scenario.js — M1 checks: the fixed orbits are solvable with realistic
// delta-v, the collision is dramatic (high closing speed), and the plane control
// meaningfully moves the collision point. Run: node test-scenario.js
'use strict';
global.window = global;
require('./kepler.js');
require('./collision-core.js');
require('./scenario.js');
var C = global.CollisionCore, S = global.Scenario5, RE = C.RE, MU = C.MU;

var pass = 0, fail = 0;
function ok(n, c, e) { if (c) { pass++; console.log('  ok  ' + n); } else { fail++; console.log('  FAIL ' + n + (e ? '   ' + e : '')); } }
function km(m) { return (m / 1000).toFixed(1); }
function hohmann(r1, r2) {  // total delta-v for a circular->circular transfer
  var at = (r1 + r2) / 2;
  var dv1 = Math.abs(Math.sqrt(MU * (2 / r1 - 1 / at)) - Math.sqrt(MU / r1));
  var dv2 = Math.abs(Math.sqrt(MU / r2) - Math.sqrt(MU * (2 / r2 - 1 / at)));
  return dv1 + dv2;
}

var sats = S.satellites();
var atk = sats[0].kep, vic = sats[1].kep;

console.log('--- scenario loads ---');
ok('4 satellites', sats.length === 4, 'got ' + sats.length);
ok('Scenario4 alias present', !!global.Scenario4);
ok('victim is the target', sats[1].target === true && sats[1].name === 'AURORA-2');

console.log('--- orbits do not collide at the start ---');
var start = C.numericMOID(atk, vic, 720);
ok('start MOID large (> 100 km)', start.moid > 100000, 'moid=' + km(start.moid) + ' km');

console.log('--- STAGE 1 gate: circular-altitude solve is wide + cheap ---');
var best = { moid: Infinity };
for (var alt = 600; alt <= 1700; alt += 25) {
  var k = [RE + alt * 1e3, 0, atk[2], atk[3], 0, 0];      // circular attacker at alt, start plane
  var m = C.numericMOID(k, vic, 600);
  if (m.moid < best.moid) best = { moid: m.moid, alt: alt, k: k };
}
ok('solvable to MOID < threshold by circular altitude', best.moid < S.moidThreshold,
   'best MOID=' + km(best.moid) + ' km at ' + best.alt + ' km');
var dv = hohmann(RE + 600e3, RE + best.alt * 1e3);
ok('solving delta-v realistic (< 1000 m/s)', dv < 1000, 'Hohmann dv=' + dv.toFixed(0) + ' m/s to ' + best.alt + ' km');

console.log('--- collision is dramatic (high closing speed) ---');
var mo = C.numericMOID(best.k, vic, 720);
var nuA = C.nuAtPoint(best.k, mo.collisionPoint), nuV = C.nuAtPoint(vic, mo.collisionPoint);
var sA = C.stateFromElements(best.k[0], best.k[1], best.k[2], best.k[3], best.k[4], nuA);
var sV = C.stateFromElements(vic[0], vic[1], vic[2], vic[3], vic[4], nuV);
var closing = C.norm(C.sub(sA.v, sV.v));
ok('closing speed dramatic (> 8 km/s, Iridium-class)', closing > 8000, 'closing=' + km(closing) + ' km/s');

console.log('--- plane control shifts the collision point ---');
var nuSet = [-800, 0, 800].map(function (cdv) {
  var k2 = C.applyManeuver3D(best.k, 0, 0, cdv);
  var m2 = C.numericMOID(k2, vic, 600);
  return Math.round(C.nuAtPoint(vic, m2.collisionPoint));
});
ok('cross-track nudge moves the victim collision anomaly', nuSet[0] !== nuSet[2],
   'victim nu at cross dv [-800,0,800] = ' + nuSet.join(', ') + ' deg');

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail ? 1 : 0);
