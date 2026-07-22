// collision-core.js — scenario 5 shared orbital-collision physics (M0).
//
// The single source of truth for the two-stage attack, imported by BOTH the
// attacker console and the victim ground station so they never drift apart:
//   STAGE 1 (geometry): numericMOID() finds whether two orbits share a point and
//                       where that collision point is (dense-sampling MOID).
//   STAGE 2 (timing):   phasingManeuver() computes the delta-v + burn timing that
//                       shifts along-track arrival so both satellites reach the
//                       point at the same instant.
// Plus full 3D state <-> elements and a 3D maneuver so an out-of-plane (cross-track)
// burn can rotate the orbital plane (change inclination + RAAN), not just altitude.
//
// Depends on SatKepler (kepler.js) for constants + keplerianToECI (so sampled
// orbits match exactly what the sim draws). Distances in metres, angles in degrees.
// Loaded as a plain global (window.CollisionCore) like SatKepler; in Node set
// global.window = global and require('kepler.js') first.
(function (root) {
  'use strict';
  var K = root.SatKepler;
  if (!K) throw new Error('collision-core.js requires SatKepler (load kepler.js first)');
  var MU = K.MuEarth, RE = K.EarthRadius, DEG = Math.PI / 180;

  // ── small vector helpers (plain [x,y,z] arrays) ─────────────────────────────
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function norm(a) { return Math.sqrt(dot(a, a)); }
  function unit(a) { var n = norm(a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; }

  // ── elements -> ECI state {r,v} ─────────────────────────────────────────────
  // Uses the SAME perifocal->ECI rotation as SatKepler.keplerianToECI (argp, then
  // inc, then RAAN), applied to both position and velocity, so a sampled orbit
  // here lands exactly on the ring the sim renders.
  function stateFromElements(a, e, incDeg, raanDeg, argpDeg, nuDeg) {
    var iR = incDeg * DEG, OR = raanDeg * DEG, wR = argpDeg * DEG, nu = nuDeg * DEG;
    var cw = Math.cos(wR), sw = Math.sin(wR), ci = Math.cos(iR), si = Math.sin(iR),
        cO = Math.cos(OR), sO = Math.sin(OR);
    var p = a * (1 - e * e), r = p / (1 + e * Math.cos(nu)), k = Math.sqrt(MU / p);
    var rpx = r * Math.cos(nu), rpy = r * Math.sin(nu);          // perifocal position
    var vpx = -k * Math.sin(nu), vpy = k * (e + Math.cos(nu));   // perifocal velocity
    function rot(px, py) {                                        // perifocal(x,y,0) -> ECI
      var x1 = cw * px - sw * py, y1 = sw * px + cw * py;
      var y2 = ci * y1, z2 = si * y1;
      return [cO * x1 - sO * y2, sO * x1 + cO * y2, z2];
    }
    return { r: rot(rpx, rpy), v: rot(vpx, vpy) };
  }

  // ── ECI state {r,v} -> classical elements ───────────────────────────────────
  // Standard RV->COE (Vallado). Handles the circular-inclined case our fixed
  // orbits use (e~0): argp is undefined, so we report argp=0 and fold it into nu
  // (true argument of latitude), which keeps the plane + size + phase exact.
  function elementsFromState(r, v) {
    var rmag = norm(r), vmag = norm(v);
    var h = cross(r, v), hmag = norm(h);
    var nvec = [-h[1], h[0], 0], nmag = norm(nvec);              // node vector = k x h
    var evec = scale(sub(scale(r, vmag * vmag - MU / rmag), scale(v, dot(r, v))), 1 / MU);
    var e = norm(evec);
    var energy = vmag * vmag / 2 - MU / rmag;
    var a = Math.abs(energy) < 1e-12 ? Infinity : -MU / (2 * energy);
    var inc = Math.acos(Math.max(-1, Math.min(1, h[2] / hmag)));
    var raan = 0, argp = 0, nu = 0;
    if (nmag > 1e-9) {
      raan = Math.acos(Math.max(-1, Math.min(1, nvec[0] / nmag)));
      if (nvec[1] < 0) raan = 2 * Math.PI - raan;
    }
    if (e > 1e-8 && nmag > 1e-9) {                               // elliptical + inclined
      argp = Math.acos(Math.max(-1, Math.min(1, dot(nvec, evec) / (nmag * e))));
      if (evec[2] < 0) argp = 2 * Math.PI - argp;
      nu = Math.acos(Math.max(-1, Math.min(1, dot(evec, r) / (e * rmag))));
      if (dot(r, v) < 0) nu = 2 * Math.PI - nu;
    } else if (nmag > 1e-9) {                                    // circular + inclined
      argp = 0;                                                  // perigee undefined
      nu = Math.acos(Math.max(-1, Math.min(1, dot(nvec, r) / (nmag * rmag))));  // arg of latitude
      if (r[2] < 0) nu = 2 * Math.PI - nu;
    } else {                                                     // equatorial fallback
      nu = Math.acos(Math.max(-1, Math.min(1, r[0] / rmag)));
      if (r[1] < 0) nu = 2 * Math.PI - nu;
    }
    var d = 1 / DEG;
    return { a: a, e: e, inc: inc * d, raan: raan * d, argp: argp * d, nu: ((nu * d) % 360 + 360) % 360 };
  }

  // ── 3D maneuver: apply a delta-v in the RSW/RTN frame -> new elements ────────
  //   prograde  : along the velocity vector  -> raises/lowers the orbit (a, e)
  //   radial    : along the radius vector     -> reshapes (e, argp)
  //   crosstrack: along the orbit normal      -> rotates the plane (inc, RAAN)
  // kep = [a, e, inc, raan, argp, nu]; returns a new kep array.
  function applyManeuver3D(kep, dvPrograde, dvRadial, dvCross) {
    var s = stateFromElements(kep[0], kep[1], kep[2], kep[3], kep[4], kep[5]);
    var vh = unit(s.v);                            // prograde
    var rh = unit(s.r);                            // radial-out
    var wh = unit(cross(s.r, s.v));                // cross-track (orbit normal)
    var dv = add(add(scale(vh, dvPrograde || 0), scale(rh, dvRadial || 0)), scale(wh, dvCross || 0));
    var el = elementsFromState(s.r, add(s.v, dv));
    return [el.a, el.e, el.inc, el.raan, el.argp, el.nu];
  }

  // ── STAGE 1: numeric MOID (dense-sampling minimum distance) ──────────────────
  // Sample both orbits over true anomaly, find the closest point pair. The min
  // distance is the numeric MOID; its midpoint is the candidate collision point.
  // Optionally refine with a finer local sweep around the best pair.
  //   returns { moid, nu1, nu2, pointA, pointB, collisionPoint }  (metres, ECI)
  function numericMOID(kep1, kep2, N, refine) {
    N = N || 720;
    var nus = new Float64Array(N);
    for (var i = 0; i < N; i++) nus[i] = i * 360 / N;
    var p1 = K.keplerianToECI(kep1[0], kep1[1], kep1[2], kep1[3], kep1[4], nus);
    var p2 = K.keplerianToECI(kep2[0], kep2[1], kep2[2], kep2[3], kep2[4], nus);
    var best = Infinity, bi = 0, bj = 0;
    for (var a = 0; a < N; a++) {
      var x1 = p1.x[a], y1 = p1.y[a], z1 = p1.z[a];
      for (var b = 0; b < N; b++) {
        var dx = x1 - p2.x[b], dy = y1 - p2.y[b], dz = z1 - p2.z[b];
        var d = dx * dx + dy * dy + dz * dz;
        if (d < best) { best = d; bi = a; bj = b; }
      }
    }
    var nu1 = nus[bi], nu2 = nus[bj];
    if (refine !== false) {                        // local refine around the best pair
      var span = 360 / N * 2, M = 40;
      var r1 = _refineAxis(kep1, nu1, span, M);
      var r2 = _refineAxis(kep2, nu2, span, M);
      var rr = _minPair(kep1, r1, kep2, r2);
      nu1 = rr.nu1; nu2 = rr.nu2; best = rr.d2;
    }
    var A = K.keplerianToECI(kep1[0], kep1[1], kep1[2], kep1[3], kep1[4], nu1);
    var B = K.keplerianToECI(kep2[0], kep2[1], kep2[2], kep2[3], kep2[4], nu2);
    var pa = [A.x, A.y, A.z], pb = [B.x, B.y, B.z];
    return { moid: Math.sqrt(best), nu1: nu1, nu2: nu2, pointA: pa, pointB: pb,
             collisionPoint: scale(add(pa, pb), 0.5) };
  }
  function _refineAxis(kep, nuC, span, M) {
    var out = new Float64Array(M);
    for (var i = 0; i < M; i++) out[i] = ((nuC - span / 2 + span * i / (M - 1)) % 360 + 360) % 360;
    return out;
  }
  function _minPair(kep1, nu1s, kep2, nu2s) {
    var q1 = K.keplerianToECI(kep1[0], kep1[1], kep1[2], kep1[3], kep1[4], nu1s);
    var q2 = K.keplerianToECI(kep2[0], kep2[1], kep2[2], kep2[3], kep2[4], nu2s);
    var best = Infinity, bi = 0, bj = 0;
    for (var a = 0; a < nu1s.length; a++) for (var b = 0; b < nu2s.length; b++) {
      var dx = q1.x[a] - q2.x[b], dy = q1.y[a] - q2.y[b], dz = q1.z[a] - q2.z[b];
      var d = dx * dx + dy * dy + dz * dz;
      if (d < best) { best = d; bi = a; bj = b; }
    }
    return { nu1: nu1s[bi], nu2: nu2s[bj], d2: best };
  }

  // nearest true anomaly on an orbit to a 3D point (for STAGE 2 timing) ─────────
  function nuAtPoint(kep, point, N) {
    N = N || 720;
    var nus = new Float64Array(N);
    for (var i = 0; i < N; i++) nus[i] = i * 360 / N;
    var p = K.keplerianToECI(kep[0], kep[1], kep[2], kep[3], kep[4], nus);
    var best = Infinity, bi = 0;
    for (var j = 0; j < N; j++) {
      var dx = p.x[j] - point[0], dy = p.y[j] - point[1], dz = p.z[j] - point[2];
      var d = dx * dx + dy * dy + dz * dz;
      if (d < best) { best = d; bi = j; }
    }
    return nus[bi];
  }

  // ── STAGE 2: phasing maneuver ────────────────────────────────────────────────
  // Shift along-track arrival by dt seconds by dropping to a phasing orbit of a
  // different period for k revolutions, then restoring the original orbit.
  //   a0     : original (circular) semi-major axis (m)
  //   rBurn  : radius at the burn point (for a circular orbit = a0)
  //   phiRad : along-track phase angle to make up (rad)
  //   k      : integer phasing revolutions
  //   dir    : +1 advance (arrive earlier, shorter period), -1 delay
  // Honest scope: the drift orbit is ECCENTRIC while phasing; the clean uniform
  // time bias applies only after the original orbit is restored (two-body ideal).
  function phasingManeuver(a0, rBurn, phiRad, k, dir) {
    k = k || 1; dir = dir >= 0 ? 1 : -1;
    var n0 = Math.sqrt(MU / (a0 * a0 * a0));
    var T0 = 2 * Math.PI / n0;
    var dtSec = Math.abs(phiRad) / n0;                 // along-track time to make up
    var Tphase = T0 - dir * dtSec / k;                 // shorter period => catch up (advance)
    var aPhase = Math.pow(MU * Tphase * Tphase / (4 * Math.PI * Math.PI), 1 / 3);
    var visViva = function (r, a) { return Math.sqrt(MU * (2 / r - 1 / a)); };
    var dvOne = Math.abs(visViva(rBurn, aPhase) - visViva(rBurn, a0));
    return {
      dtSec: dtSec, k: k, dir: dir,
      T0: T0, Tphase: Tphase, aPhase: aPhase,
      dvPerBurn: dvOne, dvTotal: 2 * dvOne,            // out + restore
      // first-order sensitivity (small maneuvers only): dT/T = 1.5 da/a
      leadPerOrbit: 3 * Math.PI * (aPhase - a0) / a0
    };
  }

  // ── STAGE 2 helpers: arrival times at the collision point + phasing shift ─────
  // Time for each satellite to first reach the collision point from its current
  // true anomaly, and the timing gap between them (the mismatch STAGE 2 must close).
  function arrivalTimes(kepA, kepV, point) {
    var nuA = nuAtPoint(kepA, point), nuV = nuAtPoint(kepV, point);
    var tA = K.timeToNu(kepA[0], kepA[1], kepA[5], nuA);
    var tV = K.timeToNu(kepV[0], kepV[1], kepV[5], nuV);
    return { tA: tA, tV: tV, nuA: nuA, nuV: nuV, gap: tV - tA,
             Ta: period(kepA[0]), Tv: period(kepV[0]) };
  }
  // A phasing maneuver: burn (signed dv) to change the circular orbit a0, drift for
  // k revolutions on the phasing orbit, then restore. Returns the along-track
  // arrival-time SHIFT with DELAY POSITIVE, so it compares directly to a gap =
  // (victim arrival - attacker arrival):
  //   dvSigned > 0 (prograde)   -> larger orbit  -> longer period  -> DELAY (shift > 0)
  //   dvSigned < 0 (retrograde) -> smaller orbit -> shorter period -> ADVANCE (shift < 0)
  function phasingShift(a0, dvSigned, k) {
    k = k || 1;
    var v0 = Math.sqrt(MU / a0);          // circular speed at r = a0
    var vN = v0 + dvSigned;
    var inv = 2 / a0 - vN * vN / MU;       // 1 / aNew from vis-viva at r = a0
    if (inv <= 0) return { shift: null, escape: true };   // burn too large: unbound
    var aN = 1 / inv;
    var T0 = period(a0), TN = period(aN);
    return { shift: k * (TN - T0), aNew: aN, Tnew: TN, T0: T0, dvTotal: 2 * Math.abs(dvSigned) };
  }

  // vis-viva speed at radius r on orbit of semi-major axis a
  function speedAt(r, a) { return Math.sqrt(MU * (2 / r - 1 / a)); }
  // orbital period for a
  function period(a) { return 2 * Math.PI * Math.sqrt(a * a * a / MU); }

  // ── ACTUATION: delta-v vector -> how to fire the gas (attitude + burn) ────────
  // The maneuver stages hand us an INTENT: a delta-v vector in the RTN/RIC frame
  // [radial, in-track(prograde), cross-track]. But a real satellite cannot "apply
  // a delta-v"; it must point a thruster in that direction and burn for a time.
  // This closes that gap using the rocket equation, so the final telecommand can
  // carry the actual physical actuation (pointing + thrust + duration + propellant).
  //   dv   : [dvRadial, dvInTrack, dvCross]  (m/s, RTN)
  //   opt  : { massKg (wet mass), thrustN (thruster force), ispSec (specific impulse) }
  // returns:
  //   dvMag   total delta-v magnitude (m/s)
  //   yawDeg  in-plane pointing from +prograde toward +radial   (atan2(dvR, dvT))
  //   pitchDeg out-of-plane pointing (elevation)                (asin(dvN/|dv|))
  //   thrustN, ispSec, massKg, finalMassKg
  //   propKg  propellant consumed  = m0 (1 - exp(-dv/(Isp g0)))   [Tsiolkovsky]
  //   mdot    mass flow rate       = F / (Isp g0)
  //   burnSec burn duration        = propKg / mdot
  //   retrograde  true if the in-track component is negative (slows the satellite)
  var G0 = 9.80665;
  function burnPlan(dv, opt) {
    opt = opt || {};
    var m0 = opt.massKg || 500, F = opt.thrustN || 400, Isp = opt.ispSec || 320;
    var dvR = dv[0] || 0, dvT = dv[1] || 0, dvN = dv[2] || 0;
    var mag = Math.sqrt(dvR * dvR + dvT * dvT + dvN * dvN);
    var yawDeg = Math.atan2(dvR, dvT) * 180 / Math.PI;                       // point in the orbit plane
    var pitchDeg = mag > 0 ? Math.asin(Math.max(-1, Math.min(1, dvN / mag))) * 180 / Math.PI : 0;
    var ve = Isp * G0;                                                       // effective exhaust velocity
    var propKg = m0 * (1 - Math.exp(-mag / ve));                             // Tsiolkovsky rocket equation
    var mdot = F / ve;                                                       // propellant mass flow
    var burnSec = mdot > 0 ? propKg / mdot : 0;                              // time to expel that propellant
    return {
      dvMag: mag, yawDeg: yawDeg, pitchDeg: pitchDeg,
      thrustN: F, ispSec: Isp, massKg: m0, finalMassKg: m0 - propKg,
      propKg: propKg, mdot: mdot, burnSec: burnSec, ve: ve,
      retrograde: dvT < 0
    };
  }

  root.CollisionCore = {
    MU: MU, RE: RE, G0: G0,
    sub: sub, add: add, scale: scale, dot: dot, cross: cross, norm: norm, unit: unit,
    stateFromElements: stateFromElements,
    elementsFromState: elementsFromState,
    applyManeuver3D: applyManeuver3D,
    numericMOID: numericMOID,
    nuAtPoint: nuAtPoint,
    phasingManeuver: phasingManeuver,
    arrivalTimes: arrivalTimes,
    phasingShift: phasingShift,
    speedAt: speedAt,
    period: period,
    burnPlan: burnPlan
  };
})(typeof window !== 'undefined' ? window : this);
