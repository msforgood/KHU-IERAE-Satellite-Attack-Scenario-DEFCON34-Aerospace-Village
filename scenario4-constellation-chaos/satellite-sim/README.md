# satellite-sim — the simulation seam (scenario 4)

This folder is a **placeholder** for the satellite simulation. It is a lightweight,
dependency-free 2D canvas stand-in so the whole scenario-4 experience works end to
end today. When the fuller 3D simulation is ported from `../../satellite-tracker`
(Three.js), it drops in here behind the **same public API** and both monitors keep
working unchanged.

Both monitors (attacker / victim) load these three files with plain `<script>` tags:

```
<script src="/sim/kepler.js"></script>     <!-- planar orbital math -->
<script src="/sim/sim.js"></script>        <!-- SatSim: renderer + interaction -->
<script src="/sim/scenario.js"></script>   <!-- shared constellation + tuning -->
```

## Files

| File | Role |
|---|---|
| `kepler.js` | `window.SatKepler` — ported from satellite-tracker `kepler.js` (`keplerianToECI`, `trueAnomalyAdvance`, `propagateKepler`, `detectCollision`, `EarthRadius`) plus planar state-vector helpers (`elementsToState2D`, `stateToElements2D`, `applyManeuver2D`, `period`). A thrust (Δv) becomes a real new orbit. Distances in meters, angles in degrees. |
| `sim.js` | `window.SatSim` — the 2D canvas simulation: constellation render, live predicted-orbit overlay, collision FX, and **mouse-wheel zoom centred on the selected satellite** + drag-pan + click-select. |
| `scenario.js` | `window.Scenario4` — the shared constellation (DEMOSAT + the AURORA ring) and tuning so both monitors start identically. |

## Public API (keep this stable when the 3D sim lands)

```js
const sim = new SatSim(canvas, {
  mode: 'planner' | 'playback',
  targetRingRadius, courseLo, courseHi, horizonSec, forceThreshold, impactTargetSec,
  onClosest(res),     // planner: { status:'idle'|'short'|'course'|'overshoot', apoAlt, periAlt, ringAlt, marginKm, collided, crossPts }
  onCollision(evt),   // playback: { pos, victimId, attackerId, minDist, tCollision }
  onOutcome(evt),     // playback: fires once — { collided, victimId, minDist }
  onSelect(id),
  onTick(telemetry)   // playback: { simTime, apoapsisAlt, periapsisAlt, alive, total, ... }
});

sim.setSatellites([{ id, name, kep:[a,e,inc,raan,argp,nu], color, role:'attacker'|'neighbor' }]);
sim.setSelected(id);
sim.setManeuver({ prograde, radial });    // planner — live predicted orbit + status
sim.applyManeuver({ prograde, radial });   // playback — commit the burn, animate to the outcome
sim.reset();
sim.destroy();
```

- **Interaction:** mouse wheel = zoom (pivots on the selected satellite), drag = pan, click = select.
- **Coplanar model:** this placeholder keeps the constellation in one plane (`inc=raan=0`),
  so the orbit is a 2D ellipse and thrust is an in-plane Δv. The 3D port can use full
  inclination/RAAN; only the internals change, not the API above.

## Collision model (tuned for a booth)

The AURORA ring is dense (45 satellites), so DEMOSAT collides once its **apoapsis reaches
the ring altitude** (the "course band", `courseLo..courseHi` around `targetRingRadius`).
`applyManeuver` finds the earliest closest-approach over `horizonSec` and compresses the
(possibly multi-orbit) chase into `impactTargetSec` of wall time via an adaptive playback
speed. A burn that is too small falls **short**; too large **overshoots** above the ring.
