// satellite-state.js — Node port of OpenVSA's src/lib/satellite-state.js.
//
// Differences from the original (browser/Electron) version:
//   - CommonJS instead of ES modules.
//   - loadFromFiles() reads hardware.json / hardware-effects.json / panel.json
//     from disk (fs) instead of window.electronAPI IPC.
//   - Adds PAYLOAD_HANDLERS.adcs_torque_magnitude for the ★ main scenario:
//     parses the int16 reaction-wheel torque, surfaces it as adcs.torque, and
//     scales the battery drain by command magnitude.
//
// The attack physics (tumbling → sun-track loss → cosineDropoff power collapse
// → battery drain) are driven by hardware-effects.json, reusing adcs_target's
// affectedHardware block via the tumbling flag — identical to the original.

const fs = require("fs");

const PAYLOAD_HANDLERS = {
  subsystem_bitmask: (payload, immediate) => {
    const mask = parseInt(payload[0], 16);
    const stab = !!(mask & 0x01);
    const trans = !!(mask & 0x02);
    immediate.set["adcs.stabilization"] = stab;
    if (stab) delete immediate.flag;
    if (trans) {
      immediate.set["transponder.state"] = true;
      delete immediate.set["comm.status"];
    }
  },
  transponder_toggle: (payload, immediate) => {
    const on = parseInt(payload[0], 16) === 1;
    immediate.set["transponder.state"] = on;
    immediate.set["comm.status"] = on ? "CONNECTED" : "NO DOWNLINK";
  },
  adcs_attitude: (payload, immediate, state, moveTargets, cascading) => {
    if (payload.length < 4) return;
    const b0 = parseInt(payload[0], 16), b1 = parseInt(payload[1], 16);
    const b2 = parseInt(payload[2], 16), b3 = parseInt(payload[3], 16);
    let yaw = (b0 << 8) | b1; if (yaw > 32767) yaw -= 65536;
    let pitch = (b2 << 8) | b3; if (pitch > 32767) pitch -= 65536;
    const magnitude = (Math.abs(yaw) + Math.abs(pitch)) / 2;
    const driftRate = Math.min(20, Math.max(2, magnitude / 12));
    state["_commLossProb"] = Math.min(0.2, Math.max(0.02, magnitude / 1000));
    if (cascading) {
      cascading["adcs.roll"] = { drift: driftRate };
      cascading["adcs.pitch"] = { drift: driftRate };
      cascading["adcs.yaw"] = { drift: driftRate };
    }
  },
  // ★ main scenario: reaction-wheel torque (int16 mNm, big-endian)
  adcs_torque_magnitude: (payload, immediate, state, moveTargets, cascading) => {
    let torque = 0;
    if (payload && payload.length >= 2) {
      const b0 = parseInt(payload[0], 16), b1 = parseInt(payload[1], 16);
      torque = (b0 << 8) | b1; if (torque > 32767) torque -= 65536;
    }
    immediate.set["adcs.torque"] = torque;
    // larger torque → faster spin drift, faster battery drain, faster sun-track loss
    const mag = Math.abs(torque);
    const driftRate = Math.min(20, Math.max(4, mag / 60));
    const drainRate = -Math.min(0.6, Math.max(0.25, mag / 2000));
    const swingSpeed = Math.min(6, Math.max(2, mag / 200));
    if (cascading) {
      cascading["adcs.roll"] = { drift: driftRate };
      cascading["adcs.pitch"] = { drift: driftRate };
      cascading["adcs.yaw"] = { drift: driftRate };
      cascading["battery.level"] = { rate: drainRate, min: 0 };
    }
    if (moveTargets) {
      // decisively swing the panel off the sun (optimal 90° → 0°) so
      // cosineDropoff collapses power — the visible "energy supply" failure.
      moveTargets["solar_panel.angle"] = { target: 0, speed: swingSpeed };
    }
  },
};

function createSatelliteState() {
  let hwConfig = {};
  let effects = {};
  let panelConfig = {};
  let state = {};
  let flags = {};
  let cascading = {};
  let moveTargets = {};
  let recoveryTimers = [];
  let listeners = [];
  let tickTimer = null;

  function getState() { return { ...state, _flags: { ...flags } }; }
  function getPanelConfig() { return panelConfig; }
  function onChange(fn) { listeners.push(fn); }
  function notify() { const s = getState(); listeners.forEach(fn => fn(s)); }

  function resolveHW(value) {
    if (typeof value !== "string" || !value.startsWith("HW:")) return value;
    const path = value.slice(3).split(".");
    let obj = hwConfig.hardware;
    for (const key of path) {
      if (!obj) return undefined;
      obj = obj[key] ?? obj.specs?.[key] ?? obj.defaults?.[key];
    }
    return obj;
  }
  function getSpec(component, specName) { return hwConfig.hardware?.[component]?.specs?.[specName]; }

  function buildDefaults() {
    const defaults = {};
    const hw = hwConfig.hardware || {};
    for (const [component, config] of Object.entries(hw)) {
      for (const [prop, val] of Object.entries(config.defaults || {})) {
        defaults[`${component}.${prop}`] = val;
      }
    }
    return defaults;
  }

  function loadFromFiles({ hardware, effects: fxPath, panel }) {
    hwConfig = JSON.parse(fs.readFileSync(hardware, "utf8"));
    effects = JSON.parse(fs.readFileSync(fxPath, "utf8"));
    panelConfig = JSON.parse(fs.readFileSync(panel, "utf8"));
    reset();
  }

  function reset() {
    flags = {}; cascading = {}; moveTargets = {};
    recoveryTimers.forEach(t => clearTimeout(t));
    recoveryTimers = [];
    state = buildDefaults();
    notify();
  }

  function cosineDropoff(angleSource, maxPower, optimalAngle) {
    const angle = state[angleSource] ?? optimalAngle;
    const diff = Math.abs(optimalAngle - (angle % 180));
    return Math.max(0, maxPower * Math.cos(diff * Math.PI / 180));
  }

  function applyImmediate(immediate, payload) {
    if (!immediate) return;
    if (immediate.payloadLogic && PAYLOAD_HANDLERS[immediate.payloadLogic]) {
      PAYLOAD_HANDLERS[immediate.payloadLogic](payload, immediate);
    }
    if (immediate.set) for (const [k, v] of Object.entries(immediate.set)) state[k] = v;
    if (immediate.flag) {
      const list = Array.isArray(immediate.flag) ? immediate.flag : [immediate.flag];
      for (const f of list) flags[f] = true;
    }
  }

  function applyMovement(movement, payload) {
    if (!movement) return;
    const speed = resolveHW(movement.speed) ?? 3;
    if (movement.key) {
      const offset = movement.defaultOffset ?? 180;
      const current = state[movement.key] ?? 0;
      moveTargets[movement.key] = { target: (current + offset) % 360, speed };
    }
    if (movement.keys) {
      for (const [key, target] of Object.entries(movement.keys)) {
        if (typeof target === "string" && target.startsWith("OFFSET:PAYLOAD:")) {
          const idx = parseInt(target.split(":")[2]);
          const offset = parseInt(payload[idx], 16) || 30;
          const current = state[key] ?? 0;
          moveTargets[key] = { target: key.includes("el")
            ? Math.max(-90, Math.min(90, current + offset)) : (current + offset) % 360, speed };
        } else {
          moveTargets[key] = { target, speed };
        }
      }
    }
  }

  function applyCascading(casc) {
    if (!casc) return;
    const resolved = {};
    for (const [key, effect] of Object.entries(casc)) {
      resolved[key] = { ...effect };
      if (typeof effect.max === "string") resolved[key].max = resolveHW(effect.max);
    }
    Object.assign(cascading, resolved);
  }

  function applyCommand(command, payload, opts = {}) {
    const effect = effects[command];
    if (!effect) { console.warn("[sat-state] No effect defined for command:", command); return; }
    let attack = effect.onAttack;
    if (!attack) { if (effect.type === "diagnostic") { notify(); return effect; } return; }

    if (effect.prerequisite) {
      const { key, value, rejectMessage } = effect.prerequisite;
      if (state[key] !== value) {
        console.warn(`[sat-state] ${rejectMessage}`);
        return { ...effect, _rejected: true, _rejectMessage: rejectMessage };
      }
    }

    const immediate = attack.immediate
      ? { ...attack.immediate, set: { ...(attack.immediate.set || {}) } } : null;

    if (attack.payloadLogic && PAYLOAD_HANDLERS[attack.payloadLogic]) {
      const attackCascading = attack.cascading ? { ...attack.cascading } : {};
      PAYLOAD_HANDLERS[attack.payloadLogic](payload, immediate || { set: {} }, state, moveTargets, attackCascading);
      attack = { ...attack, cascading: attackCascading };
    }

    if (opts.immediate) {
      applyImmediate(immediate, payload);
      applyCascading(attack.cascading);
      notify();
      return { ...effect, _baseDelay: 0 };
    }

    const baseDelay = opts.baseDelay ?? (5000 + Math.random() * 3000);
    const immTimer = setTimeout(() => {
      applyImmediate(immediate, payload);
      applyMovement(attack.movement, payload);
      applyCascading(attack.cascading);
      if (attack.commEffect) {
        const ct = setTimeout(() => { state["comm.status"] = attack.commEffect.status; notify(); },
          (attack.commEffect.delay || 0) * 1000);
        recoveryTimers.push(ct);
      }
      if (attack.delayed) {
        for (const d of attack.delayed) {
          const dt = setTimeout(() => {
            if (d.set) for (const [k, v] of Object.entries(d.set)) state[k] = v;
            if (d.flag) { const l = Array.isArray(d.flag) ? d.flag : [d.flag]; for (const f of l) flags[f] = true; }
            notify();
          }, d.delay * 1000);
          recoveryTimers.push(dt);
        }
      }
      notify();
    }, baseDelay);
    recoveryTimers.push(immTimer);

    if (attack.recovery) {
      const recoveryAfter = resolveHW(attack.recovery.after) ?? 20;
      const rt = setTimeout(() => {
        if (attack.recovery.set) for (const [k, v] of Object.entries(attack.recovery.set)) state[k] = v;
        notify();
      }, baseDelay + recoveryAfter * 1000);
      recoveryTimers.push(rt);
    }

    const result = { ...effect };
    if (attack.recovery) result._resolvedRecoveryTime = resolveHW(attack.recovery.after) ?? 20;
    result._baseDelay = baseDelay;
    return result;
  }

  function tick() {
    const idle = effects._idle;
    const beamwidth = getSpec("antenna", "beamwidth") ?? 25;
    const maxPower = getSpec("solar_panel", "maxPower") ?? 4.2;
    const optimalAngle = getSpec("solar_panel", "optimalAngle") ?? 90;
    const maxTemp = getSpec("obc", "maxTemp") ?? 85;

    const underAttack = flags.solarAttacked || flags.tumbling || flags.bricked || flags.antennaAttacked
      || state["adcs.stabilization"] === false;
    if (!underAttack && idle) {
      for (const [key, rule] of Object.entries(idle)) {
        const center = typeof rule.center === "string" ? (resolveHW(rule.center) ?? 0) : (rule.center ?? 0);
        if (rule.type === "sine") state[key] = center + Math.sin(Date.now() / rule.period) * rule.amplitude;
        else if (rule.type === "jitter") state[key] = center + (Math.random() - 0.5) * rule.amplitude * 2;
        else if (rule.type === "drift")
          state[key] = Math.min(rule.max ?? 100, Math.max(rule.min ?? 0,
            (state[key] ?? center) + (Math.random() - 0.48) * rule.rate));
      }
    }

    for (const [key, mv] of Object.entries(moveTargets)) {
      const current = state[key] ?? 0;
      const diff = mv.target - current;
      if (Math.abs(diff) < mv.speed) { state[key] = mv.target; delete moveTargets[key]; }
      else state[key] = current + Math.sign(diff) * mv.speed;
    }

    for (const [key, effect] of Object.entries(cascading)) {
      if (effect.rate !== undefined) {
        let next = (state[key] ?? 0) + effect.rate;
        if (effect.min !== undefined) next = Math.max(effect.min, next);
        if (effect.max !== undefined) next = Math.min(effect.max, next);
        state[key] = next;
      }
      if (effect.drift !== undefined) state[key] = (state[key] ?? 0) + (Math.random() - 0.5) * effect.drift;
    }

    if (flags.tumbling) {
      const spinEffect = effects.adcs_target?.onAttack;
      if (spinEffect) {
        if (spinEffect.selfEffect) {
          for (const [key, rate] of Object.entries(spinEffect.selfEffect.drift || {}))
            state[key] = (state[key] || 0) + (Math.random() - 0.5) * rate;
          if (spinEffect.selfEffect.tempRise) {
            const tr = spinEffect.selfEffect.tempRise;
            state[tr.key] = Math.min(maxTemp, (state[tr.key] || 22) + tr.rate);
          }
        }
        if (spinEffect.affectedHardware) {
          const antEffect = spinEffect.affectedHardware.antenna;
          if (antEffect) for (const [key, rate] of Object.entries(antEffect.drift || {})) {
            const current = state[key] ?? 0;
            state[key] = key.includes("el")
              ? Math.max(-90, Math.min(90, current + (Math.random() - 0.5) * rate))
              : current + (Math.random() - 0.5) * rate;
          }
          const spEffect = spinEffect.affectedHardware.solar_panel;
          if (spEffect) {
            for (const [key, rate] of Object.entries(spEffect.drift || {}))
              // ?? (not ||): panel angle driven to exactly 0° is valid off-sun;
              // `|| 90` would falsely reset it and let power recover.
              state[key] = ((state[key] ?? 90) + (Math.random() - 0.5) * rate) % 360;
            if (spEffect.powerFormula?.type === "cosineDropoff" || spEffect.powerFormula === "cosineDropoff")
              state["solar_panel.power"] = cosineDropoff("solar_panel.angle", maxPower, optimalAngle);
          }
        }
      }
    }

    if (flags.solarAttacked && !flags.tumbling)
      state["solar_panel.power"] = cosineDropoff("solar_panel.angle", maxPower, optimalAngle);

    state["obc.uptime"] = (state["obc.uptime"] || 0) + 1;

    if (flags.bricked) {
      state["comm.status"] = "DEAD"; state["transponder.state"] = false; state["adcs.stabilization"] = false;
    }

    if (!flags.bricked) {
      if (flags.tumbling && state["transponder.state"]) {
        const baseProb = state["_commLossProb"] ?? 0.14;
        if (beamwidth < 10) state["comm.status"] = "DEAD";
        else if (beamwidth < 30) { if (state["comm.status"] === "CONNECTED" && Math.random() < baseProb * 3) state["comm.status"] = "LOST"; }
        else if (beamwidth < 60) { if (state["comm.status"] === "CONNECTED" && Math.random() < baseProb) state["comm.status"] = "LOST"; }
      } else if (!flags.antennaAttacked && !state["obc.rebooting"] && state["transponder.state"]) {
        state["comm.status"] = "CONNECTED";
      }
    }

    const battery = state["battery.level"] ?? 100;
    if (battery <= 10 && !flags.bricked) state["comm.status"] = "LOW POWER";
    if (battery <= 0) {
      state["comm.status"] = "DEAD"; state["transponder.state"] = false;
      state["adcs.stabilization"] = false; state["solar_panel.power"] = 0;
    }

    notify();
  }

  function start() { if (tickTimer) clearInterval(tickTimer); tickTimer = setInterval(tick, 1000); }
  function stop() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    recoveryTimers.forEach(t => clearTimeout(t)); recoveryTimers = [];
  }

  return { getState, getPanelConfig, onChange, reset, applyCommand, loadFromFiles, start, stop, notify, tick };
}

module.exports = { createSatelliteState };
