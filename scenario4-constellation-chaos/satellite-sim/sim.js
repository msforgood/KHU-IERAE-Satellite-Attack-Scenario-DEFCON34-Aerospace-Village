// sim.js — 3D satellite simulation for scenario 4 (Three.js, on the satellite-tracker
// engine). Dependency-free at the page level: vendored global THREE + THREE.OrbitControls
// (load those + kepler.js first). Public API:
//
//   const sim = new SatSim(canvas, { mode, collisionThreshold, impactTargetSec,
//       onClosest, onCollision, onOutcome, onSelect, onTick });
//   sim.setSatellites([{ id, name, kep:[a,e,inc,raan,argp,nu], color, role }]);
//   sim.setManeuver({ altKm, inc, raan });    // planner: recolour the predicted orbit
//   sim.applyManeuver({ altKm, inc, raan });   // playback: commit + stage the collision
//   sim.getInfo(id) -> { name, role, altKm, incDeg, raanDeg }
//   sim.lockOn(id)  -> monitor 2: keep this satellite centred while Earth stays the pivot
//   sim.reset();
//
// The maneuver sets ENIGMA-1's orbit ELEMENTS (altitude / inclination / RAAN). Rotate the
// orbit until it passes over a target satellite -> collision course. Orbits are thick
// tubes and are hidden where they pass behind the Earth globe.
(function (root) {
  'use strict';
  var K = root.SatKepler;
  var CC = root.CollisionCore;   // scenario-5 shared physics (load collision-core.js before sim.js)
  var THREE = root.THREE;

  var SCENE_SCALE = 1e-5;
  var DEG = Math.PI / 180;
  var NU = [];
  for (var _i = 0; _i <= 180; _i++) NU.push(_i * 2);           // 181-sample orbit
  var TUBE_R = K.EarthRadius * SCENE_SCALE * 0.006;            // orbit tube radius (~38 km)
  var COLOR = { debris: 0xff5533, predOK: 0xe45cff, predHit: 0xff3b4e, explosion: 0xff5020, answerHi: 0x59ff9e };

  // ── textures ────────────────────────────────────────────────────────────────
  function makeDot(size) {
    size = size || 128; var c = document.createElement('canvas'); c.width = c.height = size;
    var g = c.getContext('2d'), r = size / 2, gr = g.createRadialGradient(r, r, 0, r, r, r);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, size, size); var t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t;
  }
  function makeSatIcon(css) {
    var c = document.createElement('canvas'); c.width = c.height = 128; var g = c.getContext('2d'); g.clearRect(0, 0, 128, 128);
    g.fillStyle = '#2b5fb0'; g.fillRect(6, 50, 38, 28); g.fillRect(84, 50, 38, 28);
    g.strokeStyle = 'rgba(10,20,40,.7)'; g.lineWidth = 1;
    for (var i = 1; i < 4; i++) { g.beginPath(); g.moveTo(6 + i * 9.5, 50); g.lineTo(6 + i * 9.5, 78); g.stroke(); g.beginPath(); g.moveTo(84 + i * 9.5, 50); g.lineTo(84 + i * 9.5, 78); g.stroke(); }
    g.strokeStyle = '#8fa5c0'; g.lineWidth = 2; g.beginPath(); g.moveTo(44, 64); g.lineTo(50, 64); g.moveTo(78, 64); g.lineTo(84, 64); g.stroke();
    g.fillStyle = css; g.strokeStyle = 'rgba(255,255,255,.92)'; g.lineWidth = 2.5; g.fillRect(50, 45, 28, 38); g.strokeRect(50, 45, 28, 38);
    g.fillStyle = '#e6eefb'; g.beginPath(); g.arc(64, 39, 7, 0, Math.PI * 2); g.fill();
    var t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t;
  }
  function makeGSIcon() {
    // A bold, high-contrast ground-station beacon so its spot on the globe is obvious.
    var c = document.createElement('canvas'); c.width = c.height = 128; var g = c.getContext('2d'); g.clearRect(0, 0, 128, 128);
    g.shadowColor = 'rgba(0,0,0,0.9)'; g.shadowBlur = 9;
    g.strokeStyle = '#8affe0'; g.fillStyle = '#8affe0'; g.lineWidth = 9; g.lineCap = 'round';
    g.beginPath(); g.arc(64, 58, 34, Math.PI * 1.13, Math.PI * 1.87); g.stroke();      // dish (larger)
    g.beginPath(); g.moveTo(64, 58); g.lineTo(64, 100); g.stroke();                     // mast
    g.beginPath(); g.moveTo(40, 104); g.lineTo(88, 104); g.stroke();                    // base
    g.beginPath(); g.arc(64, 36, 9, 0, Math.PI * 2); g.fill();                          // feed
    var t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t;
  }
  function makeTextTex(text, color) {
    var c = document.createElement('canvas'); c.width = 1024; c.height = 128; var g = c.getContext('2d');
    g.font = 'bold 62px sans-serif'; g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = 'rgba(0,0,0,0.85)'; g.shadowBlur = 14; g.fillText(text, 512, 64);
    var t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t;
  }
  // A high-visibility label: large text on a rounded, semi-opaque plate outlined in
  // the accent colour, so it stays readable over Earth, orbits and dark space alike.
  function makeLabelTex(text, color) {
    var c = document.createElement('canvas'); c.width = 1024; c.height = 168; var g = c.getContext('2d');
    g.font = 'bold 78px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    var tw = g.measureText(text).width, pad = 40, bw = Math.min(1000, tw + pad * 2), bh = 116;
    var x = 512 - bw / 2, y = 84 - bh / 2, r = 30;
    g.fillStyle = 'rgba(5,13,20,0.86)';
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + bw, y, x + bw, y + bh, r); g.arcTo(x + bw, y + bh, x, y + bh, r);
    g.arcTo(x, y + bh, x, y, r); g.arcTo(x, y, x + bw, y, r); g.closePath(); g.fill();
    g.lineWidth = 5; g.strokeStyle = color; g.stroke();
    g.fillStyle = color; g.fillText(text, 512, 84);
    var t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t;
  }
  function billboard(tex, hex, size, occlude) {
    var mat = new THREE.SpriteMaterial({ map: tex, color: hex != null ? new THREE.Color(hex) : new THREE.Color(0xffffff),
      sizeAttenuation: false, transparent: true, depthTest: occlude !== false, depthWrite: false });
    var s = new THREE.Sprite(mat); s.scale.set(size, size, 1); s.renderOrder = 6; return s;
  }
  function orbitCurve(kep) {
    var p = K.keplerianToECI(kep[0], kep[1], kep[2], kep[3], kep[4], NU), v = [];
    for (var i = 0; i < NU.length; i++) v.push(new THREE.Vector3(p.x[i] * SCENE_SCALE, p.y[i] * SCENE_SCALE, p.z[i] * SCENE_SCALE));
    return new THREE.CatmullRomCurve3(v, true);
  }
  function orbitTube(kep, hex, radius) {
    var geom = new THREE.TubeGeometry(orbitCurve(kep), 140, radius, 8, true);
    // MeshBasic + a touch of emissive-like brightness; opaque so the globe hides the far side
    return new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: hex }));
  }

  // ── position of the closest point on an orbit to a 3D point, + its true anomaly ─
  function closestOrbitPoint(kep, P) {
    var pts = K.keplerianToECI(kep[0], kep[1], kep[2], kep[3], kep[4], NU);
    var bd = Infinity, bi = 0;
    for (var i = 0; i < NU.length; i++) {
      var dx = pts.x[i] - P.x, dy = pts.y[i] - P.y, dz = pts.z[i] - P.z, d = dx * dx + dy * dy + dz * dz;
      if (d < bd) { bd = d; bi = i; }
    }
    return { dist: Math.sqrt(bd), nu: NU[bi], pos: { x: pts.x[bi], y: pts.y[bi], z: pts.z[bi] } };
  }

  // ═══════════════════════════════ Engine ═══════════════════════════════════
  function Engine(canvas, textureUrl) { this.canvas = canvas; this.textureUrl = textureUrl || '/sim/assets/earthmap.jpg'; this.sats = {}; this.disposed = false; }
  Engine.prototype.init = function () { this.dotTex = makeDot(); this._scene(); this._lights(); this._earth(); this._fx(); this._overlay(); this.render(); };
  Engine.prototype._sz = function () { return { w: this.canvas.clientWidth || 640, h: this.canvas.clientHeight || 400 }; };
  Engine.prototype._scene = function () {
    var s = this._sz(); this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0x050b12);
    this.camera = new THREE.PerspectiveCamera(50, s.w / s.h, 0.01, 1e5);
    var R = K.EarthRadius * SCENE_SCALE * 3.4; this.camera.position.set(R, R * 0.5, -R); this.camera.lookAt(0, 0, 0);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1); this.renderer.setSize(s.w, s.h, false);
    var self = this; this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enablePan = false; this.controls.minDistance = K.EarthRadius * SCENE_SCALE * 1.12; this.controls.maxDistance = K.EarthRadius * SCENE_SCALE * 18;
    this.controls.rotateSpeed = 0.7; this.controls.zoomSpeed = 0.9;
    this.controls.addEventListener('change', function () { self.render(); });
  };
  Engine.prototype._lights = function () { this.scene.add(new THREE.AmbientLight(0xffffff, 0.7)); var d = new THREE.DirectionalLight(0xffffff, 0.7); d.position.set(5, 3, -5); this.scene.add(d); };
  Engine.prototype._earth = function () {
    var r = K.EarthRadius * SCENE_SCALE, self = this;
    var tex = new THREE.TextureLoader().load(this.textureUrl, function () { self.render(); });
    this.earth = new THREE.Mesh(new THREE.SphereGeometry(r, 64, 48), new THREE.MeshPhongMaterial({ map: tex, color: 0x99a7bd, shininess: 6 }));
    if (this._earthSpinDeg) this.earth.rotation.y = this._earthSpinDeg * Math.PI / 180;
    this.scene.add(this.earth);
  };
  // spin the Earth texture (degrees about the polar axis) so a chosen region faces forward
  Engine.prototype.setEarthSpin = function (deg) { this._earthSpinDeg = deg || 0; if (this.earth) { this.earth.rotation.y = this._earthSpinDeg * Math.PI / 180; this.render(); } };
  Engine.prototype._fx = function () {
    this.explosion = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ color: COLOR.explosion, transparent: true, opacity: 0.55, depthWrite: false }));
    this.explosion.visible = false; this.scene.add(this.explosion);
    this.debris = []; for (var i = 0; i < 9; i++) { var d = billboard(this.dotTex, COLOR.debris, 0.02, true); d.visible = false; this.scene.add(d); this.debris.push(d); }
    this.warning = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeTextTex('COLLISION', '#ff5a5a'), transparent: true, depthTest: false, sizeAttenuation: false }));
    this.warning.scale.set(0.5, 0.09, 1); this.warning.position.set(0, 0.44, -1); this.warning.visible = false; this.warning.renderOrder = 30; this.camera.add(this.warning); this.scene.add(this.camera);
  };
  Engine.prototype._overlay = function () {
    // predicted path = a DASHED line in a distinct colour (not a solid tube like the real orbits)
    this.predicted = new THREE.Line(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3)),
      new THREE.LineDashedMaterial({ color: COLOR.predOK, dashSize: 2.2, gapSize: 1.4, transparent: true, opacity: 0.95, depthWrite: false }));
    this.predicted.visible = false; this.scene.add(this.predicted);
    this.marker = billboard(this.dotTex, COLOR.predHit, 0.04, true); this.marker.visible = false; this.scene.add(this.marker);
    // ground station (Las Vegas) + uplink beam to ENIGMA-1 — marked with a small pin
    // and label so the site is identifiable, but kept SECONDARY to the satellites
    // (smaller icon + lower render order) so the constellation stays the focus.
    this.gs = billboard(makeGSIcon(), null, 0.052, true); this.gs.renderOrder = 5; this.gs.visible = false; this.scene.add(this.gs);
    this.gsLabel = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeLabelTex('LAS VEGAS GS', '#8affe0'), transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false }));
    this.gsLabel.scale.set(0.3, 0.049, 1); this.gsLabel.visible = false; this.gsLabel.renderOrder = 6; this.scene.add(this.gsLabel);
    var pinG = new THREE.BufferGeometry(); pinG.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this.gsPin = new THREE.Line(pinG, new THREE.LineBasicMaterial({ color: 0x8affe0, transparent: true, opacity: 0.6, depthWrite: false }));
    this.gsPin.renderOrder = 4; this.gsPin.visible = false; this.scene.add(this.gsPin);
    this.gsBase = billboard(this.dotTex, 0x8affe0, 0.016, true); this.gsBase.renderOrder = 4; this.gsBase.visible = false; this.scene.add(this.gsBase);
    var bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this.beam = new THREE.Line(bg, new THREE.LineBasicMaterial({ color: 0x39c5ff, transparent: true, opacity: 0.8, depthWrite: false }));
    this.beam.visible = false; this.scene.add(this.beam);
    // thruster plume: a hot cone shown on ENIGMA-1 while the commanded burn fires (monitor 2).
    // It points OPPOSITE the delta-v — gas ejected backward is what pushes the satellite forward.
    this.plume = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1, 18, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffb43a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    this.plume.renderOrder = 7; this.plume.visible = false; this.scene.add(this.plume);
    this.plumeCore = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1, 18, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xfff2c4, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    this.plumeCore.renderOrder = 8; this.plumeCore.visible = false; this.scene.add(this.plumeCore);
  };
  Engine.prototype.setGS = function (p) {
    if (!p) { this.gs.visible = this.gsLabel.visible = false; if (this.gsPin) this.gsPin.visible = false; if (this.gsBase) this.gsBase.visible = false; return; }
    var s = SCENE_SCALE;
    var bx = p.x * s, by = p.y * s, bz = p.z * s;               // point on the globe surface
    var ox = bx * 1.045, oy = by * 1.045, oz = bz * 1.045;      // top of the pin (dish sits here)
    if (this.gsPin) {
      var a = this.gsPin.geometry.attributes.position.array;
      a[0] = bx; a[1] = by; a[2] = bz; a[3] = ox; a[4] = oy; a[5] = oz;
      this.gsPin.geometry.attributes.position.needsUpdate = true; this.gsPin.geometry.computeBoundingSphere();
      this.gsPin.visible = true;
    }
    if (this.gsBase) { this.gsBase.position.set(bx, by, bz); this.gsBase.visible = true; }
    this.gs.position.set(ox, oy, oz);
    this.gsLabel.position.set(ox * 1.01, oy * 1.01 + 0.035 * (K.EarthRadius * s), oz * 1.01);
    this.gs.visible = true; this.gsLabel.visible = true;
  };
  Engine.prototype.setBeam = function (a, b) {
    if (!a || !b) { this.beam.visible = false; return; }
    var s = SCENE_SCALE, arr = this.beam.geometry.attributes.position.array;
    arr[0] = a.x * s; arr[1] = a.y * s; arr[2] = a.z * s; arr[3] = b.x * s; arr[4] = b.y * s; arr[5] = b.z * s;
    this.beam.geometry.attributes.position.needsUpdate = true; this.beam.geometry.computeBoundingSphere(); this.beam.visible = true;
  };
  // p = satellite position (metres, ECI), dir = exhaust direction (unit, world, = -delta-v),
  // intensity 0..1 = how hard the engine is firing (length + brightness). Apex sits on the
  // satellite; the cone widens outward along dir.
  Engine.prototype.setPlume = function (p, dir, intensity) {
    if (!this.plume) return;
    var i = intensity || 0;
    if (!p || !dir || i <= 0.02) { this.plume.visible = false; this.plumeCore.visible = false; return; }
    if (i > 1) i = 1;
    var s = SCENE_SCALE;
    var pos = new THREE.Vector3(p.x * s, p.y * s, p.z * s);
    var d = new THREE.Vector3(dir.x, dir.y, dir.z);
    if (d.lengthSq() < 1e-9) { this.plume.visible = false; this.plumeCore.visible = false; return; }
    d.normalize();
    var UP = this._plumeUp || (this._plumeUp = new THREE.Vector3(0, 1, 0));
    var nd = d.clone().negate(), len = 2.2 + 4.2 * i;
    function place(mesh, radius, lenScale, opacity) {
      mesh.quaternion.setFromUnitVectors(UP, nd);
      var L = len * lenScale;
      mesh.scale.set(radius / 0.5, L, radius / 0.5);
      mesh.position.copy(pos).addScaledVector(d, L / 2);
      mesh.material.opacity = opacity; mesh.visible = true;
    }
    place(this.plume, 0.55 + 0.5 * i, 1.0, 0.30 + 0.42 * i);
    place(this.plumeCore, 0.24 + 0.2 * i, 0.68, 0.45 + 0.5 * i);
  };
  Engine.prototype.addSatellite = function (id, hex, css, radius, name) {
    if (this.sats[id]) return;
    var r = radius || TUBE_R;
    var orbit = orbitTube([K.EarthRadius + 600e3, 0, 0, 0, 0, 0], hex, r);
    var mesh = billboard(makeSatIcon(css), null, 0.08, true);   // satellites are the focus -> larger icons
    // a colour-coded name label following the satellite, so each one is easy to pick out
    var label = null;
    if (name) {
      label = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeLabelTex(name, css || '#eaf2ff'),
        transparent: true, depthTest: true, depthWrite: false, sizeAttenuation: false }));
      label.scale.set(0.34, 0.056, 1); label.renderOrder = 7;
      // screen-space anchor: push the label ABOVE the icon (its own position) so the
      // text never sits on top of the satellite, at any zoom level
      if (label.center) label.center.set(0.5, -1.5);
      this.scene.add(label);
    }
    this.scene.add(orbit); this.scene.add(mesh); this.sats[id] = { mesh: mesh, orbit: orbit, label: label, baseHex: hex, orbitR: r };
  };
  Engine.prototype.removeSatellite = function (id) { var s = this.sats[id]; if (!s) return; this.scene.remove(s.mesh); this.scene.remove(s.orbit); if (s.label) { this.scene.remove(s.label); if (s.label.material.map) s.label.material.map.dispose(); s.label.material.dispose(); } s.orbit.geometry.dispose(); s.orbit.material.dispose(); s.mesh.material.dispose(); delete this.sats[id]; };
  Engine.prototype.clearSatellites = function () { var k = Object.keys(this.sats); for (var i = 0; i < k.length; i++) this.removeSatellite(k[i]); };
  Engine.prototype.setOrbitLine = function (id, kep) { var s = this.sats[id]; if (!s) return; s.orbit.geometry.dispose(); s.orbit.geometry = new THREE.TubeGeometry(orbitCurve(kep), 140, s.orbitR || TUBE_R, 8, true); };
  Engine.prototype.setSatPosition = function (id, p) {
    var s = this.sats[id]; if (!s) return; var g = SCENE_SCALE;
    s.mesh.position.set(p.x * g, p.y * g, p.z * g);
    // the label shares the sat's world position; its screen-space anchor (center) lifts it above the icon
    if (s.label) s.label.position.set(p.x * g, p.y * g, p.z * g);
  };
  Engine.prototype.setSatSize = function (id, sz) { var s = this.sats[id]; if (s) s.mesh.scale.set(sz, sz, 1); };
  Engine.prototype.setSatVisible = function (id, v) { var s = this.sats[id]; if (s) { s.mesh.visible = v; s.orbit.visible = v; if (s.label) s.label.visible = v; } };
  Engine.prototype.setOrbitColor = function (id, hex) { var s = this.sats[id]; if (s) s.orbit.material.color.setHex(hex); };
  Engine.prototype.tintSat = function (id, hex) { var s = this.sats[id]; if (s) s.mesh.material.color.setHex(hex); };
  // predicted = the FORWARD PATH the satellite will fly (an open arc from nuStart), not the whole orbit
  Engine.prototype.setPredicted = function (kep, hex, nuStart, sweepDeg) {
    if (!kep) { this.predicted.visible = false; return; }
    var start = nuStart || 0, sweep = sweepDeg || 210, nus = [];
    for (var d = 0; d <= sweep; d += 2) nus.push(((start + d) % 360 + 360) % 360);
    var p = K.keplerianToECI(kep[0], kep[1], kep[2], kep[3], kep[4], nus);
    var arr = new Float32Array(nus.length * 3);
    for (var i = 0; i < nus.length; i++) { arr[i * 3] = p.x[i] * SCENE_SCALE; arr[i * 3 + 1] = p.y[i] * SCENE_SCALE; arr[i * 3 + 2] = p.z[i] * SCENE_SCALE; }
    this.predicted.geometry.dispose();
    this.predicted.geometry = new THREE.BufferGeometry();
    this.predicted.geometry.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    this.predicted.computeLineDistances();   // required for the dashes to render
    this.predicted.material.color.setHex(hex); this.predicted.visible = true;
  };
  Engine.prototype.setMarker = function (p, hex) {
    if (!p) { this.marker.visible = false; return; }
    this.marker.position.set(p.x * SCENE_SCALE, p.y * SCENE_SCALE, p.z * SCENE_SCALE); this.marker.material.color.setHex(hex); this.marker.visible = true;
  };
  Engine.prototype.showExplosion = function (p, radius) { this.explosion.position.set(p.x * SCENE_SCALE, p.y * SCENE_SCALE, p.z * SCENE_SCALE); var r = radius * SCENE_SCALE; this.explosion.scale.set(r, r, r); this.explosion.visible = true; };
  Engine.prototype.hideExplosion = function () { this.explosion.visible = false; };
  Engine.prototype.showDebris = function (p, spread) {
    var cx = p.x * SCENE_SCALE, cy = p.y * SCENE_SCALE, cz = p.z * SCENE_SCALE, sp = spread * SCENE_SCALE;
    var off = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [0.7, 0.7, 0], [-0.7, 0.7, 0.4], [0.5, -0.6, -0.6]];
    for (var i = 0; i < 9; i++) { this.debris[i].position.set(cx + off[i][0] * sp, cy + off[i][1] * sp, cz + off[i][2] * sp); this.debris[i].visible = true; }
  };
  Engine.prototype.hideDebris = function () { for (var i = 0; i < 9; i++) this.debris[i].visible = false; };
  Engine.prototype.showWarning = function (v) { this.warning.visible = v; };
  Engine.prototype.targetEarth = function () { this.controls.target.set(0, 0, 0); this.controls.update(); };
  Engine.prototype.setFocus = function (p) { if (p) { this.controls.target.set(p.x * SCENE_SCALE, p.y * SCENE_SCALE, p.z * SCENE_SCALE); this.controls.update(); } };
  Engine.prototype.frame = function (maxR) { var d = maxR * SCENE_SCALE * 2.9; this.camera.position.set(d * 0.5, d * 0.5, -d * 0.72); this.controls.target.set(0, 0, 0); this.controls.update(); this.render(); };
  // lock-on: keep Earth the pivot but swing the camera so P sits in front of the globe
  Engine.prototype.lockCamera = function (p) {
    var d = this.camera.position.length();            // preserve the current zoom distance
    if (d < 150) d = 150;                              // never sit too close (whole scene stays visible)
    var len = Math.hypot(p.x, p.y, p.z) || 1;
    var ux = p.x / len, uy = p.y / len, uz = p.z / len;
    // sit on the satellite's side of Earth (so it stays roughly centred) with a
    // slight elevation, then normalise back to distance d so we never zoom in on it.
    var dx = ux * 0.9, dy = uy * 0.9 + 0.42, dz = uz * 0.9;
    var m = Math.hypot(dx, dy, dz) || 1;
    this.camera.position.set(dx / m * d, dy / m * d, dz / m * d);
    this.controls.target.set(0, 0, 0); this.camera.lookAt(0, 0, 0);
  };
  Engine.prototype.resize = function () { if (!this.renderer) return; var s = this._sz(); this.renderer.setSize(s.w, s.h, false); this.camera.aspect = s.w / s.h; this.camera.updateProjectionMatrix(); this.render(); };
  Engine.prototype.pick = function (cx, cy, positions) {
    var rect = this.canvas.getBoundingClientRect(), best = null, bd = 26, v = new THREE.Vector3();
    for (var id in positions) { var p = positions[id]; if (!p) continue;
      v.set(p.x * SCENE_SCALE, p.y * SCENE_SCALE, p.z * SCENE_SCALE).project(this.camera); if (v.z > 1) continue;
      var sx = rect.left + (v.x * 0.5 + 0.5) * rect.width, sy = rect.top + (-v.y * 0.5 + 0.5) * rect.height, d = Math.hypot(sx - cx, sy - cy);
      if (d < bd) { bd = d; best = id; } }
    return best;
  };
  Engine.prototype.render = function () { if (!this.disposed) this.renderer.render(this.scene, this.camera); };
  Engine.prototype.dispose = function () { this.disposed = true; if (this.controls) this.controls.dispose(); if (this.renderer) this.renderer.dispose(); };

  // ═══════════════════════════════ SatSim ═══════════════════════════════════
  function SatSim(canvas, opts) {
    opts = opts || {}; this.canvas = canvas; this.mode = opts.mode || 'planner';
    this.onCollision = opts.onCollision || null; this.onClosest = opts.onClosest || null; this.onOutcome = opts.onOutcome || null;
    this.onSelect = opts.onSelect || null; this.onTick = opts.onTick || null;
    this.impactTargetSec = opts.impactTargetSec || 18;
    this.collisionThreshold = opts.collisionThreshold || 130000;   // m: orbit-to-target passing distance
    this.sats = []; this.selectedId = null; this.lockId = null;
    this.maneuver = null; this.running = false; this.rafId = null; this.simTime = 0; this.lastWall = 0;
    this.fx = null; this.outcome = null; this._epoch = null; this._cache = null;
    this.beamActive = false; this._beamTimer = null;   // GS→ENIGMA-1 uplink beam shows only while uplinking
    this.engine = new Engine(canvas, opts.textureUrl); this.engine.init();
    this.gsFixed = opts.gsFixed || null;                              // fixed ground-station 3D point (Las Vegas)
    if (opts.earthSpinDeg != null) this.engine.setEarthSpin(opts.earthSpinDeg);
    var self = this;
    this._onResize = function () { self.engine.resize(); self._render(); };
    this._downPt = null; this._onDown = function (e) { self._downPt = { x: e.clientX, y: e.clientY }; };
    this._onClick = function (e) { self._click(e); };
    window.addEventListener('resize', this._onResize); canvas.addEventListener('pointerdown', this._onDown); canvas.addEventListener('click', this._onClick);
  }

  SatSim.prototype.setSatellites = function (list) {
    this.engine.clearSatellites();
    this.sats = list.map(function (s) {
      var hex = typeof s.color === 'string' ? parseInt(s.color.replace('#', ''), 16) : s.color;
      return { id: s.id, name: s.name, role: s.role || 'neighbor', answer: !!s.answer, target: !!s.target, hex: hex, css: s.color, kep: s.kep.slice(), baseKep: s.kep.slice(), alive: true, _pos: null };
    });
    this._answerHi = false;
    var maxR = K.EarthRadius * 1.05;
    for (var i = 0; i < this.sats.length; i++) {
      // ENIGMA-1's orbit is drawn thick; the neighbours thin, so YOUR path stands out
      var s = this.sats[i]; this.engine.addSatellite(s.id, s.hex, s.css, s.role === 'attacker' ? TUBE_R * 1.7 : TUBE_R * 0.5, s.name); this.engine.setOrbitLine(s.id, s.kep);
      var p = K.keplerianToECI(s.kep[0], s.kep[1], s.kep[2], s.kep[3], s.kep[4], s.kep[5]); s._pos = p; this.engine.setSatPosition(s.id, p);
      maxR = Math.max(maxR, s.kep[0] * (1 + s.kep[1]));
    }
    this.selectedId = null; this.maneuver = null;
    this._maneuverStartInc = null; this._maneuverStartAlt = null; this._incNow = null; this._altNow = null; this._lastManKey = null;
    this.engine.setPredicted(null); this.engine.setMarker(null);
    // Las Vegas ground station (fixed site) + uplink beam to ENIGMA-1. If no fixed site is
    // configured, fall back to placing it under ENIGMA-1's sub-satellite point.
    var atk = this._attacker();
    this.beamActive = false;
    if (this.gsFixed) {
      this.gsPos = { x: this.gsFixed[0], y: this.gsFixed[1], z: this.gsFixed[2] };
      this.engine.setGS(this.gsPos); this.engine.setBeam(null);
    } else if (atk) {
      var D = this._pos(atk), r = Math.hypot(D.x, D.y, D.z) || 1;
      this.gsPos = { x: D.x / r * K.EarthRadius, y: D.y / r * K.EarthRadius, z: D.z / r * K.EarthRadius };
      // ground-station icon stays put; the uplink beam is only drawn while a command is being sent
      this.engine.setGS(this.gsPos); this.engine.setBeam(null);
    } else { this.gsPos = null; this.engine.setGS(null); this.engine.setBeam(null); }
    this.engine.frame(maxR); this._highlight();
  };
  SatSim.prototype._get = function (id) { for (var i = 0; i < this.sats.length; i++) if (this.sats[i].id === id) return this.sats[i]; return null; };
  SatSim.prototype._attacker = function () { return this.sats.filter(function (s) { return s.role === 'attacker'; })[0] || this.sats[0]; };
  SatSim.prototype._pos = function (s) { if (this._epoch && s._pos) return s._pos; return K.keplerianToECI(s.kep[0], s.kep[1], s.kep[2], s.kep[3], s.kep[4], s.kep[5]); };
  SatSim.prototype._satPositions = function () { var o = {}; for (var i = 0; i < this.sats.length; i++) if (this.sats[i].alive) o[this.sats[i].id] = this._pos(this.sats[i]); return o; };
  SatSim.prototype.getInfo = function (id) {
    var s = this._get(id); if (!s) return null;
    return { name: s.name, role: s.role, altKm: Math.round((s.kep[0] - K.EarthRadius) / 1000), incDeg: Math.round(s.kep[2] * 10) / 10, raanDeg: Math.round(s.kep[3] * 10) / 10 };
  };
  // a satellite is reachable only if it shares ENIGMA-1's orbital node (RAAN) — ENIGMA-1 can
  // change altitude + inclination but NOT RAAN, so a different-RAAN target can never be hit
  SatSim.prototype._isReachable = function (s) {
    var atk = this._attacker(); if (!atk || !s || s.role === 'attacker') return false;
    return Math.abs(((s.kep[3] - atk.kep[3]) % 360 + 540) % 360 - 180) <= 2;
  };
  SatSim.prototype.getAnswer = function () { for (var i = 0; i < this.sats.length; i++) if (this.sats[i].answer) return this.sats[i]; return null; };
  // hint: paint the reachable (answer) orbit a bright colour and enlarge its marker
  SatSim.prototype.highlightAnswer = function (on) {
    var a = this.getAnswer(); if (!a) return;
    this._answerHi = !!on;
    this.engine.setOrbitColor(a.id, on ? COLOR.answerHi : a.hex);
    this.engine.setSatSize(a.id, on ? 0.14 : (a.id === this.selectedId || a.id === this.lockId ? 0.11 : 0.078));
    this.engine.render();
  };

  // Satellites are the primary focus of the view, so they are drawn noticeably
  // larger than the ground-station marker (GS icon ~0.052): neighbours 0.078,
  // ENIGMA-1 0.095, and the selected/locked one 0.11.
  SatSim.prototype._highlight = function () {
    for (var i = 0; i < this.sats.length; i++) {
      var s = this.sats[i], sel = (s.id === this.selectedId || s.id === this.lockId);
      this.engine.setSatSize(s.id, sel ? 0.11 : (s.role === 'attacker' ? 0.095 : 0.078));
    }
  };
  SatSim.prototype.setSelected = function (id) { var s = this._get(id); if (!s) return; this.selectedId = id; this.engine.setFocus(this._pos(s)); this._highlight(); if (this.onSelect) this.onSelect(id); this.engine.render(); };
  SatSim.prototype.focusEarth = function () { this.selectedId = null; this.engine.targetEarth(); this._highlight(); if (this.onSelect) this.onSelect(null); this.engine.render(); };
  SatSim.prototype.lockOn = function (id) { this.lockId = id; this._highlight(); };
  SatSim.prototype._click = function (e) {
    if (this._downPt && (Math.abs(e.clientX - this._downPt.x) + Math.abs(e.clientY - this._downPt.y) > 4)) return;
    var id = this.engine.pick(e.clientX, e.clientY, this._satPositions()); if (id) this.setSelected(id); else this.focusEarth();
  };

  // ── planner ─────────────────────────────────────────────────────────────────
  SatSim.prototype._predictedKep = function () {
    var a = this._attacker(); if (!a || !this.maneuver) return null;
    var m = this.maneuver, cur = a.kep;
    if (Math.round((cur[0] - K.EarthRadius) / 1000) === m.altKm && cur[2] === m.inc && cur[3] === m.raan) return null;
    return [K.EarthRadius + m.altKm * 1000, 0, m.inc, m.raan, 0, cur[5]];
  };
  SatSim.prototype._nearestTargetToOrbit = function (kep, reachableOnly) {
    var best = null;
    for (var i = 0; i < this.sats.length; i++) {
      var s = this.sats[i]; if (s.role === 'attacker' || !s.alive) continue;
      if (reachableOnly && !this._isReachable(s)) continue;
      var P = this._pos(s), c = closestOrbitPoint(kep, P);
      if (!best || c.dist < best.dist) best = { sat: s, dist: c.dist, nu: c.nu, pos: c.pos, targetPos: P };
    }
    return best;
  };

  // ── STAGE 1 (scenario 5): circular-altitude gate + plane nudge, live MOID ─────
  // The target is the fixed victim orbit (flagged target:true in scenario.js).
  SatSim.prototype._target = function () {
    for (var i = 0; i < this.sats.length; i++) if (this.sats[i].target) return this.sats[i];
    return null;
  };
  // victim-centred RTN decomposition (km) of a relative-position vector
  SatSim.prototype._rtn = function (sV, rel) {
    var R = CC.unit(sV.r), W = CC.unit(CC.cross(sV.r, sV.v)), S = CC.cross(W, R);
    return { radialKm: Math.round(CC.dot(rel, R) / 1000),
             inTrackKm: Math.round(CC.dot(rel, S) / 1000),
             crossTrackKm: Math.round(CC.dot(rel, W) / 1000) };
  };
  // Participant sets ENIGMA-1's target CIRCULAR altitude (up/down) + a small cross-
  // track plane nudge (left/right). Redraws its predicted orbit, computes the live
  // MOID against the victim, and (when they cross) the collision point + closing
  // speed. Returns a summary and fires onClosest.
  SatSim.prototype.setStage1 = function (o) {
    o = o || {};
    var atk = this._attacker(), tgt = this._target();
    if (!atk || !tgt || !CC) return null;
    var base = atk.baseKep;
    var altKm = (o.targetAltKm != null) ? o.targetAltKm : (base[0] - K.EarthRadius) / 1000;
    var crossDv = o.crossDv || 0;
    // predicted orbit: circular at altKm on the start plane, then a cross-track nudge
    var circ = [K.EarthRadius + altKm * 1000, 0, base[2], base[3], 0, base[5]];
    var pred = crossDv ? CC.applyManeuver3D(circ, 0, 0, crossDv) : circ.slice();
    atk.kep = pred.slice();
    this.engine.setOrbitLine(atk.id, pred);
    this.engine.setSatPosition(atk.id, K.keplerianToECI(pred[0], pred[1], pred[2], pred[3], pred[4], pred[5]));
    // live MOID vs the victim
    var mo = CC.numericMOID(pred, tgt.kep, 480);
    var intersects = mo.moid <= this.collisionThreshold;
    // closing speed + RTN miss at the closest approach
    var nuA = CC.nuAtPoint(pred, mo.collisionPoint), nuV = CC.nuAtPoint(tgt.kep, mo.collisionPoint);
    var sA = CC.stateFromElements(pred[0], pred[1], pred[2], pred[3], pred[4], nuA);
    var sV = CC.stateFromElements(tgt.kep[0], tgt.kep[1], tgt.kep[2], tgt.kep[3], tgt.kep[4], nuV);
    var closing = CC.norm(CC.sub(sA.v, sV.v));
    var rtn = this._rtn(sV, CC.sub(sA.r, sV.r));
    var cp = mo.collisionPoint;
    this.engine.setMarker(intersects ? { x: cp[0], y: cp[1], z: cp[2] } : null, 0xff3b4e);
    this._stage1 = { pred: pred, moid: mo.moid, collisionPoint: cp, closing: closing, nuA: nuA, nuV: nuV, targetId: tgt.id };
    var res = {
      intersects: intersects, moid: mo.moid, moidKm: Math.round(mo.moid / 1000),
      collisionPoint: { x: Math.round(cp[0]), y: Math.round(cp[1]), z: Math.round(cp[2]) },
      collisionPointRaw: cp,
      closingKmS: Math.round(closing / 100) / 10, closingMs: Math.round(closing),
      victim: tgt.name, victimNuDeg: Math.round(nuV), rtn: rtn, altKm: Math.round(altKm),
      attackerKep: pred.slice(), attackerNuDeg: Math.round(nuA), victimKep: tgt.kep.slice()
    };
    if (this.onClosest) this.onClosest(res);
    this._render();
    return res;
  };

  // ── victim playback (scenario 5): set ENIGMA-1's maneuvered orbit, then blow it ─
  // up at the collision point (explosion + debris cascade), killing the target.
  SatSim.prototype.setAttackerOrbit = function (kep) {
    var atk = this._attacker(); if (!atk || !kep) return;
    atk.kep = kep.slice();
    this.engine.setOrbitLine(atk.id, kep);
    this.engine.setSatPosition(atk.id, K.keplerianToECI(kep[0], kep[1], kep[2], kep[3], kep[4], kep[5]));
    this._render();
  };
  SatSim.prototype.detonate = function (pointRaw, victimId) {
    var atk = this._attacker();
    var p = { x: pointRaw[0], y: pointRaw[1], z: pointRaw[2] };
    this.engine.setSatPosition(atk.id, p);                 // slam ENIGMA-1 onto the point
    if (victimId) this.engine.setSatPosition(victimId, p);
    this.triggerFX(p, [atk && atk.id, victimId]);
    this.mode = 'playback';
    if (!this.running) this.start();
    return { victimId: victimId, pos: p };
  };

  SatSim.prototype.setManeuver = function (m) {
    this.maneuver = { altKm: +m.altKm, inc: +m.inc, raan: +m.raan };
    var res = this._analyze(); var pred = this._predictedKep();
    if (pred) {
      var hex = res.status === 'course' ? COLOR.predHit : COLOR.predOK;
      var atk = this._attacker();
      var nuStart = atk ? closestOrbitPoint(pred, this._pos(atk)).nu : 0;   // path starts where ENIGMA-1 is
      // draw the path forward only as far as the impact point (or a 210° preview when off-course),
      // so it reads as a trajectory the satellite flies — not the whole new orbit ring
      var sweep = 210;
      if (res.status === 'course' && res.markerNu != null) {
        var fwd = ((res.markerNu - nuStart) % 360 + 360) % 360;
        sweep = Math.max(40, Math.min(340, fwd + 24));
      }
      this.engine.setPredicted(pred, hex, nuStart, sweep); this.engine.setMarker(res.markerPos, hex);
    } else { this.engine.setPredicted(null); this.engine.setMarker(null); }
    this.engine.render(); if (this.onClosest && res) this.onClosest(res); return res;
  };
  SatSim.prototype._analyze = function () {
    var atk = this._attacker(); if (!atk) return null;
    var pred = this._predictedKep(); var res = { hasManeuver: !!pred, status: 'idle', collided: false, victimName: null, distKm: null, markerPos: null };
    if (pred) {
      var nearAll = this._nearestTargetToOrbit(pred);          // nearest overall (for the readout)
      var nearHit = this._nearestTargetToOrbit(pred, true);    // nearest REACHABLE (same-plane) target
      if (nearHit && nearHit.dist <= this.collisionThreshold) {
        res.status = 'course'; res.collided = true;
        res.distKm = Math.round(nearHit.dist / 1000); res.victimName = nearHit.sat.name; res.markerPos = nearHit.pos; res.markerNu = nearHit.nu;
      } else if (nearAll) {
        res.distKm = Math.round(nearAll.dist / 1000); res.victimName = nearAll.sat.name; res.markerPos = nearAll.pos; res.markerNu = nearAll.nu;
        // path crosses a satellite but on a different orbital plane (RAAN) => unreachable
        res.status = (nearAll.dist <= this.collisionThreshold && !this._isReachable(nearAll.sat)) ? 'plane' : 'off';
      }
    }
    this._cache = res; return res;
  };

  // ── playback: stage the collision at the aimed point (re-phase both to meet there) ─
  // GS→ENIGMA-1 uplink beam: flash it for a few seconds when a command is uplinked, then drop it.
  SatSim.prototype.pulseBeam = function (sec) {
    if (!this.gsPos) return;
    this.beamActive = true;
    if (this._beamTimer) root.clearTimeout(this._beamTimer);
    var self = this;
    this._beamTimer = root.setTimeout(function () {
      self.beamActive = false; self._beamTimer = null; self.engine.setBeam(null); self.engine.render();
    }, (sec || 3.5) * 1000);
    this._render();
  };

  SatSim.prototype.applyManeuver = function (m) {
    this.maneuver = { altKm: +m.altKm, inc: +m.inc, raan: +m.raan };
    var atk = this._attacker(); if (!atk) return null;
    var startInc = atk.kep[2];                          // pre-maneuver inclination — the ramp starts here
    var startA = atk.kep[0];                            // pre-maneuver semi-major axis
    var startAlt = (startA - K.EarthRadius) / 1000;     // km
    this.pulseBeam(4);   // the command is arriving from the ground station — show the uplink beam briefly
    var newKep = [K.EarthRadius + this.maneuver.altKm * 1000, 0, this.maneuver.inc, this.maneuver.raan, 0, atk.kep[5]];
    // keep the orbit line at the CURRENT orbit; _step grows/tilts it toward the target gradually
    atk.kep = newKep; this.engine.setOrbitLine(atk.id, [startA, 0, startInc, newKep[3], newKep[4], newKep[5]]);
    this.engine.setPredicted(null); this.engine.setMarker(null);

    var near = this._nearestTargetToOrbit(newKep, true);   // only a reachable (same-plane) satellite can be struck
    var onCourse = near && near.dist <= this.collisionThreshold;
    var per = K.period(newKep[0]);
    var epoch = this.sats.map(function (s) { return { id: s.id, kep: s.kep.slice() }; });
    var outcome, Re = K.EarthRadius;

    if (onCourse) {
      var victim = near.sat;
      var C = near.pos;                                  // collision point (on ENIGMA-1's orbit, over the target)
      var nA = Math.sqrt(K.MuEarth / Math.pow(newKep[0], 3));
      // Run in along a fixed arc that stays clear of the orbital nodes (nu 0 / 180),
      // where a shared-plane target would graze early. This keeps the approach a single
      // clean converge instead of a node-cross-then-merge.
      var sweepDeg = Math.min(52, Math.max(24, near.nu - 8));
      var tCol = sweepDeg * DEG / nA;
      var nuCa = near.nu;                                // ENIGMA-1 true anomaly at C
      var nu0A = (((nuCa - sweepDeg) % 360) + 360) % 360;
      var vc = closestOrbitPoint(victim.kep, C);         // victim true anomaly nearest C
      var nV = Math.sqrt(K.MuEarth / Math.pow(victim.kep[0], 3));
      var nu0V = (((vc.nu - nV * tCol / DEG) % 360) + 360) % 360;
      for (var i = 0; i < epoch.length; i++) {
        if (epoch[i].id === atk.id) epoch[i].kep = [newKep[0], 0, newKep[2], newKep[3], 0, nu0A];
        if (epoch[i].id === victim.id) epoch[i].kep = [victim.kep[0], victim.kep[1], victim.kep[2], victim.kep[3], victim.kep[4], nu0V];
      }
      outcome = { collided: true, tCollision: tCol, victimId: victim.id, victimName: victim.name, pos: C,
        altKm: this.maneuver.altKm, distKm: Math.round(near.dist / 1000) };
      this.playbackSpeed = Math.max(60, Math.min(600, tCol / this.impactTargetSec));
      // the plane keeps tilting right up to the impact — they meet exactly as the last degree lands
      this._maneuverDur = tCol;
    } else {
      outcome = { collided: false, victimId: near ? near.sat.id : null, victimName: near ? near.sat.name : null,
        distKm: near ? Math.round(near.dist / 1000) : null, altKm: this.maneuver.altKm, pos: null };
      this.playbackSpeed = 140;
      this._maneuverDur = per * 0.9 * 0.6;
    }
    // gradual ramp: grow/shrink altitude + tilt inclination from the current orbit to the target
    this._maneuverStartInc = startInc; this._maneuverTargetInc = this.maneuver.inc;
    this._maneuverStartAlt = startAlt; this._maneuverTargetAlt = this.maneuver.altKm;
    this._incNow = startInc; this._altNow = startAlt; this._lastManKey = null;
    this._epoch = epoch; this.simTime = 0; this.outcome = outcome; this._playedOut = false; this._highlight(); this.start();
    return outcome;
  };
  // Predict the WALL-CLOCK seconds until impact for a maneuver, WITHOUT animating.
  // Mirrors the timing applyManeuver() uses (playback collides at simTime >= tCol,
  // and simTime advances at playbackSpeed), so the attacker console can show a
  // countdown that lines up with the collision monitor 2 plays. Returns null when
  // the maneuver does not put ENIGMA-1 on a reachable collision course.
  SatSim.prototype.predictCollisionEtaSec = function (m) {
    var atk = this._attacker(); if (!atk) return null;
    var newKep = [K.EarthRadius + (+m.altKm) * 1000, 0, (+m.inc), (+m.raan), 0, atk.kep[5]];
    var near = this._nearestTargetToOrbit(newKep, true);
    if (!near || near.dist > this.collisionThreshold) return null;
    var nA = Math.sqrt(K.MuEarth / Math.pow(newKep[0], 3));
    var sweepDeg = Math.min(52, Math.max(24, near.nu - 8));
    var tCol = sweepDeg * DEG / nA;
    var speed = Math.max(60, Math.min(600, tCol / this.impactTargetSec));
    return tCol / speed;   // seconds of wall-clock time until impact
  };
  SatSim.prototype._epochKep = function (id) { if (!this._epoch) return null; for (var i = 0; i < this._epoch.length; i++) if (this._epoch[i].id === id) return this._epoch[i].kep; return null; };

  SatSim.prototype.start = function () {
    if (this.running) return; this.running = true; this.lastWall = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    var self = this; var tick = function (wall) { if (!self.running) return; var dt = (wall - self.lastWall) / 1000; if (dt > 0.1) dt = 0.1; self.lastWall = wall; self._step(dt); self._render(); self.rafId = root.requestAnimationFrame(tick); };
    this.rafId = root.requestAnimationFrame(tick);
  };
  SatSim.prototype.stop = function () { this.running = false; if (this.rafId != null) root.cancelAnimationFrame(this.rafId); this.rafId = null; };
  SatSim.prototype._render = function () {
    if (this.lockId) { var s = this._get(this.lockId); if (s && s.alive) this.engine.lockCamera(this._pos(s)); }
    else if (this.selectedId) { var sel = this._get(this.selectedId); if (sel && sel.alive) this.engine.setFocus(this._pos(sel)); }
    if (this.gsPos && this.beamActive) { var atk = this._attacker(); if (atk && atk.alive) this.engine.setBeam(this.gsPos, this._pos(atk)); else this.engine.setBeam(null); }
    this.engine.controls.update(); this.engine.render();
  };

  SatSim.prototype._step = function (dt) {
    if (this.fx) this._fxStep(dt);
    if (this.mode !== 'playback' || !this._epoch) return;
    this.simTime += dt * (this.playbackSpeed || 140);
    // ramp ENIGMA-1's altitude + inclination toward the target (1° / 10 km steps): the
    // orbit ring visibly grows and tilts, and both land exactly as the impact fires.
    var atkSat = this._attacker(), atkId = null, atkPos = null;
    if (atkSat && this._maneuverStartInc != null) {
      atkId = atkSat.id;
      var ek0 = this._epochKep(atkId);   // [aFinal, 0, incFinal, raan, 0, nu0A]
      var f = this._maneuverDur > 0 ? Math.min(1, this.simTime / this._maneuverDur) : 1;
      var incNow = this._maneuverStartInc + Math.round(f * (this._maneuverTargetInc - this._maneuverStartInc));
      var altNow = this._maneuverStartAlt + Math.round(f * (this._maneuverTargetAlt - this._maneuverStartAlt) / 10) * 10;
      this._incNow = incNow; this._altNow = altNow;
      var aNow = K.EarthRadius + altNow * 1000;
      var key = incNow + ':' + altNow;
      if (ek0 && key !== this._lastManKey) {
        this._lastManKey = key;
        this.engine.setOrbitLine(atkId, [aNow, 0, incNow, ek0[3], ek0[4], 0]);
      }
      if (ek0) {
        // keep the orbital PHASE from the final orbit (constant period) but render the ramping a + inc
        var nFinal = Math.sqrt(K.MuEarth / Math.pow(ek0[0], 3));
        var nuT = ek0[5] + nFinal * this.simTime / DEG;
        atkPos = K.keplerianToECI(aNow, 0, incNow, ek0[3], ek0[4], nuT);
      }
    }
    for (var i = 0; i < this.sats.length; i++) { var s = this.sats[i]; if (!s.alive) continue; var ek = this._epochKep(s.id); if (!ek) continue;
      if (s.id === atkId && atkPos) s._pos = atkPos;
      else s._pos = K.propagateKepler(ek[0], ek[1], ek[2], ek[3], ek[4], ek[5], this.simTime);
      this.engine.setSatPosition(s.id, s._pos); }
    var out = this.outcome;
    if (out && out.collided && !this._playedOut && this.simTime >= out.tCollision) {
      var atk = this._attacker(); this.triggerFX(out.pos, [atk && atk.id, out.victimId]); this._playedOut = true;
      if (this.onCollision) this.onCollision({ pos: out.pos, victimId: out.victimId, victimName: out.victimName, attackerId: atk && atk.id });
      if (this.onOutcome) this.onOutcome({ collided: true, victimId: out.victimId, victimName: out.victimName });
    }
    if (out && !out.collided && !this._playedOut) { var per = K.period(this._attacker().kep[0]); if (this.simTime >= per * 0.9) { this._playedOut = true; if (this.onOutcome) this.onOutcome({ collided: false, distKm: out.distKm }); } }
    if (this.onTick) this.onTick(this._telemetry());
  };
  SatSim.prototype._telemetry = function () {
    var atk = this._attacker();
    return { simTime: this.simTime, altKm: atk ? Math.round(this._altNow != null ? this._altNow : (atk.kep[0] - K.EarthRadius) / 1000) : 0,
      incDeg: atk ? Math.round((this._incNow != null ? this._incNow : atk.kep[2]) * 10) / 10 : 0, raanDeg: atk ? Math.round(atk.kep[3] * 10) / 10 : 0,
      alive: this.sats.filter(function (s) { return s.alive; }).length, total: this.sats.length,
      collided: this.outcome ? this.outcome.collided : false };
  };

  SatSim.prototype.triggerFX = function (pos, ids) { if (!pos) return; this.fx = { t: 0, total: 3.6, pos: pos, ids: (ids || []).filter(Boolean), applied: {} }; };
  SatSim.prototype._fxStep = function (dt) {
    var fx = this.fx, Re = K.EarthRadius, t = (fx.t += dt), i;
    if (t >= 0 && !fx.applied[0]) { for (i = 0; i < fx.ids.length; i++) { this.engine.tintSat(fx.ids[i], 0xffff00); this.engine.setSatSize(fx.ids[i], 0.12); this.engine.setOrbitColor(fx.ids[i], 0xff3838); } this.engine.showWarning(true); fx.applied[0] = true; }
    if (t >= 0.4 && !fx.applied[1]) { for (i = 0; i < fx.ids.length; i++) this.engine.tintSat(fx.ids[i], 0xff2020); this.engine.showExplosion(fx.pos, Re * 0.05); fx.applied[1] = true; }
    if (t >= 1.0 && !fx.applied[2]) { this.engine.showExplosion(fx.pos, Re * 0.2); this.engine.showDebris(fx.pos, Re * 0.13); fx.applied[2] = true; }
    if (t >= 2.4 && !fx.applied[3]) { for (i = 0; i < fx.ids.length; i++) { this.engine.setSatVisible(fx.ids[i], false); this._kill(fx.ids[i]); } fx.applied[3] = true; }
    if (t >= 3.1 && !fx.applied[4]) { this.engine.hideExplosion(); this.engine.showWarning(false); fx.applied[4] = true; }
    if (t >= fx.total) { this.engine.hideDebris(); this.fx = null; }
  };
  SatSim.prototype._kill = function (id) { var s = this._get(id); if (s) s.alive = false; };

  SatSim.prototype.reset = function () {
    this.stop(); var maxR = K.EarthRadius * 1.05;
    for (var i = 0; i < this.sats.length; i++) {
      var s = this.sats[i]; s.kep = s.baseKep.slice(); s.alive = true; s._pos = null;
      this.engine.setSatVisible(s.id, true); this.engine.tintSat(s.id, 0xffffff); this.engine.setOrbitColor(s.id, s.hex); this.engine.setOrbitLine(s.id, s.kep);
      var p = K.keplerianToECI(s.kep[0], s.kep[1], s.kep[2], s.kep[3], s.kep[4], s.kep[5]); s._pos = p; this.engine.setSatPosition(s.id, p);
      maxR = Math.max(maxR, s.kep[0] * (1 + s.kep[1]));
    }
    this.maneuver = null; this.simTime = 0; this.fx = null; this.outcome = null; this._epoch = null; this._playedOut = false; this._cache = null;
    this._maneuverStartInc = null; this._maneuverTargetInc = null; this._maneuverStartAlt = null; this._maneuverTargetAlt = null;
    this._incNow = null; this._altNow = null; this._lastManKey = null;
    this.engine.hideExplosion(); this.engine.hideDebris(); this.engine.showWarning(false); this.engine.setPredicted(null); this.engine.setMarker(null);
    this.selectedId = null;
    this.beamActive = false; if (this._beamTimer) { root.clearTimeout(this._beamTimer); this._beamTimer = null; }
    if (this.gsPos) { this.engine.setGS(this.gsPos); this.engine.setBeam(null); }
    this.engine.frame(maxR); this._highlight(); this.engine.render();
  };
  SatSim.prototype._resize = function () { this.engine.resize(); this._render(); };
  SatSim.prototype.destroy = function () { this.stop(); window.removeEventListener('resize', this._onResize); this.canvas.removeEventListener('pointerdown', this._onDown); this.canvas.removeEventListener('click', this._onClick); this.engine.dispose(); };

  root.SatSim = SatSim;
})(typeof window !== 'undefined' ? window : this);
