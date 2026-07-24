// app.js — AURORA ground station dashboard (scenario 5, monitor 2).
// Receives a "collision" event over WebSocket: shows ENIGMA-1's maneuvered orbit,
// counts down to impact, then plays the collision (explosion + debris cascade),
// raises the CDM alert, plays the debris video, and reports it to the console.
'use strict';
var $ = function (s) { return document.querySelector(s); };
var sim = null, collided = false, collisionReported = false, evtTimers = [];
var Scn = window.Scenario5, K = window.SatKepler, CCv = window.CollisionCore;
var livePos = {};   // last ECI position of every satellite, for the live telemetry (nearest object)

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
var nominalTimer = null, nominalT = 0, atkKep = null, tgtKep = null, converging = false;
function orbitPos(kep, t) { var nu = K.trueAnomalyAdvance(kep[0], kep[1], kep[5], t); return K.keplerianToECI(kep[0], kep[1], kep[2], kep[3], kep[4], nu); }
function propagateAll() {
  if (!sim || !sim.engine) return;
  var atk = null, atkNu = null;
  Scn.satellites().forEach(function (s) {
    if (converging && (s.role === 'attacker' || s.target)) return;   // these two are being driven to the impact point
    var kep = (s.role === 'attacker' && atkKep) ? atkKep : (s.target && tgtKep) ? tgtKep : s.kep;
    var nu = K.trueAnomalyAdvance(kep[0], kep[1], kep[5], nominalT);
    var pos = K.keplerianToECI(kep[0], kep[1], kep[2], kep[3], kep[4], nu);
    sim.engine.setSatPosition(s.id, pos);
    livePos[s.id] = pos;
    if (s.role === 'attacker') { atk = kep; atkNu = nu; }
  });
  updateTelemetry(atk, atkNu);   // when converging the event tick drives ENIGMA-1 speed instead
}
// live telemetry: ENIGMA-1 speed (vis-viva from its current orbit + true anomaly) and the
// distance to the nearest other satellite (min over the last known positions of everything).
function enigmaSpeedKmS(kep, nu) {
  if (!CCv || !CCv.stateFromElements || !kep) return null;
  var s = CCv.stateFromElements(kep[0], kep[1], kep[2], kep[3], kep[4], nu);
  return Math.hypot(s.v[0], s.v[1], s.v[2]) / 1000;
}
function updateTelemetry(kep, nu) {
  if (kep != null && nu != null) {
    var sp = enigmaSpeedKmS(kep, nu);
    if (sp != null) setVal('#mSpeed', sp.toFixed(3) + ' km/s', converging ? 'warn' : 'nominal');
  }
  var ep = livePos['demosat']; if (!ep) return;
  var best = Infinity;
  Object.keys(livePos).forEach(function (id) {
    if (id === 'demosat') return;
    var p = livePos[id]; if (!p) return;
    var d = Math.hypot(ep.x - p.x, ep.y - p.y, ep.z - p.z);
    if (d < best) best = d;
  });
  if (best < Infinity) {
    var km = Math.round(best / 1000);
    setVal('#mNear', km + ' km', km < 30 ? 'danger' : (km < 300 ? 'warn' : 'nominal'));
  }
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
  var hit = m.collided !== false;                                    // collide-vs-miss verdict from the console difficulty
  var vic = m.victim || 'AURORA-2', eta = m.impactTargetSec || 18;   // orbit morphs gradually below, not instantly
  var missKm = Math.round((m.missM || 0) / 1000);
  if (hit) {
    setBanner('warn', 'BURN COMMAND EXECUTED - ENIGMA-1 on a collision course with ' + vic + '. Impact in ' + eta + ' s.');
    setTag('#orbitTag', 'warn', 'MANEUVERING'); setTag('#threatTag', 'danger blink', 'COLLISION IMMINENT');
    set('#cClosest', '0 km (impact)'); cdm(vic, m, eta);
  } else {
    setBanner('warn', 'BURN COMMAND EXECUTED - ENIGMA-1 maneuvering near ' + vic + '. Screening conjunction, predicted miss about ' + missKm + ' km.');
    setTag('#orbitTag', 'warn', 'MANEUVERING'); setTag('#threatTag', 'warn', 'CONJUNCTION');
    set('#cClosest', 'screening'); cdmNearMiss(vic, m, eta, missKm);
  }
  // ENIGMA-1's orbit readout (altitude, inclination, RAAN) is NOT snapped to the final maneuvered
  // values here. The burn tick below climbs it gradually with the lerping orbit, so the altitude
  // rises smoothly toward its final value instead of jumping in one step.
  // drive ENIGMA-1 and AURORA-2 together to the impact point over the countdown, moving
  // ALONG their orbits (interpolating true anomaly), so they stay on the orbit lines and
  // never cut a straight chord through the Earth. Neighbours keep orbiting via nominal.
  converging = true;
  var vid = findVictimId();
  var baseKep = (Scn.satellites().filter(function (x) { return x.role === 'attacker'; })[0] || {}).kep;
  var targetKep = m.attackerKep || baseKep;
  atkKep = targetKep;   // keep ENIGMA-1 on its maneuvered orbit once nominal orbiting resumes
  var vKep = m.victimKep || (Scn.satellites().filter(function (x) { return x.target; })[0] || {}).kep;
  var P = m.collisionPoint ? [m.collisionPoint.x, m.collisionPoint.y, m.collisionPoint.z] : null;
  var aStartNu = K.trueAnomalyAdvance(baseKep[0], baseKep[1], baseKep[5], nominalT);
  var vStartNu = K.trueAnomalyAdvance(vKep[0], vKep[1], vKep[5], nominalT);
  var aEndNu = (P && CCv) ? CCv.nuAtPoint(targetKep, P) : aStartNu;
  // near-miss: nudge AURORA-2 off the crossing so it is NOT there when ENIGMA-1 arrives. A geometry
  // miss already leaves a gap (their closest points differ); a timing miss needs this offset.
  var vTimeOff = (!hit && m.timingOffSec && vKep) ? (m.timingOffSec / K.period(vKep[0]) * 360) : 0;
  var vEndNu = (P && CCv) ? (CCv.nuAtPoint(vKep, P) + vTimeOff) : vStartNu;
  var shortArc = function (from, to) { var d = ((to - from) % 360 + 360) % 360; return d > 180 ? d - 360 : d; };
  var aArc = shortArc(aStartNu, aEndNu), vArc = shortArc(vStartNu, vEndNu);
  // how far a satellite sweeps at the NOMINAL (slow) rate over the countdown, and how many
  // whole extra revolutions bring an arc up to that pace (full revs keep the endpoint on P).
  var nomSweep = function (kep) { return NOMINAL_STEP * (eta * 1000 / NOMINAL_TICK) / K.period(kep[0]) * 360; };
  var revsToward = function (arc, sweep) { return Math.max(0, Math.round((sweep - arc) / 360)); };
  // how hard was the commanded burn? |Δv| = velocity on the maneuvered orbit minus velocity on
  // the base orbit at the burn point (m/s) — exactly the Δv the attacker dialed in on monitor 1.
  var dvMag = (function () {
    if (!CCv || !CCv.stateFromElements) return 0;
    var sB = CCv.stateFromElements(baseKep[0], baseKep[1], baseKep[2], baseKep[3], baseKep[4], aStartNu);
    var sT = CCv.stateFromElements(targetKep[0], targetKep[1], targetKep[2], targetKep[3], targetKep[4], aStartNu);
    return Math.hypot(sT.v[0] - sB.v[0], sT.v[1] - sB.v[1], sT.v[2] - sB.v[2]);
  })();
  // AURORA-2 keeps roughly its normal (now slow) pace on the way to the crossing, so it no
  // longer looks singled-out and frozen. ENIGMA-1 speeds up AFTER the burn, and HOW MUCH scales
  // with the commanded Δv: a light nudge adds ~1 extra lap, a hard burn adds up to 4 (whole laps
  // keep the endpoint exactly on P), and the ease-in also sharpens with the burn.
  var ENIGMA_EXTRA_REVS = Math.max(1, Math.min(4, Math.round(Math.sqrt(dvMag) / 9)));
  var accel = Math.max(0, Math.min(1, dvMag / 900));   // 0..1 burn-scaled acceleration sharpness
  var vTotal = vArc + 360 * revsToward(vArc, nomSweep(vKep));
  var aTotal = aArc + 360 * (revsToward(aArc, nomSweep(baseKep)) + ENIGMA_EXTRA_REVS);
  var easeIn = function (f) { var a0 = 0.35 - 0.22 * accel; return f * (a0 + (1 - a0) * f); };   // starts near baseline, then accelerates (harder for a bigger burn)
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
    if (sb) {
      if (left > 0.1) { sb.textContent = '⚠ BURN IN PROGRESS - orbit changing, ' + (hit ? 'impact' : 'closest approach') + ' in ' + left.toFixed(1) + ' s'; }
      else { sb.textContent = hit ? '⚠ IMPACT' : 'CLOSEST APPROACH'; }
      sb.className = 'simbar ' + (hit ? 'danger' : 'warn');
    }
    var kepF = lerpKep(frac);
    // orbit readout follows the lerping orbit: the altitude climbs gradually toward its final value
    setVal('#mAlt', Math.round((kepF[0] - K.EarthRadius) / 1000) + ' km', hit ? 'danger' : 'warn');
    setVal('#mInc', kepF[2].toFixed(1) + '°', 'nominal');
    setVal('#mRaan', kepF[3].toFixed(1) + '°', 'nominal');
    if (sim && sim.engine) {
      var nuE = aStartNu + aTotal * easeIn(frac);
      var aPos = K.keplerianToECI(kepF[0], kepF[1], kepF[2], kepF[3], kepF[4], nuE);
      var vPos = K.keplerianToECI(vKep[0], vKep[1], vKep[2], vKep[3], vKep[4], vStartNu + vTotal * frac);
      sim.engine.setOrbitLine('demosat', kepF);
      sim.engine.setSatPosition('demosat', aPos);
      sim.engine.setSatPosition(vid, vPos);
      livePos['demosat'] = aPos; livePos[vid] = vPos; updateTelemetry(kepF, nuE);   // live speed + nearest object
      if (sim.engine.lockCamera) sim.engine.lockCamera(aPos, true);   // monitor 2 eases onto ENIGMA-1 and follows it to impact
      if (sim.engine.setPlume) {   // gas plume firing per the commanded burn direction
        var ramp = Math.min(1, el / 0.6);                                 // quick ignition
        var cut = frac > 0.85 ? Math.max(0, (0.98 - frac) / 0.13) : 1;    // engine cut-off just before impact
        var flick = 0.72 + 0.28 * Math.sin(el * 26);                      // flame flicker
        sim.engine.setPlume(aPos, exhaustDir(nuE), ramp * cut * flick);
      }
    }
    if (left > 0.1) evtTimers.push(setTimeout(tick, 60));
  };
  tick();
  evtTimers.push(setTimeout(function () { hit ? detonate(m) : nearMissEnd(m); }, eta * 1000));
}
// near-miss resolution: ENIGMA-1 passed AURORA-2 without colliding. No explosion, no debris; the
// two keep orbiting (ENIGMA-1 on its maneuvered ring), and the console offers a retry.
function nearMissEnd(m) {
  // keep ENIGMA-1 and AURORA-2 MOVING after the pass instead of freezing. Re-seed each orbit's phase
  // so nominal propagation continues from the closest-approach point (no teleport), then hand them
  // back to the nominal loop so both keep orbiting and visibly drift apart.
  var CCv = window.CollisionCore, P = m.collisionPoint ? [m.collisionPoint.x, m.collisionPoint.y, m.collisionPoint.z] : null;
  if (P && CCv && atkKep) {
    var an = CCv.nuAtPoint(atkKep, P);
    atkKep[5] = K.trueAnomalyAdvance(atkKep[0], atkKep[1], an, -nominalT);   // orbitPos(atkKep, nominalT) now == the closest-approach point
  }
  if (P && CCv && m.victimKep) {
    var vk = m.victimKep, off = m.timingOffSec ? (m.timingOffSec / K.period(vk[0]) * 360) : 0;
    var vn = CCv.nuAtPoint(vk, P) + off; tgtKep = vk.slice();
    tgtKep[5] = K.trueAnomalyAdvance(vk[0], vk[1], vn, -nominalT);
  }
  converging = false;   // nominal drives ENIGMA-1 + AURORA-2 again, continuing from where they are
  var vic = m.victim || 'AURORA-2', missKm = Math.round((m.missM || 0) / 1000);
  setBanner('warn', 'NEAR MISS - ENIGMA-1 passed ' + vic + ' with a closest approach of about ' + missKm + ' km. No collision.');
  setTag('#orbitTag', 'nominal', 'STATION-KEEPING'); setTag('#threatTag', 'warn', 'NEAR MISS');
  if (m.attackerKep) setVal('#mAlt', Math.round((m.attackerKep[0] - K.EarthRadius) / 1000) + ' km', 'warn');   // settle on the exact final altitude
  var sb = $('#simbar'); if (sb) { sb.textContent = 'NEAR MISS - closest approach about ' + missKm + ' km'; sb.className = 'simbar warn'; }
  set('#cClosest', missKm + ' km (near miss)');
  var st = $('#cdmStatus'); if (st) { st.textContent = 'YELLOW - SCREENED'; st.className = 'cdmstatus'; }
  set('#cdmMiss', missKm + ' km'); set('#cdmPc', 'below threshold');
  var n = $('#cdmNote'); if (n) n.innerHTML = 'Conjunction with AURORA-2 screened: <b>closest approach outside the collision threshold</b>. No impact; the operator can retry with a tighter burn.';
  if (sim && sim.engine && sim.engine.setPlume) sim.engine.setPlume(null);   // engine off after the pass
  startNominal();   // make sure the nominal loop is running so the re-seeded orbits keep moving
  if (sim && sim.engine && sim.engine.frameSmooth) sim.engine.frameSmooth(1300);   // glide the camera back to the overview instead of cutting to the reset viewpoint
}
// CDM shown while a near-miss conjunction is being screened (before the pass resolves)
function cdmNearMiss(vic, m, tcaSec, missKm) {
  var st = $('#cdmStatus'); if (st) { st.textContent = 'YELLOW - SCREENING'; st.className = 'cdmstatus'; }
  set('#cdmSec', 'ENIGMA-1'); set('#cdmMiss', '~' + missKm + ' km (predicted)'); set('#cdmTca', tcaSec + ' s');
  set('#cdmRel', (m.closingKmS || '?') + ' km/s'); set('#cdmPc', 'below threshold');
  var n = $('#cdmNote'); if (n) n.innerHTML = 'Conjunction screened against AURORA-2: predicted miss <b>outside the collision threshold</b> for this difficulty. Impact not expected.';
}
function findVictimId() { var s = Scn.satellites().filter(function (x) { return x.target; })[0]; return s ? s.id : 'aurora-2'; }
function detonate(m) {
  collided = true; var vic = m.victim || 'AURORA-2';
  setBanner('danger', 'COLLISION - ENIGMA-1 struck ' + vic + ' at ' + (m.closingKmS || '?') + ' km/s. Debris cascade in progress.');
  setTag('#orbitTag', 'danger', 'DESTROYED'); setTag('#threatTag', 'danger blink', 'DEBRIS CASCADE');
  if (m.attackerKep) setVal('#mAlt', Math.round((m.attackerKep[0] - K.EarthRadius) / 1000) + ' km', 'danger');   // settle on the exact final altitude
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
  atkKep = null; tgtKep = null; converging = false; nominalT = 0; livePos = {}; startNominal();
  setBanner('nominal', 'NOMINAL - all satellites separated and station-keeping');
  setTag('#orbitTag', 'nominal', 'STATION-KEEPING'); setTag('#threatTag', 'nominal', 'NONE');
  var st = (Scn && Scn.attackerStart) || { altKm: 600, inc: 97.8, raan: 25 };
  setVal('#mAlt', st.altKm + ' km', 'nominal'); setVal('#mInc', st.inc + '°', 'nominal'); setVal('#mRaan', st.raan + '°', 'nominal');
  setVal('#mSpeed', '— km/s', 'nominal'); setVal('#mNear', '— km', 'nominal');
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
    else if (msg.type === 'collision') { addLog('START BURN', (msg.collided !== false ? 'collision course, ' : 'maneuver near miss, ') + (msg.closingKmS || '?') + ' km/s'); onCollision(msg); }
    else if (msg.type === 'reset') { doReset(); }
    else if (msg.type === 'uplink') { addLog(msg.command || 'command', 'received'); }
  };
}

initSim();
connect();
doReset();
