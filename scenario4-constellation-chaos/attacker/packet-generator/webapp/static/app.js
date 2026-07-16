// ENIGMA-1 Command Builder — scenario 4, four phases:
//   1 PLAN    orbit planner (satellite-sim): tune an up/down/left/right burn until the
//             predicted orbit reaches the AURORA constellation ring
//   2 BUILD   assemble the CCSDS orbit_maneuver packet (the value = the planned burn)
//   3 UPLINK  transmit the IQ file to the victim ground station (software uplink)
//   4 OBSERVE watch monitor 2; on a miss, reset and re-plan
// All CCSDS/OOK logic is in the Python backend (ccsds_ook.py); this drives the UI.
'use strict';

let M = null;                 // mission payload
let sim = null;               // orbit-planning simulation (satellite-sim seam, 3D)
let phase = 1;
let lastPlan = null;          // most recent planner status (for the phase-2 recap)
let hintOn = false;           // hint toggle: highlight the reachable (answer) orbit
const S = {
  scid: null,
  command: null, cmdDef: null,
  params: { altKm: 600, inc: 50, raan: 25 },   // resulting orbit (absolute — this is what the packet carries)
  thrust: { alt: 0, ud: 0 },                   // gas fired from the ALTITUDE / UP-DOWN thrusters (deltas)
  valueConfirmed: false,
  rf: { modulation: null, baud: null, sampleRate: null },
  generated: false,
  lastOutcome: null,
};

const $ = (s) => document.querySelector(s);
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round1 = (v) => Math.round(v * 10) / 10;

async function boot() {
  M = await (await fetch('/api/mission')).json();
  renderDossier();
  renderSteps();
  initSim();
  buildElementInputs();
  wirePhaseNav();
  updateSimManeuver();
  // preset thrusters from the query string (?alt=&ud=) - booth setup / demo shortcut
  const qp = new URLSearchParams(location.search);
  ['alt', 'ud'].forEach((k) => { if (qp.has(k)) { const t = THRUSTERS.find((x) => x.key === k); setThrust(k, +qp.get(k) || 0, t.min, t.max, false); } });
  // intro shows first; #toPlan reveals the phase stepper + phase 1.
  // deep-link: #p1/#plan or #p3/#uplink jumps straight to a phase (booth operator shortcut)
  const h = (location.hash || '').replace('#', '').toLowerCase();
  const jump = { p1: 1, plan: 1, p2: 2, build: 2, p3: 3, uplink: 3, p4: 4, observe: 4 }[h];
  if (jump) { $('#intro').classList.add('hidden'); $('#phasebar').classList.remove('hidden'); showPhase(jump); }
}

// ── phase navigation ─────────────────────────────────────────────────────────
function showPhase(n) {
  phase = n;
  if (n !== 4) clearObserveTimers();   // stop the phase-4 countdown/poll when leaving OBSERVE
  for (let i = 1; i <= 4; i++) $('#phase' + i).classList.toggle('hidden', i !== n);
  document.querySelectorAll('.phasebar .pstep').forEach((s) => {
    const p = +s.dataset.p;
    s.classList.toggle('active', p === n);
    s.classList.toggle('done', p < n);
  });
  window.scrollTo(0, 0);
  if (n === 1) { syncThrustFromParams(); if (sim) requestAnimationFrame(() => { sim._resize(); updateSimManeuver(); }); }
  if (n === 2) { renderPlanRecap(); renderBuildGuide(); renderBurnRecap(); renderSteps(); }
  if (n === 3) { renderUplinkSummary(); setupGpredict(); }
}
// (re)load the VSA + gpredict iframes when phase 3 opens; show a hint if the container is down
function setupGpredict() {
  const vf = $('#vsaFrame');
  // auto-configure the VSA: UPLINK mode + ENIGMA-1 + Helix + UHF 20W amp + 449.5 MHz,
  // and hide its left settings menu (handled inside the VSA via ?auto=uplink)
  if (vf) { try { vf.src = '/vsa/index.html?auto=uplink&sat=ENIGMA-1&ant=helix&amp=uhf-20w&freq=449.5&t=' + phase; } catch (e) {} }
  const fr = $('#gpredictFrame'), fb = $('#gpFallback');
  if (fr) { try { fr.src = 'http://localhost:6080/vnc.html?autoconnect=1&resize=remote'; } catch (e) {} }
  if (!fb) return;
  fb.classList.add('hidden');
  const ctrl = new AbortController();
  const to = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 2500);
  fetch('http://localhost:6080/', { mode: 'no-cors', signal: ctrl.signal })
    .then(() => { clearTimeout(to); fb.classList.add('hidden'); })
    .catch(() => { clearTimeout(to); fb.classList.remove('hidden'); });
}
function wirePhaseNav() {
  $('#toPlan').onclick = () => {
    $('#intro').classList.add('hidden');
    $('#phasebar').classList.remove('hidden');
    showPhase(1);
    if (sim) requestAnimationFrame(() => { sim._resize(); updateSimManeuver(); });
  };
  $('#toPhase2').onclick = () => { if (!$('#toPhase2').disabled) showPhase(2); };
  $('#backTo1').onclick = () => showPhase(1);
  $('#toPhase3').onclick = () => { if (!$('#toPhase3').disabled) showPhase(3); };
  $('#backTo2').onclick = () => showPhase(2);
  $('#uplinkBtn').onclick = doUplink;
  $('#retryBtn').onclick = doRetry;
  $('#genBtn').onclick = doGenerate;
  const hb = $('#hintBtn');
  if (hb) hb.onclick = () => {
    hintOn = !hintOn;
    if (sim) sim.highlightAnswer(hintOn);
    hb.classList.toggle('on', hintOn);
    hb.textContent = hintOn ? '💡 Hide hint' : '💡 Hint: show the target satellite orbit';
  };
  const rp = $('#resetPass'); if (rp) rp.onclick = doResetPass;
  const et = $('#engageTrack'); if (et) et.onclick = doEngageTracking;
}
// phase 3 · turn on gpredict tracking. This connects and enables BOTH links: the
// antenna rotator (Track+Engage -> az/el follows ENIGMA-1) and the radio (Track+
// Engage -> the uplink frequency is Doppler-corrected). The in-container helper
// clicks each Track/Engage toggle with a check-first, single-click discipline so a
// good state is never toggled back off.
async function doEngageTracking() {
  const btn = $('#engageTrack'), stat = $('#passStatus');
  const prev = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '… checking'; }
  if (stat) { stat.className = 'passstatus'; stat.textContent = 'Turning on gpredict antenna + Doppler tracking… (the gpredict window will move briefly)'; }
  try {
    const j = await (await fetch('http://localhost:6079/engage')).json();
    if (j && j.rotorTracking) {
      const dop = j.radioTracking ? ' · Doppler correction on (uplink frequency corrected in real time)' : ' · (Doppler will follow shortly)';
      if (stat) { stat.className = 'passstatus ok'; stat.textContent = 'Antenna tracking on · the VSA antenna is following ENIGMA-1' + dop; }
    } else if (j && j.rotorEngaged && j.satUp === false) {
      if (stat) { stat.className = 'passstatus err'; stat.textContent = 'Rotor connected · the satellite is still below the horizon. When gpredict shows EL>0, press the button again.'; }
    } else if (j && j.rotorEngaged) {
      if (stat) { stat.className = 'passstatus err'; stat.textContent = 'Rotor connected but tracking did not turn on · press the button again.'; }
    } else {
      if (stat) { stat.className = 'passstatus err'; stat.textContent = 'Rotor connection failed: ' + ((j && j.error) || '?') + ' · check the gpredict container.'; }
    }
  } catch (e) {
    if (stat) { stat.className = 'passstatus err'; stat.textContent = 'Cannot reach the gpredict control (:6079). Restart the container with run.sh.'; }
  }
  if (btn) { btn.disabled = false; btn.textContent = prev; }
}
// phase 3 · reset ENIGMA-1's position: re-arm the pass so gpredict jumps back to
// just before AOS (the in-container time-control server on :6079, /arm endpoint)
async function doResetPass() {
  const btn = $('#resetPass'), stat = $('#passStatus');
  if (!btn) return;
  const prev = btn.textContent; btn.disabled = true; btn.textContent = '… resetting';
  if (stat) { stat.textContent = ''; stat.className = 'passstatus'; }
  try {
    const j = await (await fetch('http://localhost:6079/arm')).json();
    if (j && j.ok) {
      const inSec = j.secToAos != null ? ` (AOS in ${Math.max(0, Math.round(j.secToAos))}s)` : '';
      if (stat) { stat.className = 'passstatus ok'; stat.textContent = `Position reset · next pass AOS ${j.aosUtc || ''}${j.maxAltDeg != null ? ', max elevation ' + j.maxAltDeg + '°' : ''}${inSec}`; }
    } else {
      if (stat) { stat.className = 'passstatus err'; stat.textContent = 'Reset failed: ' + ((j && j.error) || '?'); }
    }
  } catch (e) {
    if (stat) { stat.className = 'passstatus err'; stat.textContent = 'Cannot reach the gpredict control (:6079). Restart the container with run.sh.'; }
  }
  btn.disabled = false; btn.textContent = prev;
}

// ── PHASE 1 · orbit planner ──────────────────────────────────────────────────
function initSim() {
  const cv = $('#planSim');
  if (!cv || typeof SatSim === 'undefined' || typeof Scenario4 === 'undefined') return;
  sim = new SatSim(cv, Object.assign({ mode: 'planner', onClosest: onPlanStatus, onSelect: renderSatInfo }, Scenario4.simOpts));
  sim.setSatellites(Scenario4.satellites());
  requestAnimationFrame(() => sim._resize());
  renderSatInfo('demosat');
}
// Two thrusters (ALTITUDE / UP-DOWN) as separate blocks in one horizontal row.
// Each block fires "gas" (a signed delta); the resulting orbit is shown under it.
// The packet still carries the resulting absolute orbit, so nothing else changes.
const THRUSTERS = [
  { key: 'alt', name: 'ALTITUDE', tag: 'orbit altitude', effect: 'raises / lowers the orbit (altitude)', unit: 'km', min: -200, max: 600, step: 10 },
  { key: 'ud',  name: 'UP / DOWN', tag: 'orbital plane', effect: 'tilts the orbital plane (inclination)', unit: '°', min: -50, max: 40, step: 1 },
];
function thrustBase() { return (Scenario4 && Scenario4.demosatStart) || { altKm: 600, inc: 50, raan: 25 }; }
function applyThrust() {
  const b = thrustBase();
  S.params.altKm = round1(clamp(b.altKm + S.thrust.alt, 300, 1400));
  S.params.inc   = round1(clamp(b.inc + S.thrust.ud, 0, 90));
  S.params.raan  = b.raan;   // node stays fixed; thrusters change altitude + inclination only
}
function buildElementInputs() {
  const pad = $('#thrustPad'); if (!pad) return;
  pad.innerHTML = '';
  THRUSTERS.forEach((t) => pad.appendChild(thrustInput(t)));
  refreshThrustResults();
}
function thrustInput(t) {
  const col = el('div', 'thrustcol');
  col.appendChild(el('div', 'txhead', `<span class="txname">${t.name}</span><span class="txko">${t.tag}</span>`));
  col.appendChild(el('div', 'txdesc', t.effect));
  const ctl = el('div', 'axctl');
  const dec = el('button', 'stepbtn', '−');
  const inp = el('input', 'axinput'); inp.type = 'number'; inp.min = t.min; inp.max = t.max; inp.step = t.step; inp.id = 'th_' + t.key;
  inp.value = S.thrust[t.key];
  const inc = el('button', 'stepbtn', '+');
  dec.onclick = () => setThrust(t.key, (+inp.value || 0) - t.step, t.min, t.max, false);
  inc.onclick = () => setThrust(t.key, (+inp.value || 0) + t.step, t.min, t.max, false);
  inp.oninput = () => setThrust(t.key, +inp.value || 0, t.min, t.max, true);
  ctl.appendChild(dec); ctl.appendChild(inp); ctl.appendChild(inc);
  col.appendChild(ctl);
  col.appendChild(el('div', 'txunit', `gas output (${t.unit})`));
  const res = el('div', 'txresult'); res.id = 'res_' + t.key;
  col.appendChild(res);
  return col;
}
function setThrust(key, v, min, max, typing) {
  v = clamp(round1(v), min, max);
  S.thrust[key] = v;
  const box = $('#th_' + key); if (box && !typing) box.value = v;
  applyThrust();
  S.valueConfirmed = false; S.generated = false;
  updateSimManeuver();
  refreshThrustResults();
  renderSatInfo('demosat');
}
function refreshThrustResults() {
  const map = {
    alt: `→ altitude <b>${round1(S.params.altKm)} km</b>`,
    ud:  `→ inclination <b>${round1(S.params.inc)}°</b>`,
  };
  Object.keys(map).forEach((k) => { const e = $('#res_' + k); if (e) e.innerHTML = map[k]; });
}
// keep the thruster deltas in sync if the value was edited directly in phase 2
function syncThrustFromParams() {
  const b = thrustBase();
  S.thrust.alt = round1(S.params.altKm - b.altKm);
  S.thrust.ud = round1(S.params.inc - b.inc);
  THRUSTERS.forEach((t) => { const e = $('#th_' + t.key); if (e) e.value = S.thrust[t.key]; });
  refreshThrustResults();
}
function updateSimManeuver() {
  if (sim) sim.setManeuver({ altKm: +S.params.altKm, inc: +S.params.inc, raan: +S.params.raan });
  const changed = S.thrust.alt !== 0 || S.thrust.ud !== 0;
  const b = $('#toPhase2'); if (b) b.disabled = !changed;
}
// right-side satellite info panel; ENIGMA-1 shows the planned orbit, others their orbit
function renderSatInfo(id) {
  const box = $('#satInfo'); if (!box) return;
  if (!id) { box.innerHTML = '<div class="siempty">Click a satellite to inspect its orbit.</div>'; return; }
  let info;
  if (id === 'demosat') info = { name: 'ENIGMA-1', role: 'attacker', altKm: +S.params.altKm, incDeg: +S.params.inc, raanDeg: +S.params.raan };
  else info = sim ? sim.getInfo(id) : null;
  if (!info) return;
  const tag = info.role === 'attacker' ? '<span class="sirole atk">YOUR SATELLITE</span>' : '<span class="sirole tgt">TARGET</span>';
  box.innerHTML = `<div class="sihead">${info.name} ${tag}</div>
    <div class="sirow"><span>Altitude</span><b>${info.altKm} km</b></div>
    <div class="sirow"><span>Inclination</span><b>${info.incDeg}°</b></div>
    <div class="sirow"><span>RAAN</span><b>${info.raanDeg}°</b></div>` +
    (info.role !== 'attacker'
      ? (Math.abs(info.raanDeg - thrustBase().raan) <= 2
          ? '<div class="sihint">Same RAAN plane as ENIGMA-1. Fire ALTITUDE / UP-DOWN until ENIGMA-1 reaches this altitude + inclination.</div>'
          : '<div class="sihint" style="color:#d9b3ff">Different RAAN plane. ENIGMA-1 can only change ALTITUDE / UP-DOWN (not RAAN), so this one is out of reach.</div>')
      : '');
}
function onPlanStatus(r) {
  lastPlan = r;
  const box = $('#planStatus');
  if (!box) return;
  if (!r || !r.hasManeuver) { box.className = 'planstatus idle'; box.innerHTML = 'Fire the thrusters to preview ENIGMA-1\'s new path.'; return; }
  if (r.status === 'course') {
    box.className = 'planstatus course';
    box.innerHTML = `<b>⚠ COLLISION COURSE</b> - ENIGMA-1's new path passes over <b>${r.victimName}</b> (${r.distKm} km). Transmit this maneuver.`;
  } else if (r.status === 'plane') {
    box.className = 'planstatus plane';
    box.innerHTML = `Path crosses <b>${r.victimName}</b>, but it is on a <b>different orbital plane (RAAN)</b>. ALTITUDE / UP-DOWN alone can't line it up — aim for a different satellite.`;
  } else {
    box.className = 'planstatus off';
    box.innerHTML = `Nearest satellite <b>${r.victimName || '-'}</b>, path passes <b>${r.distKm != null ? r.distKm + ' km' : '-'}</b> away. Keep firing ALTITUDE / UP-DOWN to close in.`;
  }
}

// ── TARGET INTEL dossier (both phase 1 + phase 2) ────────────────────────────
function renderDossier() {
  const t = M.target;
  const html = `
    <div class="drow"><span>SATELLITE</span><b>${t.satellite}</b></div>
    <div class="drow hl-scid"><span>SPACECRAFT ID</span><b>${t.scid}</b></div>
    <div class="hl-rf">
      <div class="dsep">RECEIVER (RF)</div>
      <div class="drow"><span>MODULATION</span><b>${t.modulation}</b></div>
      <div class="drow"><span>BAUD RATE</span><b>${t.baud} bps</b></div>
      <div class="drow"><span>SAMPLE RATE</span><b>${(t.sampleRate / 1000)} kSa/s</b></div>
    </div>
    <div class="dsep">UPLINK</div>
    <div class="drow"><span>FREQUENCY</span><b>${t.uplinkFreqMHz.toFixed(3)} MHz</b></div>
    <div class="dnote">${t.notes}</div>`;
  if ($('#dossier')) $('#dossier').innerHTML = html;
  if ($('#dossier2')) $('#dossier2').innerHTML = html + '<div class="dnote dim">Match every field to arm the uplink.</div>';
}
function renderBurnRecap() {
  const r = $('#burnRecap'); if (!r) return;
  r.innerHTML = `<div class="brl">PLANNED ORBIT</div>
    <div class="brv">alt <b>${S.params.altKm} km</b> · inc <b>${S.params.inc}°</b></div>
    <div class="brhint">this is the value STEP 3 will carry. Re-plan in phase 1 to change it.</div>`;
}
// phase 2 · top strip: recap the maneuver the visitor dialled in phase 1
function renderPlanRecap() {
  const box = $('#planRecap'); if (!box) return;
  const fmt = (v) => (v >= 0 ? '+' : '') + round1(v);
  let target = '';
  if (lastPlan && lastPlan.status === 'course') {
    target = `<div class="prtarget">⚠ COLLISION COURSE → <b>${lastPlan.victimName}</b> (${lastPlan.distKm} km)</div>`;
  } else if (lastPlan && lastPlan.victimName) {
    target = `<div class="prtarget">nearest <b>${lastPlan.victimName}</b>${lastPlan.distKm != null ? ' (' + lastPlan.distKm + ' km away)' : ''}</div>`;
  }
  box.innerHTML = `<div class="prtag">PHASE 1 · YOUR MANEUVER</div>
    <div class="prcells">
      <div class="prcell"><span>ALTITUDE thruster</span><b>${fmt(S.thrust.alt)} km</b></div>
      <div class="prcell"><span>UP / DOWN thruster</span><b>${fmt(S.thrust.ud)}°</b></div>
      <div class="prcell arrow">→</div>
      <div class="prcell res"><span>Result altitude</span><b>${round1(S.params.altKm)} km</b></div>
      <div class="prcell res"><span>Result inclination</span><b>${round1(S.params.inc)}°</b></div>
    </div>
    ${target}
    <div class="prhint">This value is carried by the STEP 3 packet below. To change it, <a href="#" id="rePlan1">re-plan in phase 1</a>.</div>`;
  const rp = box.querySelector('#rePlan1'); if (rp) rp.onclick = (e) => { e.preventDefault(); showPhase(1); };
}
// phase 2 · top strip: tell the visitor which packet to build
function renderBuildGuide() {
  const box = $('#buildGuide'); if (!box) return;
  box.innerHTML = `<div class="bgtag">PACKET BUILD GUIDE</div>
    <ol class="bglist">
      <li>Build the <b>orbit_maneuver</b> command that changes the satellite's orbit (an attack that abuses a legitimate command).</li>
      <li><span class="bgstep">STEP 1</span> Match the target satellite's <b>SCID</b> to the TARGET INTEL.</li>
      <li><span class="bgstep">STEP 2</span> Under the <b>AOCS</b> subsystem, choose <b>orbit_maneuver ★</b>.</li>
      <li><span class="bgstep">STEP 3</span> Confirm the <b>orbit values</b> (altitude / inclination) you planned in phase 1.</li>
      <li><span class="bgstep">STEP 4</span> Match the receiver <b>RF settings</b> (modulation / baud rate / sample rate) to arm the uplink.</li>
    </ol>`;
}

// ── PHASE 2 · step machine (scenario 2) ──────────────────────────────────────
const FRAME_MAP = [
  { field: 'preamble', label: 'Preamble · bit sync' },
  { field: 'tc_header', label: 'TC Frame Header · addressing', anno: () => S.scid != null ? `addressed → SCID ${S.scid}` : 'awaiting Spacecraft ID (Step 1)' },
  { field: 'sp_header', label: 'Space Packet Header · APID', anno: () => S.cmdDef ? `routed → APID ${S.cmdDef.apid}` : 'awaiting command (Step 2)' },
  { field: 'opcode', label: 'Opcode · command', anno: () => S.cmdDef ? `→ ${S.command}` : 'awaiting command (Step 2)' },
  { field: 'payload', label: 'Payload · value', anno: () => S.valueConfirmed ? 'value confirmed' : 'awaiting value (Step 3)' },
  { field: 'crc', label: 'Frame CRC-16 · integrity', anno: () => 'computed over the whole frame' },
];
function stepStatus() {
  const t = M.target, rf = S.rf;
  return {
    1: S.scid == null ? 'pending' : (S.scid === t.scid ? 'ok' : 'bad'),
    2: S.command == null ? 'pending' : 'ok',
    3: S.command == null ? 'pending' : (S.valueConfirmed ? 'ok' : 'pending'),
    4: (rf.modulation == null || rf.baud == null || rf.sampleRate == null) ? 'pending'
      : (rf.modulation === t.modulation && rf.baud === t.baud && rf.sampleRate === t.sampleRate ? 'ok' : 'bad'),
  };
}
const PILL = { pending: 'PENDING', ok: 'LOCKED ✓', bad: 'MISMATCH ✗' };
function stepUnlocked() { return { 1: true, 2: S.scid != null, 3: S.command != null, 4: S.valueConfirmed }; }
function stepComplete() {
  return { 1: S.scid != null, 2: S.command != null, 3: S.valueConfirmed,
    4: S.rf.modulation != null && S.rf.baud != null && S.rf.sampleRate != null };
}
function activeStep() {
  const u = stepUnlocked(), c = stepComplete();
  for (let n = 1; n <= 4; n++) if (u[n] && !c[n]) return n;
  return 5;
}
function stepSummary(n) {
  if (n === 1) return S.scid != null ? `SCID ${S.scid}` : '';
  if (n === 2) return S.command || '';
  if (n === 3) return S.command === 'orbit_maneuver' ? `alt ${S.params.altKm} · inc ${S.params.inc}` : (S.valueConfirmed ? 'confirmed' : '');
  if (n === 4) { const r = S.rf; return r.modulation == null ? '' : `${r.modulation} · ${r.baud}bps · ${r.sampleRate / 1000}kSa/s`; }
  return '';
}
const collapseOverride = {};
const STEP_DEFS = [
  [1, 'TARGET ADDRESSING', 'Match the Spacecraft ID (SCID) to the target satellite.', bodyAddressing],
  [2, 'COMMAND SELECT', 'Choose the subsystem and command to send.', bodyCommand],
  [3, 'COMMAND VALUE', 'The maneuver Δv you planned in phase 1. Confirm it.', bodyValue],
  [4, 'RF CONFIG', 'Match the modulation, baud and sample rate to the satellite receiver.', bodyRF],
];
// per-step hint: which element holds the value this step needs (step 2 needs none)
const STEP_HINTS = {
  1: '#dossier2 .hl-scid',   // Spacecraft ID in TARGET INTEL
  3: '#planRecap',           // the phase-1 "YOUR MANEUVER" strip at the top
  4: '#dossier2 .hl-rf',     // RECEIVER (RF) block in TARGET INTEL
};
const hintTimers = {};
function flashHint(n) {
  const sel = STEP_HINTS[n]; if (!sel) return;
  const els = document.querySelectorAll(sel);
  els.forEach((e) => { e.classList.remove('hlpulse'); void e.offsetWidth; e.classList.add('hlpulse'); });
  const first = els[0]; if (first && first.scrollIntoView) first.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  clearTimeout(hintTimers[n]);
  hintTimers[n] = setTimeout(() => els.forEach((e) => e.classList.remove('hlpulse')), 5000);
}
function renderSteps() {
  const wrap = $('#stepList'); if (!wrap) return;
  wrap.innerHTML = '';
  const u = stepUnlocked(), done = stepComplete(), active = activeStep();
  STEP_DEFS.forEach(([n, title, prompt, fn]) => {
    let collapsed = u[n] && done[n] && n !== active;
    if (collapseOverride[n] !== undefined) collapsed = collapseOverride[n];
    wrap.appendChild(stepCard(n, title, prompt, fn, u[n], collapsed));
  });
  refreshPills();
}
function stepCard(n, title, prompt, bodyFn, unlocked, collapsed) {
  const card = el('div', 'step' + (unlocked ? '' : ' locked') + (collapsed ? ' collapsed' : ''));
  card.dataset.step = n;
  card.innerHTML = `<div class="shead"><span class="snum">${n}</span>
      <span class="stitle">${title}</span><span class="ssum">${collapsed ? stepSummary(n) : ''}</span>
      <span class="pill"></span>${unlocked ? `<span class="chev">${collapsed ? '▸' : '▾'}</span>` : ''}</div>
    <div class="sbody"></div><div class="sprompt">${prompt}${(unlocked && STEP_HINTS[n]) ? ' <button class="stephint" type="button">💡 Hint</button>' : ''}</div>`;
  const body = card.querySelector('.sbody');
  if (unlocked) bodyFn(body);
  else body.innerHTML = `<div class="lockmsg">🔒 Complete Step ${n - 1} first</div>`;
  if (unlocked) card.querySelector('.shead').onclick = () => { collapseOverride[n] = !card.classList.contains('collapsed'); renderSteps(); };
  const hbtn = card.querySelector('.stephint');
  if (hbtn) hbtn.onclick = (e) => { e.stopPropagation(); flashHint(n); };
  return card;
}
function refreshPills() {
  const st = stepStatus();
  document.querySelectorAll('.step').forEach((c) => {
    const n = +c.dataset.step, s = st[n], pill = c.querySelector('.pill');
    if (c.classList.contains('locked')) { pill.className = 'pill locked'; pill.textContent = 'LOCKED 🔒'; return; }
    pill.className = 'pill ' + s; pill.textContent = PILL[s];
    c.classList.toggle('done', s === 'ok'); c.classList.toggle('mismatch', s === 'bad');
  });
  const ok = Object.values(st).filter((x) => x === 'ok').length;
  if ($('#progText')) { $('#progText').textContent = `${ok} / 4`; $('#progFill').style.width = (ok / 4 * 100) + '%'; }
  const btn = $('#genBtn');
  if (ok === 4) {
    btn.disabled = false; btn.className = 'genbtn armed';
    btn.textContent = S.generated ? '✓ IQ GENERATED — REGENERATE' : '⚡ GENERATE UPLINK IQ';
    if ($('#progHint')) $('#progHint').textContent = 'All systems configured — uplink armed.';
  } else {
    btn.disabled = true; btn.className = 'genbtn locked';
    btn.textContent = `🔒 UPLINK LOCKED — ${ok}/4 CONFIGURED`;
    S.generated = false;
    if ($('#progHint')) $('#progHint').textContent = 'Complete all 4 systems to arm the uplink.';
  }
  const to3 = $('#toPhase3');
  if (to3) { to3.classList.toggle('hidden', !S.generated); to3.disabled = !S.generated; }
}

function bodyAddressing(body) {
  const row = el('div', 'chips');
  M.options.scid.forEach((v) => {
    const c = el('button', 'chip', `SCID ${v}`);
    c.onclick = () => { S.scid = v; renderSteps(); rebuild(); };
    if (S.scid === v) c.classList.add('sel');
    row.appendChild(c);
  });
  body.appendChild(row);
}
function bodyCommand(body) {
  const tabs = el('div', 'tabs'); const list = el('div', 'cmdlist');
  M.subsystems.forEach((sub) => {
    const t = el('button', 'tab', sub); t.dataset.sub = sub;
    t.onclick = () => selectSub(sub, tabs, list);
    tabs.appendChild(t);
  });
  body.appendChild(tabs); body.appendChild(list);
  selectSub((S.cmdDef && S.cmdDef.subsystem) || 'PROP', tabs, list);
}
function selectSub(sub, tabs, list) {
  tabs.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.sub === sub));
  list.innerHTML = '';
  M.commands.filter((c) => c.subsystem === sub).forEach((c) => {
    const item = el('div', 'cmd' + (S.command === c.command ? ' sel' : ''));
    item.innerHTML = `<div class="n">${c.command}${c.star ? ' <span class="star">★ attack</span>' : ''}</div>
                      <div class="o">${c.opcode} · APID ${c.apid}</div><div class="role">${c.blurb}</div>`;
    item.onclick = () => selectCommand(c);
    list.appendChild(item);
  });
}
function selectCommand(c) {
  S.command = c.command; S.cmdDef = c; S.valueConfirmed = false;
  if (c.command === 'orbit_maneuver') {
    // keep the orbit elements planned in phase 1 (do not overwrite with defaults)
    if (S.params.altKm == null) S.params.altKm = 600;
    if (S.params.inc == null) S.params.inc = 50;
    if (S.params.raan == null) S.params.raan = 25;
  } else {
    S.params = {};
    (c.fields || []).forEach((f) => { S.params[f.key] = f.type === 'toggle' ? !!f.default : f.default; });
    if (!c.fields || !c.fields.length) S.valueConfirmed = true;
  }
  renderSteps(); rebuild();
}
// STEP 3 — value. orbit_maneuver shows the phase-1 burn read-only; other commands use fields.
function bodyValue(body) {
  if (!S.cmdDef) { body.innerHTML = '<div class="muted">Select a command first (Step 2).</div>'; return; }
  const c = S.cmdDef;
  if (S.command === 'orbit_maneuver') {
    body.innerHTML = `<div class="vhead">${c.title} <span class="star">★</span></div>
      <div class="muted">${c.blurb}</div>
      <div class="pvnote">These orbit elements were <b>derived in phase 1</b>. You can fill or fine-tune them here · <a href="#" id="rePlan">re-plan</a></div>`;
    const grid = el('div', 'valgrid');
    grid.appendChild(valInput('altKm', 'Altitude', 'km'));
    grid.appendChild(valInput('inc', 'Inclination', '°'));
    body.appendChild(grid);
    body.appendChild(el('div', 'effect', `<b>PREDICTED EFFECT</b> — ${c.effect}`));
    const confirm = el('button', 'confirm' + (S.valueConfirmed ? ' done' : ''), S.valueConfirmed ? '✓ VALUE CONFIRMED' : 'CONFIRM VALUE');
    confirm.onclick = () => { S.valueConfirmed = true; refreshPills(); renderSteps(); rebuild(); };
    body.appendChild(confirm);
    const rp = body.querySelector('#rePlan'); if (rp) rp.onclick = (e) => { e.preventDefault(); showPhase(1); };
    return;
  }
  body.innerHTML = `<div class="vhead">${c.title}</div><div class="muted">${c.blurb}</div>`;
  const fields = el('div', 'fields');
  (c.fields || []).forEach((f) => fields.appendChild(fieldControl(f)));
  if (!c.fields.length) fields.innerHTML = '<div class="muted">This command carries no payload.</div>';
  body.appendChild(fields);
  const danger = el('div', 'danger hidden'); danger.id = 'danger'; body.appendChild(danger);
  body.appendChild(el('div', 'effect', `<b>PREDICTED EFFECT</b> — ${c.effect}`));
  if (c.fields.length) {
    const confirm = el('button', 'confirm' + (S.valueConfirmed ? ' done' : ''), S.valueConfirmed ? '✓ VALUE CONFIRMED' : 'CONFIRM VALUE');
    confirm.onclick = () => { S.valueConfirmed = true; refreshPills(); renderSteps(); };
    body.appendChild(confirm);
  }
}
// editable phase-2 value input for orbit_maneuver (pre-filled from the phase-1 plan)
function valInput(key, label, unit) {
  const f = el('div', 'valfield');
  f.innerHTML = `<label>${label} <span class="vu">${unit}</span></label>`;
  const inp = el('input', 'axinput'); inp.type = 'number'; inp.value = S.params[key]; inp.id = 'v_' + key;
  inp.oninput = () => { S.params[key] = +inp.value || 0; S.valueConfirmed = false; S.generated = false; rebuild(); syncConfirm(); };
  f.appendChild(inp);
  return f;
}

function fieldControl(f) {
  const field = el('div', 'field');
  const show = () => {
    const bad = f.safeAbsMax != null && Math.abs(S.params[f.key]) > f.safeAbsMax;
    const fv = field.querySelector('.fv');
    if (fv) { fv.textContent = `${S.params[f.key]}${f.unit || ''}`; fv.classList.toggle('bad', bad); }
  };
  if (f.type === 'slider' || f.type === 'number') {
    field.innerHTML = `<div class="flabel"><span class="fk">${f.key}</span><span class="fv"></span></div>`;
    const inp = el('input'); inp.type = f.type === 'slider' ? 'range' : 'number'; inp.min = f.min; inp.max = f.max; inp.value = S.params[f.key];
    inp.oninput = () => { S.params[f.key] = +inp.value; S.valueConfirmed = false; show(); rebuild(); syncConfirm(); };
    field.appendChild(inp); show();
  } else if (f.type === 'toggle') {
    const tg = el('div', 'toggle' + (S.params[f.key] ? ' on' : ''), `<span class="sw"></span><span>${f.key.toUpperCase()}</span>`);
    tg.onclick = () => { S.params[f.key] = !S.params[f.key]; tg.classList.toggle('on', S.params[f.key]); S.valueConfirmed = false; rebuild(); syncConfirm(); };
    field.appendChild(tg);
  }
  return field;
}
function syncConfirm() { const b = document.querySelector('.confirm'); if (b) { b.classList.remove('done'); b.textContent = 'CONFIRM VALUE'; } refreshPills(); }
function bodyRF(body) {
  body.appendChild(rfRow('MODULATION', 'modulation', M.options.modulation, (v) => v));
  body.appendChild(rfRow('BAUD RATE', 'baud', M.options.baud, (v) => v + ' bps'));
  body.appendChild(rfRow('SAMPLE RATE', 'sampleRate', M.options.sampleRate, (v) => (v / 1000) + ' kSa/s'));
}
function rfRow(label, key, opts, fmt) {
  const row = el('div', 'rfrow'); row.appendChild(el('div', 'rflabel', label));
  const chips = el('div', 'chips');
  opts.forEach((v) => {
    const c = el('button', 'chip' + (S.rf[key] === v ? ' sel' : ''), fmt(v));
    c.onclick = () => { S.rf[key] = v; markSel(chips, c); refreshPills(); rebuild(); };
    chips.appendChild(c);
  });
  row.appendChild(chips); return row;
}
function markSel(row, sel) { row.querySelectorAll('.chip').forEach((c) => c.classList.remove('sel')); sel.classList.add('sel'); }

// ── frame preview ────────────────────────────────────────────────────────────
let timer = null;
function rebuild() { clearTimeout(timer); timer = setTimeout(build, 100); }
async function build() {
  const st = stepStatus();
  let bd = null, wf = [];
  if (S.command) {
    const r = await postJSON('/api/build', payload());
    if (r.ok) {
      bd = r.breakdown; wf = r.waveform || [];
      const d = $('#danger');
      if (d) { if (r.danger) { d.textContent = r.danger; d.classList.remove('hidden'); } else d.classList.add('hidden'); }
    }
  }
  renderFrame(bd, st);
  const rfSet = S.rf.modulation != null && S.rf.baud != null && S.rf.sampleRate != null;
  const hint = $('#waveHint');
  if (rfSet && wf.length) {
    drawWave(wf);
    if (st[4] === 'ok') hint.classList.add('hidden');
    else { hint.textContent = '⚠ Signal shown — but RF mismatch: the receiver won\'t decode it.'; hint.classList.remove('hidden'); }
    $('#frameMeta').textContent = bd ? `${bd.frameBytes.length} bytes · ${bd.sampleCount} IQ samples · ${bd.durationSec}s @ ${S.rf.baud} baud ${S.rf.modulation}` : '';
  } else { drawWave([]); hint.textContent = 'RF not configured — complete Step 4.'; hint.classList.remove('hidden'); $('#frameMeta').textContent = ''; }
}
function renderFrame(bd, st) {
  const byField = {}; if (bd) bd.segments.forEach((s) => (byField[s.field] = s));
  const cond = { preamble: true, tc_header: S.scid != null, sp_header: S.command != null, opcode: S.command != null,
    payload: S.valueConfirmed, crc: S.scid != null && S.command != null && S.valueConfirmed };
  let filled = 0, total = 0;
  const wrap = $('#breakdown'); if (!wrap) return; wrap.innerHTML = '';
  FRAME_MAP.forEach((m) => {
    const seg = byField[m.field]; const isPre = m.field === 'preamble';
    const canFill = cond[m.field] && (isPre || !!seg);
    if (!isPre) { total++; if (canFill) filled++; }
    const div = el('div', 'seg f-' + m.field + (canFill ? ' filled' : ' pending'));
    div.appendChild(el('div', 'sl', m.label));
    const bytes = el('div', 'bytes');
    if (canFill) {
      const bs = seg ? seg.bytes : [0xAA, 0xAA];
      (bs.length ? bs : [null]).forEach((b) => {
        const chip = el('div', 'byte', b == null ? '—' : b.toString(16).padStart(2, '0').toUpperCase());
        if (b != null) { chip.onmousemove = (e) => showTip(e, seg || { label: m.label }, b); chip.onmouseleave = hideTip; }
        bytes.appendChild(chip);
      });
    } else { for (let i = 0; i < 2; i++) bytes.appendChild(el('div', 'byte ph', '··')); }
    div.appendChild(bytes);
    if (m.anno) div.appendChild(el('div', 'anno', m.anno()));
    wrap.appendChild(div);
  });
  $('#frameProg').textContent = `${filled} / ${total} fields`;
}
function showTip(e, seg, b) {
  const tip = $('#tooltip');
  const sub = (seg.sub || []).map((x) => `${x.name}: <b>${x.value}${x.unit ? ' ' + x.unit : ''}</b>`).join('<br>');
  tip.innerHTML = `<b>${seg.label}</b><br>byte 0x${b.toString(16).padStart(2, '0')}` + (sub ? '<br>' + sub : '');
  tip.classList.remove('hidden');
  tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 250) + 'px';
  tip.style.top = (e.clientY + 14) + 'px';
}
function hideTip() { $('#tooltip').classList.add('hidden'); }
function drawWave(w) {
  const cv = $('#wave'), ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  if (!w || !w.length) return;
  ctx.strokeStyle = '#39c5ff'; ctx.lineWidth = 1.5; ctx.beginPath();
  const pad = 10, h = H - 2 * pad;
  w.forEach((v, i) => { const x = (i / (w.length - 1)) * W, y = H - pad - v * h; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke(); ctx.fillStyle = 'rgba(57,197,255,.08)'; ctx.lineTo(W, H - pad); ctx.lineTo(0, H - pad); ctx.fill();
}

// ── PHASE 2→3: generate the IQ ───────────────────────────────────────────────
async function doGenerate() {
  const btn = $('#genBtn'); if (btn.disabled) return;
  const prev = btn.textContent; btn.textContent = '… GENERATING';
  const r = await postJSON('/api/generate', payload());
  if (r.ok && r.saved) { S.generated = true; refreshPills(); }
  else { S.generated = false; btn.textContent = 'generate blocked: ' + (r.error || '?'); return; }
  refreshPills();
}

// ── PHASE 3 · uplink ─────────────────────────────────────────────────────────
function renderUplinkSummary() {
  const box = $('#uplinkSummary'); if (!box) return;
  box.innerHTML = `
    <div class="usrow"><span>Satellite</span><b>${M.target.satellite}</b></div>
    <div class="usrow"><span>Command</span><b>orbit_maneuver</b></div>
    <div class="usrow"><span>Target orbit</span><b>alt ${S.params.altKm} km · inc ${S.params.inc}°</b></div>
    <div class="usrow"><span>Modulation</span><b>${S.rf.modulation} · ${S.rf.baud} bps · ${S.rf.sampleRate / 1000} kSa/s</b></div>
    <div class="usrow"><span>Uplink</span><b>${M.target.uplinkFreqMHz.toFixed(3)} MHz</b></div>
    <div class="usnote">IQ file generated. Press TRANSMIT to uplink the command to ENIGMA-1.</div>`;
  runLinkSequence();
}
// animated VSA <-> GPredict auto-link + uplink-file registration (scenario 2 process)
function runLinkSequence() {
  const steps = document.querySelectorAll('#linkSteps .lstep');
  const wire = $('#lnWire'), vsa = $('#lnVsa'), gp = $('#lnGp'), btn = $('#uplinkBtn');
  steps.forEach((s) => s.classList.remove('on'));
  if (wire) wire.classList.remove('linked');
  if (vsa) vsa.classList.remove('on'); if (gp) gp.classList.remove('on');
  if (btn) { btn.disabled = true; btn.textContent = '… LINKING VSA + GPREDICT'; }
  let i = 0;
  const tick = () => {
    if ($('#phase3').classList.contains('hidden')) return;   // aborted (navigated away)
    if (i < steps.length) {
      steps[i].classList.add('on');
      if (i === 0 && gp) gp.classList.add('on');
      if (i === 1) { if (vsa) vsa.classList.add('on'); if (wire) wire.classList.add('linked'); }
      i++;
      setTimeout(tick, 750);
    } else if (btn) {
      btn.disabled = !S.generated;
      btn.textContent = '⚡ TRANSMIT UPLINK → ENIGMA-1';
    }
  };
  setTimeout(tick, 400);
}
async function doUplink() {
  const b = $('#uplinkBtn'); if (b.disabled) return;
  b.disabled = true; b.textContent = '… TRANSMITTING';
  const r = await postJSON('/api/uplink', payload());
  const res = $('#uplinkResult');
  if (r.ok && r.uplink && r.uplink.ok) {
    const out = (r.uplink.gs && r.uplink.gs.outcome) || {};
    S.lastOutcome = out;
    res.className = 'result hit'; res.innerHTML = '⚡ Uplink transmitted to ENIGMA-1.';
    res.classList.remove('hidden');
    setTimeout(() => { showPhase(4); renderObserve(out); }, 700);
  } else {
    const why = (r.uplink && r.uplink.error) || r.error || 'assembly incomplete';
    res.className = 'result'; res.textContent = 'uplink blocked: ' + why; res.classList.remove('hidden');
  }
  b.disabled = false; b.textContent = '⚡ TRANSMIT UPLINK → ENIGMA-1';
}

// ── PHASE 4 · observe (impact countdown → confirm via monitor 2 → congrats) ───
// The uplink already returns a PREDICTED outcome. On a predicted hit we show a live
// countdown to impact (the same wall-clock time monitor 2's sim uses), then wait for
// monitor 2 to report it actually played the debris video before declaring success.
// If nothing is confirmed in time (or the burn was a predicted miss) we offer retry.
let observePoll = null, countdownTimer = null;
function clearObserveTimers() {
  if (observePoll) { clearInterval(observePoll); observePoll = null; }
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}
function setRetryVisible(show, label) {
  const b = $('#retryBtn'); if (!b) return;
  b.classList.toggle('hidden', !show);
  if (label) b.textContent = label;
}
function renderObserve(out) {
  const box = $('#observeResult'); if (!box) return;
  clearObserveTimers();
  const note = $('#observeNote');

  // predicted MISS → the burn never reaches the constellation; fail + retry now
  if (!out || !out.collided) {
    box.className = 'observeresult miss';
    box.innerHTML = `<div class="obico">✕</div>
      <div class="obtitle">NO COLLISION</div>
      <div class="obsub">ENIGMA-1 <b>missed the constellation</b>${out && out.distKm != null ? ` — closest approach <b>${out.distKm} km</b>` : ''}.
        Reset and re-plan the burn in phase 1 so the orbit crosses a satellite.</div>`;
    setRetryVisible(true, '↺ RESET & RE-PLAN');
    if (note) note.textContent = 'ENIGMA-1 missed — reset and recompute the burn in phase 1.';
    return;
  }

  // predicted COLLISION → count down to impact, then wait for monitor 2 to confirm
  let eta = null;
  try { if (sim && sim.predictCollisionEtaSec) eta = sim.predictCollisionEtaSec({ altKm: +S.params.altKm, inc: +S.params.inc, raan: +S.params.raan }); } catch (e) {}
  if (!eta || !isFinite(eta) || eta <= 0) eta = (typeof Scenario4 !== 'undefined' && Scenario4.simOpts && Scenario4.simOpts.impactTargetSec) || 18;

  setRetryVisible(false);
  if (note) note.textContent = 'Watch monitor 2: the maneuver plays out and the debris video confirms the strike.';
  const t0 = Date.now();
  const failAt = t0 + (eta + 16) * 1000;      // impact time + slack for the video + polling
  paintCountdown(box, out, eta, 0);
  countdownTimer = setInterval(() => paintCountdown(box, out, eta, (Date.now() - t0) / 1000), 100);

  observePoll = setInterval(async () => {
    let st = null;
    try { st = await (await fetch('/api/observe-status')).json(); } catch (e) {}
    if (st && st.videoPlayed) { clearObserveTimers(); showObserveSuccess(out); }
    else if (Date.now() > failAt) { clearObserveTimers(); showObserveTimeout(out); }
  }, 700);
}
function paintCountdown(box, out, eta, elapsed) {
  const left = Math.max(0, eta - elapsed);
  const pct = Math.max(0, Math.min(100, (1 - left / eta) * 100));
  const victim = out.victim || 'a constellation satellite';
  if (left > 0.05) {
    box.className = 'observeresult counting';
    box.innerHTML = `<div class="cdtag">⚠ COLLISION COURSE — ENIGMA-1 → <b>${victim}</b></div>
      <div class="cdclock">IMPACT IN <b>${left.toFixed(1)}</b><span>s</span></div>
      <div class="cdrail"><i style="width:${pct}%"></i></div>
      <div class="cdsub">ENIGMA-1 is ramping onto the target orbit — watch it close in on monitor 2.</div>`;
  } else {
    box.className = 'observeresult counting impact';
    box.innerHTML = `<div class="cdtag danger">⚠ IMPACT</div>
      <div class="cdclock danger">IMPACT</div>
      <div class="cdrail"><i style="width:100%"></i></div>
      <div class="cdsub">Confirming the debris cascade on monitor 2…</div>`;
  }
}
function showObserveSuccess(out) {
  const box = $('#observeResult'); if (!box) return;
  box.className = 'observeresult hit celebrate';
  box.innerHTML = `<div class="celebico">🎉</div>
    <div class="celebtitle">ATTACK SUCCESSFUL</div>
    <div class="celebsub">ENIGMA-1 collided with <b>${out.victim || 'a constellation satellite'}</b>.
      Debris is cascading onto the other AURORA satellites — watch it play out on monitor 2.</div>`;
  setRetryVisible(true, '↺ RESET FOR NEXT ATTEMPT');
  const note = $('#observeNote'); if (note) note.textContent = 'Reset to run the demonstration again.';
}
function showObserveTimeout(out) {
  const box = $('#observeResult'); if (!box) return;
  box.className = 'observeresult miss';
  box.innerHTML = `<div class="obico">✕</div>
    <div class="obtitle">COLLISION NOT CONFIRMED</div>
    <div class="obsub">Monitor 2 did not report a debris cascade in time. Make sure the ground station
      dashboard (monitor 2) is open and reachable, then reset and transmit again.</div>`;
  setRetryVisible(true, '↺ RESET & RE-PLAN');
  const note = $('#observeNote'); if (note) note.textContent = 'Open monitor 2, then reset and re-transmit.';
}
async function doRetry() {
  const b = $('#retryBtn'); b.disabled = true; b.textContent = '… RESETTING';
  clearObserveTimers();
  await postJSON('/api/reset-target', {});
  // reset local build state, keep the sim; go back to phase 1
  S.scid = null; S.command = null; S.cmdDef = null; S.valueConfirmed = false; S.generated = false;
  S.rf = { modulation: null, baud: null, sampleRate: null }; S.lastOutcome = null;
  for (const k in collapseOverride) delete collapseOverride[k];
  if (sim) sim.reset();
  hintOn = false; { const hb = $('#hintBtn'); if (hb) { hb.classList.remove('on'); hb.textContent = '💡 Hint: show the target satellite orbit'; } }
  renderSteps();
  $('#uplinkResult').classList.add('hidden');
  b.disabled = false; b.textContent = '↺ RESET & RE-PLAN';
  showPhase(1);
  updateSimManeuver();
}

function payload() { return { scid: S.scid, command: S.command, params: S.params, valueConfirmed: S.valueConfirmed, rf: S.rf }; }
async function postJSON(url, body) {
  try { return await (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json(); }
  catch (e) { return { ok: false, error: String(e) }; }
}

boot();
