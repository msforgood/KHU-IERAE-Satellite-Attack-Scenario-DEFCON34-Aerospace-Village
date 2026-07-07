// DEMOSAT Command Builder — a booth puzzle. The visitor must assemble every
// element of a valid uplink (addressing, command, value, RF) to match the target
// dossier; only then does GENERATE unlock. All CCSDS/OOK logic is in the Python
// backend (ccsds_ook.py); this script drives the steps and renders responses.
'use strict';

let M = null;                 // mission payload (target, options, commands)
const S = {                   // participant's assembled state
  scid: null,
  command: null, cmdDef: null,
  params: {},
  valueConfirmed: false,
  rf: { modulation: null, baud: null, sampleRate: null },
};

const $ = (s) => document.querySelector(s);
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };

async function boot() {
  M = await (await fetch('/api/mission')).json();
  initPhases();
  renderDossier();
  renderSteps();
  rebuild();
}

// PHASE A → B gate: must acknowledge the briefing before building.
function initPhases() {
  const chk = $('#ackChk'), toBuild = $('#toBuild');
  chk.onchange = () => { toBuild.disabled = !chk.checked; };
  toBuild.onclick = () => {
    if (toBuild.disabled) return;
    $('#briefing').classList.add('hidden');
    $('#builder').classList.remove('hidden');
    window.scrollTo(0, 0);
  };
}

// which CCSDS field each step completes (drives the progressive assembly view)
const FRAME_MAP = [
  { field: 'preamble',  label: 'Preamble · bit sync' },
  { field: 'tc_header', label: 'TC Frame Header · addressing', anno: () => S.scid != null ? `addressed → SCID ${S.scid}` : 'awaiting Spacecraft ID (Step 1)' },
  { field: 'sp_header', label: 'Space Packet Header · APID',    anno: () => S.cmdDef ? `routed → APID ${S.cmdDef.apid}` : 'awaiting command (Step 2)' },
  { field: 'opcode',    label: 'Opcode · command',             anno: () => S.cmdDef ? `→ ${S.command}` : 'awaiting command (Step 2)' },
  { field: 'payload',   label: 'Payload · value',              anno: () => S.valueConfirmed ? 'value confirmed' : 'awaiting value (Step 3)' },
  { field: 'crc',       label: 'Frame CRC-16 · integrity',     anno: () => 'computed over the whole frame' },
];

// ── TARGET INTEL dossier (the answer key the visitor matches) ───────────────
function renderDossier() {
  const t = M.target;
  $('#dossier').innerHTML = `
    <div class="drow"><span>SATELLITE</span><b>${t.satellite}</b></div>
    <div class="drow"><span>SPACECRAFT ID</span><b>${t.scid}</b></div>
    <div class="dsep">RECEIVER (RF)</div>
    <div class="drow"><span>MODULATION</span><b>${t.modulation}</b></div>
    <div class="drow"><span>BAUD RATE</span><b>${t.baud} bps</b></div>
    <div class="drow"><span>SAMPLE RATE</span><b>${(t.sampleRate/1000)} kSa/s</b></div>
    <div class="dsep">UPLINK</div>
    <div class="drow"><span>FREQUENCY</span><b>${t.uplinkFreqMHz.toFixed(3)} MHz</b></div>
    <div class="dnote">${t.notes}</div>
    <div class="dnote dim">Match every field on the right to arm the uplink.</div>`;
}

// ── status of each step (client-side tri-state; server re-checks on generate) ─
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

// ── render the 4 step cards ─────────────────────────────────────────────────
function renderSteps() {
  const wrap = $('#stepList');
  wrap.innerHTML = '';
  wrap.appendChild(stepCard(1, 'TARGET ADDRESSING', 'Match the Spacecraft ID (SCID) to the target satellite. The wrong bird ignores your command.', bodyAddressing));
  wrap.appendChild(stepCard(2, 'COMMAND SELECT', 'Choose the subsystem and command to send.', bodyCommand));
  wrap.appendChild(stepCard(3, 'COMMAND VALUE', 'Set the command payload, then confirm it.', bodyValue));
  wrap.appendChild(stepCard(4, 'RF CONFIG', 'Match the modulation, baud and sample rate to the satellite receiver.', bodyRF));
  refreshPills();
}
function stepCard(n, title, prompt, bodyFn) {
  const card = el('div', 'step');
  card.dataset.step = n;
  card.innerHTML = `<div class="shead"><span class="snum">${n}</span>
      <span class="stitle">${title}</span><span class="pill"></span></div>
    <div class="sbody"></div><div class="sprompt">${prompt}</div>`;
  bodyFn(card.querySelector('.sbody'));
  return card;
}
function refreshPills() {
  const st = stepStatus();
  document.querySelectorAll('.step').forEach((c) => {
    const n = +c.dataset.step, s = st[n];
    const pill = c.querySelector('.pill');
    pill.className = 'pill ' + s;
    pill.textContent = PILL[s];
    c.classList.toggle('done', s === 'ok');
    c.classList.toggle('mismatch', s === 'bad');
  });
  const ok = Object.values(st).filter((x) => x === 'ok').length;
  $('#progText').textContent = `${ok} / 4`;
  $('#progFill').style.width = (ok / 4 * 100) + '%';
  const btn = $('#genBtn');
  if (ok === 4) {
    btn.disabled = false; btn.className = 'genbtn armed';
    btn.textContent = '⚡ GENERATE UPLINK IQ';
    $('#progHint').textContent = 'All systems configured — uplink armed.';
  } else {
    btn.disabled = true; btn.className = 'genbtn locked';
    btn.textContent = `🔒 UPLINK LOCKED — ${ok}/4 CONFIGURED`;
    $('#progHint').textContent = 'Complete all 4 systems to arm the uplink.';
  }
}

// STEP 1 — SCID chips
function bodyAddressing(body) {
  const row = el('div', 'chips');
  M.options.scid.forEach((v) => {
    const c = el('button', 'chip', `SCID ${v}`);
    c.onclick = () => { S.scid = v; markSel(row, c); refreshPills(); rebuild(); };
    if (S.scid === v) c.classList.add('sel');
    row.appendChild(c);
  });
  body.appendChild(row);
}

// STEP 2 — subsystem tabs + command list
function bodyCommand(body) {
  const tabs = el('div', 'tabs');
  const list = el('div', 'cmdlist');
  M.subsystems.forEach((sub) => {
    const t = el('button', 'tab', sub); t.dataset.sub = sub;
    t.onclick = () => selectSub(sub, tabs, list);
    tabs.appendChild(t);
  });
  body.appendChild(tabs); body.appendChild(list);
  selectSub((S.cmdDef && S.cmdDef.subsystem) || 'ADCS', tabs, list);
}
function selectSub(sub, tabs, list) {
  tabs.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.sub === sub));
  list.innerHTML = '';
  M.commands.filter((c) => c.subsystem === sub).forEach((c) => {
    const item = el('div', 'cmd' + (S.command === c.command ? ' sel' : ''));
    item.innerHTML = `<div class="n">${c.command}${c.star ? ' <span class="star">★ attack</span>' : ''}</div>
                      <div class="o">${c.opcode} · APID ${c.apid}</div>
                      <div class="role">${c.blurb}</div>`;
    item.onclick = () => selectCommand(c);
    list.appendChild(item);
  });
}
function selectCommand(c) {
  S.command = c.command; S.cmdDef = c; S.params = {}; S.valueConfirmed = false;
  (c.fields || []).forEach((f) => { S.params[f.key] = f.type === 'toggle' ? !!f.default : f.default; });
  if (!c.fields || !c.fields.length) S.valueConfirmed = true;  // no payload → auto
  renderSteps(); rebuild();
}

// STEP 3 — payload value + confirm
function bodyValue(body) {
  if (!S.cmdDef) { body.innerHTML = '<div class="muted">Select a command first (Step 2).</div>'; return; }
  const c = S.cmdDef;
  body.innerHTML = `<div class="vhead">${c.title}${c.star ? ' <span class="star">★</span>' : ''}</div>
                    <div class="muted">${c.blurb}</div>`;
  const fields = el('div', 'fields');
  (c.fields || []).forEach((f) => fields.appendChild(fieldControl(f)));
  if (!c.fields.length) fields.innerHTML = '<div class="muted">This command carries no payload.</div>';
  body.appendChild(fields);
  const danger = el('div', 'danger hidden'); danger.id = 'danger'; body.appendChild(danger);
  body.appendChild(el('div', 'effect', `<b>PREDICTED EFFECT</b> — ${c.effect}`));
  if (c.fields.length) {
    const confirm = el('button', 'confirm' + (S.valueConfirmed ? ' done' : ''),
      S.valueConfirmed ? '✓ VALUE CONFIRMED' : 'CONFIRM VALUE');
    confirm.onclick = () => { S.valueConfirmed = true; refreshPills(); renderSteps(); };
    body.appendChild(confirm);
  }
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
    if (f.type === 'slider') {
      const inp = el('input'); inp.type = 'range'; inp.min = f.min; inp.max = f.max; inp.value = S.params[f.key];
      inp.oninput = () => { S.params[f.key] = +inp.value; S.valueConfirmed = false; show(); rebuild(); syncConfirm(); };
      field.appendChild(inp);
      if (f.safeAbsMax != null) {
        const span = f.max - f.min, s0 = ((-f.safeAbsMax - f.min) / span) * 100, sw = ((2 * f.safeAbsMax) / span) * 100;
        const zb = el('div', 'zonebar');
        zb.appendChild(zone('zone-danger', s0)); zb.appendChild(zone('zone-safe', sw)); zb.appendChild(zone('zone-danger', 100 - s0 - sw));
        field.appendChild(zb);
        field.appendChild(el('div', 'ticks', `<span>${f.min}</span><span>SAFE ≤${f.safeAbsMax}</span><span>${f.max}</span>`));
      }
    } else {
      const inp = el('input'); inp.type = 'number'; inp.min = f.min; inp.max = f.max; inp.value = S.params[f.key];
      inp.oninput = () => { S.params[f.key] = +inp.value; S.valueConfirmed = false; show(); rebuild(); syncConfirm(); };
      field.appendChild(inp);
    }
    show();
  } else if (f.type === 'toggle') {
    const tg = el('div', 'toggle' + (S.params[f.key] ? ' on' : ''), `<span class="sw"></span><span>${f.key.toUpperCase()}</span>`);
    tg.onclick = () => { S.params[f.key] = !S.params[f.key]; tg.classList.toggle('on', S.params[f.key]); S.valueConfirmed = false; rebuild(); syncConfirm(); };
    field.appendChild(tg);
  }
  return field;
}
function zone(cls, w) { const d = el('div', cls); d.style.width = Math.max(0, w) + '%'; return d; }
function syncConfirm() {
  const b = document.querySelector('.confirm');
  if (b) { b.classList.remove('done'); b.textContent = 'CONFIRM VALUE'; }
  refreshPills();
}

// STEP 4 — RF config chips
function bodyRF(body) {
  body.appendChild(rfRow('MODULATION', 'modulation', M.options.modulation, (v) => v));
  body.appendChild(rfRow('BAUD RATE', 'baud', M.options.baud, (v) => v + ' bps'));
  body.appendChild(rfRow('SAMPLE RATE', 'sampleRate', M.options.sampleRate, (v) => (v / 1000) + ' kSa/s'));
}
function rfRow(label, key, opts, fmt) {
  const row = el('div', 'rfrow');
  row.appendChild(el('div', 'rflabel', label));
  const chips = el('div', 'chips');
  opts.forEach((v) => {
    const c = el('button', 'chip' + (S.rf[key] === v ? ' sel' : ''), fmt(v));
    c.onclick = () => { S.rf[key] = v; markSel(chips, c); refreshPills(); rebuild(); };
    chips.appendChild(c);
  });
  row.appendChild(chips);
  return row;
}
function markSel(row, sel) { row.querySelectorAll('.chip').forEach((c) => c.classList.remove('sel')); sel.classList.add('sel'); }

// ── frame preview (server build) ────────────────────────────────────────────
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
  // the OOK waveform is the physical layer — gate it on Step 4 (RF config)
  if (st[4] === 'ok' && wf.length) {
    drawWave(wf); $('#waveHint').classList.add('hidden');
    $('#frameMeta').textContent = bd ? `${bd.frameBytes.length} bytes · ${bd.sampleCount} IQ samples · ${bd.durationSec}s @ 100 baud OOK` : '';
  } else {
    drawWave([]); $('#waveHint').classList.remove('hidden'); $('#frameMeta').textContent = '';
  }
}

// Progressive CCSDS assembly: each field reveals as the step that defines it completes.
function renderFrame(bd, st) {
  const byField = {};
  if (bd) bd.segments.forEach((s) => (byField[s.field] = s));
  const cond = {
    preamble: true,
    tc_header: st[1] === 'ok',
    sp_header: st[2] === 'ok',
    opcode: st[2] === 'ok',
    payload: st[3] === 'ok',
    crc: st[1] === 'ok' && st[2] === 'ok' && st[3] === 'ok',
  };
  let filled = 0, total = 0;
  const wrap = $('#breakdown'); wrap.innerHTML = '';
  FRAME_MAP.forEach((m) => {
    const seg = byField[m.field];
    const isPre = m.field === 'preamble';
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
    } else {
      for (let i = 0; i < 2; i++) bytes.appendChild(el('div', 'byte ph', '··'));
    }
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

// ── generate (server re-validates all steps) ────────────────────────────────
$('#genBtn').onclick = async () => {
  const btn = $('#genBtn'); if (btn.disabled) return;
  btn.disabled = true; btn.textContent = '… GENERATING';
  const r = await postJSON('/api/generate', payload());
  refreshPills();
  const res = $('#result');
  if (r.ok && r.saved) {
    const url = 'data:application/octet-stream;base64,' + r.downloadB64;
    res.innerHTML = `✓ <b>${r.saved.filename}</b> written — load this into OpenVSA/VSA and uplink.<br>
      <span class="path">${r.saved.path}</span><br><a href="${url}" download="${r.saved.filename}">⬇ download cf32</a>`;
    res.classList.remove('hidden');
  } else {
    res.textContent = 'generate blocked: ' + (r.error || '?'); res.classList.remove('hidden');
  }
};

function payload() {
  return { scid: S.scid, command: S.command, params: S.params, valueConfirmed: S.valueConfirmed, rf: S.rf };
}
async function postJSON(url, body) {
  try { return await (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json(); }
  catch (e) { return { ok: false, error: String(e) }; }
}

boot();
