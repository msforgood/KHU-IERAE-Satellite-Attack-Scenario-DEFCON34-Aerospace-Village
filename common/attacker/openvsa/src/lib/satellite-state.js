// Copyright (c) 2026 SunHyuk Hwang. All Rights Reserved.

// Generic satellite state engine.
// Loads hardware.json + hardware-effects.json per satellite via IPC.
// Renders panel based on panel.json.
// tick() applies effects from hardware-effects.json, parameterized by satellite specs.

// Built-in payload logic handlers (referenced by hardware-effects.json payloadLogic field)
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
    // Parse yaw/pitch from payload (int16 big-endian, stored as hex strings)
    if (payload.length < 4) return;
    const b0 = parseInt(payload[0], 16), b1 = parseInt(payload[1], 16);
    const b2 = parseInt(payload[2], 16), b3 = parseInt(payload[3], 16);
    let yaw = (b0 << 8) | b1; if (yaw > 32767) yaw -= 65536;
    let pitch = (b2 << 8) | b3; if (pitch > 32767) pitch -= 65536;
    // Scale drift rate: larger angle = faster drift (proportional to command magnitude)
    const magnitude = (Math.abs(yaw) + Math.abs(pitch)) / 2;
    const driftRate = Math.min(20, Math.max(2, magnitude / 12));
    // Scale comm loss probability: large angles → high prob, small angles → low prob
    // magnitude 135 (yaw=180,pitch=90) → 0.14, magnitude 30 → 0.03
    state["_commLossProb"] = Math.min(0.2, Math.max(0.02, magnitude / 1000));
    // Override cascading drift rates based on payload
    if (cascading) {
      cascading["adcs.roll"] = { drift: driftRate };
      cascading["adcs.pitch"] = { drift: driftRate };
      cascading["adcs.yaw"] = { drift: driftRate };
    }
  },
};

export function createSatelliteState() {
  let hwConfig = {};       // satellite's hardware.json (portMap + hardware specs)
  let effects = {};        // shared hardware-effects.json
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
  function notify() { listeners.forEach(fn => fn(getState())); }

  // Resolve "HW:component.spec" references against satellite hardware specs
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

  // Get a hardware spec value
  function getSpec(component, specName) {
    return hwConfig.hardware?.[component]?.specs?.[specName];
  }

  // Get a hardware default value
  function getDefault(component, prop) {
    return hwConfig.hardware?.[component]?.defaults?.[prop];
  }

  // Build initial state from hardware.json defaults
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

  // Load satellite configs via IPC
  async function loadSatellite(satelliteName) {
    if (!window.electronAPI) return;
    const [hw, fx, panel] = await Promise.all([
      window.electronAPI.getSatelliteConfig(satelliteName, "hardware.json"),
      window.electronAPI.getSatelliteConfig(satelliteName, "../hardware-effects.json"),
      window.electronAPI.getSatelliteConfig(satelliteName, "panel.json"),
    ]);
    hwConfig = hw || {};
    effects = fx || {};
    panelConfig = panel || {};
    flags = {};
    cascading = {};
    moveTargets = {};
    recoveryTimers.forEach(t => clearTimeout(t));
    recoveryTimers = [];
    state = buildDefaults();
    notify();
  }

  function reset() {
    flags = {};
    cascading = {};
    moveTargets = {};
    recoveryTimers.forEach(t => clearTimeout(t));
    recoveryTimers = [];
    state = buildDefaults();
    notify();
  }

  // Cosine dropoff formula: power drops as angle deviates from optimal
  function cosineDropoff(angleSource, maxPower, optimalAngle) {
    const angle = state[angleSource] ?? optimalAngle;
    const diff = Math.abs(optimalAngle - (angle % 180));
    return Math.max(0, maxPower * Math.cos(diff * Math.PI / 180));
  }

  // Apply an effect's "immediate" block
  function applyImmediate(immediate, payload) {
    if (!immediate) return;

    // Run payload logic handler if specified
    if (immediate.payloadLogic && PAYLOAD_HANDLERS[immediate.payloadLogic]) {
      PAYLOAD_HANDLERS[immediate.payloadLogic](payload, immediate);
    }

    // Set state values
    if (immediate.set) {
      for (const [key, value] of Object.entries(immediate.set)) {
        state[key] = value;
      }
    }

    // Set flags
    if (immediate.flag) {
      const flagList = Array.isArray(immediate.flag) ? immediate.flag : [immediate.flag];
      for (const f of flagList) flags[f] = true;
    }
  }

  // Apply movement rules from effect
  function applyMovement(movement, payload) {
    if (!movement) return;
    const speed = resolveHW(movement.speed) ?? 3;

    if (movement.key) {
      // Single key offset movement
      const offset = movement.defaultOffset ?? 180;
      const current = state[movement.key] ?? 0;
      const target = (current + offset) % 360;
      moveTargets[movement.key] = { target, speed };
    }

    if (movement.keys) {
      // Multi-key movement (antenna az/el)
      for (const [key, target] of Object.entries(movement.keys)) {
        if (typeof target === "string" && target.startsWith("OFFSET:PAYLOAD:")) {
          const idx = parseInt(target.split(":")[2]);
          const offset = parseInt(payload[idx], 16) || 30;
          const current = state[key] ?? 0;
          moveTargets[key] = { target: key.includes("el")
            ? Math.max(-90, Math.min(90, current + offset))
            : (current + offset) % 360, speed };
        } else {
          moveTargets[key] = { target, speed };
        }
      }
    }
  }

  // Apply cascading effects from effect
  function applyCascading(casc) {
    if (!casc) return;
    const resolved = {};
    for (const [key, effect] of Object.entries(casc)) {
      resolved[key] = { ...effect };
      if (typeof effect.max === "string") resolved[key].max = resolveHW(effect.max);
    }
    Object.assign(cascading, resolved);
  }

  // Apply a command from a successful uplink
  function applyCommand(command, payload, opts = {}) {
    // Look up effect from hardware-effects.json
    const effect = effects[command];
    if (!effect) {
      console.warn("[sat-state] No effect defined for command:", command);
      return;
    }

    let attack = effect.onAttack;
    if (!attack) {
      // Diagnostic command (ping)
      if (effect.type === "diagnostic") {
        notify();
        return effect;
      }
      return;
    }

    // Check prerequisites
    if (effect.prerequisite) {
      const { key, value, rejectMessage } = effect.prerequisite;
      if (state[key] !== value) {
        console.warn(`[sat-state] ${rejectMessage}`);
        return { ...effect, _rejected: true, _rejectMessage: rejectMessage };
      }
    }

    // Deep copy immediate to avoid mutating the config
    const immediate = attack.immediate ? {
      ...attack.immediate,
      set: { ...(attack.immediate.set || {}) },
    } : null;

    // Handle payloadLogic at the attack level
    if (attack.payloadLogic && PAYLOAD_HANDLERS[attack.payloadLogic]) {
      // Deep copy cascading so handler can modify it
      const attackCascading = attack.cascading ? { ...attack.cascading } : {};
      PAYLOAD_HANDLERS[attack.payloadLogic](payload, immediate || { set: {} }, state, moveTargets, attackCascading);
      attack = { ...attack, cascading: attackCascading };
    }

    // For multi-command sequences, apply prerequisite commands immediately (no delay)
    if (opts.immediate) {
      applyImmediate(immediate, payload);
      applyCascading(attack.cascading);
      notify();
      return { ...effect, _baseDelay: 0 };
    }

    // Base telemetry delay (5-8 seconds) — simulates signal propagation + processing
    const baseDelay = 5000 + Math.random() * 3000;

    // Schedule immediate effects
    const immTimer = setTimeout(() => {
      applyImmediate(immediate, payload);
      applyMovement(attack.movement, payload);
      applyCascading(attack.cascading);

      // Apply comm effect
      if (attack.commEffect) {
        const commDelay = (attack.commEffect.delay || 0) * 1000;
        const ct = setTimeout(() => {
          state["comm.status"] = attack.commEffect.status;
          notify();
        }, commDelay);
        recoveryTimers.push(ct);
      }

      // Apply delayed actions
      if (attack.delayed) {
        for (const d of attack.delayed) {
          const dt = setTimeout(() => {
            if (d.set) {
              for (const [key, value] of Object.entries(d.set)) state[key] = value;
            }
            if (d.flag) {
              const flagList = Array.isArray(d.flag) ? d.flag : [d.flag];
              for (const f of flagList) flags[f] = true;
            }
            notify();
          }, d.delay * 1000);
          recoveryTimers.push(dt);
        }
      }

      notify();
    }, baseDelay);
    recoveryTimers.push(immTimer);

    // Schedule recovery
    if (attack.recovery) {
      const recoveryAfter = resolveHW(attack.recovery.after) ?? 20;
      const recoveryDelay = baseDelay + recoveryAfter * 1000;
      const rt = setTimeout(() => {
        if (attack.recovery.set) {
          for (const [key, value] of Object.entries(attack.recovery.set)) state[key] = value;
        }
        notify();
      }, recoveryDelay);
      recoveryTimers.push(rt);
    }

    // Attach resolved metadata for the caller
    const result = { ...effect };
    if (attack.recovery) {
      result._resolvedRecoveryTime = resolveHW(attack.recovery.after) ?? 20;
    }
    result._baseDelay = baseDelay;
    return result;
  }

  // Tick — called every second
  function tick() {
    const idle = effects._idle;
    const commRules = effects._commRules;
    const beamwidth = getSpec("antenna", "beamwidth") ?? 25;
    const maxPower = getSpec("solar_panel", "maxPower") ?? 4.2;
    const optimalAngle = getSpec("solar_panel", "optimalAngle") ?? 90;
    const maxTemp = getSpec("obc", "maxTemp") ?? 85;

    // ── Ambient idle simulation (no attack active) ──
    const underAttack = flags.solarAttacked || flags.tumbling || flags.bricked || flags.antennaAttacked
      || state["adcs.stabilization"] === false;
    if (!underAttack) {
      if (idle) {
        for (const [key, rule] of Object.entries(idle)) {
          const center = typeof rule.center === "string" ? (resolveHW(rule.center) ?? 0) : (rule.center ?? 0);
          if (rule.type === "sine") {
            state[key] = center + Math.sin(Date.now() / rule.period) * rule.amplitude;
          } else if (rule.type === "jitter") {
            state[key] = center + (Math.random() - 0.5) * rule.amplitude * 2;
          } else if (rule.type === "drift") {
            state[key] = Math.min(rule.max ?? 100, Math.max(rule.min ?? 0,
              (state[key] ?? center) + (Math.random() - 0.48) * rule.rate));
          }
        }
      }
    }

    // ── Gradual movement toward targets ──
    for (const [key, mv] of Object.entries(moveTargets)) {
      const current = state[key] ?? 0;
      const diff = mv.target - current;
      if (Math.abs(diff) < mv.speed) {
        state[key] = mv.target;
        delete moveTargets[key];
      } else {
        state[key] = current + Math.sign(diff) * mv.speed;
      }
    }

    // ── Apply cascading effects ──
    for (const [key, effect] of Object.entries(cascading)) {
      if (effect.rate !== undefined) {
        const current = state[key] ?? 0;
        let next = current + effect.rate;
        if (effect.min !== undefined) next = Math.max(effect.min, next);
        if (effect.max !== undefined) next = Math.min(effect.max, next);
        state[key] = next;
      }
      if (effect.drift !== undefined) {
        const current = state[key] ?? 0;
        state[key] = current + (Math.random() - 0.5) * effect.drift;
      }
    }

    // ── Tumbling effects (driven by hardware-effects.json adcs_target.affectedHardware) ──
    if (flags.tumbling) {
      const spinEffect = effects.adcs_target?.onAttack;
      if (spinEffect) {
        // Self effect: attitude drift + temp rise
        if (spinEffect.selfEffect) {
          for (const [key, rate] of Object.entries(spinEffect.selfEffect.drift || {})) {
            state[key] = (state[key] || 0) + (Math.random() - 0.5) * rate;
          }
          if (spinEffect.selfEffect.tempRise) {
            const tr = spinEffect.selfEffect.tempRise;
            state[tr.key] = Math.min(maxTemp, (state[tr.key] || 22) + tr.rate);
          }
        }
        // Affected hardware
        if (spinEffect.affectedHardware) {
          const antEffect = spinEffect.affectedHardware.antenna;
          if (antEffect) {
            for (const [key, rate] of Object.entries(antEffect.drift || {})) {
              const current = state[key] ?? 0;
              state[key] = key.includes("el")
                ? Math.max(-90, Math.min(90, current + (Math.random() - 0.5) * rate))
                : current + (Math.random() - 0.5) * rate;
            }
          }
          const spEffect = spinEffect.affectedHardware.solar_panel;
          if (spEffect) {
            for (const [key, rate] of Object.entries(spEffect.drift || {})) {
              state[key] = ((state[key] || 90) + (Math.random() - 0.5) * rate) % 360;
            }
            if (spEffect.powerFormula?.type === "cosineDropoff" || spEffect.powerFormula === "cosineDropoff") {
              state["solar_panel.power"] = cosineDropoff("solar_panel.angle", maxPower, optimalAngle);
            }
          }
        }
      }
    }

    // ── Solar panel attacked — power drops ──
    if (flags.solarAttacked && !flags.tumbling) {
      state["solar_panel.power"] = cosineDropoff("solar_panel.angle", maxPower, optimalAngle);
    }

    // ── Uptime ──
    state["obc.uptime"] = (state["obc.uptime"] || 0) + 1;

    // ── Bricked — force dead state ──
    if (flags.bricked) {
      state["comm.status"] = "DEAD";
      state["transponder.state"] = false;
      state["adcs.stabilization"] = false;
    }

    // ── Comm link logic (driven by _commRules + antenna beamwidth) ──
    if (!flags.bricked) {
      if (flags.tumbling && state["transponder.state"]) {
        // Comm degradation depends on antenna beamwidth + command magnitude
        const baseProb = state["_commLossProb"] ?? 0.14;
        if (beamwidth < 10) {
          state["comm.status"] = "DEAD";
        } else if (beamwidth < 30) {
          // Narrow beam: higher probability
          if (state["comm.status"] === "CONNECTED" && Math.random() < baseProb * 3) {
            state["comm.status"] = "LOST";
          }
        } else if (beamwidth < 60) {
          // Wide beam: use base probability from payload magnitude
          if (state["comm.status"] === "CONNECTED" && Math.random() < baseProb) {
            state["comm.status"] = "LOST";
          }
        }
        // beamwidth >= 60 (dipole-like): stays CONNECTED
      } else if (!flags.antennaAttacked && !state["obc.rebooting"] && state["transponder.state"]) {
        state["comm.status"] = "CONNECTED";
      }
    }

    // ── Low / dead battery ──
    const battery = state["battery.level"] ?? 100;
    if (battery <= 10 && !flags.bricked) {
      state["comm.status"] = "LOW POWER";
    }
    if (battery <= 0) {
      state["comm.status"] = "DEAD";
      state["transponder.state"] = false;
      state["adcs.stabilization"] = false;
      state["solar_panel.power"] = 0;
    }

    notify();
  }

  function start() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(tick, 1000);
  }

  function stop() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    recoveryTimers.forEach(t => clearTimeout(t));
    recoveryTimers = [];
  }

  // Look up style for a status value from _statusDefinitions
  function getStatusStyle(source, value) {
    const defs = effects._statusDefinitions;
    if (!defs || !defs[source]) return null;
    return defs[source].values?.[value]?.style ?? null;
  }

  // Check if a comm status value means disruption
  function isCommDisrupted(value) {
    const style = getStatusStyle("comm.status", value);
    return style === "danger" || style === "warn";
  }

  return { getState, getPanelConfig, onChange, reset, applyCommand, loadSatellite, start, stop, notify, getStatusStyle, isCommDisrupted };
}
