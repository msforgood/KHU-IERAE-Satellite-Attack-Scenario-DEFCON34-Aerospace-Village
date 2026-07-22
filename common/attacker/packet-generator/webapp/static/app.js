// DEMOSAT Command Builder — a booth puzzle. The visitor must assemble every
// element of a valid uplink to match the target dossier; only then does GENERATE
// unlock. STEP 1 is a Scratch-style block composer: you click a subsystem block
// (POWER/ADCS/COMM/OBC) to reveal its command list, click the command you think is
// right to snap a block onto the script, then TYPE the parameter (e.g. torque) into
// the block's value slot. All CCSDS/OOK logic lives in the Python backend; this
// script drives the UI.
"use strict";

let M = null; // mission payload (target, options, commands)
const S = {
  // participant's assembled state
  block: null, // { sub } — which subsystem block sits on the canvas
  valText: {}, // raw text typed into each argument slot (by key)
  command: null,
  cmdDef: null,
  params: {},
  valueConfirmed: false,
  step1Done: false, // participant pressed "완료" → unlocks Step 2 & starts RF magic-writing
  rf: { modulation: null, baud: null, sampleRate: null },
};

// STEP 2 is no longer a manual choice — the attacker's SDR "auto-detects" the RF
// parameters off the intercepted carrier and magically types them in. RFA holds the
// typewriter animation's progress; S.rf is committed one field at a time as it lands.
let RFA = null;
let timerRF = null;
const RF_FIELDS = [
  { key: "modulation", label: "MODULATION", text: (t) => t.modulation, val: (t) => t.modulation,
    desc: "How bits ride the carrier. DEMOSAT uses <b>OOK</b> (On-Off Keying): carrier on = 1, off = 0 — the simplest scheme." },
  { key: "baud", label: "BAUD RATE", text: (t) => t.baud + " bps", val: (t) => t.baud,
    desc: "<b>Symbols per second.</b> The SDR must clock at this exact rate to slice the carrier back into bits." },
  { key: "sampleRate", label: "SAMPLE RATE", text: (t) => t.sampleRate / 1000 + " kSa/s", val: (t) => t.sampleRate,
    desc: "<b>I/Q samples captured per second.</b> High enough to faithfully reconstruct the carrier (Nyquist)." },
];
function rfAutoReset() {
  clearTimeout(timerRF);
  RFA = { started: false, done: false, i: 0, typed: { modulation: "", baud: "", sampleRate: "" } };
  S.rf = { modulation: null, baud: null, sampleRate: null };
}

const $ = (s) => document.querySelector(s);
const el = (t, c, h) => {
  const e = document.createElement(t);
  if (c) e.className = c;
  if (h != null) e.innerHTML = h;
  return e;
};

async function boot() {
  // Wire the acknowledge → BUILD gate FIRST and independently of the mission
  // fetch. A slow or failed /api/mission must never leave the ack checkbox dead
  // (previously boot() awaited the fetch before initPhases(), so any fetch error
  // skipped the wiring and the checkbox couldn't enable the button).
  initPhases();
  try {
    const res = await fetch("/api/mission");
    if (!res.ok) throw new Error("/api/mission HTTP " + res.status);
    M = await res.json();
    renderSteps();
    rebuild();
  } catch (e) {
    console.error("[boot] mission load failed:", e);
    // Make the failure visible instead of a blank builder.
    const msg =
      `⚠ Failed to load mission data — <code>/api/mission</code> (${e && e.message ? e.message : e}).` +
      ` Restart the Command Builder server (Ctrl-C, then <code>python3 app.py</code>) and refresh.`;
    const sl = $("#stepList");
    if (sl) sl.innerHTML = `<div class="dnote">${msg}</div>`;
  }
}

// PHASE A → B gate: must acknowledge the briefing before building.
function initPhases() {
  const chk = $("#ackChk"),
    toBuild = $("#toBuild");
  chk.onchange = () => {
    toBuild.disabled = !chk.checked;
  };
  toBuild.onclick = () => {
    if (toBuild.disabled) return;
    // delegate to the inline phase router (updates the /2 URL); fall back to a
    // plain show/hide if the router isn't present.
    if (window.__gotoPhase) return window.__gotoPhase(2, true);
    $("#briefing").classList.add("hidden");
    $("#builder").classList.remove("hidden");
    window.scrollTo(0, 0);
  };
}

// which CCSDS field each step completes (drives the progressive assembly view)
const FRAME_MAP = [
  { field: "preamble", label: "Preamble · bit sync" },
  // Addressing is fixed (SCID is no longer a puzzle step) → show it pre-filled from
  // the start. `fixed()` yields the SCID bytes so the field renders before a command
  // is chosen; once a command is picked the real 5-byte header from the build replaces it.
  {
    field: "tc_header",
    label: "TC Frame Header · addressing",
    fixed: () => {
      const s = (M && M.target && M.target.scid) || 0;
      return [0x20 | ((s >> 8) & 0x03), s & 0xff];
    },
    anno: () => ``,
  },
  {
    field: "sp_header",
    label: "Space Packet Header · APID",
    anno: () => (S.cmdDef ? `routed → APID ${S.cmdDef.apid}` : "awaiting command (Step 1)"),
  },
  {
    field: "opcode",
    label: "Opcode · command",
    anno: () => (S.cmdDef ? `→ ${S.command}` : "awaiting command (Step 1)"),
  },
  {
    field: "payload",
    label: "Payload · value",
    anno: () => (S.valueConfirmed ? "value confirmed" : "awaiting value (Step 1)"),
  },
  { field: "crc", label: "Frame CRC-16 · integrity", anno: () => "computed over the whole frame" },
];

// ── status of each step (client-side tri-state; server re-checks on generate) ─
function stepStatus() {
  const t = M.target,
    rf = S.rf;
  return {
    1: S.command != null && S.valueConfirmed ? "ok" : "pending",
    2:
      rf.modulation == null || rf.baud == null || rf.sampleRate == null
        ? "pending"
        : rf.modulation === t.modulation && rf.baud === t.baud && rf.sampleRate === t.sampleRate
          ? "ok"
          : "bad",
  };
}
const PILL = { pending: "PENDING", ok: "LOCKED ✓", bad: "MISMATCH ✗" };
const NSTEPS = 2;

// steps unlock in order — RF opens only after the visitor presses "완료" on Step 1
// (which is itself only enabled once the command block is fully composed).
function stepUnlocked() {
  return { 1: true, 2: S.step1Done };
}
// a step counts as "acted on" once it holds a valid selection
function stepComplete() {
  return {
    1: S.command != null && S.valueConfirmed,
    2: S.rf.modulation != null && S.rf.baud != null && S.rf.sampleRate != null,
  };
}
// the step the visitor is currently on = lowest unlocked step not yet complete
function activeStep() {
  const u = stepUnlocked(),
    c = stepComplete();
  for (let n = 1; n <= NSTEPS; n++) if (u[n] && !c[n]) return n;
  return NSTEPS + 1;
}
// one-line recap shown in a collapsed step's header
function stepSummary(n) {
  if (n === 1) {
    if (!S.command) return "";
    const fs = (S.cmdDef && S.cmdDef.fields) || [];
    if (!fs.length) return S.command;
    return `${S.command} ` + fs.map((f) => `--${f.key} ${S.params[f.key]}`).join(" ");
  }
  if (n === 2) {
    const r = S.rf;
    return r.modulation == null ? "" : `${r.modulation} · ${r.baud}bps · ${r.sampleRate / 1000}kSa/s`;
  }
  return "";
}
// per-step manual open/close override (undefined = follow the auto default)
const collapseOverride = {};

// ── render the step cards ───────────────────────────────────────────────────
const STEP_DEFS = [
  [1, "COMPOSE COMMAND", bodyCompose],
  [2, "RF CONFIG", bodyRF],
];
function renderSteps() {
  const wrap = $("#stepList");
  wrap.innerHTML = "";
  const u = stepUnlocked(),
    done = stepComplete(),
    active = activeStep();
  STEP_DEFS.forEach(([n, title, fn]) => {
    // Auto-collapse a completed step once you've moved past it; a manual click wins.
    // Never collapse the compose step (1) — it re-renders on every keystroke, so folding
    // it mid-typing would hide the block — nor the RF step (2), which auto-fills and has
    // nothing to hide.
    let collapsed = u[n] && done[n] && n !== active && n !== 1 && n !== 2;
    if (n !== 2 && collapseOverride[n] !== undefined) collapsed = collapseOverride[n];
    wrap.appendChild(stepCard(n, title, fn, u[n], collapsed));
  });
  refreshPills();
}
function stepCard(n, title, bodyFn, unlocked, collapsed) {
  const card = el("div", "step" + (unlocked ? "" : " locked") + (collapsed ? " collapsed" : ""));
  card.dataset.step = n;
  card.innerHTML = `<div class="shead"><span class="snum">${n}</span>
      <span class="stitle">${title}</span>
      <span class="ssum">${collapsed ? stepSummary(n) : ""}</span>
      <span class="pill"></span>
      ${unlocked && n !== 2 ? `<span class="chev">${collapsed ? "▸" : "▾"}</span>` : ""}</div>
    <div class="sbody"></div>`;
  const body = card.querySelector(".sbody");
  if (unlocked) bodyFn(body);
  else body.innerHTML = `<div class="lockmsg">🔒 Finish composing the command first</div>`;
  // clicking the header toggles this step open/closed (unlocked, collapsible steps only —
  // step 2 has no chevron and never folds).
  if (unlocked && n !== 2) {
    const head = card.querySelector(".shead");
    head.onclick = () => {
      collapseOverride[n] = !card.classList.contains("collapsed");
      renderSteps();
    };
  }
  return card;
}
function refreshPills() {
  const st = stepStatus();
  document.querySelectorAll(".step").forEach((c) => {
    const n = +c.dataset.step,
      s = st[n];
    const pill = c.querySelector(".pill");
    if (c.classList.contains("locked")) {
      pill.className = "pill locked";
      pill.textContent = "LOCKED 🔒";
      return;
    }
    pill.className = "pill " + s;
    pill.textContent = PILL[s];
    c.classList.toggle("done", s === "ok");
    c.classList.toggle("mismatch", s === "bad");
  });
  const ok = Object.values(st).filter((x) => x === "ok").length;
  $("#progText").textContent = `${ok} / ${NSTEPS}`;
  $("#progFill").style.width = (ok / NSTEPS) * 100 + "%";
  const btn = $("#genBtn");
  // The IQ generate button only unclicks for the CORRECT attack: the right command
  // driven past its safe envelope. A merely-complete-but-harmless command stays locked.
  const armed = ok === NSTEPS && attackArmed();
  if (armed) {
    btn.disabled = false;
    btn.className = "genbtn armed";
    btn.textContent = "⚡ GENERATE UPLINK IQ";
    $("#progHint").textContent = "Attack armed — the command will disrupt the satellite.";
  } else {
    btn.disabled = true;
    btn.className = "genbtn locked";
    btn.textContent =
      ok === NSTEPS ? "🔒 UPLINK LOCKED — COMMAND HAS NO EFFECT" : `🔒 UPLINK LOCKED — ${ok}/${NSTEPS} CONFIGURED`;
    $("#progHint").textContent = ok === NSTEPS ? "This command won't disrupt the satellite — try another." : "";
  }
}

// the attack is only "correct" when the chosen command has a safety-bounded field and
// the typed value is pushed beyond that bound (the RED zone) — i.e. an abusive uplink.
function attackArmed() {
  const c = S.cmdDef;
  if (!c) return false;
  const f = (c.fields || []).find((x) => x.safeAbsMax != null);
  if (!f) return false;
  const v = S.params[f.key];
  return typeof v === "number" && Math.abs(v) > f.safeAbsMax;
}

// ── STEP 1 — Scratch-style command composer (palette + typed slots) ─────────
function bodyCompose(body) {
  body.innerHTML = "";
  const wrap = el("div", "composer");

  const palette = el("div", "palette");
  palette.appendChild(el("div", "palcap", "SUBSYSTEM"));
  M.subsystems.forEach((sub) => {
    const b = el(
      "div",
      "palblock sub-" + sub + (S.block && S.block.sub === sub ? " active" : ""),
      `<span class="pbgrip">⣿</span>${sub} command`,
    );
    b.dataset.sub = sub;
    b.onclick = () => placeBlock(sub);
    palette.appendChild(b);
  });
  palette.appendChild(el("div", "palhint", "① Click a subsystem ▶ ② pick its command ▶ ③ type the value."));

  const script = el("div", "script");
  script.appendChild(el("div", "scriptcap", "SCRIPT"));
  script.appendChild(el("div", "hat", "⚡ SEND UPLINK"));
  const zone = el("div", "dropzone");
  zone.id = "dropzone";
  script.appendChild(zone);

  wrap.appendChild(palette);
  wrap.appendChild(script);
  body.appendChild(wrap);
  // Pass the freshly-built zone directly: bodyCompose runs while the step card is
  // still DETACHED from the document, so a document.querySelector("#dropzone") here
  // would find nothing and the block would never render.
  renderBlock(zone);

  // "완료" gate: only once the command block is fully composed does this button arm,
  // and pressing it is what unlocks Step 2 and kicks off the RF magic-writing.
  const ready = S.command != null && S.valueConfirmed;
  const done = S.step1Done;
  const foot = el("div", "s1foot");
  const btn = el(
    "button",
    "s1done" + (done ? " committed" : ready ? " ready" : " disabled"),
    done ? "✓ COMMAND LOADED" : ready ? "✓ LOAD COMMAND" : "Compose the command first",
  );
  btn.disabled = !ready || done;
  if (ready && !done) btn.onclick = confirmStep1;
  foot.appendChild(btn);
  body.appendChild(foot);
}

// press "완료" → lock in Step 1 and start Step 2's RF auto-detect from scratch
function confirmStep1() {
  if (!(S.command != null && S.valueConfirmed) || S.step1Done) return;
  S.step1Done = true;
  rfAutoReset(); // guarantees the magic-writing (re)plays each time 완료 is pressed
  renderSteps();
  rebuild();
  // Scroll Step 2 into view so the "SDR" auto-typing is visible the moment it starts,
  // instead of playing off-screen below the fold. rAF waits for the fresh DOM to lay out.
  requestAnimationFrame(function () {
    const s2 = document.querySelector('.step[data-step="2"]');
    if (s2) s2.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

function placeBlock(sub) {
  if (!S.block || S.block.sub !== sub) {
    S.block = { sub };
    S.command = null;
    S.cmdDef = null;
    S.valText = {};
    S.params = {};
    S.valueConfirmed = false;
    S.step1Done = false;
    rfAutoReset(); // new command line → SDR re-detects RF from scratch
  }
  renderSteps();
  rebuild();
}
function clearBlock() {
  S.block = null;
  S.command = null;
  S.cmdDef = null;
  S.valText = {};
  S.params = {};
  S.valueConfirmed = false;
  S.step1Done = false;
  rfAutoReset();
  renderSteps();
  rebuild();
}
// snap a command onto the script by clicking it (no typing the command name)
function pickCommand(name) {
  if (!S.block) return;
  const sub = S.block.sub;
  const c = M.commands.find((x) => x.subsystem === sub && x.command === name);
  if (!c) return;
  S.command = c.command;
  S.cmdDef = c;
  S.valText = {};
  S.params = {};
  S.valueConfirmed = false;
  S.step1Done = false;
  rfAutoReset();
  evalValue(); // no-payload commands (e.g. obc_reboot) confirm on selection
  renderSteps();
  rebuild();
}
// go back to the command list to pick a different one (keeps the subsystem block)
function changeCommand() {
  S.command = null;
  S.cmdDef = null;
  S.valText = {};
  S.params = {};
  S.valueConfirmed = false;
  S.step1Done = false;
  rfAutoReset();
  renderSteps();
  rebuild();
}

// what each subsystem acronym stands for — shown next to "choose a command" so a
// visitor who's never seen satellite jargon knows what they're aiming the uplink at.
const SUB_FULL = {
  ADCS: "Attitude Determination & Control — the satellite's orientation / reaction wheels",
  COMM: "Communications — the radio, antenna gimbal & transponder",
  OBC: "On-Board Computer — the flight computer that runs everything",
};

// render the script from state: a subsystem block shows its command list until a
// command is picked; once picked it becomes a scratch block with typed value slots.
function renderBlock(zone) {
  zone = zone || document.querySelector("#dropzone");
  if (!zone) return;
  if (!S.block) {
    zone.className = "dropzone empty";
    zone.innerHTML = '<div class="dzhint">▶ click a subsystem block to begin</div>';
    return;
  }
  zone.className = "dropzone";
  const sub = S.block.sub;

  // No command chosen yet → present the subsystem's command list to click.
  if (!S.command) {
    const cmds = M.commands.filter((c) => c.subsystem === sub);
    zone.innerHTML = `
      <div class="cblock sub-${sub}">
        <div class="cbrow">
          <span class="cbpicktag">${sub}${SUB_FULL[sub] ? `<span class="cbsubfull">${SUB_FULL[sub]}</span>` : ""}</span>
          <button class="cbx" title="remove block">✕</button>
        </div>
        <div class="cbpicklist"></div>
        <div class="cbmsg">Click the command you believe matches the attack goal.</div>
      </div>`;
    const list = zone.querySelector(".cbpicklist");
    cmds.forEach((c) => {
      const item = el("button", "cmdpick", `<code>${c.command}</code><span class="cmddesc">${c.effect}</span>`);
      item.onclick = () => pickCommand(c.command);
      list.appendChild(item);
    });
    zone.querySelector(".cbx").onclick = clearBlock;
    return;
  }

  // Command chosen → the scratch block, with the value slot(s) to type into.
  zone.innerHTML = `
    <div class="cblock sub-${sub}">
      <div class="cbrow">
        <span class="cbkw">send</span>
        <span class="cbcmd">${S.command}</span>
        <button class="cbchg" title="pick a different command">↺ change</button>
        <button class="cbx" title="remove block">✕</button>
      </div>
      <div class="cbargs"></div>
      <div class="cbmsg"></div>
    </div>`;
  zone.querySelector(".cbx").onclick = clearBlock;
  zone.querySelector(".cbchg").onclick = changeCommand;
  renderArgs(zone);
}

// argument slots for the recognised command (values are TYPED, not clicked).
// Rendered purely from S so it survives the re-render on every keystroke.
function renderArgs(scope) {
  scope = scope || document;
  const box = scope.querySelector(".cbargs");
  const msg = scope.querySelector(".cbmsg");
  if (!box) return;
  box.innerHTML = "";
  if (!S.command) return; // command list is shown by renderBlock in this state
  if (msg) msg.textContent = "";
  const c = S.cmdDef;
  if (!c.fields || !c.fields.length) {
    box.appendChild(el("div", "cbnopay", "↳ no payload — this command carries no value"));
    box.appendChild(effectBox(c));
    return;
  }
  c.fields.forEach((f) => box.appendChild(argRow(f)));
  box.appendChild(effectBox(c));
  box.querySelectorAll(".cbval").forEach((inp) => inp.addEventListener("input", onVal));
}

// parse one typed slot → { val, ok, bad (invalid & non-empty), over (past safe) }
function parseVal(f, raw) {
  const t = String(raw == null ? "" : raw).trim();
  if (f.type === "toggle") {
    if (/^(on|1|true|yes)$/i.test(t)) return { val: true, ok: true };
    if (/^(off|0|false|no)$/i.test(t)) return { val: false, ok: true };
    return { val: null, ok: false, bad: t.length > 0 };
  }
  if (t === "" || isNaN(Number(t))) return { val: null, ok: false, bad: t.length > 0 };
  const v = Number(t);
  return { val: v, ok: true, over: f.safeAbsMax != null && Math.abs(v) > f.safeAbsMax };
}

function argRow(f) {
  const row = el("div", "cbarg");
  const raw = S.valText[f.key] != null ? S.valText[f.key] : "";
  const p = parseVal(f, raw);
  // a valid-but-over-safe number is the attack goal, not an error → stays "good";
  // the RED zone tag carries the "armed" signal instead.
  const cls = p.ok ? "good" : p.bad ? "bad" : "";
  if (f.type === "toggle") {
    row.innerHTML = `<span class="cbflag">--${f.key}</span>
       <input class="cbval ${cls}" data-key="${f.key}" data-type="toggle" spellcheck="false"
              autocomplete="off" placeholder="on / off" value="${escapeAttr(raw)}">`;
  } else {
    let zone = "";
    if (f.safeAbsMax != null && p.ok)
      zone = p.over ? '<span class="cbzone danger">⚠ RED</span>' : '<span class="cbzone safe">✓ safe</span>';
    // ATTACK GOAL hint — appears to the RIGHT of the unit only while the value input
    // is focused (see .cbarg:focus-within .cbgoal in the CSS). Shown only for the
    // safety-bounded field, since that's the one the visitor abuses.
    const goalHint =
      f.safeAbsMax != null
        ? `<span class="cbgoal">🎯 <b>ATTACK GOAL</b> — a <b>safe</b> ${f.key} is within <b>±${f.safeAbsMax}${f.unit || ""}</b>. Abuse it: type a value in the <b>RED</b> zone (e.g. <b>${f.default}${f.unit || ""}</b>).</span>`
        : "";
    row.innerHTML = `<span class="cbflag">--${f.key}</span>
       <input class="cbval ${cls}" data-key="${f.key}" data-type="num" inputmode="numeric" spellcheck="false"
              autocomplete="off" placeholder="type ${f.min}…${f.max}" value="${escapeAttr(raw)}">
       <span class="cbunit">${f.unit || ""}</span>${zone}${goalHint}`;
  }
  return row;
}

function onVal(e) {
  const inp = e.target,
    key = inp.dataset.key;
  const raw = inp.value;
  S.valText[key] = raw;
  const f = S.cmdDef.fields.find((x) => x.key === key);
  S.params[key] = parseVal(f, raw).val;
  evalValue();
  withFocusPreserved(renderSteps);
  rebuild();
}

function evalValue() {
  if (!S.cmdDef) {
    S.valueConfirmed = false;
    return;
  }
  const fs = S.cmdDef.fields || [];
  if (!fs.length) {
    S.valueConfirmed = true;
    return;
  }
  S.valueConfirmed = fs.every((f) => S.params[f.key] !== null && S.params[f.key] !== undefined);
}

function effectBox(c) {
  return el("div", "cbeffect", `<b>PREDICTED EFFECT</b> — ${c.effect}`);
}
function escapeAttr(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}
// re-render the step tree while keeping caret in whichever slot is being typed
function withFocusPreserved(fn) {
  const a = document.activeElement;
  let sel = null,
    pos = null;
  if (a && a.classList) {
    if (a.classList.contains("cbval")) sel = `.cbval[data-key="${a.dataset.key}"]`;
    if (sel) {
      try {
        pos = a.selectionStart;
      } catch (e) {
        /* ignore */
      }
    }
  }
  fn();
  if (sel) {
    const n = document.querySelector(sel);
    if (n) {
      n.focus();
      try {
        if (pos != null) n.setSelectionRange(pos, pos);
      } catch (e) {
        /* ignore */
      }
    }
  }
}

// ── STEP 2 — RF config, auto-typed by the "SDR" (no participant input) ───────
function bodyRF(body) {
  if (!RFA) rfAutoReset();
  const t = M.target;
  // Show the auto-detect intro only while sniffing; once locked, drop the banner.
  if (!RFA.done) {
    body.appendChild(
      el("div", "rfauto-intro", `🔍 <b>AUTO-DETECT</b> — sniffing the intercepted carrier… RF parameters lock in automatically.`),
    );
  }
  const active = RFA.started && !RFA.done ? RFA.i : -1;
  RF_FIELDS.forEach((f, i) => {
    const row = el("div", "rfrow");
    row.appendChild(el("div", "rflabel", f.label));
    const typed = RFA.typed[f.key];
    const complete = S.rf[f.key] != null;
    const cell = el(
      "div",
      "rfauto" + (complete ? " done" : ""),
      `<span class="rfval">${escapeAttr(typed)}</span>${i === active ? '<span class="rfcaret">▌</span>' : ""}${complete ? '<span class="rfok">✓</span>' : ""}`,
    );
    row.appendChild(cell);
    row.appendChild(el("div", "rfdesc", f.desc)); // explanation to the RIGHT of the value
    body.appendChild(row);
  });
  if (!RFA.started) startRFAuto();
}

// the typewriter: type each field's value char-by-char, committing S.rf[key] as it lands
function startRFAuto() {
  RFA.started = true;
  const t = M.target;
  const seq = RF_FIELDS.map((f) => ({ key: f.key, text: f.text(t), val: f.val(t) }));
  let fi = 0,
    ci = 0;
  function step() {
    if (fi >= seq.length) {
      RFA.done = true;
      withFocusPreserved(renderSteps); // full re-render: pills, progress, GENERATE gate
      rebuild();
      return;
    }
    RFA.i = fi;
    const cur = seq[fi];
    if (ci < cur.text.length) {
      ci++;
      RFA.typed[cur.key] = cur.text.slice(0, ci);
      renderRFBody();
      timerRF = setTimeout(step, 55);
    } else {
      S.rf[cur.key] = cur.val; // field fully typed → commit the real value
      fi++;
      ci = 0;
      refreshPills(); // light up progress as each field locks
      renderRFBody();
      timerRF = setTimeout(step, 320);
    }
  }
  timerRF = setTimeout(step, 420);
}
// re-render only Step 2's body from RFA/S state (survives the detached-card render path)
function renderRFBody() {
  const b = document.querySelector('.step[data-step="2"] .sbody');
  if (!b) return;
  b.innerHTML = "";
  bodyRF(b);
}
// ── frame preview (server build) ────────────────────────────────────────────
let timer = null;
// The uplink signal is not drawn live: it stays blank until GENERATE is pressed,
// then sweeps in left→right. lastWave keeps the most recent server waveform so the
// generate handler can animate it without another round-trip.
let lastWave = [];
let iqRevealed = false;
function rebuild() {
  clearTimeout(timer);
  timer = setTimeout(build, 100);
}
async function build() {
  const st = stepStatus();
  let bd = null,
    wf = [];
  if (S.command) {
    const r = await postJSON("/api/build", payload());
    if (r.ok) {
      bd = r.breakdown;
      wf = r.waveform || [];
    }
  }
  renderFrame(bd, st);
  // The waveform is the physical layer — draw it as soon as RF is fully chosen,
  // even if the values are wrong (a wrong signal still exists on the air; it just
  // won't decode). Only the "not yet configured" case hides it.
  const rfSet = S.rf.modulation != null && S.rf.baud != null && S.rf.sampleRate != null;
  const hint = $("#waveHint");
  lastWave = rfSet && wf.length ? wf : [];
  if (rfSet && wf.length) {
    // Hold the canvas blank until GENERATE reveals it (then keep it drawn).
    if (iqRevealed) {
      drawWave(wf);
      hint.classList.add("hidden");
    } else {
      drawWave([]);
      hint.textContent =
        st[2] === "ok"
          ? "▶ Press GENERATE to render the uplink signal."
          : "⚠ RF mismatch: the satellite receiver won't decode this command.";
      hint.classList.remove("hidden");
    }
    $("#frameMeta").textContent = bd
      ? `${bd.frameBytes.length} bytes · ${bd.sampleCount} IQ samples · ${bd.durationSec}s @ ${S.rf.baud} baud ${S.rf.modulation}`
      : "";
  } else {
    drawWave([]);
    hint.textContent = "RF auto-detects once the command is composed (Step 2).";
    hint.classList.remove("hidden");
    $("#frameMeta").textContent = "";
  }
}

// Progressive CCSDS assembly: each field reveals as the step that defines it completes.
function renderFrame(bd, st) {
  const byField = {};
  if (bd) bd.segments.forEach((s) => (byField[s.field] = s));
  // The packet reflects what you actually send — a wrong-but-selected value
  // still fills its field (GENERATE stays gated on matching the target).
  const cond = {
    preamble: true,
    tc_header: true, // fixed addressing — filled from the start
    sp_header: S.command != null,
    opcode: S.command != null,
    payload: S.valueConfirmed,
    crc: S.command != null && S.valueConfirmed,
  };
  let filled = 0,
    total = 0;
  const wrap = $("#breakdown");
  wrap.innerHTML = "";
  FRAME_MAP.forEach((m) => {
    const seg = byField[m.field];
    const isPre = m.field === "preamble";
    const canFill = cond[m.field] && (isPre || !!seg || !!m.fixed);
    if (!isPre) {
      total++;
      if (canFill) filled++;
    }
    const div = el("div", "seg f-" + m.field + (canFill ? " filled" : " pending"));
    div.appendChild(el("div", "sl", m.label));
    const bytes = el("div", "bytes");
    if (canFill) {
      const bs = seg ? seg.bytes : m.fixed ? m.fixed() : [0xaa, 0xaa];
      (bs.length ? bs : [null]).forEach((b) => {
        const chip = el("div", "byte", b == null ? "—" : b.toString(16).padStart(2, "0").toUpperCase());
        if (b != null) {
          chip.onmousemove = (e) => showTip(e, seg || { label: m.label }, b);
          chip.onmouseleave = hideTip;
        }
        bytes.appendChild(chip);
      });
    } else {
      for (let i = 0; i < 2; i++) bytes.appendChild(el("div", "byte ph", "··"));
    }
    div.appendChild(bytes);
    if (m.anno) div.appendChild(el("div", "anno", m.anno()));
    wrap.appendChild(div);
  });
  $("#frameProg").textContent = `${filled} / ${total} fields`;
}
function showTip(e, seg, b) {
  const tip = $("#tooltip");
  const sub = (seg.sub || []).map((x) => `${x.name}: <b>${x.value}${x.unit ? " " + x.unit : ""}</b>`).join("<br>");
  tip.innerHTML = `<b>${seg.label}</b><br>byte 0x${b.toString(16).padStart(2, "0")}` + (sub ? "<br>" + sub : "");
  tip.classList.remove("hidden");
  tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 250) + "px";
  tip.style.top = e.clientY + 14 + "px";
}
function hideTip() {
  $("#tooltip").classList.add("hidden");
}
function drawWave(w) {
  const cv = $("#wave"),
    ctx = cv.getContext("2d"),
    W = cv.width,
    H = cv.height;
  ctx.clearRect(0, 0, W, H);
  if (!w || !w.length) return;
  ctx.strokeStyle = "#39c5ff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const pad = 10,
    h = H - 2 * pad;
  w.forEach((v, i) => {
    const x = (i / (w.length - 1)) * W,
      y = H - pad - v * h;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = "rgba(57,197,255,.08)";
  ctx.lineTo(W, H - pad);
  ctx.lineTo(0, H - pad);
  ctx.fill();
}
// Draw only the first `k` samples, but keep each sample's x mapped over the FULL
// width — so the trace grows in from the left, giving the left→right sweep.
function drawWaveUpTo(w, k) {
  const cv = $("#wave"),
    ctx = cv.getContext("2d"),
    W = cv.width,
    H = cv.height;
  ctx.clearRect(0, 0, W, H);
  if (!w || w.length < 2 || k < 1) return;
  const n = Math.min(k, w.length),
    pad = 10,
    h = H - 2 * pad;
  ctx.strokeStyle = "#39c5ff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = (i / (w.length - 1)) * W,
      y = H - pad - w[i] * h;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke();
  ctx.fillStyle = "rgba(57,197,255,.08)";
  ctx.lineTo(((n - 1) / (w.length - 1)) * W, H - pad);
  ctx.lineTo(0, H - pad);
  ctx.fill();
}
let waveAnim = null;
function animateWave(w, done) {
  cancelAnimationFrame(waveAnim);
  if (!w || w.length < 2) {
    drawWave(w || []);
    done && done();
    return;
  }
  const DUR = 900;
  let start = null;
  function frame(t) {
    if (start == null) start = t;
    const p = Math.min(1, (t - start) / DUR);
    drawWaveUpTo(w, Math.max(1, Math.floor(p * w.length)));
    if (p < 1) {
      waveAnim = requestAnimationFrame(frame);
    } else {
      drawWave(w);
      done && done();
    }
  }
  waveAnim = requestAnimationFrame(frame);
}

// ── generate (server re-validates all steps) ────────────────────────────────
$("#genBtn").onclick = async () => {
  const btn = $("#genBtn");
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = "… GENERATING";
  const r = await postJSON("/api/generate", payload());
  refreshPills();
  const res = $("#result");
  res.classList.add("hidden");
  if (r.ok && r.saved) {
    // Reveal the signal first: sweep the uplink waveform in left→right, and only
    // once it finishes surface the cf32 "download" (which is really the phase-3
    // click-through — the server has already fired the attack at the ground station).
    iqRevealed = true;
    // refreshPills() re-armed the button; keep it locked while the signal renders.
    btn.disabled = true;
    btn.className = "genbtn locked";
    btn.textContent = "… RENDERING SIGNAL";
    $("#waveHint").classList.add("hidden");
    animateWave(lastWave, () => {
      res.innerHTML = `✓ <b>${r.saved.filename}</b> generated — open it in the targeting console to uplink.<br>
        <a href="#" class="cf32go">⬇ ${r.saved.filename} → open targeting console</a>`;
      res.classList.remove("hidden");
      btn.textContent = "✓ UPLINK IQ GENERATED";
    });
  } else {
    res.textContent = "generate blocked: " + (r.error || "?");
    res.classList.remove("hidden");
  }
};

function payload() {
  return { command: S.command, params: S.params, valueConfirmed: S.valueConfirmed, rf: S.rf };
}
async function postJSON(url, body) {
  try {
    return await (
      await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    ).json();
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

boot();
