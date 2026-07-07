// DEMOSAT Command Builder — UI only. All CCSDS/OOK logic lives in the Python
// backend (ccsds_ook.py); this script drives the form and renders responses.
'use strict';

let PROTO = null;
let current = null;          // current command def
let params = {};             // current field values
let lastBreakdown = null;

const $ = (s) => document.querySelector(s);
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };

async function boot() {
  PROTO = await (await fetch('/api/protocol')).json();
  renderTabs();
  selectSubsystem(PROTO.subsystems[1] || PROTO.subsystems[0]); // default ADCS
}

function renderTabs() {
  const wrap = $('#subsystems');
  wrap.innerHTML = '';
  PROTO.subsystems.forEach((s) => {
    const t = el('div', 'tab', s);
    t.dataset.sub = s;
    t.onclick = () => selectSubsystem(s);
    wrap.appendChild(t);
  });
}

function selectSubsystem(sub) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.sub === sub));
  const list = $('#commandList');
  list.innerHTML = '';
  PROTO.commands.filter((c) => c.subsystem === sub).forEach((c) => {
    const item = el('div', 'cmd');
    item.innerHTML = `<div class="n">${c.command}${c.star ? ' <span class="star">★</span>' : ''}</div>
                      <div class="o">${c.opcode} · APID ${c.apid}</div>`;
    item.onclick = () => selectCommand(c);
    item.dataset.cmd = c.command;
    list.appendChild(item);
  });
  const first = PROTO.commands.find((c) => c.subsystem === sub);
  if (first) selectCommand(first);
}

function selectCommand(c) {
  current = c;
  params = {};
  document.querySelectorAll('.cmd').forEach((i) => i.classList.toggle('active', i.dataset.cmd === c.command));
  $('#cmdHead').innerHTML = `<div class="ct">${c.title}${c.star ? ' <span class="star">★</span>' : ''}</div>
                            <div class="cb">${c.command} · ${c.opcode} · ${c.blurb}</div>`;
  $('#effect').innerHTML = `<b>PREDICTED EFFECT</b> — ${c.effect}`;
  renderFields(c);
  rebuild();
}

function renderFields(c) {
  const wrap = $('#fields');
  wrap.innerHTML = '';
  c.fields.forEach((f) => {
    params[f.key] = f.default;
    const field = el('div', 'field');
    if (f.type === 'slider' || f.type === 'number') {
      const showVal = () => {
        const bad = f.safeAbsMax != null && Math.abs(params[f.key]) > f.safeAbsMax;
        field.querySelector('.fv').textContent = `${params[f.key]}${f.unit || ''}`;
        field.querySelector('.fv').classList.toggle('bad', bad);
      };
      field.innerHTML = `<div class="flabel"><span class="fk">${f.key}</span>
                         <span class="fv"></span></div>`;
      if (f.type === 'slider') {
        const rw = el('div', 'rangewrap');
        const inp = el('input'); inp.type = 'range'; inp.min = f.min; inp.max = f.max; inp.value = f.default;
        inp.oninput = () => { params[f.key] = +inp.value; showVal(); rebuild(); };
        rw.appendChild(inp);
        // safe/danger zone bar
        if (f.safeAbsMax != null) {
          const span = f.max - f.min;
          const safeStart = ((-f.safeAbsMax - f.min) / span) * 100;
          const safeW = ((2 * f.safeAbsMax) / span) * 100;
          const zb = el('div', 'zonebar');
          zb.appendChild(mk('zone-danger', safeStart));
          zb.appendChild(mk('zone-safe', safeW));
          zb.appendChild(mk('zone-danger', 100 - safeStart - safeW));
          rw.appendChild(zb);
        }
        const ticks = el('div', 'ticks', `<span>${f.min}</span><span>SAFE ≤${f.safeAbsMax ?? '—'}</span><span>${f.max}</span>`);
        field.appendChild(rw); field.appendChild(ticks);
      } else {
        const inp = el('input'); inp.type = 'number'; inp.min = f.min; inp.max = f.max; inp.value = f.default;
        inp.oninput = () => { params[f.key] = +inp.value; showVal(); rebuild(); };
        field.appendChild(inp);
      }
      wrap.appendChild(field);
      showVal();
    } else if (f.type === 'toggle') {
      params[f.key] = !!f.default;
      const tg = el('div', 'toggle' + (params[f.key] ? ' on' : ''),
        `<span class="sw"></span><span>${f.key.toUpperCase()}</span>`);
      tg.onclick = () => { params[f.key] = !params[f.key]; tg.classList.toggle('on', params[f.key]); rebuild(); };
      field.appendChild(tg);
      wrap.appendChild(field);
    }
  });
  if (!c.fields.length) wrap.innerHTML = '<div class="cb">This command carries no payload.</div>';
}
function mk(cls, wPct) { const d = el('div', cls); d.style.width = Math.max(0, wPct) + '%'; return d; }

let timer = null;
function rebuild() { clearTimeout(timer); timer = setTimeout(build, 120); }

async function build() {
  if (!current) return;
  const r = await postJSON('/api/build', { command: current.command, params });
  if (!r.ok) return;
  lastBreakdown = r.breakdown;
  renderBreakdown(r.breakdown);
  drawWave(r.waveform);
  const d = $('#danger');
  if (r.danger) { d.textContent = r.danger; d.classList.remove('hidden'); $('#genBtn').classList.add('armed'); }
  else { d.classList.add('hidden'); $('#genBtn').classList.remove('armed'); }
  $('#frameMeta').textContent =
    `${r.breakdown.frameBytes.length} bytes · ${r.breakdown.sampleCount} IQ samples · ${r.breakdown.durationSec}s @ 100 baud OOK`;
}

function renderBreakdown(bd) {
  const wrap = $('#breakdown');
  wrap.innerHTML = '';
  bd.segments.forEach((seg) => {
    const s = el('div', 'seg f-' + seg.field);
    s.appendChild(el('div', 'sl', seg.label));
    const bytes = el('div', 'bytes');
    seg.bytes.forEach((b) => {
      const chip = el('div', 'byte', b.toString(16).padStart(2, '0').toUpperCase());
      chip.onmousemove = (e) => showTip(e, seg, b);
      chip.onmouseleave = hideTip;
      bytes.appendChild(chip);
    });
    if (!seg.bytes.length) bytes.appendChild(el('div', 'byte', '—'));
    s.appendChild(bytes);
    wrap.appendChild(s);
  });
}

function showTip(e, seg, b) {
  const tip = $('#tooltip');
  let sub = (seg.sub || []).map((x) => `${x.name}: <b>${x.value}${x.unit ? ' ' + x.unit : ''}</b>`).join('<br>');
  tip.innerHTML = `<b>${seg.label}</b><br>byte 0x${b.toString(16).padStart(2, '0')}` + (sub ? '<br>' + sub : '');
  tip.classList.remove('hidden');
  tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 250) + 'px';
  tip.style.top = (e.clientY + 14) + 'px';
}
function hideTip() { $('#tooltip').classList.add('hidden'); }

function drawWave(w) {
  const cv = $('#wave'), ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  if (!w || !w.length) return;
  ctx.strokeStyle = '#39c5ff'; ctx.lineWidth = 1.5; ctx.beginPath();
  const pad = 10, h = H - 2 * pad;
  w.forEach((v, i) => {
    const x = (i / (w.length - 1)) * W;
    const y = H - pad - v * h;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = 'rgba(57,197,255,.08)';
  ctx.lineTo(W, H - pad); ctx.lineTo(0, H - pad); ctx.fill();
}

$('#genBtn').onclick = async () => {
  if (!current) return;
  const btn = $('#genBtn'); btn.disabled = true; btn.textContent = '… GENERATING';
  const r = await postJSON('/api/generate', { command: current.command, params });
  btn.disabled = false; btn.textContent = '⚡ GENERATE UPLINK IQ';
  const res = $('#result');
  if (r.ok && r.saved) {
    const url = 'data:application/octet-stream;base64,' + r.downloadB64;
    res.innerHTML = `✓ <b>${r.saved.filename}</b> written — load this into OpenVSA/VSA and uplink.<br>
      <span class="path">${r.saved.path}</span><br>
      <a href="${url}" download="${r.saved.filename}">⬇ download cf32</a>`;
    res.classList.remove('hidden');
  } else {
    res.textContent = 'generate failed: ' + (r.error || '?');
    res.classList.remove('hidden');
  }
};

async function postJSON(url, body) {
  try { return await (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json(); }
  catch (e) { return { ok: false, error: String(e) }; }
}

boot();
