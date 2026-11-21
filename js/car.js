// 3D car model built from primitives (front of the car points to +X, right side is +Z).
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { RoomEnvironment } from '../vendor/RoomEnvironment.js';

const LEVEL_COLORS = { bad: '#ff5a5f', warn: '#f5b83d', ok: '#34c77b' };

export class CarViewer {
  constructor(container, { bodyColor = '#c8102e', onSelect } = {}) {
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
    this.scene = scene;

    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(4, 8, 3);
    scene.add(sun);
    scene.add(new THREE.HemisphereLight(0xbcd4ff, 0x202530, 0.5));

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    Object.assign(this.controls, {
      enableDamping: true,
      dampingFactor: 0.08,
      enablePan: false,
      minDistance: 4,
      maxDistance: 22,
      maxPolarAngle: Math.PI * 0.52,
      autoRotate: true,
      autoRotateSpeed: 0.8,
      rotateSpeed: 0.9,
    });
    this.controls.target.set(0, 0.65, 0);
    this.controls.addEventListener('start', () => {
      this.controls.autoRotate = false;
      this.onInteract?.();
    });

    this.car = new THREE.Group();
    scene.add(this.car);
    this.#buildCar(bodyColor);
    this.#buildShadow();

    this.raycaster = new THREE.Raycaster();
    this.#bindTap();

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.clock = new THREE.Clock();
    renderer.setAnimationLoop(() => this.#tick());
  }

  // ---------- model ----------
  #part(id, mesh, anchor) {
    if (!this.parts.has(id)) this.parts.set(id, { meshes: [], anchor: null, marker: null });
    const p = this.parts.get(id);
    mesh.traverse((o) => {
      if (o.isMesh) {
        o.userData.partId = id;
        o.material = o.material.clone();
        o.userData.baseEmissive = o.material.emissive ? o.material.emissive.clone() : null;
        o.userData.baseEmissiveIntensity = o.material.emissiveIntensity ?? 1;
        p.meshes.push(o);
      }
    });
    if (anchor) p.anchor = new THREE.Vector3(...anchor);
    this.car.add(mesh);
    return mesh;
  }

  #buildCar(bodyColor) {
    this.bodyMat = new THREE.MeshPhysicalMaterial({
      color: bodyColor, metalness: 0.55, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08,
    });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x15181e, roughness: 0.7, metalness: 0.2 });
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0x0b131d, metalness: 0.2, roughness: 0.05,
      side: THREE.DoubleSide, clearcoat: 1,
    });
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.92 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xd4d8de, metalness: 1, roughness: 0.25 });
    const chromeMat = new THREE.MeshStandardMaterial({ color: 0xcfd3d8, metalness: 1, roughness: 0.15 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0xf4f7ff, emissive: 0xdbe8ff, emissiveIntensity: 0.35, roughness: 0.1, metalness: 0.3 });
    const tailMat = new THREE.MeshStandardMaterial({ color: 0xb3121b, emissive: 0x8a0008, emissiveIntensity: 0.4, roughness: 0.2 });
    const plateMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 });

    const W = 0.85; // half width (before bevel)
    const WHEEL_X = 1.35, WHEEL_R = 0.33;

    // Lower body (side profile extruded across width)
    const s = new THREE.Shape();
    s.moveTo(-2.15, 0.28);
    s.lineTo(-WHEEL_X - 0.42, 0.28);
    s.absarc(-WHEEL_X, WHEEL_R, 0.42, Math.PI, 0, true);
    s.lineTo(WHEEL_X - 0.42, 0.28);
    s.absarc(WHEEL_X, WHEEL_R, 0.42, Math.PI, 0, true);
    s.lineTo(2.2, 0.28);
    s.lineTo(2.26, 0.55);
    s.lineTo(2.15, 0.78);
    s.lineTo(0.85, 0.95);
    s.lineTo(-1.6, 0.98);
    s.lineTo(-2.15, 0.92);
    s.lineTo(-2.22, 0.6);
    s.closePath();
    const bodyGeo = new THREE.ExtrudeGeometry(s, {
      depth: W * 2, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 4, curveSegments: 28,
    });
    bodyGeo.translate(0, 0, -W);
    const body = new THREE.Group();
    body.add(new THREE.Mesh(bodyGeo, this.bodyMat));
    // underbody / wheel wells
    const under = new THREE.Mesh(new THREE.BoxGeometry(3.9, 0.22, 1.3), darkMat);
    under.position.set(0, 0.38, 0);
    body.add(under);
    // grille
    const grille = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.9), darkMat);
    grille.position.set(2.27, 0.5, 0);
    body.add(grille);
    // plates
    const fp = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.14, 0.42), plateMat);
    fp.position.set(2.31, 0.36, 0);
    const rp = fp.clone();
    rp.position.set(-2.26, 0.5, 0);
    body.add(fp, rp);
    // door handles
    for (const z of [-1, 1]) {
      for (const x of [0.25, -0.75]) {
        const h = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.03, 0.03), chromeMat);
        h.position.set(x, 0.86, z * (W + 0.065));
        body.add(h);
      }
    }
    this.#part('body', body, [-0.45, 0.68, W + 0.12]);

    // Hood (engine room)
    const hood = this.#quad([2.15, 0.78], [0.85, 0.95], W - 0.04, 0.056, this.bodyMat, 1);
    this.#part('engine', hood, [1.5, 0.98, 0]);

    // Cabin (roof / pillars) => interior
    const c = new THREE.Shape();
    c.moveTo(1.0, 0.9);
    c.lineTo(0.85, 0.98);
    c.lineTo(-0.05, 1.42);
    c.lineTo(-0.95, 1.44);
    c.lineTo(-1.6, 1.0);
    c.lineTo(-1.65, 0.9);
    c.closePath();
    const CW = 0.72;
    const cabinGeo = new THREE.ExtrudeGeometry(c, {
      depth: CW * 2, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 3,
    });
    cabinGeo.translate(0, 0, -CW);
    this.#part('interior', new THREE.Mesh(cabinGeo, this.bodyMat), [-0.5, 1.52, 0]);

    // Windshield & rear window
    this.#part('windshield', this.#quad([0.85, 0.98], [-0.05, 1.42], CW - 0.02, 0.045, glassMat, 1), [0.42, 1.24, 0]);
    this.#part('rear_window', this.#quad([-0.95, 1.44], [-1.6, 1.0], CW - 0.04, 0.045, glassMat, 1), [-1.3, 1.26, 0]);

    // Side windows
    const side = new THREE.Group();
    const winA = [[0.72, 1.0], [-0.02, 1.37], [-0.3, 1.375], [-0.3, 1.0]];
    const winB = [[-0.4, 1.0], [-0.4, 1.38], [-0.92, 1.39], [-1.5, 1.0]];
    for (const pts of [winA, winB]) {
      const sh = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
      const g = new THREE.ShapeGeometry(sh);
      for (const z of [-1, 1]) {
        const m = new THREE.Mesh(g, glassMat);
        m.position.z = z * (CW + 0.045);
        side.add(m);
      }
    }
    this.#part('side_window', side, [-0.35, 1.2, CW + 0.1]);

    // Wipers
    const wipers = new THREE.Group();
    for (const z of [-0.32, 0.3]) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.025, 0.6), darkMat);
      w.position.set(0.86, 1.03, z);
      w.rotation.y = 0.18;
      wipers.add(w);
    }
    this.#part('wiper', wipers, [0.9, 1.08, 0.35]);

    // Head lights / tail lights
    const heads = new THREE.Group();
    const tails = new THREE.Group();
    for (const z of [-1, 1]) {
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.11, 0.38), headMat);
      h.position.set(2.215, 0.69, z * 0.55);
      h.rotation.z = -0.5;
      heads.add(h);
      const t = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.4), tailMat);
      t.position.set(-2.215, 0.8, z * 0.55);
      t.rotation.z = -0.2;
      tails.add(t);
    }
    this.#part('headlight', heads, [2.32, 0.72, 0.55]);
    this.#part('taillight', tails, [-2.32, 0.84, 0.55]);

    // Mirrors
    const mirrors = new THREE.Group();
    for (const z of [-1, 1]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.16), this.bodyMat);
      m.position.set(0.72, 1.04, z * (W + 0.12));
      const g = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.07, 0.12), glassMat);
      g.position.set(0.635, 1.04, z * (W + 0.12));
      mirrors.add(m, g);
    }
    this.#part('mirror', mirrors, [0.72, 1.18, W + 0.15]);

    // Wheels
    const wheelDefs = [
      ['tire_fl', WHEEL_X, -1], ['tire_fr', WHEEL_X, 1],
      ['tire_rl', -WHEEL_X, -1], ['tire_rr', -WHEEL_X, 1],
    ];
    this.wheels = [];
    for (const [id, x, side] of wheelDefs) {
      const wheel = this.#wheel(tireMat, rimMat, side);
      wheel.position.set(x, WHEEL_R, side * 0.78);
      this.wheels.push(wheel);
      this.#part(id, wheel, [x, WHEEL_R + 0.05, side * 1.02]);
    }

    // Markers (status dots shown over parts)
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

  #quad([x1, y1], [x2, y2], halfW, offset, mat) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    // outward normal (pointing up / away from the car)
    let nx = -dy / len, ny = dx / len;
    if (ny < 0) { nx = -nx; ny = -ny; }
    const ox = nx * offset, oy = ny * offset;
    const v = new Float32Array([
      x1 + ox, y1 + oy, -halfW,
      x1 + ox, y1 + oy, halfW,
      x2 + ox, y2 + oy, halfW,
      x2 + ox, y2 + oy, -halfW,
    ]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(v, 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.computeVertexNormals();
    const m = mat.clone();
    m.side = THREE.DoubleSide;
    return new THREE.Mesh(g, m);
  }

  #wheel(tireMat, rimMat, side) {
    const g = new THREE.Group();
    const tireGeo = new THREE.TorusGeometry(0.245, 0.085, 18, 40);
    const tire = new THREE.Mesh(tireGeo, tireMat);
    tire.scale.z = 1.35;
    g.add(tire);
    const tread = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.2, 40, 1, true), tireMat);
    tread.rotation.x = Math.PI / 2;
    g.add(tread);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.2, 32), rimMat);
    rim.rotation.x = Math.PI / 2;
    g.add(rim);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.03, 16), rimMat);
    hub.rotation.x = Math.PI / 2;
    hub.position.z = side * 0.115;
    g.add(hub);
    for (let i = 0; i < 5; i++) {
      const sp = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.19, 0.025), rimMat);
      const a = (i / 5) * Math.PI * 2;
      sp.position.set(Math.cos(a) * 0.1, Math.sin(a) * 0.1, side * 0.105);
      sp.rotation.z = a - Math.PI / 2;
      g.add(sp);
    }
    return g;
  }

  #buildShadow() {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    const ctx = cv.getContext('2d');
    const grd = ctx.createRadialGradient(128, 128, 10, 128, 128, 128);
    grd.addColorStop(0, 'rgba(0,0,0,0.75)');
    grd.addColorStop(0.55, 'rgba(0,0,0,0.35)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 256, 256);
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(6.2, 3.2),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false }),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.002;
    this.scene.add(m);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(3.3, 3.34, 96),
      new THREE.MeshBasicMaterial({ color: 0x6f8fc7, transparent: true, opacity: 0.18, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    this.scene.add(ring);
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
      if (moved < 10 && dt < 500) this.#pick(e.clientX, e.clientY);
    });
  }

  #pick(cx, cy) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    // markers first (they are drawn on top)
    const markers = [...this.parts.values()].map((p) => p.marker).filter((m) => m && m.visible);
    let hit = this.raycaster.intersectObjects(markers, false)[0];
    if (!hit) hit = this.raycaster.intersectObjects(this.car.children, true).find((h) => h.object.isMesh);
    const id = hit?.object.userData.partId || null;
    this.select(id);
    this.onSelect(id);
  }

  select(id) {
    this.selected = id;
    if (id) this.controls.autoRotate = false;
    for (const [pid, p] of this.parts) {
      const on = pid === id;
      for (const m of p.meshes) {
        if (!m.material.emissive) continue;
        if (on) {
          m.material.emissive.set(0x3d7bff);
          m.material.emissiveIntensity = 0.55;
        } else {
          m.material.emissive.copy(m.userData.baseEmissive);
          m.material.emissiveIntensity = m.userData.baseEmissiveIntensity;
        }
      }
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

  setBodyColor(color) {
    for (const id of ['body', 'engine', 'interior', 'mirror']) {
      for (const m of this.parts.get(id)?.meshes || []) {
        if (m.material.clearcoat !== undefined && m.material.clearcoat > 0 && m.material.opacity === 1) {
          m.material.color.set(color);
        }
      }
    }
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
    // keep the car (~5m long) inside the screen width on portrait phones
    const dist = Math.min(18, Math.max(8.5, 6.8 / Math.min(this.camera.aspect, 1.4)));
    this.camera.fov = 40;
    this.camera.updateProjectionMatrix();
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
    const tgt = this._insetTarget || 0;
    this._inset = (this._inset || 0) + (tgt - (this._inset || 0)) * 0.15;
    if (Math.abs(this._inset - tgt) < 0.5) this._inset = tgt;
    const { width: w, height: h } = this.renderer.domElement;
    if (this._inset > 0) {
      const pr = this.renderer.getPixelRatio();
      this.camera.setViewOffset(w / pr, h / pr, 0, this._inset * 0.45, w / pr, h / pr);
    } else if (this.camera.view) this.camera.clearViewOffset();
    this.controls.update();
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
