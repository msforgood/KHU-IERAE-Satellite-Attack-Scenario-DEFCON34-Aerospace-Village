// app.js — ENIGMA-1 orbital-collision console (scenario 5, monitor 1), reversed flow.
//   PHASE 1 INTEL      parse both TLEs into the six classical orbital elements
//   PHASE 2 PROPAGATE  advance the clock (Kepler chain), pick the collision pass = execution time
//   PHASE 3 SOLVE      assemble the equation chain, tune the real delta-v, back-solve the burn
//   PHASE 4 TRANSMIT   ground-station-style send: build the CCSDS/cFS packet, uplink, observe
// Physics lives in kepler.js + collision-core.js; this drives the UI.
'use strict';

var $ = function (s) { return document.querySelector(s); };
var K = window.SatKepler, CC = window.CollisionCore, Scn = window.Scenario5;
var phase = 1, sim = null, solveSim = null;
var clamp = function (v, lo, hi) { return Math.max(lo, Math.min(hi, v)); };

// precomputed nominal geometry + timing (fixed collision point, victim passes)
var G = null;
// solve state
var S = {
  execTimeSec: null, execPassM: null,
  dv: { prograde: 0, cross: 0, phase: 0, k: 5 },
  thrusterId: Scn.defaultThruster,
  geom: null, timing: null, burn: null, packet: null
};

// ── formula rendering helpers ────────────────────────────────────────────────
var SUP = { '-': '⁻', '.': '·', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
function sup(n) { return String(n).split('').map(function (c) { return SUP[c] || c; }).join(''); }
function sci(x, d) { d = (d == null) ? 3 : d; if (!x) return '0'; var e = Math.floor(Math.log(Math.abs(x)) / Math.LN10); var m = x / Math.pow(10, e); return m.toFixed(d) + '×10' + sup(e); }
function frac(n, d) { return '<span class="frac"><span class="fn">' + n + '</span><span class="fd">' + d + '</span></span>'; }
function rt(inner) { return '<span class="rt"><span class="rb">' + inner + '</span></span>'; }
function fv(x) { return '<span class="fvar">' + x + '</span>'; }
function fo(x) { return '<span class="fout">' + x + '</span>'; }
function fkc(x) { return '<span class="fconst">' + x + '</span>'; }
function fmtDur(sec) { sec = Math.max(0, Math.round(sec)); var m = Math.floor(sec / 60), s = sec % 60; return m + 'm ' + (s < 10 ? '0' : '') + s + 's'; }

// ── phase navigation ─────────────────────────────────────────────────────────
function showPhase(n) {
  phase = n;
  if (sim && sim.stop) sim.stop();               // pause any running sim; the enter* handler
  if (solveSim && solveSim.stop) solveSim.stop(); // starts the one this phase needs
  for (var i = 1; i <= 4; i++) { var p = $('#phase' + i); if (p) p.classList.toggle('hidden', i !== n); }
  document.querySelectorAll('.phasebar .pstep').forEach(function (s) {
    var pp = +s.dataset.p; s.classList.toggle('active', pp === n); s.classList.toggle('done', pp < n);
  });
  window.scrollTo(0, 0);
  if (n === 2) enterPropagate();
  if (n === 3) enterSolve();
  if (n === 4) enterTransmit();
}
function wireNav() {
  $('#toIntel').onclick = function () { $('#intro').classList.add('hidden'); $('#phasebar').classList.remove('hidden'); showPhase(1); };
  $('#parseTle').onclick = parseTle;
  var t2 = $('#toProp'); if (t2) t2.onclick = function () { showPhase(2); };
  var t3 = $('#toSolve'); if (t3) t3.onclick = function () { if (!t3.disabled) showPhase(3); };
  var t4 = $('#toTransmit'); if (t4) t4.onclick = function () { if (!t4.disabled) showPhase(4); };
  document.querySelectorAll('[data-goto]').forEach(function (b) { b.onclick = function () { showPhase(+b.dataset.goto); }; });
}

// ── PHASE 1 · INTEL (TLE -> 6 orbital elements) ──────────────────────────────
function renderTleRaw() { var e = $('#tleRaw'); if (e) e.textContent = (Scn && Scn.tleText) || ''; }
function parseTleText(text) {
  var lines = text.split('\n'), out = [], name = null;
  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].trim(); if (!t) { name = null; continue; }
    if (t.charAt(0) === '1' && t.charAt(1) === ' ') { /* line 1 ignored for the demo */ }
    else if (t.charAt(0) === '2' && t.charAt(1) === ' ') {
      var c = t.split(/\s+/);
      out.push({ name: name || ('SAT ' + c[1]), inc: parseFloat(c[2]), raan: parseFloat(c[3]),
        ecc: parseFloat('0.' + c[4]), argp: parseFloat(c[5]), meanAnom: parseFloat(c[6]), meanMotion: parseFloat(c[7]) });
    } else { name = t; }
  }
  return out;
}
function orbitFromMeanMotion(mm) {
  var n = mm * 2 * Math.PI / 86400;
  var a = Math.pow(K.MuEarth / (n * n), 1 / 3);
  return { a: a, altKm: (a - K.EarthRadius) / 1000, periodMin: (2 * Math.PI / n) / 60 };
}
function parseTle() {
  var sats = parseTleText((Scn && Scn.tleText) || '');
  var box = $('#intelTable'); if (!box) return;
  var rows = sats.map(function (s) {
    var o = orbitFromMeanMotion(s.meanMotion);
    var peri = o.a * (1 - s.ecc), apo = o.a * (1 + s.ecc);
    var altLine = s.ecc < 1e-4 ? (Math.round(o.altKm) + ' km circular')
      : (Math.round((peri - K.EarthRadius) / 1000) + ' – ' + Math.round((apo - K.EarthRadius) / 1000) + ' km (e=' + s.ecc.toFixed(2) + ')');
    return '<div class="intelcard"><div class="intelname">' + s.name + '</div>' +
      '<div class="intelrow"><span>a · semi-major</span><b>' + Math.round(o.a / 1000) + ' km</b></div>' +
      '<div class="intelrow"><span>e · eccentricity</span><b>' + s.ecc.toFixed(4) + '</b></div>' +
      '<div class="intelrow"><span>i · inclination</span><b>' + s.inc.toFixed(2) + '°</b></div>' +
      '<div class="intelrow"><span>Ω · RAAN</span><b>' + s.raan.toFixed(2) + '°</b></div>' +
      '<div class="intelrow"><span>ω · arg perigee</span><b>' + s.argp.toFixed(2) + '°</b></div>' +
      '<div class="intelrow"><span>M · mean anomaly</span><b>' + s.meanAnom.toFixed(2) + '°</b></div>' +
      '<div class="intelrow"><span>altitude</span><b>' + altLine + '</b></div>' +
      '<div class="intelrow"><span>period</span><b>' + o.periodMin.toFixed(1) + ' min</b></div></div>';
  }).join('');
  box.innerHTML = '<div class="intelgrid">' + rows + '</div>';
  var read = $('#intelRead');
  if (read && sats.length >= 2) {
    var dR = Math.abs(sats[0].raan - sats[1].raan);
    read.innerHTML = 'Read: both orbits are near-polar but their <b>RAAN differs by ' + dR.toFixed(0) +
      '°</b>, so their planes cross at a steep angle — that is what makes a crossing a hypervelocity hit. ' +
      'AURORA-2 is <b>eccentric</b> (altitude rises and falls), so its orbit reaches down to where you can meet it.';
    read.classList.remove('hidden');
  }
  var t2 = $('#toProp'); if (t2) t2.classList.remove('hidden');
}

// ── PHASE 2 · PROPAGATE & TIME ───────────────────────────────────────────────
var propInited = false, propStarted = false, hint1On = false, hint2On = false;
function baseSats() { return Scn.satellites(); }
function attacker() { return baseSats().filter(function (s) { return s.role === 'attacker'; })[0]; }
function victim() { return baseSats().filter(function (s) { return s.target; })[0]; }

// nominal geometry: raise ENIGMA-1 (prograde only) until its orbit best-crosses AURORA-2;
// gives the fixed collision point P and the two orbits' passes through it.
function precompute() {
  var atk = attacker(), vic = victim();
  var base = atk.kep;
  var v0 = Math.sqrt(K.MuEarth / base[0]);           // current circular speed
  var best = null;
  for (var dvp = 0; dvp <= 900; dvp += 15) {          // scan a prograde transfer burn
    var kep = CC.applyManeuver3D(base, dvp, 0, 0);
    var mo = CC.numericMOID(kep, vic.kep, 360);
    if (!best || mo.moid < best.moid) best = { dvp: dvp, moid: mo.moid, cp: mo.collisionPoint, kep: kep };
  }
  var P = best.cp;                                    // fixed collision point (raw ECI array)
  var nuV = CC.nuAtPoint(vic.kep, P), nuA = CC.nuAtPoint(best.kep, P);
  var Tv = CC.period(vic.kep[0]), Ta = CC.period(best.kep[0]);
  var tV0 = K.timeToNu(vic.kep[0], vic.kep[1], vic.kep[5], nuV);      // victim first reaches P
  var tA0 = K.timeToNu(best.kep[0], best.kep[1], best.kep[5], nuA);   // attacker first reaches P (after transfer)
  // phasing capability: for each victim pass, the phasing dv needed (at k=30) to shift
  // the attacker's arrival onto it. A pass is REACHABLE only if that dv is within a
  // realistic budget, so the demo never asks for an absurd phasing burn.
  var kMax = 30, dvCap = 120, Tins = CC.period(best.kep[0]);   // m/s: realistic phasing ceiling
  var passes = [];
  for (var m = 0; m < 10; m++) {
    var tc = tV0 + m * Tv;
    var need = centeredMod(tc - tA0, Tins);            // align mod ENIGMA-1's period (it passes P each orbit)
    var dv = phaseDvFor(best.kep[0], need, kMax);      // min phasing dv (at kMax) to cover it
    passes.push({ m: m, tc: tc, need: need, dv: dv, feasible: dv <= dvCap });
  }
  G = { atk: atk, vic: vic, base: base, v0: v0, nominal: best, P: P,
        nuV: nuV, nuA: nuA, Tv: Tv, Ta: Ta, tV0: tV0, tA0: tA0, passes: passes };
  return G;
}

function enterPropagate() {
  if (!G) precompute();
  if (!propInited) { initPropSim(); propInited = true; }
  requestAnimationFrame(function () { if (sim) sim._resize(); });
  // time slider spans ~ the last feasible pass + one victim period (fine step for tuning)
  var span = Math.max(G.tV0 + (G.passes.length - 1) * G.Tv, G.Tv * 3) + G.Tv * 0.5;
  var sl = $('#timeSlider'); if (sl) { sl.min = 0; sl.max = span.toFixed(0); sl.step = (span / 1500).toFixed(2); sl.value = 0; }
  // default: only the TASK + slider are shown. Hints reveal the marker / the valid times.
  hint1On = false; hint2On = false; S.execTimeSec = null; S.execPassM = null;
  if (sim && sim.engine && sim.engine.setMarker) sim.engine.setMarker(null);
  var pb = $('#passBox'); if (pb) pb.classList.add('hidden');
  var hm = $('#hintMsg'); if (hm) hm.classList.add('hidden');
  var h1b = $('#hint1Btn'); if (h1b) { h1b.disabled = false; h1b.classList.remove('on', 'used'); h1b.innerHTML = '💡 Hint 1 · show collision point'; }
  var h2b = $('#hint2Btn'); if (h2b) { h2b.disabled = false; h2b.classList.remove('on', 'used'); h2b.innerHTML = '💡 Hint 2 · show valid times'; }
  wireHints();
  propAt(0);
  if (sim && !sim.running) sim.start();
}
function initPropSim() {
  var cv = $('#propSim'); if (!cv || typeof SatSim === 'undefined' || !Scn) return;
  sim = new SatSim(cv, Object.assign({ mode: 'planner' }, Scn.simOpts));
  sim.setSatellites(baseSats());
  sim.lockOn('demosat');
  if (sim.engine && sim.engine.setMarker) sim.engine.setMarker(null);   // collision marker hidden until Hint 1
  var sl = $('#timeSlider'); if (sl) sl.oninput = function () { propAt(+sl.value); };
  if (!propStarted) { sim.start(); propStarted = true; }
  // frame ENIGMA-1 once, then release the camera so mouse drag rotates freely
  setTimeout(function () { if (sim) sim.lockId = null; }, 120);
}
// reveal (or hide) the collision point (Hint 1) or the list of valid times (Hint 2).
// Both hints are TOGGLES: click to show, click again to hide.
var HINT1_MSG = '<b>Hint 1:</b> the red marker is the plane-crossing point. Find the moment <b>AURORA-2 sits on it</b> — that is where it lands on ENIGMA-1\'s (future) orbit.';
var HINT2_MSG = '<b>Hint 2:</b> these are the exact moments AURORA-2 is on the crossing. Click one to jump the clock there.';
// the hint message plate is shared, so drive it from the current toggle state
function refreshHintMsg() {
  var hm = $('#hintMsg'); if (!hm) return;
  if (hint2On) { hm.classList.remove('hidden'); hm.innerHTML = HINT2_MSG; }
  else if (hint1On) { hm.classList.remove('hidden'); hm.innerHTML = HINT1_MSG; }
  else { hm.classList.add('hidden'); hm.innerHTML = ''; }
}
function wireHints() {
  var h1 = $('#hint1Btn'); if (h1) h1.onclick = function () {
    hint1On = !hint1On;
    h1.classList.toggle('on', hint1On);
    h1.innerHTML = hint1On ? '💡 Hint 1 · hide collision point' : '💡 Hint 1 · show collision point';
    if (sim && sim.engine && sim.engine.setMarker) {
      if (hint1On && G) sim.engine.setMarker({ x: G.P[0], y: G.P[1], z: G.P[2] }, 0xff3b4e);
      else sim.engine.setMarker(null);
    }
    refreshHintMsg();
    if (lastPropT != null) updateTimeStatus(lastPropT);
  };
  var h2 = $('#hint2Btn'); if (h2) h2.onclick = function () {
    hint2On = !hint2On;
    h2.classList.toggle('on', hint2On);
    h2.innerHTML = hint2On ? '💡 Hint 2 · hide valid times' : '💡 Hint 2 · show valid times';
    var pb = $('#passBox'); if (pb) pb.classList.toggle('hidden', !hint2On);
    if (hint2On) renderPasses();
    refreshHintMsg();
  };
}
// propagate both satellites (and neighbours) to time t and update the Kepler readout
var lastPropT = null;
function propAt(t) {
  lastPropT = t;
  $('#clockVal').textContent = 't = ' + Math.round(t) + ' s  (' + fmtDur(t) + ')';
  var list = baseSats();
  list.forEach(function (s) {
    var nu = K.trueAnomalyAdvance(s.kep[0], s.kep[1], s.kep[5], t);
    var p = K.keplerianToECI(s.kep[0], s.kep[1], s.kep[2], s.kep[3], s.kep[4], nu);
    if (sim && sim.engine) sim.engine.setSatPosition(s.id, p);
  });
  renderKepler(t);
  updateTimeStatus(t);
}
// detect whether AURORA-2 is at the crossing point at time t (a valid collision window);
// if so, snap the execution time to the exact pass and enable "confirm". This is the core
// no-hint mechanic: line AURORA-2 up with the crossing using only the sim + slider.
function updateTimeStatus(t) {
  var tw = $('#timeWindow'), btn = $('#toSolve');
  var vic = G.vic, nu = K.trueAnomalyAdvance(vic.kep[0], vic.kep[1], vic.kep[5], t);
  var pv = K.keplerianToECI(vic.kep[0], vic.kep[1], vic.kep[2], vic.kep[3], vic.kep[4], nu);
  var dist = Math.hypot(pv.x - G.P[0], pv.y - G.P[1], pv.z - G.P[2]);   // AURORA-2 distance to the crossing (m)
  var best = null; G.passes.forEach(function (p) { var d = Math.abs(p.tc - t); if (!best || d < best.d) best = { d: d, p: p }; });
  var near = dist < 1000e3 && best && best.p.feasible;                  // within ~1000 km of the crossing
  if (near) {
    S.execTimeSec = best.p.tc; S.execPassM = best.p.m;
    if (btn) btn.disabled = false;
    if (tw) { tw.className = 'timewindow ok'; tw.innerHTML = '✓ <b>Collision window</b> — AURORA-2 is on the crossing (' + Math.round(dist / 1000) + ' km). Confirm to lock t = ' + fmtDur(best.p.tc) + '.'; }
  } else {
    S.execTimeSec = null; S.execPassM = null;
    if (btn) btn.disabled = true;
    if (tw) { tw.className = 'timewindow'; tw.innerHTML = 'AURORA-2 is <b>' + Math.round(dist / 1000) + ' km</b> from the crossing. Scrub the clock until it lines up' + (hint1On ? ' with the red marker.' : '.'); }
  }
  if (hint2On) renderPasses();
}
function renderKepler(t) {
  var box = $('#keplerRows'); if (!box) return;
  var rows = [attacker(), victim()].map(function (s) {
    var a = s.kep[0], e = s.kep[1], nu0 = s.kep[5];
    var n = Math.sqrt(K.MuEarth / (a * a * a));                       // mean motion
    var M0 = meanFromTrue(nu0, e), M = M0 + n * t;
    var Mdeg = ((M * 180 / Math.PI) % 360 + 360) % 360;
    var nu = K.trueAnomalyAdvance(a, e, nu0, t);
    return '<div class="krow"><div class="kname">' + s.name + '</div>' +
      '<div class="kcell"><span>n</span><b>' + (n * 1e3).toFixed(3) + ' mrad/s</b></div>' +
      '<div class="kcell"><span>M = M₀+n·t</span><b>' + Mdeg.toFixed(1) + '°</b></div>' +
      '<div class="kcell"><span>ν (Kepler)</span><b>' + nu.toFixed(1) + '°</b></div></div>';
  }).join('');
  box.innerHTML = rows;
}
function meanFromTrue(nuDeg, e) {
  var nu = nuDeg * Math.PI / 180;
  var E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
  return E - e * Math.sin(E);
}
function renderPasses() {
  var box = $('#passList'); if (!box) return;
  box.innerHTML = G.passes.map(function (p) {
    return '<div class="passrow ' + (p.feasible ? 'ok' : 'no') + (S.execPassM === p.m ? ' sel' : '') + '" data-m="' + p.m + '">' +
      '<span class="pt">pass #' + (p.m + 1) + '</span>' +
      '<span class="ptime">t = ' + fmtDur(p.tc) + '</span>' +
      '<span class="ptag">' + (p.feasible ? 'phasing ≈ ' + p.dv + ' m/s' : 'out of range') + '</span></div>';
  }).join('');
  box.querySelectorAll('.passrow.ok').forEach(function (r) {
    r.onclick = function () { pickPass(+r.dataset.m); };
  });
  var note = $('#feasNote');
  if (note) note.innerHTML = 'A pass is <b>REACHABLE</b> when a phasing burn (within ENIGMA-1\'s budget) can shift its arrival to meet AURORA-2 there. Later passes leave more room to phase.';
}
function pickPass(m) {
  var p = G.passes.filter(function (x) { return x.m === m; })[0]; if (!p || !p.feasible) return;
  // jump the clock to the exact pass; propAt -> updateTimeStatus lands AURORA-2 on the
  // crossing and enables "confirm", so the slider and the pass list share one code path.
  var sl = $('#timeSlider'); if (sl) sl.value = Math.min(+sl.max, p.tc);
  propAt(p.tc);
}

// ── PHASE 3 · SOLVE (equation-chain puzzle + variable tuning + burn plan) ──────
var CARDS = [
  { id: 'orbit', order: 0, drive: true, t: 'Transfer: new orbit', c: 'prograde Δv raises a',
    sym: frac('1', 'a<sub>new</sub>') + ' = ' + frac('2', 'a₀') + ' − ' + frac('v<sub>new</sub>²', 'μ'),
    out: function (c) { return 'a<sub>new</sub> = ' + fo(c.aNewKm + ' km'); },
    feed: 'period', driver: 'Δv prograde',
    detail: { purpose: 'The vis-viva equation, rearranged to give the new orbit size after a burn. It is how a change in speed becomes a change in orbit.',
      vars: [ ['a<sub>new</sub>', 'new semi-major axis — the orbit\'s overall size'],
              ['a₀', 'starting semi-major axis (ENIGMA-1\'s current orbit)'],
              ['v<sub>new</sub>', 'speed just after the burn = v₀ + Δv prograde'],
              ['μ', 'Earth\'s gravitational parameter, 3.986×10¹⁴ (fixed)'] ],
      effect: 'Raise Δv prograde → v<sub>new</sub> grows → a<sub>new</sub> grows → the far side of the orbit (apogee) climbs toward AURORA-2. This is the knob that makes the two rings touch (MOID → 0).' } },
  { id: 'pert', order: 1, group: ['pert-drag', 'pert-srp', 'pert-j2', 'pert-3b'],
    t: '섭동력 (Perturbations)', c: '선택하면 4개 힘으로 확장',
    sym: 'a<sub>tot</sub> = −μ ' + frac('r', '|r|³') + ' + a<sub>drag</sub> + a<sub>SRP</sub> + a<sub>J2</sub> + a<sub>3b</sub>',
    detail: { purpose: '2체 중력 외에 궤도에 실제로 작용하는 힘들. 선택하면 4개 힘 카드로 펼쳐지고, 각 힘이 체인의 어느 요소에 작용하는지 화살표로 이어집니다.',
      vars: [ ['대기 항력', 'a<sub>drag</sub>, 고도 a에 작용'],
              ['태양복사압', 'a<sub>SRP</sub>, 이심률 e에 작용'],
              ['지구 편평률 J2', 'dΩ/dt, 궤도면 Ω와 ω 세차'],
              ['제3체 중력', 'a<sub>3b</sub>, 여러 요소 장기 섭동'] ],
      effect: '실제 비행역학은 이 힘들까지 넣어 궤도를 전파합니다.' } },
  { id: 'period', order: 2, t: 'Orbital period', c: 'Kepler III',
    sym: 'T = 2π ' + rt(frac('a³', 'μ')),
    out: function (c) { return 'T = ' + fo(c.TinsMin + ' min'); },
    feed: 'arrival shift', driver: 'a<sub>new</sub>',
    detail: { purpose: 'Kepler\'s third law: how long one lap takes, from the orbit size. It turns the new orbit into a clock.',
      vars: [ ['T', 'orbital period — time for one full lap'],
              ['a', 'semi-major axis (from the transfer step)'],
              ['μ', 'Earth\'s gravitational parameter (fixed)'] ],
      effect: 'A bigger orbit has a longer period (T grows with a^1.5). This period is what the phasing maneuver briefly changes to shift ENIGMA-1\'s arrival time.' } },
  { id: 'plane', order: 4, drive: true, t: 'Plane tilt', c: 'cross-track burn',
    sym: 'Δθ ≈ arctan(' + frac('Δv⊥', 'v') + ')',
    out: function (c) { return 'Δθ = ' + fo(c.dThetaDeg + '°'); },
    feed: 'crossing point', driver: 'Δv cross-track',
    detail: { purpose: 'How far an out-of-plane (cross-track) burn tilts the orbit plane. It steers WHERE the two orbits cross.',
      vars: [ ['Δθ', 'plane tilt angle produced by the burn'],
              ['Δv⊥', 'cross-track burn (perpendicular to the orbit plane)'],
              ['v', 'orbital speed at the burn point'] ],
      effect: 'A small nudge slides the crossing point along AURORA-2. The big 13 km/s closing speed already comes from the fixed 125° plane difference (like Iridium-Cosmos), not from this burn — large cross-track values just pull the orbits apart and break the crossing.' } },
  { id: 'shift', order: 3, drive: true, t: 'Arrival-time shift', c: 'phasing, k laps',
    sym: 'Δt = k · (T<sub>new</sub> − T₀)',
    out: function (c) { return 'Δt = ' + fo(c.shiftS + ' s') + ' (off ' + c.offS + ' s)'; },
    feed: 'match the pass', driver: 'Δv phasing, k',
    detail: { purpose: 'The phasing maneuver: a brief burn onto a slightly different orbit for k laps, then back. Same orbit, but you arrive earlier or later.',
      vars: [ ['Δt', 'total arrival-time shift you gain'],
              ['k', 'number of phasing laps (revolutions)'],
              ['T<sub>new</sub>', 'period of the temporary phasing orbit (set by Δv phasing)'],
              ['T₀', 'original orbital period'] ],
      effect: 'More laps (k) or a bigger phasing Δv → a bigger shift. ENIGMA-1 passes the crossing every orbit, so tune Δt until one of those passes lands exactly when AURORA-2 is there (the timing gauge → 0).' } },
  { id: 'point', order: 5, t: 'Burn pointing', c: 'attitude',
    sym: 'yaw = atan2(Δv<sub>R</sub>, Δv<sub>T</sub>),  pitch = asin(' + frac('Δv<sub>N</sub>', '|Δv|') + ')',
    out: function (c) { return 'yaw ' + fo(c.yaw + '°') + ', pitch ' + fo(c.pitch + '°'); },
    feed: 'command packet', driver: 'Δv vector',
    detail: { purpose: 'A satellite cannot simply "apply a delta-v" — it must point its thruster along the Δv vector. This gives the burn attitude.',
      vars: [ ['yaw', 'in-plane pointing (from prograde toward radial)'],
              ['pitch', 'out-of-plane pointing (elevation)'],
              ['Δv<sub>R</sub>, Δv<sub>T</sub>, Δv<sub>N</sub>', 'radial / in-track / cross-track components of the burn'],
              ['|Δv|', 'total delta-v magnitude'] ],
      effect: 'A pure prograde burn gives yaw 0, pitch 0. Adding cross-track raises the pitch. The satellite holds this attitude while the engine fires; these angles go into the command packet.' } },
  { id: 'rocket', order: 6, t: 'Rocket equation', c: 'Tsiolkovsky',
    sym: 'Δm = m₀(1 − e' + sup('-') + '<sup>|Δv|/(Isp·g₀)</sup>),  t<sub>burn</sub> = Δm / ṁ',
    out: function (c) { return 't<sub>burn</sub> ' + fo(c.burnSec + ' s') + ', Δm ' + fo(c.propKg + ' kg'); },
    feed: 'command packet', driver: '|Δv|, thruster',
    detail: { purpose: 'Tsiolkovsky\'s rocket equation: how much propellant a delta-v costs, and how long the engine must fire.',
      vars: [ ['Δm', 'propellant burned'],
              ['m₀', 'spacecraft mass before the burn'],
              ['Isp', 'specific impulse — thruster efficiency (s)'],
              ['g₀', 'standard gravity, 9.807 m/s² (fixed)'],
              ['ṁ = F/(Isp·g₀)', 'propellant mass flow rate (F = thrust)'],
              ['t<sub>burn</sub>', 'burn duration = Δm / ṁ'] ],
      effect: 'A bigger total Δv burns more propellant. A smaller thruster (low F) means the same burn takes much longer. Pick the thruster to trade burn time against realism.' } }
];
// the 4 cards the 섭동력 group expands into. Each acts on a maneuver-chain element (shown by a
// hover arrow). Outputs are display-only; the collision solve never reads them.
var PERTURBATIONS = [
  { id: 'pert-drag', pgroup: true, t: '대기 항력 (drag)', feed: 'orbit (a, 고도)', card: 'orbit',
    sym: 'a<sub>drag</sub> = −½ ρ ' + frac('C<sub>d</sub> A', 'm') + ' v²',
    out: function (c) { var b = window.G && G.base; if (!b) return ''; var a = b[0], h = a - K.EarthRadius,
        rho = 1.3e-11 * Math.exp(-(h - 180000) / 60000), v = Math.sqrt(K.MuEarth / a);
      return 'a<sub>drag</sub> ≈ ' + fo(sci(0.5 * rho * v * v * 0.022, 2) + ' m/s²'); },
    detail: { purpose: '희박한 대기와의 마찰이 만드는 감속. LEO 궤도가 서서히 낮아지는 주원인.',
      vars: [ ['ρ', '대기밀도 (고도와 태양활동에 따라 변함)'], ['C<sub>d</sub>', '항력계수 (마찰)'],
              ['A / m', '단면적 대 질량비 (탄도계수 B = C<sub>d</sub>A/m)'], ['v', '대기에 대한 상대속도'] ],
      effect: '반장축 a가 줄어든다. 항력은 속도 반대 방향으로 작용한다.' } },
  { id: 'pert-srp', pgroup: true, t: '태양복사압 (SRP)', feed: 'orbit (e, 이심률)', card: 'orbit',
    sym: 'a<sub>SRP</sub> = −P<sub>⊙</sub> ' + frac('C<sub>r</sub> A', 'm') + ' ŝ',
    out: function (c) { return 'a<sub>SRP</sub> ≈ ' + fo(sci(4.56e-6 * 1.3 * 0.01, 2) + ' m/s²'); },
    detail: { purpose: '햇빛(광자)의 압력이 위성을 미는 힘. 하전입자인 태양풍과는 다르다.',
      vars: [ ['P<sub>⊙</sub>', '1 AU 복사압 ≈ 4.56×10' + sup('-') + sup(6) + ' N/m²'], ['C<sub>r</sub>', '반사계수'],
              ['A / m', '단면적 대 질량비'], ['ŝ', '태양 방향'] ],
      effect: '이심률 e와 궤도면을 천천히 바꾼다.' } },
  { id: 'pert-j2', pgroup: true, t: '지구 편평률 J2', feed: 'plane (Ω, ω)', card: 'plane',
    sym: frac('dΩ', 'dt') + ' = −' + frac('3', '2') + ' n J₂ ' + frac('R<sub>e</sub>²', 'p²') + ' cos i',
    out: function (c) { var b = window.G && G.base; if (!b) return ''; var a = b[0], e = b[1], inc = b[2] * Math.PI / 180,
        n = Math.sqrt(K.MuEarth / (a * a * a)), p = a * (1 - e * e), rr = K.EarthRadius / p;
      return 'dΩ/dt = ' + fo((-1.5 * n * 1.0826e-3 * rr * rr * Math.cos(inc) * 180 / Math.PI * 86400).toFixed(3) + '°/day'); },
    detail: { purpose: '지구 적도가 볼록해서 생기는 섭동. 궤도면을 돌린다.',
      vars: [ ['J₂', '≈ 1.083×10' + sup('-') + sup(3)], ['n', '평균 운동'], ['p = a(1−e²)', '반통경'], ['i', '경사각'] ],
      effect: '승교점 Ω와 근점편각 ω를 세차시킨다. 태양동기궤도는 이 세차로 유지된다.' } },
  { id: 'pert-3b', pgroup: true, t: '제3체 중력 (Moon/Sun)', feed: 'orbit (a, e, i)', card: 'orbit',
    sym: 'a<sub>3b</sub> = μ₃ [ ' + frac('r₃−r', '|r₃−r|³') + ' − ' + frac('r₃', '|r₃|³') + ' ]',
    out: function (c) { var b = window.G && G.base; if (!b) return ''; return 'a<sub>3b</sub> ≈ ' + fo(sci(2 * 4.903e12 * b[0] / Math.pow(3.844e8, 3), 2) + ' m/s²'); },
    detail: { purpose: '달과 태양의 인력이 만드는 조석형 섭동.',
      vars: [ ['μ₃', '제3체(달/태양) 중력계수'], ['r₃', '제3체 위치'], ['r', '위성 위치'] ],
      effect: '여러 궤도 요소(a, e, i)를 장기적으로 흔든다.' } }
];
var PERT_LINKS = PERTURBATIONS.map(function (p) { return { from: p.id, to: p.card }; });
var lastCtx = null;
var chainState = { placed: [], pool: [] };

function enterSolve() {
  if (!G || S.execTimeSec == null) return;
  // reset puzzle + variables
  chainState.placed = []; chainState.step = 0;
  chainState.pool = CARDS.slice().sort(function () { return Math.random() - 0.5; });
  // start with every delta-v at 0 so ENIGMA-1 begins exactly where Phase 2 left it
  // (its un-maneuvered orbit at time T); the participant then tunes the values up.
  S.dv = { prograde: 0, cross: 0, phase: 0, k: 12 };
  renderChain(); renderVarBlock(); syncVarInputs();
  wireSolveControls();
  renderThrusterSel();
  lockVars(false); lockThruster(true);
  initSolveSim();
  placeSolveSimAtT();
  updateSolve();
}
// place the victim + neighbours at the Phase-2 execution time T (they are the fixed
// backdrop; only ENIGMA-1 moves as the burn is tuned)
function placeSolveSimAtT() {
  if (!solveSim || !solveSim.engine || S.execTimeSec == null) return;
  baseSats().forEach(function (s) {
    if (s.role === 'attacker') return;
    var nu = K.trueAnomalyAdvance(s.kep[0], s.kep[1], s.kep[5], S.execTimeSec);
    solveSim.engine.setSatPosition(s.id, K.keplerianToECI(s.kep[0], s.kep[1], s.kep[2], s.kep[3], s.kep[4], nu));
  });
}
// live orbit view for the solve phase: ENIGMA-1's predicted orbit updates as the
// participant tunes the burn, with the collision point marked once the orbits cross.
function initSolveSim() {
  var cv = $('#solveSim'); if (!cv || typeof SatSim === 'undefined' || !Scn) return;
  if (!solveSim) {
    solveSim = new SatSim(cv, Object.assign({ mode: 'planner' }, Scn.simOpts));
    solveSim.setSatellites(baseSats());
    solveSim.lockOn('demosat');
  }
  requestAnimationFrame(function () { if (solveSim) solveSim._resize(); });
  if (!solveSim.running) solveSim.start();
  // frame ENIGMA-1 once, then release the camera so mouse drag rotates freely
  setTimeout(function () { if (solveSim) solveSim.lockId = null; }, 120);
}
function renderChain() {
  var slots = $('#chainSlots'), pool = $('#chainPool');
  var mnum = 0;
  var placedHTML = chainState.placed.map(function (c) {
    var badge = c.pgroup ? '<span class="cnum pgroup">∿</span>' : '<span class="cnum">' + (++mnum) + '</span>';
    return '<div class="ccard placed' + (c.pgroup ? ' pcard' : '') + '" data-id="' + c.id + '">' +
      '<div class="cchead">' + badge + '<span class="ct">' + c.t + '</span>' +
        (c.drive ? '<span class="cdrv">▲ ' + c.driver + '</span>' : '') +
        '<button class="cexp" data-id="' + c.id + '" title="show details">ⓘ</button></div>' +
      '<div class="csym">' + c.sym + '</div>' +
      '<div class="cout" id="cout-' + c.id + '"><span class="muted">tune →</span></div>' +
      '<div class="cfeedchip">' + (c.pgroup ? 'acts on → ' : 'feeds → ') + c.feed + '</div>' +
    '</div>';
  }).join('') || '<div class="chainempty">Click the equations below, in dependency order, to build the chain.</div>';
  slots.innerHTML = placedHTML;   // the 6-step maneuver chain only (perturbations live in their own block)
  pool.innerHTML = chainState.pool.map(function (c) {
    return '<div class="ccard pool" data-id="' + c.id + '"><span class="ct">' + c.t + '</span><span class="cpc">' + c.c + '</span></div>';
  }).join('');
  slots.querySelectorAll('.ccard').forEach(function (el) {
    el.onclick = function () { explainCard(el.dataset.id); };
    el.onmouseenter = function () { highlightChainLink(el.dataset.id, true); };
    el.onmouseleave = function () { highlightChainLink(el.dataset.id, false); };
  });
  slots.querySelectorAll('.cexp').forEach(function (b) { b.onclick = function (e) { e.stopPropagation(); explainCard(b.dataset.id); }; });
  pool.querySelectorAll('.ccard').forEach(function (el) { el.onclick = function () { tryPlace(el.dataset.id); }; });
  if (lastCtx) updateChainLive(lastCtx);
  drawChainArrows();
}
function pulseSolveSim() { var cv = $('#solveSim'); if (cv) { cv.classList.remove('simpulse'); void cv.offsetWidth; cv.classList.add('simpulse'); setTimeout(function () { cv.classList.remove('simpulse'); }, 700); } }
// fill each placed card's output with its live computed value, showing the result
// that flows into the next equation in the chain
function updateChainLive(ctx) {
  if (!ctx) return; lastCtx = ctx;
  chainState.placed.forEach(function (c) {
    var el = document.getElementById('cout-' + c.id);
    if (el && c.out) el.innerHTML = '<span class="colabel">→ outputs</span> ' + c.out(ctx);
  });
}
// ── chain dependency arrows: show where each result feeds the next equation ──────
// Solve-chain arrows (a → period, T → shift) are always visible. Perturbation arrows stay
// hidden until you hover their card, keeping the default view clean. Every arrow has a
// START DOT (where it begins) and an ARROWHEAD (where it goes), plus a solid, readable label.
var CHAIN_LINKS = [ { from: 'orbit', to: 'period', label: 'a' }, { from: 'period', to: 'shift', label: 'T' } ];
var _chainTuneTimer = null, _chainResizeWired = false;
function _bez(sp, c1, c2, dp, t) {
  var u = 1 - t;
  return { x: u*u*u*sp.x + 3*u*u*t*c1.x + 3*u*t*t*c2.x + t*t*t*dp.x,
           y: u*u*u*sp.y + 3*u*u*t*c1.y + 3*u*t*t*c2.y + t*t*t*dp.y };
}
function _arrow(svg, NS, sp, c1, c2, dp, cls, from, to) {
  var extra = cls ? (' ' + cls) : '';
  var dot = document.createElementNS(NS, 'circle');
  dot.setAttribute('class', 'chainstart' + extra); dot.setAttribute('data-from', from); dot.setAttribute('data-to', to);
  dot.setAttribute('cx', sp.x); dot.setAttribute('cy', sp.y); dot.setAttribute('r', 3.5); svg.appendChild(dot);
  var p = document.createElementNS(NS, 'path');
  p.setAttribute('class', 'chainarrow' + extra); p.setAttribute('data-from', from); p.setAttribute('data-to', to);
  p.setAttribute('d', 'M ' + sp.x + ' ' + sp.y + ' C ' + c1.x + ' ' + c1.y + ' ' + c2.x + ' ' + c2.y + ' ' + dp.x + ' ' + dp.y);
  p.setAttribute('marker-end', 'url(#chainAH)'); svg.appendChild(p);
}
function drawChainArrows() {
  var col = document.querySelector('#phase3 .puzzlecol'); if (!col) return;
  if (getComputedStyle(col).position === 'static') col.style.position = 'relative';
  var NS = 'http://www.w3.org/2000/svg';
  var svg = col.querySelector('#chainArrows');
  if (!svg) {
    svg = document.createElementNS(NS, 'svg'); svg.id = 'chainArrows'; svg.setAttribute('class', 'chainarrows');
    svg.innerHTML = '<defs><marker id="chainAH" markerWidth="10" markerHeight="10" refX="7" refY="3.2" orient="auto">' +
      '<path d="M0,0 L8,3.2 L0,6.4 Z" fill="currentColor"/></marker></defs>';
    col.appendChild(svg);
  }
  Array.prototype.slice.call(svg.querySelectorAll('.chainarrow,.chainlabel,.chainstart')).forEach(function (n) { n.remove(); });
  svg.setAttribute('width', col.clientWidth); svg.setAttribute('height', col.clientHeight);
  var cr = col.getBoundingClientRect();
  CHAIN_LINKS.forEach(function (lk) {   // from the source card's output to the next equation that uses it
    var src = document.getElementById('cout-' + lk.from);
    var dstCard = document.querySelector('#chainSlots .ccard[data-id="' + lk.to + '"]');
    var dst = dstCard ? (dstCard.querySelector('.csym') || dstCard) : null;
    if (!src || !dst) return;
    var a = src.getBoundingClientRect(), b = dst.getBoundingClientRect();
    var sp = { x: a.right - cr.left, y: a.top + a.height / 2 - cr.top };
    var dp = { x: b.left - cr.left, y: b.top + b.height / 2 - cr.top };
    var mx = (sp.x + dp.x) / 2;
    _arrow(svg, NS, sp, { x: mx, y: sp.y }, { x: mx, y: dp.y }, dp, '', lk.from, lk.to);
  });
  PERT_LINKS.forEach(function (lk) {   // hover-only: each perturbation card → the chain element it acts on
    var srcCard = document.querySelector('#chainSlots .ccard[data-id="' + lk.from + '"]');
    var dstCard = document.querySelector('#chainSlots .ccard[data-id="' + lk.to + '"]');
    if (!srcCard || !dstCard) return;
    var a = srcCard.getBoundingClientRect(), b = dstCard.getBoundingClientRect();
    var sp = { x: a.left + a.width / 2 - cr.left, y: a.top + a.height / 2 - cr.top };
    var dp = { x: b.left + b.width / 2 - cr.left, y: b.top + b.height / 2 - cr.top };
    var my = (sp.y + dp.y) / 2;
    _arrow(svg, NS, sp, { x: sp.x, y: my }, { x: dp.x, y: my }, dp, 'pert', lk.from, lk.to);
  });
  if (!_chainResizeWired) { _chainResizeWired = true; window.addEventListener('resize', function () { if (phase === 3) drawChainArrows(); }); }
}
function highlightChainLink(cardId, on) {
  var svg = document.getElementById('chainArrows'); if (!svg) return;
  svg.querySelectorAll('.chainarrow,.chainlabel,.chainstart').forEach(function (n) {
    if (n.getAttribute('data-from') === cardId || n.getAttribute('data-to') === cardId) n.classList.toggle('hot', on);
  });
}
function markChainTuning() {
  var svg = document.getElementById('chainArrows'); if (!svg) return;
  svg.classList.add('tuning'); clearTimeout(_chainTuneTimer);
  _chainTuneTimer = setTimeout(function () { svg.classList.remove('tuning'); }, 1100);
}
function tryPlace(id) {
  var card = CARDS.filter(function (c) { return c.id === id; })[0];
  explainCard(id);
  if (card.order === chainState.step) {   // step counts pool items placed (a group counts as one)
    var added = card.group
      ? card.group.map(function (pid) { return PERTURBATIONS.filter(function (x) { return x.id === pid; })[0]; }).filter(Boolean)
      : [card];
    added.forEach(function (pc) { chainState.placed.push(pc); });
    chainState.pool = chainState.pool.filter(function (c) { return c.id !== id; });
    chainState.step++;
    renderChain();
    added.forEach(function (pc) { var el = document.querySelector('#chainSlots .ccard[data-id="' + pc.id + '"]'); if (el) { el.classList.add('justplaced'); setTimeout(function () { if (el) el.classList.remove('justplaced'); }, 750); } });
    pulseSolveSim();
    if (chainState.step === CARDS.length) { lockVars(true); flashExplain('Chain complete — every equation and force is linked. Tune the burn variables and watch the results update.'); }
    else { flashExplain('Linked ' + chainState.step + '/' + CARDS.length + ': ' + card.t + '.'); }
  } else {
    flashExplain('Not yet — that equation depends on an earlier one. Build the chain in order.');
  }
}
function explainCard(id) {
  var c = CARDS.filter(function (x) { return x.id === id; })[0] || PERTURBATIONS.filter(function (x) { return x.id === id; })[0];
  if (!c) return;
  var d = c.detail || {};
  var vars = (d.vars || []).map(function (v) { return '<div class="cev"><b>' + v[0] + '</b><span>' + v[1] + '</span></div>'; }).join('');
  $('#cardExplain').innerHTML =
    '<div class="cetitle">' + c.t + '<span class="cesymsm">' + c.sym + '</span></div>' +
    '<div class="cesec"><span class="cel">WHAT IT COMPUTES</span><div class="cet">' + (d.purpose || c.why || '') + '</div></div>' +
    (vars ? '<div class="cesec"><span class="cel">VARIABLES</span><div class="cevars">' + vars + '</div></div>' : '') +
    '<div class="cesec"><span class="cel">EFFECT OF CHANGING IT</span><div class="cet">' + (d.effect || '') + '</div></div>';
}
function flashExplain(msg) { var e = $('#cardExplain'); if (e) { var d = document.createElement('div'); d.className = 'ceflash'; d.textContent = msg; e.prepend(d); setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 2600); } }

function renderVarBlock() { /* markup is static in index.html; just enable/disable */ }
function lockVars(on) {
  var blk = $('#varBlock'); if (blk) blk.classList.toggle('locked', !on);
  $('#varLock').textContent = on ? 'chain assembled — tune away' : 'assemble the chain first';
  ['#inPg', '#inCr', '#inPh', '#inK'].forEach(function (s) { var e = $(s); if (e) e.disabled = !on; });
  document.querySelectorAll('#varBlock .stepbtn').forEach(function (b) { b.disabled = !on; });
}
function lockThruster(lock) {
  var blk = $('#thrBlock'); if (blk) blk.classList.toggle('locked', lock);
  $('#thrLock').textContent = lock ? 'lock geometry + timing first' : 'choose the thruster';
}
function syncVarInputs() {
  var m = { '#inPg': S.dv.prograde, '#inCr': S.dv.cross, '#inPh': S.dv.phase, '#inK': S.dv.k };
  Object.keys(m).forEach(function (s) { var e = $(s); if (e) e.value = m[s]; });
}
function wireSolveControls() {
  var inMap = { prograde: '#inPg', cross: '#inCr', phase: '#inPh', k: '#inK' };
  Object.keys(inMap).forEach(function (key) {
    var el = $(inMap[key]); if (el) el.oninput = function () { S.dv[key] = clampVar(key, +el.value || 0); updateSolve(); };
  });
  var STEP = { prograde: 10, cross: 20, phase: 1, k: 1 };
  var KEYOF = { pg: 'prograde', cr: 'cross', ph: 'phase', k: 'k' };
  document.querySelectorAll('#varBlock .stepbtn').forEach(function (b) {
    b.onclick = function () {
      var a = b.dataset.act, sign = a.indexOf('+') >= 0 ? 1 : -1, key = KEYOF[a.replace(/[+-]/g, '')];
      if (!key) return;
      S.dv[key] = clampVar(key, S.dv[key] + sign * STEP[key]); syncVarInputs(); updateSolve();
    };
  });
  var tb = $('#toTransmit'); if (tb) tb.onclick = function () { if (!tb.disabled) showPhase(4); };
}
function clampVar(key, v) {
  var r = Scn.dvRanges;
  if (key === 'prograde') return clamp(Math.round(v), r.prograde[0], r.prograde[1]);
  if (key === 'cross') return clamp(Math.round(v), r.cross[0], r.cross[1]);
  if (key === 'phase') return clamp(Math.round(v), 0, (r.phase && r.phase[1]) || 300);
  if (key === 'k') return clamp(Math.round(v), 1, 30);
  return v;
}
// signed remainder of x mod m in [-m/2, +m/2] (ENIGMA-1 passes the crossing every orbit,
// so timing only matters modulo its period)
function centeredMod(x, m) { var r = ((x % m) + m) % m; return r > m / 2 ? r - m : r; }
// smallest phasing dv (m/s) whose k-lap shift covers |target| seconds (binary search)
function phaseDvFor(a0, target, k) {
  var dir = target >= 0 ? 1 : -1, lo = 0, hi = 300;
  for (var i = 0; i < 26; i++) {
    var mid = (lo + hi) / 2, ps = CC.phasingShift(a0, dir * mid, k), sh = ps && ps.shift != null ? ps.shift : 0;
    if (Math.abs(sh) < Math.abs(target)) lo = mid; else hi = mid;
  }
  return Math.round((lo + hi) / 2);
}
function suggestPhaseDv(a0, tA, targetTime, k) { return phaseDvFor(a0, centeredMod(targetTime - tA, CC.period(a0)), k); }
// geometry (prograde + cross-track burn) -> orbit + MOID; timing (phase + k) -> arrival
function updateSolve() {
  var base = G.base;
  // zero delta-v => the un-maneuvered base orbit exactly (avoids state<->elements round-trip drift,
  // so Phase 3 starts on the very same orbit/position Phase 2 showed)
  var kep = (S.dv.prograde === 0 && S.dv.cross === 0) ? base.slice() : CC.applyManeuver3D(base, S.dv.prograde, 0, S.dv.cross);
  var mo = CC.numericMOID(kep, G.vic.kep, 480);
  var geomLocked = mo.moid <= (Scn.moidThreshold || 20000);
  var P = G.P;   // the fixed collision point chosen in Phase 2 (where AURORA-2 is at time T)
  // closing speed + geometry anchored on that fixed point
  var nuA = CC.nuAtPoint(kep, P), nuV = CC.nuAtPoint(G.vic.kep, P);
  var sA = CC.stateFromElements(kep[0], kep[1], kep[2], kep[3], kep[4], nuA);
  var sV = CC.stateFromElements(G.vic.kep[0], G.vic.kep[1], G.vic.kep[2], G.vic.kep[3], G.vic.kep[4], nuV);
  var closing = CC.norm(CC.sub(sA.v, sV.v));
  S.geom = { kep: kep, moid: mo.moid, cp: P, closingKmS: Math.round(closing / 100) / 10, nuA: nuA, nuV: nuV };
  // timing: ENIGMA-1 passes P every orbit, so what matters is whether one of those passes
  // lands at the chosen time T. Measure the arrival mismatch MODULO ENIGMA-1's period.
  var tA = K.timeToNu(kep[0], kep[1], kep[5], nuA);
  var Tins = CC.period(kep[0]);
  var need = centeredMod(S.execTimeSec - tA, Tins);          // signed time to align, within one orbit
  var dvSigned = (need >= 0) ? Math.abs(S.dv.phase) : -Math.abs(S.dv.phase);   // delay if we must arrive later
  var ps = CC.phasingShift(kep[0], dvSigned, S.dv.k);
  var shift = ps && ps.shift != null ? ps.shift : 0;
  var arrival = tA + shift;
  var offset = arrival - S.execTimeSec;
  var residual = centeredMod(offset, Tins);                  // how far ENIGMA-1's nearest pass is from T
  var timeLocked = Math.abs(residual) < 45;
  S.timing = { tA: tA, dvSigned: dvSigned, shift: shift, arrival: arrival, offset: offset, residual: residual, dvTotal: ps ? ps.dvTotal : 0, aNew: ps ? ps.aNew : kep[0] };
  // live sim AT the Phase-2 execution time T: draw ENIGMA-1's new orbit and place it where
  // it actually is at T. Raising Δv reshapes the ring; phasing (offset) slides ENIGMA-1
  // along it. Locked geometry + timing => ENIGMA-1 sits on P, on top of AURORA-2.
  if (solveSim && solveSim.engine) {
    // propagate ENIGMA-1 on its (maneuvered) orbit from the burn point by T minus the
    // phasing shift: at zero dv this is exactly Phase 2's position; when locked it sits on P.
    var nuAtT = K.trueAnomalyAdvance(kep[0], kep[1], kep[5], S.execTimeSec - shift);
    var posAtT = K.keplerianToECI(kep[0], kep[1], kep[2], kep[3], kep[4], nuAtT);
    solveSim.engine.setOrbitLine('demosat', kep);
    solveSim.engine.setSatPosition('demosat', posAtT);
    if (solveSim.engine.setMarker) solveSim.engine.setMarker({ x: P[0], y: P[1], z: P[2] }, 0xff3b4e);
  }
  // live equation-chain values: each formula's result, flowing to the next card
  var lth = thruster();
  var livePlan = CC.burnPlan([0, S.dv.prograde, S.dv.cross], { massKg: Scn.spacecraft.massKg, thrustN: lth.thrustN, ispSec: lth.ispSec });
  var vBurn = Math.sqrt(K.MuEarth / G.base[0]);
  updateChainLive({
    kep: kep,
    aNewKm: Math.round(kep[0] / 1000),
    TinsMin: (CC.period(kep[0]) / 60).toFixed(1),
    dThetaDeg: (Math.atan2(Math.abs(S.dv.cross), vBurn) * 180 / Math.PI).toFixed(2),
    incDeg: kep[2].toFixed(1),
    shiftS: Math.round(shift), offS: Math.round(residual),
    yaw: livePlan.yawDeg.toFixed(1), pitch: livePlan.pitchDeg.toFixed(1),
    burnSec: livePlan.burnSec.toFixed(0), propKg: livePlan.propKg.toFixed(1)
  });
  // gauges
  var moidKm = Math.round(mo.moid / 1000);
  $('#moidNum').textContent = moidKm; $('#moidFill').style.width = clamp(100 - moidKm / 4, 3, 100) + '%';
  $('#gMoid').classList.toggle('lock', geomLocked);
  $('#timeNum').textContent = Math.round(residual); $('#timeFill').style.width = clamp(100 - Math.abs(residual) / 5, 3, 100) + '%';
  $('#gTime').classList.toggle('lock', timeLocked);
  var st = $('#solveState');
  if (geomLocked && timeLocked) { st.textContent = 'GEOMETRY + TIMING LOCKED — choose a thruster and confirm the burn.'; st.className = 'solvestate lock'; }
  else if (!geomLocked) { st.textContent = 'Geometry: raise Δv prograde so the orbits cross (MOID → 0). MOID ' + moidKm + ' km — try Δv prograde ≈ ' + G.nominal.dvp + ' m/s.'; st.className = 'solvestate'; }
  else { var sug = suggestPhaseDv(kep[0], tA, S.execTimeSec, S.dv.k); st.textContent = 'Timing: ENIGMA-1\'s pass is off by ' + Math.round(residual) + ' s. Set phasing Δv ≈ ' + sug + ' m/s at k=' + S.dv.k + ' (more revs = smaller Δv per lap).'; st.className = 'solvestate'; }
  lockThruster(!(geomLocked && timeLocked));
  if (geomLocked && timeLocked) renderBurn(); else { $('#burnPanel').innerHTML = ''; S.burn = null; }
  var tb = $('#toTransmit'); if (tb) tb.disabled = !(geomLocked && timeLocked && S.burn);
  drawChainArrows(); markChainTuning();   // keep arrows aligned + flag the live recompute
}
function renderThrusterSel() {
  var box = $('#thrSel'); if (!box) return;
  box.innerHTML = Scn.thrusters.map(function (th) {
    return '<div class="thropt' + (S.thrusterId === th.id ? ' sel' : '') + '" data-id="' + th.id + '">' +
      '<b>' + th.name + '</b><span>' + th.thrustN + ' N · Isp ' + th.ispSec + ' s</span><i>' + th.note + '</i></div>';
  }).join('');
  box.querySelectorAll('.thropt').forEach(function (el) {
    el.onclick = function () { S.thrusterId = el.dataset.id; renderThrusterSel(); if (S.geom) renderBurn(); updateTransmitReady(); };
  });
}
function updateTransmitReady() { var tb = $('#toTransmit'); if (tb) tb.disabled = !(S.geom && S.timing && S.burn); }
function thruster() { return Scn.thrusters.filter(function (t) { return t.id === S.thrusterId; })[0] || Scn.thrusters[0]; }
// back-solve the burn: the commanded INSERTION burn (transfer prograde + plane cross-
// track) is one delta-v vector -> pointing + thrust + duration + propellant. The
// phasing is a separate timing maneuver; its fuel is added to the total budget.
function renderBurn() {
  var th = thruster(), opt = { massKg: Scn.spacecraft.massKg, thrustN: th.thrustN, ispSec: th.ispSec };
  var dv = [0, S.dv.prograde, S.dv.cross];                 // in-track transfer + cross-track plane
  var plan = CC.burnPlan(dv, opt);
  var phaseDvTotal = S.timing ? Math.abs(S.timing.dvTotal || 0) : 0;      // 2×|phasing dv|, out + restore
  // phasing happens AFTER the insertion burn, so it sizes against the lighter post-insertion mass
  var phasePlan = CC.burnPlan([0, phaseDvTotal, 0], { massKg: Scn.spacecraft.massKg - plan.propKg, thrustN: th.thrustN, ispSec: th.ispSec });
  var totalProp = plan.propKg + phasePlan.propKg;
  S.burn = { plan: plan, dv: dv, thruster: th, phaseDvTotal: phaseDvTotal, phaseProp: phasePlan.propKg, totalProp: totalProp };
  $('#burnPanel').innerHTML =
    '<div class="brow"><span>Insertion Δv</span><b>' + plan.dvMag.toFixed(1) + ' m/s</b></div>' +
    '<div class="brow"><span>Point thruster</span><b>yaw ' + plan.yawDeg.toFixed(1) + '°, pitch ' + plan.pitchDeg.toFixed(1) + '°' + (plan.retrograde ? ' (retro)' : ' (prograde)') + '</b></div>' +
    '<div class="brow"><span>Thrust · Isp</span><b>' + th.thrustN + ' N · ' + th.ispSec + ' s</b></div>' +
    '<div class="brow"><span>Burn duration</span><b>' + plan.burnSec.toFixed(1) + ' s</b></div>' +
    '<div class="brow"><span>Phasing Δv (k=' + S.dv.k + ')</span><b>' + phaseDvTotal.toFixed(1) + ' m/s</b></div>' +
    '<div class="brow"><span>Propellant total</span><b>' + totalProp.toFixed(2) + ' kg</b> <span class="bdim">(of ' + Scn.spacecraft.massKg + ' kg)</span></div>' +
    '<div class="bnote">' + (plan.burnSec > CC.period(G.base[0]) / 4 ?
      'The small 22 N thruster makes this a long finite burn — the high-thrust option shortens it. ' : '') +
      'Planned as an impulsive Δv; the real burn spans the duration above.</div>';
  updateTransmitReady();
}

// ── PHASE 4 · TRANSMIT (extended CCSDS/cFS byte map + uplink) ─────────────────
// 38-byte layout: header(6) fc(1) chk(1) time(6) mode(1) thrmask(1)
//   dvIn(4) dvCross(4) thrustN(4) yaw(2) pitch(2) burnDur(2) prop(2) crc(2)
var PKT_FIELDS = [
  { o: 0, n: 2, g: 'hdr', label: 'CCSDS primary: version / type=CMD / APID 0x1F0' },
  { o: 2, n: 2, g: 'hdr', label: 'Sequence flags + count' },
  { o: 4, n: 2, g: 'hdr', label: 'Packet data length (= total − 7)' },
  { o: 6, n: 1, g: 'fc', label: 'Function code = 0x03 START BURN' },
  { o: 7, n: 1, g: 'chk', label: 'cFS command XOR checksum (whole packet → 0)' },
  { o: 8, n: 6, g: 'time', label: 'Execution time T (CUC: 4B sec + 2B subsec)' },
  { o: 14, n: 1, g: 'act', label: 'Maneuver mode (RTN delta-v + burn)' },
  { o: 15, n: 1, g: 'act', label: 'Thruster select mask (from pointing)' },
  { o: 16, n: 4, g: 'dv', label: 'delta-v in-track / prograde (float32, m/s)' },
  { o: 20, n: 4, g: 'dv', label: 'delta-v cross-track (float32, m/s)' },
  { o: 24, n: 4, g: 'act', label: 'thrust magnitude F (float32, N)' },
  { o: 28, n: 2, g: 'act', label: 'burn attitude yaw (int16, 0.1°)' },
  { o: 30, n: 2, g: 'act', label: 'burn attitude pitch (int16, 0.1°)' },
  { o: 32, n: 2, g: 'act', label: 'burn duration (uint16, 0.1 s)' },
  { o: 34, n: 2, g: 'act', label: 'propellant Δm (uint16, 0.1 kg)' },
  { o: 36, n: 2, g: 'chk', label: 'payload CRC-16-CCITT (bytes 8-35)' }
];
var PKT_LEN = 38;
function crc16(u8, start, end) {
  var c = 0xFFFF;
  for (var i = start; i < end; i++) { c ^= u8[i] << 8; for (var b = 0; b < 8; b++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF; }
  return c;
}
function buildPacket() {
  var plan = S.burn.plan, buf = new ArrayBuffer(PKT_LEN), w = new DataView(buf), u8 = new Uint8Array(buf);
  var execSec = Math.round(S.execTimeSec || 0), apid = 0x1F0, fc = 0x03;
  var dvIn = S.dv.prograde, dvCross = S.dv.cross;   // commanded insertion burn (in-track + cross-track)
  w.setUint16(0, (0 << 13) | (1 << 12) | (1 << 11) | (apid & 0x7FF), false);
  w.setUint16(2, (3 << 14) | 0, false);
  w.setUint16(4, PKT_LEN - 7, false);
  u8[6] = fc & 0x7F; u8[7] = 0;
  w.setUint32(8, execSec >>> 0, false); w.setUint16(12, 0, false);
  u8[14] = 0x02; u8[15] = 0x01;
  w.setFloat32(16, dvIn, false); w.setFloat32(20, dvCross, false);
  w.setFloat32(24, plan.thrustN, false);
  w.setInt16(28, Math.round(plan.yawDeg * 10), false);
  w.setInt16(30, Math.round(plan.pitchDeg * 10), false);
  w.setUint16(32, Math.min(0xFFFF, Math.round(plan.burnSec * 10)), false);
  w.setUint16(34, Math.min(0xFFFF, Math.round((S.burn.totalProp || plan.propKg) * 10)), false);
  // payload CRC-16 over bytes 8..35 (independent of the header + command checksum)
  w.setUint16(36, crc16(u8, 8, 36), false);
  // cFS command checksum LAST: XOR of the whole packet (byte 7 = 0 here), so the
  // stored value makes the packet's total XOR validate to 0. Covers the CRC bytes too.
  var x = 0xFF; for (var i = 0; i < PKT_LEN; i++) x ^= u8[i]; u8[7] = x;
  return { u8: u8, w: w };
}
function fieldGroupAt(off) { for (var i = 0; i < PKT_FIELDS.length; i++) { var f = PKT_FIELDS[i]; if (off >= f.o && off < f.o + f.n) return f.g; } return 'hdr'; }
function enterTransmit() {
  var pk = buildPacket(); S.packet = pk;
  var hex = $('#pktHex');
  if (hex) { var html = ''; for (var i = 0; i < pk.u8.length; i++) html += '<span class="pb pg-' + fieldGroupAt(i) + '" title="byte ' + i + '">' + ('0' + pk.u8[i].toString(16)).slice(-2).toUpperCase() + '</span>'; hex.innerHTML = html; }
  var fields = $('#pktFields');
  if (fields) {
    var val = function (f) {
      if (f.g === 'dv') return pk.w.getFloat32(f.o, false).toFixed(1) + ' m/s';
      if (f.o === 24) return pk.w.getFloat32(24, false).toFixed(0) + ' N';
      if (f.o === 28) return (pk.w.getInt16(28, false) / 10).toFixed(1) + '°';
      if (f.o === 30) return (pk.w.getInt16(30, false) / 10).toFixed(1) + '°';
      if (f.o === 32) return (pk.w.getUint16(32, false) / 10).toFixed(1) + ' s';
      if (f.o === 34) return (pk.w.getUint16(34, false) / 10).toFixed(1) + ' kg';
      if (f.g === 'time') return 'T = ' + pk.w.getUint32(8, false) + ' s';
      if (f.o === 6) return '0x03';
      if (f.o === 4) return (PKT_LEN - 7) + ' B';
      return '';
    };
    fields.innerHTML = PKT_FIELDS.map(function (f) {
      return '<div class="pktfield pg-' + f.g + '"><span class="pkoff">' + f.o + (f.n > 1 ? '–' + (f.o + f.n - 1) : '') + '</span>' +
        '<span class="pklbl">' + f.label + '</span><b>' + val(f) + '</b></div>';
    }).join('');
  }
  $('#pktLen').textContent = pk.u8.length;
  renderUplinkSummary();
}
function renderUplinkSummary() {
  var box = $('#uplinkSummary'); if (!box) return; var g = S.geom || {}, b = S.burn || {}, plan = b.plan || {};
  box.innerHTML =
    '<div class="usrow"><span>Target</span><b>' + G.vic.name + '</b></div>' +
    '<div class="usrow"><span>Execution time</span><b>t = ' + fmtDur(S.execTimeSec) + '</b></div>' +
    '<div class="usrow"><span>Closing speed</span><b>' + (g.closingKmS || '?') + ' km/s</b></div>' +
    '<div class="usrow"><span>Burn</span><b>point yaw ' + (plan.yawDeg != null ? plan.yawDeg.toFixed(0) : '?') + '°, ' + (b.thruster ? b.thruster.thrustN : '?') + ' N for ' + (plan.burnSec != null ? plan.burnSec.toFixed(1) : '?') + ' s</b></div>' +
    '<div class="usrow"><span>Command</span><b>START BURN (FC 0x03)</b></div>' +
    '<div class="usnote">Packet ready. Press TRANSMIT to command ENIGMA-1 to execute the burn.</div>';
}
function maneuverMsg() {
  var g = S.geom || {}, b = S.burn || {}, plan = b.plan || {};
  return { command: 'orbit_collision', satellite: 'ENIGMA-1',
    collisionPoint: { x: g.cp[0], y: g.cp[1], z: g.cp[2] }, closingKmS: g.closingKmS,
    victim: G.vic.name, victimNuDeg: Math.round(g.nuV), attackerKep: g.kep.slice(), victimKep: G.vic.kep.slice(),
    execTimeSec: S.execTimeSec, burnSec: plan.burnSec, propKg: plan.propKg,
    impactTargetSec: (Scn.simOpts && Scn.simOpts.impactTargetSec) || 18 };
}
function postJSON(url, body) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function (r) { return r.json(); }).catch(function (e) { return { ok: false, error: String(e) }; });
}
var observePoll = null, countdownTimer = null;
function clearObserveTimers() { if (observePoll) { clearInterval(observePoll); observePoll = null; } if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; } }
function uplinkAnimHTML() {
  return '<div class="uplinkanim">' +
    '<div class="ua-row"><span class="ua-gs">📡</span>' +
      '<span class="ua-beam"><i></i><i></i><i></i><i></i></span>' +
      '<span class="ua-sat">🛰</span></div>' +
    '<div class="ua-label">UPLINKING BURN COMMAND → ENIGMA-1…</div>' +
    '<div class="ua-sub">C2 command in flight. ENIGMA-1 will execute the burn at the scheduled time.</div>' +
  '</div>';
}
async function doUplink() {
  var btn = $('#uplinkBtn'); if (btn.disabled) return; btn.disabled = true; btn.textContent = '… TRANSMITTING';
  var res = $('#observeResult'); res.classList.remove('hidden'); res.className = 'observeresult uplinking'; res.innerHTML = uplinkAnimHTML();
  var r = await postJSON('/api/uplink-collision', maneuverMsg());
  if (r && r.ok) { setTimeout(renderObserve, 1700); }   // let the uplink animation play, then start the impact countdown
  else { res.className = 'observeresult miss'; res.textContent = 'Uplink failed: ' + ((r && r.error) || '?') + ' (is the ground station on?)'; }
  btn.disabled = false; btn.textContent = '⚡ TRANSMIT BURN COMMAND → ENIGMA-1';
}
function renderObserve() {
  var box = $('#observeResult'); if (!box) return; clearObserveTimers();
  var eta = (Scn.simOpts && Scn.simOpts.impactTargetSec) || 18, t0 = Date.now(), failAt = t0 + (eta + 16) * 1000, vic = G.vic.name;
  var paint = function () {
    var left = Math.max(0, eta - (Date.now() - t0) / 1000);
    box.className = 'observeresult counting' + (left <= 0.05 ? ' impact' : '');
    box.innerHTML = left > 0.05
      ? '<div class="cdtag">⚠ COLLISION COURSE → <b>' + vic + '</b></div><div class="cdclock">IMPACT IN <b>' + left.toFixed(1) + '</b><span>s</span></div><div class="cdrail"><i style="width:' + (100 - left / eta * 100) + '%"></i></div><div class="cdsub">ENIGMA-1 is executing the burn — watch monitor 2.</div>'
      : '<div class="cdtag danger">⚠ IMPACT</div><div class="cdclock danger">IMPACT</div><div class="cdrail"><i style="width:100%"></i></div><div class="cdsub">Confirming the debris cascade on monitor 2…</div>';
  };
  paint();
  var retry = $('#retryBtn'); if (retry) retry.classList.add('hidden');
  countdownTimer = setInterval(paint, 100);
  observePoll = setInterval(async function () {
    var st = null; try { st = await (await fetch('/api/observe-status')).json(); } catch (e) {}
    if (st && st.videoPlayed) { clearObserveTimers(); showSuccess(); }
    else if (Date.now() > failAt) { clearObserveTimers(); showTimeout(); }
  }, 700);
}
function showSuccess() {
  var box = $('#observeResult'), vic = G.vic.name, cs = (S.geom && S.geom.closingKmS) || '';
  box.className = 'observeresult hit celebrate';
  box.innerHTML = '<div class="celebico">🎉</div><div class="celebtitle">ATTACK SUCCESSFUL</div><div class="celebsub">ENIGMA-1 struck <b>' + vic + '</b> at ' + cs + ' km/s. Debris is cascading onto the AURORA constellation — watch it on monitor 2.</div>';
  var retry = $('#retryBtn'); if (retry) { retry.classList.remove('hidden'); retry.textContent = '↺ RESET FOR NEXT ATTEMPT'; }
  var note = $('#observeNote'); if (note) note.textContent = 'Reset to run the demonstration again.';
}
function showTimeout() {
  var box = $('#observeResult');
  box.className = 'observeresult miss';
  box.innerHTML = '<div class="obico">✕</div><div class="obtitle">COLLISION NOT CONFIRMED</div><div class="obsub">Monitor 2 did not report a debris cascade in time. Make sure the ground station dashboard is open, then reset and transmit again.</div>';
  var retry = $('#retryBtn'); if (retry) { retry.classList.remove('hidden'); retry.textContent = '↺ RESET & RE-PLAN'; }
}
async function doRetry() {
  var b = $('#retryBtn'); if (b) { b.disabled = true; b.textContent = '… RESETTING'; }
  clearObserveTimers();
  await postJSON('/api/reset-target', {});
  var res = $('#observeResult'); if (res) res.classList.add('hidden');
  if (b) { b.disabled = false; b.classList.add('hidden'); }
  S.execPassM = null; S.execTimeSec = null;   // force re-picking a pass
  showPhase(2);
}

// ── boot ─────────────────────────────────────────────────────────────────────
function boot() {
  renderTleRaw(); wireNav();
  var ub = $('#uplinkBtn'); if (ub) ub.onclick = doUplink;
  var rb = $('#retryBtn'); if (rb) rb.onclick = doRetry;
}
boot();
