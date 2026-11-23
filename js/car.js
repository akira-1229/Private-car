// 3D car viewer (front of the car points to +X, right side is +Z).
// Shows the built-in Insight model (js/model.js); doors, hood and trunk open on a double tap.
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { RoomEnvironment } from '../vendor/RoomEnvironment.js';
import { buildGarage } from './garage.js';
import { buildModel } from './model.js';
import { cloneMaterial, isClipped } from './detail.js';

const LEVEL_COLORS = { bad: '#ff5a5f', warn: '#f5b83d', ok: '#34c77b' };

export class CarViewer {
  constructor(container, { bodyColor = '#080c0b', plate, onSelect } = {}) {
    this.container = container;
    this.onSelect = onSelect || (() => {});
    this.parts = new Map(); // partId -> { meshes: [], anchor: Vector3, marker }
    this.selected = null;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 1.0;
    this.scene = scene;

    // studio lighting tuned for a dark paint: key, cool rim lights and a soft fill
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(4, 8, 3);
    const rimL = new THREE.DirectionalLight(0xa9c4ff, 1.6);
    rimL.position.set(-6, 3, -5);
    const rimR = new THREE.DirectionalLight(0xffffff, 1.0);
    rimR.position.set(-3, 4, 6);
    scene.add(key, rimL, rimR, new THREE.HemisphereLight(0xcfe0ff, 0x1a1f28, 0.45));

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    Object.assign(this.controls, {
      enableDamping: true,
      dampingFactor: 0.08,
      enablePan: false,
      // the camera stays inside the garage (half size 10m x 8m, ceiling 5.5m)
      minDistance: 3.2,
      maxDistance: 7.4,
      minPolarAngle: Math.PI * 0.2,
      maxPolarAngle: Math.PI * 0.49,
      autoRotate: true,
      autoRotateSpeed: 0.8,
      rotateSpeed: 0.9,
    });
    this.controls.target.set(0, 0.65, 0);
    this.controls.addEventListener('start', () => {
      this.controls.autoRotate = false;
      this._camGoal = null; // the user takes over from any automatic camera move
      this.onInteract?.();
    });

    this.car = new THREE.Group();
    scene.add(this.car);
    this.#buildCar(bodyColor);
    this.#buildShadow();
    this.setPlate(plate || {});
    // glowing copy of parts whose material has no emissive colour (e.g. invisible hit areas)
    this.hlGroup = new THREE.Group();
    this.scene.add(this.hlGroup);
    this.hlMat = new THREE.MeshBasicMaterial({
      color: 0x5b95ff, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending,
      // back faces are culled so the far side of the car does not glow through
      depthWrite: false, depthTest: false, side: THREE.FrontSide,
    });

    this.raycaster = new THREE.Raycaster();
    this.#bindTap();

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.clock = new THREE.Clock();
    renderer.setAnimationLoop(() => this.#tick());
  }

  // ---------- model ----------
  #part(id, mesh, anchor, parent = this.car) {
    if (!this.parts.has(id)) this.parts.set(id, { meshes: [], anchor: null, marker: null });
    const p = this.parts.get(id);
    mesh.traverse((o) => {
      if (o.isMesh) {
        o.userData.partId = id;
        o.material = cloneMaterial(o.material);
        o.userData.baseEmissive = o.material.emissive ? o.material.emissive.clone() : null;
        o.userData.baseEmissiveIntensity = o.material.emissiveIntensity ?? 1;
        p.meshes.push(o);
      }
    });
    if (anchor) p.anchor = new THREE.Vector3(...anchor);
    parent.add(mesh);
    return mesh;
  }

  // Body is a smooth loft traced from a side-view photo of the Insight ZE4 (js/body.js),
  // detailed in js/model.js (grille mesh, LED lamps, trims, wheels, interior, opening panels).
  #buildCar(bodyColor) {
    // number plates (texture drawn in setPlate)
    this.plateTex = new THREE.CanvasTexture(document.createElement('canvas'));
    this.plateTex.colorSpace = THREE.SRGBColorSpace;
    this.plateTex.anisotropy = 8;
    const { panels, wheels } = buildModel({
      car: this.car,
      bodyColor,
      plateTex: this.plateTex,
      part: (id, obj, anchor, parent) => this.#part(id, obj, anchor || null, parent),
    });
    this.panels = panels;
    this.wheels = wheels;

    // ---- markers (status dots shown over parts) ----
    for (const [id, p] of this.parts) {
      if (!p.anchor) continue;
      const mat = new THREE.SpriteMaterial({ map: dotTexture('#ffffff'), depthTest: false, transparent: true });
      const sp = new THREE.Sprite(mat);
      sp.scale.setScalar(0.2);
      sp.position.copy(p.anchor);
      sp.renderOrder = 10;
      sp.visible = false;
      sp.userData.partId = id;
      this.car.add(sp);
      p.marker = sp;
    }
  }

  #buildShadow() {
    // the car sits in a clean private garage
    this.garage = buildGarage();
    this.scene.add(this.garage);

    const cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    const ctx = cv.getContext('2d');
    const grd = ctx.createRadialGradient(128, 128, 10, 128, 128, 128);
    grd.addColorStop(0, 'rgba(0,0,0,0.8)');
    grd.addColorStop(0.55, 'rgba(0,0,0,0.4)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 256, 256);
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(6.0, 2.9),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false }),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.002;
    this.scene.add(m);

  }

  // ---------- interaction ----------
  #bindTap() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.isPrimary) down = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    el.addEventListener('pointerup', (e) => {
      if (!down || !e.isPrimary) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const dt = performance.now() - down.t;
      down = null;
      if (moved >= 10 || dt >= 500) return;
      const now = performance.now(), x = e.clientX, y = e.clientY;
      // double tap opens/closes a door, the hood or the trunk; a single tap shows the part's records
      if (this.panels && last && now - last.t < 320 && Math.hypot(x - last.x, y - last.y) < 40) {
        clearTimeout(pending);
        last = null;
        if (!this.#toggleAt(x, y)) this.#pick(x, y);
        return;
      }
      last = { t: now, x, y };
      clearTimeout(pending);
      if (this.panels) pending = setTimeout(() => this.#pick(x, y), 300);
      else this.#pick(x, y);
    });
    let last = null, pending = 0;
  }

  #rayFrom(cx, cy) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
  }

  // which opening panel a point on the car belongs to (car space, metres)
  static panelAt(p) {
    const az = Math.abs(p.z), side = p.z > 0 ? 'r' : 'l';
    if (p.x > 0.8 && p.y > 0.72 && az < 0.8) return 'hood';
    if (p.x < -1.88 && p.y > 0.58 && az < 0.7) return 'trunk';
    if (az > 0.55 && p.y > 0.24 && p.y < 1.42) {
      const aFront = p.y < 0.95 ? 0.7 : 0.7 - (p.y - 0.95) * 1.6;
      if (p.x > -0.36 && p.x < aFront) return `door_f${side}`;
      if (p.x < -0.36 && p.x > -1.2 && Math.hypot(p.x + 1.35, p.y - 0.32) > 0.48) return `door_r${side}`;
    }
    return null;
  }

  #toggleAt(cx, cy) {
    this.#rayFrom(cx, cy);
    const hit = this.#hits().find((h) => !h.object.isSprite);
    let id = null;
    for (let o = hit?.object; o && !id; o = o.parent) id = o.userData.panelId || null;
    if (!id && hit) id = CarViewer.panelAt(hit.point);
    if (!id || !this.panels.has(id)) return false;
    this.togglePanel(id);
    return true;
  }

  togglePanel(id, open) {
    const p = this.panels?.get(id);
    if (!p) return;
    p.target = open === undefined ? (p.target > 0.5 ? 0 : 1) : (open ? 1 : 0);
    this.controls.autoRotate = false;
    this.onPanel?.(id, p.target > 0.5, p.label);
  }

  #pick(cx, cy) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    // markers first (they are drawn on top)
    const markers = [...this.parts.values()].map((p) => p.marker).filter((m) => m && m.visible);
    let hit = this.raycaster.intersectObjects(markers, false)[0];
    if (!hit) hit = this.#hits()[0];
    let id = hit?.object.userData.partId || null;
    // the engine bay is only shown once the hood has been opened (double tap); a single tap on the closed hood is the body
    if (id === 'engine' && this.panels?.has('hood') && this.panels.get('hood').target < 0.5 && !hit?.object.isSprite) id = 'body';
    this.select(id);
    this.onSelect(id);
  }

  // ray hits on the car, skipping the openings cut into the paint by the shader (grille, lamps,
  // an open door's hole) so a tap there reaches whatever is behind
  #hits() {
    const local = new THREE.Vector3();
    return this.raycaster.intersectObjects(this.car.children, true).filter((h) => {
      const o = h.object;
      if (!o.isMesh || !o.visible || o.isSprite) return false;
      if (!o.material?.userData?.clip) return true;
      // clip regions are defined in the geometry's own (car-space) coordinates
      local.copy(h.point);
      o.worldToLocal(local);
      return !isClipped(o.material, local);
    });
  }

  select(id) {
    this.selected = id;
    if (id) this.controls.autoRotate = false;
    // reset the previous highlight
    for (const p of this.parts.values()) {
      for (const m of p.meshes) {
        if (!m.material.emissive) continue;
        m.material.emissive.copy(m.userData.baseEmissive);
        m.material.emissiveIntensity = m.userData.baseEmissiveIntensity;
      }
    }
    this.hlGroup.clear();
    this.hlMeshes = [];
    const part = id && this.parts.get(id);
    if (!part) return;
    // the body glow also covers the hood and the roof, which are separate tap areas
    const extra = id === 'body' ? ['engine', 'interior'].flatMap((k) => this.parts.get(k)?.meshes || []) : [];
    const meshes = [...part.meshes, ...extra];
    // glow the part itself (and overlay parts that have no emissive colour)
    const overlay = meshes.filter((m) => !m.material.emissive && !m.userData.noGlow);
    if (overlay.length) {
      this.car.updateMatrixWorld(true);
      for (const m of overlay) {
        const o = new THREE.Mesh(m.geometry, this.hlMat);
        o.matrixAutoUpdate = false;
        o.matrix.copy(m.matrixWorld);
        o.renderOrder = 1000;
        this.hlGroup.add(o);
      }
    }
    this.hlMeshes = meshes.filter((m) => m.material.emissive && !m.userData.noGlow);
    for (const m of this.hlMeshes) m.material.emissive.set(0x3d7bff);
  }

  /** Closes every door / the hood / the trunk at once (used when the app comes back to the front). */
  closeAllPanels() {
    if (!this.panels) return;
    for (const p of this.panels.values()) {
      p.t = p.target = 0;
      p.pivot.quaternion.identity();
    }
  }

  setLevels(levels) {
    for (const [id, p] of this.parts) {
      if (!p.marker) continue;
      const lv = levels[id];
      if (lv === 'bad' || lv === 'warn') {
        p.marker.material.map = dotTexture(LEVEL_COLORS[lv]);
        p.marker.material.needsUpdate = true;
        p.marker.visible = true;
        p.marker.userData.level = lv;
      } else {
        p.marker.visible = false;
      }
    }
  }

  // Japanese private-car plate: white with green characters.
  setPlate({ region = '', kana = '', number = '' }) {
    const cv = document.createElement('canvas');
    cv.width = 660; cv.height = 330;
    const ctx = cv.getContext('2d');
    const green = '#0d5c35';
    ctx.fillStyle = '#f7f8f4';
    ctx.fillRect(0, 0, 660, 330);
    ctx.strokeStyle = green;
    ctx.lineWidth = 10;
    ctx.strokeRect(12, 12, 636, 306);
    ctx.fillStyle = green;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const font = (w, px) => `${w} ${px}px "Hiragino Sans", "Noto Sans JP", sans-serif`;
    ctx.font = font(700, 84);
    ctx.fillText(region, 330, 82, 420);
    if (kana) {
      ctx.font = font(700, 70);
      ctx.fillText(kana, 78, 222);
    }
    ctx.font = font(800, 172);
    ctx.fillText(number, kana ? 372 : 330, 222, kana ? 520 : 600);
    this.plateTex.image = cv;
    this.plateTex.needsUpdate = true;
  }

  setBodyColor(color) {
    for (const p of this.parts.values()) {
      for (const m of p.meshes) if (m.material.name === 'paint') m.material.color.set(color);
    }
  }

  /** Smoothly moves the camera to look at a part of the car. */
  focusOn(what) {
    const views = {
      hood: { target: [1.0, 0.75, 0], pos: [5.2, 3.3, 2.4] }, // front three-quarter, looking down into the engine bay
      body: { target: [0, 0.65, 0], pos: [4.6, 2.6, 4.8] },
    };
    const v = views[what];
    if (!v) return;
    this.controls.autoRotate = false;
    this._camGoal = { target: new THREE.Vector3(...v.target), pos: new THREE.Vector3(...v.pos) };
  }

  /** Appearance settings from the 設定 tab. */
  setPrefs({ brightness = 1, autoRotate = true, rotateSpeed = 0.8, garage = true } = {}) {
    // a CSS filter brightens the whole 3D view
    this.renderer.domElement.style.filter = Math.abs(brightness - 1) > 0.01 ? `brightness(${brightness})` : '';
    this.controls.autoRotateSpeed = rotateSpeed;
    if (this.prefAutoRotate !== autoRotate) this.controls.autoRotate = autoRotate && !this.selected;
    this.prefAutoRotate = autoRotate;
    if (this.garage) this.garage.visible = garage;
  }

  // Shift the rendered image up so the car stays visible above the bottom sheet.
  setBottomInset(px) { this._insetTarget = px; }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = h + 'px';
    this.camera.aspect = w / h;
    // the camera has to stay inside the garage, so widen the lens on narrow (portrait) screens
    // until about 38 degrees of horizontal view fit the car at the start distance
    const hfov = THREE.MathUtils.degToRad(38);
    const vfov = 2 * Math.atan(Math.tan(hfov / 2) / this.camera.aspect);
    this.camera.fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(vfov), 40, 72);
    this.camera.updateProjectionMatrix();
    const dist = 6.6;
    if (!this._placed) {
      const dir = new THREE.Vector3(1, 0.42, 1.05).normalize();
      this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
      this._placed = true;
    }
  }

  #tick() {
    const t = this.clock.getElapsedTime();
    for (const p of this.parts.values()) {
      if (p.marker?.visible) {
        const k = p.marker.userData.level === 'bad' ? 3.2 : 2;
        p.marker.scale.setScalar(0.17 + Math.sin(t * k) * 0.035);
      }
    }
    if (this.panels) {
      for (const p of this.panels.values()) {
        if (Math.abs(p.target - p.t) < 0.001) continue;
        p.t += (p.target - p.t) * 0.09;
        if (Math.abs(p.target - p.t) < 0.002) p.t = p.target;
        const e = p.t * p.t * (3 - 2 * p.t);
        p.pivot.quaternion.setFromAxisAngle(p.axis, p.angle * e);
      }
    }
    // slow pulse of the selected part
    const pulse = 0.5 - 0.5 * Math.cos(t * 2.6);
    this.hlMat.opacity = 0.08 + 0.38 * pulse;
    for (const m of this.hlMeshes || []) m.material.emissiveIntensity = 0.08 + 0.7 * pulse;
    const tgt = this._insetTarget || 0;
    this._inset = (this._inset || 0) + (tgt - (this._inset || 0)) * 0.15;
    if (Math.abs(this._inset - tgt) < 0.5) this._inset = tgt;
    const { width: w, height: h } = this.renderer.domElement;
    if (this._inset > 0) {
      const pr = this.renderer.getPixelRatio();
      this.camera.setViewOffset(w / pr, h / pr, 0, this._inset * 0.45, w / pr, h / pr);
    } else if (this.camera.view) this.camera.clearViewOffset();
    if (this._camGoal) {
      const g = this._camGoal;
      this.controls.target.lerp(g.target, 0.07);
      this.camera.position.lerp(g.pos, 0.07);
      if (this.camera.position.distanceTo(g.pos) < 0.01 && this.controls.target.distanceTo(g.target) < 0.01) this._camGoal = null;
    }
    this.controls.update();
    this.garage?.userData.update(this.camera);
    this.renderer.render(this.scene, this.camera);
  }
}

const texCache = new Map();
function dotTexture(color) {
  if (texCache.has(color)) return texCache.get(color);
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 10, 64, 64, 64);
  g.addColorStop(0, color);
  g.addColorStop(0.45, color);
  g.addColorStop(0.5, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.6, hexA(color, 0.45));
  g.addColorStop(1, hexA(color, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(64, 64, 64, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  texCache.set(color, tex);
  return tex;
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
