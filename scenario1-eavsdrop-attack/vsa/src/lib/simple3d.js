// Copyright (c) 2026 SunHyuk Hwang. All Rights Reserved.

const DEG_TO_RAD = Math.PI / 180;
const SCREEN_BASELINE_RATIO = 0.76;

function rotateX(point, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return { x: point.x, y: point.y * c - point.z * s, z: point.y * s + point.z * c };
}

function rotateY(point, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return { x: point.x * c + point.z * s, y: point.y, z: -point.x * s + point.z * c };
}

function rotateZ(point, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return { x: point.x * c - point.y * s, y: point.x * s + point.y * c, z: point.z };
}

function subtract(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function normalize(v) {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function shadeColor(hex, intensity) {
  const v = hex.replace("#", "");
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  const f = Math.max(0.18, Math.min(1.18, intensity));
  return `rgb(${Math.round(r * f)} ${Math.round(g * f)} ${Math.round(b * f)})`;
}

function project(point, width, height) {
  const camDist = 720, focal = 510;
  const depth = camDist - point.z;
  const scale = focal / Math.max(120, depth);
  return { x: width / 2 + point.x * scale, y: height * SCREEN_BASELINE_RATIO - point.y * scale, depth };
}

function transformWorld(point, transform) {
  let p = point;
  if (transform.modelScale) {
    const s = transform.modelScale;
    p = { x: p.x * s, y: p.y * s, z: p.z * s };
  }
  if (transform.elevation) p = rotateZ(p, transform.elevation);
  if (transform.azimuth)   p = rotateY(p, transform.azimuth);
  return {
    x: p.x + (transform.offsetX || 0),
    y: p.y + (transform.offsetY || 0),
    z: p.z + (transform.offsetZ || 0),
  };
}

function createBoxTriangles({ center, size, color }) {
  const hx = size.x / 2, hy = size.y / 2, hz = size.z / 2;
  const v = [
    { x: center.x - hx, y: center.y - hy, z: center.z - hz },
    { x: center.x + hx, y: center.y - hy, z: center.z - hz },
    { x: center.x + hx, y: center.y + hy, z: center.z - hz },
    { x: center.x - hx, y: center.y + hy, z: center.z - hz },
    { x: center.x - hx, y: center.y - hy, z: center.z + hz },
    { x: center.x + hx, y: center.y - hy, z: center.z + hz },
    { x: center.x + hx, y: center.y + hy, z: center.z + hz },
    { x: center.x - hx, y: center.y + hy, z: center.z + hz },
  ];
  const faces = [
    [0,2,1],[0,3,2], [1,6,5],[1,2,6], [5,6,7],[5,7,4],
    [4,7,3],[4,3,0], [3,7,6],[3,6,2], [4,1,5],[4,0,1],
  ];
  return faces.map((idx) => ({ vertices: idx.map((i) => v[i]), color }));
}

function createDishTriangles({ center, radius, depth, color, rimColor }) {
  const latSeg = 7, lonSeg = 16;
  const tris = [];
  for (let lat = 0; lat < latSeg; lat++) {
    const tA = (lat / latSeg) * (Math.PI / 2);
    const tB = ((lat + 1) / latSeg) * (Math.PI / 2);
    for (let lon = 0; lon < lonSeg; lon++) {
      const pA = (lon / lonSeg) * Math.PI * 2;
      const pB = ((lon + 1) / lonSeg) * Math.PI * 2;
      const quad = [tA, tB].flatMap((t) => {
        const r = Math.sin(t) * radius;
        const x = -Math.cos(t) * depth;
        return [pA, pB].map((p) => ({
          x: center.x + x,
          y: center.y + Math.cos(p) * r,
          z: center.z + Math.sin(p) * r,
        }));
      });
      tris.push({ vertices: [quad[0], quad[1], quad[3]], color });
      tris.push({ vertices: [quad[0], quad[3], quad[2]], color });
    }
  }
  const rim = Array.from({ length: lonSeg }, (_, i) => {
    const p = (i / lonSeg) * Math.PI * 2;
    return { x: center.x, y: center.y + Math.cos(p) * radius, z: center.z + Math.sin(p) * radius };
  });
  for (let i = 0; i < rim.length; i++) {
    const ni = (i + 1) % rim.length;
    tris.push({
      vertices: [
        rim[i], rim[ni],
        { x: center.x + 4, y: (rim[i].y + rim[ni].y) / 2, z: (rim[i].z + rim[ni].z) / 2 },
      ],
      color: rimColor,
    });
  }
  return tris;
}

function createStaticTriangles() {
  return [
    ...createBoxTriangles({ center: { x:0, y:10,  z:0 }, size: { x:84, y:20,  z:84 }, color: "#566674" }),
    ...createBoxTriangles({ center: { x:0, y:24,  z:0 }, size: { x:62, y:8,   z:62 }, color: "#2f3c48" }),
    ...createBoxTriangles({ center: { x:0, y:76,  z:0 }, size: { x:20, y:96,  z:20 }, color: "#a2b2bf" }),
    ...createBoxTriangles({ center: { x:0, y:130, z:0 }, size: { x:34, y:12,  z:34 }, color: "#3f4d59" }),
    ...createBoxTriangles({ center: { x:0, y:154, z:0 }, size: { x:12, y:36,  z:12 }, color: "#7f919e" }),
  ];
}

function createAzimuthHeadTriangles() {
  return [
    ...createBoxTriangles({ center: { x:0,  y:0, z:0 }, size: { x:24, y:16, z:24 }, color: "#36424d" }),
    ...createBoxTriangles({ center: { x:16, y:6, z:0 }, size: { x:28, y:6,  z:10 }, color: "#4e6271" }),
  ];
}

const STARS = (() => {
  // Fixed seed so stars don't flicker on every render call
  const s = [];
  let seed = 42;
  const rand = () => { seed = (seed * 1664525 + 1013904223) & 0xffffffff; return (seed >>> 0) / 0xffffffff; };
  for (let i = 0; i < 80; i++) {
    const r = rand() * 1.2 + 0.3;
    const a = rand() * 0.5 + 0.5;
    // Mark the brightest stars as twinklers
    s.push({ x: rand(), y: rand() * 0.64, r, a, twinkle: (r > 1.0 && a > 0.7) });
  }
  return s;
})();

function drawSky(ctx, width, height) {
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "#03060f");
  sky.addColorStop(1, "#0a1628");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  // Stars
  const now = Date.now() / 1000;
  for (const star of STARS) {
    let alpha = star.a;
    let radius = star.r;
    if (star.twinkle) {
      // Slow sinusoidal twinkle with unique phase per star
      const phase = star.x * 17 + star.y * 31;
      alpha = star.a * (0.4 + 0.6 * Math.abs(Math.sin(now * 0.8 + phase)));
      radius = star.r * (0.8 + 0.2 * Math.abs(Math.sin(now * 1.2 + phase)));
    }
    ctx.beginPath();
    ctx.arc(star.x * width, star.y * height, radius, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 255, 255, ${alpha.toFixed(2)})`;
    ctx.fill();
  }

  const groundTop = height * 0.68;
  const dip       = height * 0.05;  // how much the sides dip below the center peak

  const ground = ctx.createLinearGradient(0, groundTop, 0, height);
  ground.addColorStop(0, "#2a4228");
  ground.addColorStop(1, "#1a2a18");
  ctx.fillStyle = ground;
  ctx.beginPath();
  // top edge: arc highest at center, sides dip down
  ctx.moveTo(0, groundTop + dip);
  ctx.quadraticCurveTo(width / 2, groundTop, width, groundTop + dip);
  ctx.lineTo(width, height);
  ctx.lineTo(0, height);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, groundTop + dip);
  ctx.quadraticCurveTo(width / 2, groundTop, width, groundTop + dip);
  ctx.stroke();
}

export function createSceneRenderer({ canvas }) {
  const ctx = canvas.getContext("2d");
  const cameraTilt = { x: 0.3, y: 0.0 };
  const lightDir = normalize({ x: 0.45, y: 0.9, z: 0.3 });
  const toCamera = (v) => rotateX(rotateY(v, cameraTilt.y), cameraTilt.x);

  // ── Starlink-style satellite train ────────────────────────────────────────
  const TRAIN_COUNT   = 10;
  const TRAIN_SPACING = 24; // px between consecutive satellites

  const trainState = {
    active: false,
    x: 0, y: 0,   // lead satellite (index 0)
    vx: 0, vy: 0,
    nx: 0, ny: 0, // unit direction vector
    lastMs: 0,
    nextMs: Date.now() + 8000,
  };

  function tickSatellite(width, height) {
    const now = Date.now();
    if (!trainState.active) {
      if (now >= trainState.nextMs) {
        trainState.active = true;
        const dx   = width + 12;
        const dy   = -(height * 0.62 + 6);
        const dist = Math.hypot(dx, dy);
        const spd  = dist / (14000 + Math.random() * 8000);
        trainState.nx = dx / dist;
        trainState.ny = dy / dist;
        trainState.vx = trainState.nx * spd;
        trainState.vy = trainState.ny * spd;
        // lead starts at bottom-left entry point
        trainState.x = -6;
        trainState.y = height * 0.62;
        trainState.lastMs = now;
      }
    } else {
      const dt = now - trainState.lastMs;
      trainState.x += trainState.vx * dt;
      trainState.y += trainState.vy * dt;
      trainState.lastMs = now;
      // done when the tail (last satellite) exits the sky
      const tailX = trainState.x - trainState.nx * (TRAIN_COUNT - 1) * TRAIN_SPACING;
      const tailY = trainState.y - trainState.ny * (TRAIN_COUNT - 1) * TRAIN_SPACING;
      if (tailX > width + 6 || tailY < -6) {
        trainState.active = false;
        trainState.nextMs = now + 30000 + Math.random() * 40000;
      }
    }
  }

  function drawSatellite() {
    if (!trainState.active) return;
    for (let i = 0; i < TRAIN_COUNT; i++) {
      const x = trainState.x - trainState.nx * i * TRAIN_SPACING;
      const y = trainState.y - trainState.ny * i * TRAIN_SPACING;
      // clip to sky area (above the curved ground)
      if (x < -8 || x > canvas.width + 8 || y < -8 || y > canvas.height + 8) continue;
      const groundY = canvas.height * 0.68 + canvas.height * 0.05 * ((2 * x / canvas.width - 1) ** 2);
      if (y > groundY) continue;
      ctx.beginPath();
      ctx.arc(x, y, 1.36, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(220, 240, 255, 0.64)";
      ctx.fill();
    }
  }

  function render({ azimuth, elevation, antennaParts, extraParts, overlayLabels }) {
    const width  = Math.max(1, canvas.width);
    const height = Math.max(1, canvas.height);
    ctx.clearRect(0, 0, width, height);
    drawSky(ctx, width, height);
    tickSatellite(width, height);
    drawSatellite();

    const az = -(azimuth - 90) * DEG_TO_RAD;
    const el =  elevation * DEG_TO_RAD;

    const staticT  = { offsetY: 0 };
    const headT    = { azimuth: az, offsetY: 172 };
    const mountedT = { azimuth: az, elevation: el, offsetY: 172, modelScale: 1.5 };

    const groundAnchor = project(toCamera({ x: 0, y: 0, z: 0 }), width, height);

    // Scale the model 1.4× around the ground anchor
    ctx.save();
    ctx.translate(groundAnchor.x, groundAnchor.y);
    ctx.scale(1.08, 1.08);
    ctx.translate(-groundAnchor.x, -groundAnchor.y);

    // shadow under mast
    ctx.fillStyle = "rgba(19, 33, 47, 0.16)";
    ctx.beginPath();
    ctx.ellipse(groundAnchor.x, groundAnchor.y + 10, 78, 18, 0, 0, Math.PI * 2);
    ctx.fill();

    // compass ring
    const compassR = 74;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.32)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(groundAnchor.x, groundAnchor.y + 2, compassR + 24, 22, 0, 0, Math.PI * 2);
    ctx.stroke();


    // ── 3D geometry ───────────────────────────────────────────────────────────
    const groups = [
      { triangles: createStaticTriangles(),       transform: staticT  },
      { triangles: createAzimuthHeadTriangles(),   transform: headT    },
      { triangles: antennaParts,                   transform: mountedT },
    ];
    if (extraParts && extraParts.length > 0) {
      groups.push({ triangles: extraParts, transform: staticT });
    }

    const rendered = groups
      .flatMap(({ triangles: gTris, transform }) =>
        gTris.map((tri) => {
          const world  = tri.vertices.map((v) => transformWorld(v, transform));
          const cam    = world.map(toCamera);
          const eA     = subtract(cam[1], cam[0]);
          const eB     = subtract(cam[2], cam[0]);
          const normal = normalize(cross(eA, eB));

          // if (normal.z >= 0.22) return null;

          const light = Math.max(0, -(
            normal.x * lightDir.x + normal.y * lightDir.y + normal.z * lightDir.z
          ));
          const proj  = cam.map((v) => project(v, width, height));
          const depth = proj.reduce((s, p) => s + p.depth, 0) / proj.length;

          return { proj, depth, fill: shadeColor(tri.color, 0.45 + light * 0.9) };
        }),
      )
      .filter(Boolean)
      .sort((a, b) => b.depth - a.depth);

    for (const t of rendered) {
      ctx.beginPath();
      ctx.moveTo(t.proj[0].x, t.proj[0].y);
      ctx.lineTo(t.proj[1].x, t.proj[1].y);
      ctx.lineTo(t.proj[2].x, t.proj[2].y);
      ctx.closePath();
      ctx.fillStyle = t.fill;
      ctx.fill();
    }

    ctx.restore();

    // ── Cardinal labels (unscaled, drawn last so they're always on top) ────────
    const cardinalLabels = [
      ["N", groundAnchor.x+50,  groundAnchor.y - 58],
      ["S", (width / 2) - 50,   height - 30],
      ["W", 30,                  height * 0.74],
      ["E", width - 30,          height * 0.74],
    ];
    const compassInk = "rgba(19, 33, 47, 0.95)";
    ctx.font      = 'bold 36px "Segoe UI", Tahoma, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.strokeStyle  = "rgba(255, 255, 255, 0.85)";
    ctx.lineWidth    = 5;
    ctx.lineJoin     = "round";
    for (const [lbl, x, y] of cardinalLabels) ctx.strokeText(lbl, x, y);
    ctx.fillStyle = compassInk;
    for (const [lbl, x, y] of cardinalLabels) ctx.fillText(lbl, x, y);

    // ── Overlay labels (e.g., "AMP" on amplifier) ─────────────────────────────
    if (overlayLabels) {
      ctx.font = 'bold 11px "Segoe UI", Tahoma, sans-serif';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const { text, x, y, color } of overlayLabels) {
        ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
        ctx.lineWidth = 3;
        ctx.lineJoin = "round";
        ctx.strokeText(text, x, y);
        ctx.fillStyle = color || "#fff";
        ctx.fillText(text, x, y);
      }
    }

    ctx.textBaseline = "alphabetic";
  }

  return { render };
}

export function boxPart(center, size, color) {
  return createBoxTriangles({ center, size, color });
}

export function dishPart(center, radius, depth, color, rimColor) {
  return createDishTriangles({ center, radius, depth, color, rimColor });
}

export function transformPartTriangles(
  triangles,
  {
    rotateX: rx = 0, rotateY: ry = 0, rotateZ: rz = 0,
    pivot  = { x: 0, y: 0, z: 0 },
    offset = { x: 0, y: 0, z: 0 },
  } = {},
) {
  return triangles.map((tri) => ({
    ...tri,
    vertices: tri.vertices.map((v) => {
      let p = { x: v.x - pivot.x, y: v.y - pivot.y, z: v.z - pivot.z };
      if (rx) p = rotateX(p, rx);
      if (ry) p = rotateY(p, ry);
      if (rz) p = rotateZ(p, rz);
      return { x: p.x + pivot.x + offset.x, y: p.y + pivot.y + offset.y, z: p.z + pivot.z + offset.z };
    }),
  }));
}
