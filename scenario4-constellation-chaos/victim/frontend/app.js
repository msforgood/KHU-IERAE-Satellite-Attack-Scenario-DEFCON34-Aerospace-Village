// app.js — AURORA ground station dashboard (scenario 5, monitor 2).
// Receives a "collision" event over WebSocket: shows ENIGMA-1's maneuvered orbit,
// counts down to impact, then plays the collision (explosion + debris cascade),
// raises the CDM alert, plays the debris video, and reports it to the console.
'use strict';
var $ = function (s) { return document.querySelector(s); };
var sim = null, collided = false, collisionReported = false, evtTimers = [];
var Scn = window.Scenario5, K = window.SatKepler;

setInterval(function () { var c = $('#clock'); if (c) c.textContent = new Date().toTimeString().slice(0, 8); }, 1000);

function initSim() {
  var cv = $('#playSim'); if (!cv || typeof SatSim === 'undefined' || !Scn) return;
  sim = new SatSim(cv, Object.assign({ mode: 'playback' }, Scn.simOpts));
  sim.setSatellites(Scn.satellites());
  sim.lockOn('demosat');
  sim._resize();
  setTimeout(function () { if (sim) sim.lockId = null; }, 150);   // frame once, keep a steady view
  startNominal();
}
// nominal orbiting: keep every satellite moving along its orbit so monitor 2 looks live
// before any collision. ENIGMA-1 follows its maneuvered orbit once a burn is commanded.
// slow, UNIFORM baseline motion for every satellite (was 50/70ms, which read as fast and
// made ENIGMA-1 + the target look oddly frozen once they were driven to the impact point).
var NOMINAL_STEP = 14, NOMINAL_TICK = 70;
var nominalTimer = null, nominalT = 0, atkKep = null, converging = false;
function orbitPos(kep, t) { var nu = K.trueAnomalyAdvance(kep[0], kep[1], kep[5], t); return K.keplerianToECI(kep[0], kep[1], kep[2], kep[3], kep[4], nu); }
function propagateAll() {
  if (!sim || !sim.engine) return;
  Scn.satellites().forEach(function (s) {
    if (converging && (s.role === 'attacker' || s.target)) return;   // these two are being driven to the impact point
    var kep = (s.role === 'attacker' && atkKep) ? atkKep : s.kep;
    sim.engine.setSatPosition(s.id, orbitPos(kep, nominalT));
  });
}
function startNominal() {
  if (!sim) return;
  if (!sim.running) sim.start();
  if (nominalTimer) return;
  nominalTimer = setInterval(function () { nominalT += NOMINAL_STEP; propagateAll(); }, NOMINAL_TICK);
}
function stopNominal() { if (nominalTimer) { clearInterval(nominalTimer); nominalTimer = null; } }
function clearEvtTimers() { evtTimers.forEach(function (t) { clearTimeout(t); }); evtTimers = []; }
function set(sel, v) { var e = $(sel); if (e) e.textContent = v; }
function setVal(sel, text, cls) { var e = $(sel); if (!e) return; e.textContent = text; if (cls) e.className = 'val ' + cls; }
function setTag(sel, cls, text) { var e = $(sel); if (!e) return; e.className = 'tag ' + cls; e.textContent = text; }
function setBanner(kind, text) { var b = $('#statusBanner'); if (b) b.className = 'banner ' + kind; var t = $('#bannerText'); if (t) t.textContent = text; }
function addLog(cmd, detail) {
  var log = $('#log'); if (!log) return; var empty = log.querySelector('.logempty'); if (empty) empty.remove();
  var it = document.createElement('div'); it.className = 'logitem';
  it.innerHTML = '<div class="lt">' + new Date().toTimeString().slice(0, 8) + '</div><div class="lc">' + cmd + '</div><div class="ld">' + detail + '</div>';
  log.insertBefore(it, log.firstChild);
}

// ── incoming collision ───────────────────────────────────────────────────────
function onCollision(m) {
  collided = false; collisionReported = false; aftermathShown = false;
  clearEvtTimers();
  document.body.classList.remove('collision'); hideVideo(); hideAlarm();
  var vic = m.victim || 'AURORA-2', eta = m.impactTargetSec || 18;   // orbit morphs gradually below, not instantly
  setBanner('warn', 'BURN COMMAND EXECUTED — ENIGMA-1 on a collision course with ' + vic + '. Impact in ' + eta + ' s.');
  setTag('#orbitTag', 'warn', 'MANEUVERING');
  setTag('#threatTag', 'danger blink', 'COLLISION IMMINENT');
  if (m.attackerKep) {
    setVal('#mAlt', Math.round((m.attackerKep[0] - K.EarthRadius) / 1000) + ' km', 'danger');
    setVal('#mInc', m.attackerKep[2].toFixed(1) + '°', 'nominal');
    setVal('#mRaan', m.attackerKep[3].toFixed(1) + '°', 'nominal');
  }
  set('#cClosest', '0 km · IMPACT');
  cdm(vic, m, eta);
  // drive ENIGMA-1 and AURORA-2 together to the impact point over the countdown, moving
  // ALONG their orbits (interpolating true anomaly), so they stay on the orbit lines and
  // never cut a straight chord through the Earth. Neighbours keep orbiting via nominal.
  converging = true;
  var vid = findVictimId(), CCv = window.CollisionCore;
  var baseKep = (Scn.satellites().filter(function (x) { return x.role === 'attacker'; })[0] || {}).kep;
  var targetKep = m.attackerKep || baseKep;
  var vKep = m.victimKep || (Scn.satellites().filter(function (x) { return x.target; })[0] || {}).kep;
  var P = m.collisionPoint ? [m.collisionPoint.x, m.collisionPoint.y, m.collisionPoint.z] : null;
  var aStartNu = K.trueAnomalyAdvance(baseKep[0], baseKep[1], baseKep[5], nominalT);
  var vStartNu = K.trueAnomalyAdvance(vKep[0], vKep[1], vKep[5], nominalT);
  var aEndNu = (P && CCv) ? CCv.nuAtPoint(targetKep, P) : aStartNu;
  var vEndNu = (P && CCv) ? CCv.nuAtPoint(vKep, P) : vStartNu;
  var shortArc = function (from, to) { var d = ((to - from) % 360 + 360) % 360; return d > 180 ? d - 360 : d; };
  var aArc = shortArc(aStartNu, aEndNu), vArc = shortArc(vStartNu, vEndNu);
  // how far a satellite sweeps at the NOMINAL (slow) rate over the countdown, and how many
  // whole extra revolutions bring an arc up to that pace (full revs keep the endpoint on P).
  var nomSweep = function (kep) { return NOMINAL_STEP * (eta * 1000 / NOMINAL_TICK) / K.period(kep[0]) * 360; };
  var revsToward = function (arc, sweep) { return Math.max(0, Math.round((sweep - arc) / 360)); };
  // AURORA-2 keeps roughly its normal (now slow) pace on the way to the crossing, so it no
  // longer looks singled-out and frozen. ENIGMA-1 gets an EXTRA revolution plus an ease-in,
  // so right after the burn it visibly SPEEDS UP and races around to the impact point.
  var ENIGMA_EXTRA_REVS = 1;
  var vTotal = vArc + 360 * revsToward(vArc, nomSweep(vKep));
  var aTotal = aArc + 360 * (revsToward(aArc, nomSweep(baseKep)) + ENIGMA_EXTRA_REVS);
  var easeIn = function (f) { return f * (0.35 + 0.65 * f); };   // starts near baseline, then accelerates
  // the burn takes time: interpolate ENIGMA-1's orbit from its current (base) orbit to the
  // maneuvered orbit over the countdown, so the ring visibly grows and tilts as it fires.
  var lerpKep = function (f) { var k = []; for (var i = 0; i < 6; i++) k[i] = baseKep[i] + (targetKep[i] - baseKep[i]) * f; return k; };
  // exhaust direction = OPPOSITE the commanded delta-v (velocity on the maneuvered orbit minus
  // velocity on the base orbit, at the same point). Falls back to retrograde if the burn is tiny.
  var exhaustDir = function (nu) {
    if (!CCv || !CCv.stateFromElements) return null;
    var sB = CCv.stateFromElements(baseKep[0], baseKep[1], baseKep[2], baseKep[3], baseKep[4], nu);
    var sT = CCv.stateFromElements(targetKep[0], targetKep[1], targetKep[2], targetKep[3], targetKep[4], nu);
    // stateFromElements returns r/v as ARRAYS [x,y,z]
    var dx = sT.v[0] - sB.v[0], dy = sT.v[1] - sB.v[1], dz = sT.v[2] - sB.v[2], L = Math.hypot(dx, dy, dz);
    if (L < 1) { var v = sT.v, lv = Math.hypot(v[0], v[1], v[2]) || 1; return { x: -v[0] / lv, y: -v[1] / lv, z: -v[2] / lv }; }
    return { x: -dx / L, y: -dy / L, z: -dz / L };
  };
  var t0 = Date.now();
  var tick = function () {
    var el = (Date.now() - t0) / 1000, frac = Math.min(1, el / eta), left = Math.max(0, eta - el), sb = $('#simbar');
    if (sb) { sb.textContent = left > 0.1 ? ('⚠ BURN IN PROGRESS - orbit changing · impact in ' + left.toFixed(1) + ' s') : '⚠ IMPACT'; sb.className = 'simbar danger'; }
    if (sim && sim.engine) {
      var kepF = lerpKep(frac);
      var aPos = K.keplerianToECI(kepF[0], kepF[1], kepF[2], kepF[3], kepF[4], aStartNu + aTotal * easeIn(frac));
      sim.engine.setOrbitLine('demosat', kepF);
      sim.engine.setSatPosition('demosat', aPos);
      sim.engine.setSatPosition(vid, K.keplerianToECI(vKep[0], vKep[1], vKep[2], vKep[3], vKep[4], vStartNu + vTotal * frac));
      if (sim.engine.lockCamera) sim.engine.lockCamera(aPos);   // monitor 2 locks on and follows ENIGMA-1 to impact
      if (sim.engine.setPlume) {   // gas plume firing per the commanded burn direction
        var nuE = aStartNu + aTotal * easeIn(frac);
        var ramp = Math.min(1, el / 0.6);                                 // quick ignition
        var cut = frac > 0.85 ? Math.max(0, (0.98 - frac) / 0.13) : 1;    // engine cut-off just before impact
        var flick = 0.72 + 0.28 * Math.sin(el * 26);                      // flame flicker
        sim.engine.setPlume(aPos, exhaustDir(nuE), ramp * cut * flick);
      }
    }
    if (left > 0.1) evtTimers.push(setTimeout(tick, 60));
  };
  tick();
  evtTimers.push(setTimeout(function () { detonate(m); }, eta * 1000));
}
function findVictimId() { var s = Scn.satellites().filter(function (x) { return x.target; })[0]; return s ? s.id : 'aurora-2'; }
function detonate(m) {
  collided = true; var vic = m.victim || 'AURORA-2';
  setBanner('danger', 'COLLISION - ENIGMA-1 struck ' + vic + ' at ' + (m.closingKmS || '?') + ' km/s. Debris cascade in progress.');
  setTag('#orbitTag', 'danger', 'DESTROYED'); setTag('#threatTag', 'danger blink', 'DEBRIS CASCADE');
  var sb = $('#simbar'); if (sb) { sb.textContent = '⚠ IMPACT - debris cascade'; sb.className = 'simbar danger'; }
  converging = false; stopNominal();   // freeze orbits so the explosion + debris are not overwritten
  if (sim && sim.engine && sim.engine.setPlume) sim.engine.setPlume(null);   // engine off at impact
  var pt = m.collisionPoint ? [m.collisionPoint.x, m.collisionPoint.y, m.collisionPoint.z] : null;
  if (sim && pt) sim.detonate(pt, findVictimId());
  cascade();
  playVideo(vic);
}
function cascade() {
  var sats = Scn.satellites().filter(function (s) { return s.role === 'neighbor' && !s.target; });
  var total = 1 + sats.length, alive = sats.length;   // victim gone immediately
  updateConstellation(alive, total);
  sats.forEach(function (s, i) {
    evtTimers.push(setTimeout(function () {
      if (sim) sim.engine.setSatVisible(s.id, false);
      alive--; updateConstellation(alive, total);
    }, 1500 + i * 1100));
  });
}
function updateConstellation(alive, total) {
  setVal('#cAlive', Math.max(0, alive) + ' / ' + total, alive < total ? 'danger' : 'nominal');
  var bar = $('#cBar'); if (bar) { bar.style.width = Math.max(0, alive) / total * 100 + '%'; bar.parentElement.className = 'bar' + (alive < total ? ' danger' : ''); }
}

// ── CDM (Conjunction Data Message) ───────────────────────────────────────────
function cdm(vic, m, tcaSec) {
  var st = $('#cdmStatus'); if (st) { st.textContent = 'RED - COLLISION'; st.className = 'cdmstatus red'; }
  set('#cdmSec', 'ENIGMA-1'); set('#cdmMiss', '0.0 km (impact)'); set('#cdmTca', tcaSec + ' s');
  set('#cdmRel', (m.closingKmS || '?') + ' km/s'); set('#cdmPc', '1.0 (certain)');
  var n = $('#cdmNote'); if (n) n.innerHTML = 'Conjunction screened against AURORA-2: <b>Pc far above the 1e-4 threshold</b>. Impact unavoidable; debris will threaten the constellation.';
}

// ── video + alarm ────────────────────────────────────────────────────────────
var aftermathShown = false, videoTimer = null;
function playVideo(vic) {
  var ov = $('#videoOverlay'), v = $('#collisionVideo');
  reportCollision();
  var done = function () { afterVideo(vic); };
  if (!ov || !v) { done(); return; }
  ov.classList.remove('hidden'); v.onended = done;
  try { v.currentTime = 0; var p = v.play(); if (p && p.catch) p.catch(done); } catch (e) { done(); }
  clearTimeout(videoTimer); videoTimer = setTimeout(function () { if (v.paused || v.ended) done(); }, 12000);
}
function afterVideo(vic) {
  if (aftermathShown) return; aftermathShown = true; clearTimeout(videoTimer);
  var ov = $('#videoOverlay'); if (ov) ov.classList.add('hidden');
  document.body.classList.add('collision'); showAlarm(vic);
}
function hideVideo() { var ov = $('#videoOverlay'), v = $('#collisionVideo'); if (ov) ov.classList.add('hidden'); if (v) { try { v.pause(); } catch (e) {} } clearTimeout(videoTimer); }
function showAlarm(vic) { var a = $('#alarm'); if (!a) return; var d = $('#alarmDesc'); if (d) d.textContent = 'Unauthorized burn command - ENIGMA-1 struck ' + vic + '. Debris cascade in progress across AURORA.'; a.classList.remove('hidden'); }
function hideAlarm() { var a = $('#alarm'); if (a) a.classList.add('hidden'); }
function reportCollision() { if (collisionReported) return; collisionReported = true; try { fetch('/api/collision-reported', { method: 'POST' }).catch(function () {}); } catch (e) {} }

// ── reset ─────────────────────────────────────────────────────────────────────
function doReset() {
  collided = false; collisionReported = false; aftermathShown = false; clearEvtTimers();
  document.body.classList.remove('collision'); hideVideo(); hideAlarm();
  if (sim) { sim.setSatellites(Scn.satellites()); sim.lockOn('demosat'); setTimeout(function () { if (sim) sim.lockId = null; }, 150); if (sim.engine && sim.engine.setPlume) sim.engine.setPlume(null); }
  atkKep = null; converging = false; nominalT = 0; startNominal();
  setBanner('nominal', 'NOMINAL - all satellites separated and station-keeping');
  setTag('#orbitTag', 'nominal', 'STATION-KEEPING'); setTag('#threatTag', 'nominal', 'NONE');
  var st = (Scn && Scn.attackerStart) || { altKm: 600, inc: 97.8, raan: 25 };
  setVal('#mAlt', st.altKm + ' km', 'nominal'); setVal('#mInc', st.inc + '°', 'nominal'); setVal('#mRaan', st.raan + '°', 'nominal');
  var cnt = (Scn && Scn.target && Scn.target.constellationCount) || 3;
  setVal('#cMembers', String(cnt)); updateConstellation(cnt, cnt); set('#cClosest', '—');
  var cst = $('#cdmStatus'); if (cst) { cst.textContent = 'CLEAR'; cst.className = 'cdmstatus clear'; }
  ['#cdmSec', '#cdmMiss', '#cdmTca', '#cdmRel', '#cdmPc'].forEach(function (s) { set(s, '—'); });
  var cn = $('#cdmNote'); if (cn) cn.textContent = 'No conjunctions screened. All AURORA members separated.';
  var sb = $('#simbar'); if (sb) { sb.textContent = 'Awaiting uplink…'; sb.className = 'simbar'; }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connect() {
  var ws = new WebSocket('ws://' + location.host + '/');
  ws.onopen = function () { var d = $('#connDot'), t = $('#connText'); if (d) d.className = 'dot'; if (t) t.textContent = 'LINKED'; };
  ws.onclose = function () { var d = $('#connDot'), t = $('#connText'); if (d) d.className = 'dot off'; if (t) t.textContent = 'RECONNECTING…'; setTimeout(connect, 1000); };
  ws.onmessage = function (e) {
    var msg; try { msg = JSON.parse(e.data); } catch (x) { return; }
    if (msg.type === 'hello') { if (msg.scenario) { var c = msg.scenario.count; setVal('#cMembers', String(c)); updateConstellation(c, c); } }
    else if (msg.type === 'collision') { addLog('START BURN', 'collision course · ' + (msg.closingKmS || '?') + ' km/s'); onCollision(msg); }
    else if (msg.type === 'reset') { doReset(); }
    else if (msg.type === 'uplink') { addLog(msg.command || 'command', 'received'); }
  };
}

initSim();
connect();
doReset();
