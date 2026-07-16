// kepler.js — planar orbital mechanics for the scenario-4 satellite sim.
//
// Ported from ../../satellite-tracker/kepler.js (the framework the fuller 3D sim
// will eventually replace this placeholder with). Same math: keplerianToECI,
// trueAnomalyAdvance, propagateKepler, detectCollision — plus 2D state-vector
// helpers so an up/down/left/right thrust (delta-v) turns into a real new orbit.
//
// Exposed as a plain global (window.SatKepler) so both monitors can load it with
// a normal <script> tag, no bundler. Distances in meters, angles in degrees.
(function (root) {
  'use strict';

  var EarthRadius = 6378.137e3;      // m, WGS84 equatorial
  var MuEarth     = 3.986004418e14;  // m^3/s^2
  var DEG = Math.PI / 180;

  // (a, e, inc[deg], RAAN[deg], argp[deg], nuDeg[number|array]) -> {x,y,z}.
  // nuDeg number -> single point; array -> parallel Float64Array orbit line.
  function keplerianToECI(a, e, incDeg, raanDeg, argpDeg, nuDeg) {
    if (e < 0 || e >= 1) throw new Error('keplerianToECI: e must be in [0,1), got ' + e);
    var iR = incDeg * DEG, raanR = raanDeg * DEG, argpR = argpDeg * DEG;
    var cw = Math.cos(argpR), sw = Math.sin(argpR);
    var ci = Math.cos(iR),    si = Math.sin(iR);
    var cR = Math.cos(raanR), sR = Math.sin(raanR);
    var p  = a * (1 - e * e);

    function apply(nuR) {
      var cn = Math.cos(nuR), sn = Math.sin(nuR);
      var r  = p / (1 + e * cn);
      var xpf = r * cn, ypf = r * sn;
      var x1 = cw * xpf - sw * ypf;
      var y1 = sw * xpf + cw * ypf;
      var y2 = ci * y1;
      var z2 = si * y1;
      var x  = cR * x1 - sR * y2;
      var y  = sR * x1 + cR * y2;
      return [x, y, z2];
    }

    if (typeof nuDeg === 'number') {
      var r0 = apply(nuDeg * DEG);
      return { x: r0[0], y: r0[1], z: r0[2] };
    }
    var n = nuDeg.length;
    var xs = new Float64Array(n), ys = new Float64Array(n), zs = new Float64Array(n);
    for (var k = 0; k < n; k++) {
      var q = apply(nuDeg[k] * DEG);
      xs[k] = q[0]; ys[k] = q[1]; zs[k] = q[2];
    }
    return { x: xs, y: ys, z: zs };
  }

  function solveKepler(M, e) {
    var E = M;
    for (var i = 0; i < 30; i++) {
      var f  = E - e * Math.sin(E) - M;
      var fp = 1 - e * Math.cos(E);
      var d  = f / fp;
      E -= d;
      if (Math.abs(d) < 1e-10) return E;
    }
    return E;
  }

  // current nu -> nu after dt seconds (0..360). Stateful free-run step.
  function trueAnomalyAdvance(a, e, nuDeg, dtSec) {
    if (dtSec === 0) return nuDeg;
    var n = Math.sqrt(MuEarth / (a * a * a));
    var nuR = nuDeg * DEG;
    var oneEcc = Math.sqrt(1 + e), minEcc = Math.sqrt(1 - e);
    var E0 = 2 * Math.atan2(minEcc * Math.sin(nuR / 2), oneEcc * Math.cos(nuR / 2));
    var M0 = E0 - e * Math.sin(E0);
    var E1 = solveKepler(M0 + n * dtSec, e);
    var nuOut = 2 * Math.atan2(oneEcc * Math.sin(E1 / 2), minEcc * Math.cos(E1 / 2)) / DEG;
    return ((nuOut % 360) + 360) % 360;
  }

  // epoch elements + time(s) -> ECI position(s). tArray number or array.
  function propagateKepler(a, e, incDeg, raanDeg, argpDeg, nu0Deg, tArray) {
    var n = Math.sqrt(MuEarth / (a * a * a));
    var nu0R = nu0Deg * DEG;
    var E0 = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu0R / 2), Math.sqrt(1 + e) * Math.cos(nu0R / 2));
    var M0 = E0 - e * Math.sin(E0);
    var oneEcc = Math.sqrt(1 + e), minEcc = Math.sqrt(1 - e);
    function trueAnomaly(t) {
      var E = solveKepler(M0 + n * t, e);
      return 2 * Math.atan2(oneEcc * Math.sin(E / 2), minEcc * Math.cos(E / 2)) / DEG;
    }
    if (typeof tArray === 'number') {
      return keplerianToECI(a, e, incDeg, raanDeg, argpDeg, trueAnomaly(tArray));
    }
    var N = tArray.length;
    var nuArr = new Float64Array(N);
    for (var k = 0; k < N; k++) nuArr[k] = trueAnomaly(tArray[k]);
    return keplerianToECI(a, e, incDeg, raanDeg, argpDeg, nuArr);
  }

  // Two keplerian orbits sampled over durationSec -> first threshold breach.
  // kep = [a, e, inc, RAAN, argp, nu0]. Returns {collided,tCollision,posCollision,minDist,minIdx}.
  function detectCollision(kep1, kep2, durationSec, sampleTime, threshold) {
    sampleTime = sampleTime || 1;
    threshold = threshold || 10000;
    var N = Math.floor(durationSec / sampleTime) + 1;
    var tArr = new Float64Array(N);
    for (var i = 0; i < N; i++) tArr[i] = i * sampleTime;
    var p1 = propagateKepler(kep1[0], kep1[1], kep1[2], kep1[3], kep1[4], kep1[5], tArr);
    var p2 = propagateKepler(kep2[0], kep2[1], kep2[2], kep2[3], kep2[4], kep2[5], tArr);
    var minDist = Infinity, minIdx = -1, collided = false, hitIdx = -1;
    for (var j = 0; j < N; j++) {
      var dx = p1.x[j] - p2.x[j], dy = p1.y[j] - p2.y[j], dz = p1.z[j] - p2.z[j];
      var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < minDist) { minDist = d; minIdx = j; }
      if (!collided && d < threshold) { collided = true; hitIdx = j; }
    }
    if (collided) {
      return { collided: true, tCollision: tArr[hitIdx],
               posCollision: { x: p1.x[hitIdx], y: p1.y[hitIdx], z: p1.z[hitIdx] },
               minDist: minDist, minIdx: minIdx };
    }
    return { collided: false, tCollision: NaN, posCollision: null, minDist: minDist, minIdx: minIdx };
  }

  // ── Planar (inc=0, raan=0) state-vector helpers for maneuver planning ───────
  // In this placeholder the constellation is coplanar, so the orbit is an ellipse
  // in the XY plane and a thrust just adds a delta-v to the velocity there.

  // elements -> {rx,ry,vx,vy} (m, m/s) at true anomaly nu.
  function elementsToState2D(a, e, argpDeg, nuDeg) {
    var w = argpDeg * DEG, nu = nuDeg * DEG;
    var p = a * (1 - e * e);
    var r = p / (1 + e * Math.cos(nu));
    var rpx = r * Math.cos(nu), rpy = r * Math.sin(nu);          // perifocal position
    var k = Math.sqrt(MuEarth / p);
    var vpx = -k * Math.sin(nu), vpy = k * (e + Math.cos(nu));   // perifocal velocity
    var cw = Math.cos(w), sw = Math.sin(w);
    return {
      rx: cw * rpx - sw * rpy, ry: sw * rpx + cw * rpy,
      vx: cw * vpx - sw * vpy, vy: sw * vpx + cw * vpy
    };
  }

  // {rx,ry,vx,vy} -> {a,e,argp[deg],nu[deg]} (planar).
  function stateToElements2D(rx, ry, vx, vy) {
    var r = Math.hypot(rx, ry), v = Math.hypot(vx, vy);
    var energy = v * v / 2 - MuEarth / r;
    var a = -MuEarth / (2 * energy);
    var rv = rx * vx + ry * vy;
    var ex = ((v * v - MuEarth / r) * rx - rv * vx) / MuEarth;
    var ey = ((v * v - MuEarth / r) * ry - rv * vy) / MuEarth;
    var e = Math.hypot(ex, ey);
    var posAngle = Math.atan2(ry, rx) / DEG;
    var argp, nu;
    if (e < 1e-6) {                       // ~circular: perigee undefined, keep position
      argp = 0; nu = posAngle;
    } else {
      argp = Math.atan2(ey, ex) / DEG;
      nu = posAngle - argp;
    }
    return {
      a: a, e: e,
      argp: ((argp % 360) + 360) % 360,
      nu: ((nu % 360) + 360) % 360
    };
  }

  // kep [a,e,inc,raan,argp,nu] + delta-v (m/s) -> new kep after an IN-PLANE burn.
  // prograde: along velocity (+ raise, - lower). radial: along position (+ out, - in).
  // The burn stays in the orbital plane, so inc and RAAN are preserved exactly.
  function applyManeuver2D(kep, dvPrograde, dvRadial) {
    var s = elementsToState2D(kep[0], kep[1], kep[4], kep[5]);
    var r = Math.hypot(s.rx, s.ry), v = Math.hypot(s.vx, s.vy);
    var vhx = s.vx / v, vhy = s.vy / v;      // prograde unit
    var rhx = s.rx / r, rhy = s.ry / r;      // radial-out unit
    var nvx = s.vx + dvPrograde * vhx + dvRadial * rhx;
    var nvy = s.vy + dvPrograde * vhy + dvRadial * rhy;
    var el = stateToElements2D(s.rx, s.ry, nvx, nvy);
    return [el.a, el.e, kep[2], kep[3], el.argp, el.nu];   // keep inc, RAAN
  }

  // orbital period (s) for a.
  function period(a) { return 2 * Math.PI * Math.sqrt((a * a * a) / MuEarth); }

  // seconds for the next forward pass from true anomaly nuFrom to nuTo on orbit (a,e).
  function timeToNu(a, e, nuFromDeg, nuToDeg) {
    var n = Math.sqrt(MuEarth / (a * a * a));
    function meanAnom(nuDeg) {
      var nuR = nuDeg * DEG;
      var E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nuR / 2), Math.sqrt(1 + e) * Math.cos(nuR / 2));
      return E - e * Math.sin(E);
    }
    var dM = meanAnom(nuToDeg) - meanAnom(nuFromDeg);
    dM = ((dM % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);   // next occurrence forward
    return dM / n;
  }

  root.SatKepler = {
    EarthRadius: EarthRadius, MuEarth: MuEarth,
    keplerianToECI: keplerianToECI,
    trueAnomalyAdvance: trueAnomalyAdvance,
    propagateKepler: propagateKepler,
    detectCollision: detectCollision,
    elementsToState2D: elementsToState2D,
    stateToElements2D: stateToElements2D,
    applyManeuver2D: applyManeuver2D,
    period: period,
    timeToNu: timeToNu
  };
})(typeof window !== 'undefined' ? window : this);
