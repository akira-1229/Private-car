// 3D car viewer (front of the car points to +X, right side is +Z).
// Shows a built-in model made from primitives, or a scanned model (.glb) of the real car.
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { RoomEnvironment } from '../vendor/RoomEnvironment.js';
import { GLTFLoader } from '../vendor/GLTFLoader.js';
import { buildBody, surfacePoint, dloOutline, GLASS, WHEELS, X_FRONT, X_REAR } from './body.js';

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
    this.setPlate(plate || {});
    this.focus = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture(), depthTest: false, transparent: true }));
    this.focus.renderOrder = 9;
    this.focus.visible = false;
    this.car.add(this.focus);

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

  // Body is a smooth loft traced from a side-view photo of the Insight ZE4 (see js/body.js).
  #buildCar(bodyColor) {
    this.bodyMat = new THREE.MeshPhysicalMaterial({
      color: bodyColor, metalness: 0.35, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.04,
    });
    this.bodyMat.name = 'paint';
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.85, metalness: 0.1, side: THREE.DoubleSide });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x050607, roughness: 0.3, metalness: 0.4 });
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0x05080a, metalness: 0.1, roughness: 0.12, side: THREE.DoubleSide, envMapIntensity: 0.45,
    });
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x18181a, roughness: 0.9 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xc4c9cf, metalness: 1, roughness: 0.25 });
    const rimDarkMat = new THREE.MeshStandardMaterial({ color: 0x1e2125, metalness: 0.7, roughness: 0.4 });
    const chromeMat = new THREE.MeshStandardMaterial({ color: 0xe8ecf0, metalness: 1, roughness: 0.07 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xeaf2ff, emissiveIntensity: 1.2, roughness: 0.1 });
    const lensMat = new THREE.MeshPhysicalMaterial({ color: 0x15191f, metalness: 0.6, roughness: 0.08, clearcoat: 1 });
    const tailMat = new THREE.MeshStandardMaterial({ color: 0xa30f19, emissive: 0x8a0009, emissiveIntensity: 0.75, roughness: 0.15 });
    const tailLensMat = new THREE.MeshPhysicalMaterial({ color: 0x3a0508, metalness: 0.2, roughness: 0.06, clearcoat: 1 });
    const plateMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 });

    const W = 0.905;
    const WHEEL_X = WHEELS.x, WHEEL_R = WHEELS.r;
    const tube = (pts, r, mat, closed = false) => new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, closed), Math.max(16, pts.length * 6), r, 10, closed), mat);
    const mirrorZ = (pts) => pts.map((p) => new THREE.Vector3(p.x, p.y, -p.z));
    const surf = (x, y, off) => surfacePoint(x, y, off);

    // ---- smooth body shell ----
    const g = buildBody();
    const body = new THREE.Group();
    body.add(new THREE.Mesh(g.paint, this.bodyMat));
    body.add(new THREE.Mesh(g.under, darkMat));
    // underbody filler between the wheels
    const floor = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.12, 1.3), darkMat);
    floor.position.set(-0.05, 0.27, 0);
    body.add(floor);
    // gloss-black side sills
    for (const sd of [-1, 1]) {
      const pts = [];
      for (let x = -0.95; x <= 0.95; x += 0.19) pts.push(surf(x, 0.3, 0.006));
      body.add(tube(sd > 0 ? pts : mirrorZ(pts), 0.03, trimMat));
    }
    // chrome window surround (Black Style) + beltline
    const dlo = dloOutline(48);
    for (const sd of [-1, 1]) {
      const fix = (arr, off) => arr.map((p) => new THREE.Vector3(p.x, p.y, (p.z + off) * sd));
      body.add(tube(fix(dlo.lower, 0.012), 0.011, chromeMat));
      body.add(tube(fix(dlo.upper, 0.01), 0.009, chromeMat));
      // pillars between the side windows
      for (const [a, b] of GLASS.pillars) {
        const x = (a + b) / 2;
        const lo = dlo.lower.reduce((p, q) => (Math.abs(q.x - x) < Math.abs(p.x - x) ? q : p));
        const hi = dlo.upper.reduce((p, q) => (Math.abs(q.x - x) < Math.abs(p.x - x) ? q : p));
        const pil = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.03, b - a), 1, 0.01), trimMat);
        const len = hi.y - lo.y;
        pil.scale.y = len;
        pil.position.set(x, (lo.y + hi.y) / 2, ((lo.z + hi.z) / 2 + 0.004) * sd);
        pil.rotation.x = -sd * Math.atan2(lo.z - hi.z, len);
        body.add(pil);
      }
    }
    // front: gloss-black grille with plated slats, chrome wing bar, lower intake
    const nose = X_FRONT + 0.04;
    const grille = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.17, 0.64), trimMat);
    grille.position.set(nose - 0.03, 0.53, 0);
    grille.rotation.z = 0.25;
    body.add(grille);
    for (let i = 0; i < 4; i++) {
      const slat = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, 0.6 - i * 0.04), chromeMat);
      slat.position.set(nose + 0.012 - i * 0.012, 0.585 - i * 0.035, 0);
      body.add(slat);
    }
    body.add(tube([
      surf(1.98, 0.7, 0.004), surf(2.16, 0.66, 0.005), new THREE.Vector3(nose + 0.01, 0.64, 0.42),
      new THREE.Vector3(nose + 0.035, 0.635, 0), new THREE.Vector3(nose + 0.01, 0.64, -0.42),
      mirrorZ([surf(2.16, 0.66, 0.005)])[0], mirrorZ([surf(1.98, 0.7, 0.004)])[0],
    ], 0.013, chromeMat));
    const intake = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.8), trimMat);
    intake.position.set(nose - 0.05, 0.34, 0);
    body.add(intake);
    for (const sd of [-1, 1]) {
      const fog = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.22), trimMat);
      fog.position.set(nose - 0.09, 0.39, sd * 0.66);
      fog.rotation.y = sd * 0.5;
      body.add(fog);
    }
    // number plates (texture drawn in setPlate)
    this.plateTex = new THREE.CanvasTexture(document.createElement('canvas'));
    this.plateTex.colorSpace = THREE.SRGBColorSpace;
    this.plateTex.anisotropy = 8;
    const faceMat = new THREE.MeshStandardMaterial({ map: this.plateTex, roughness: 0.5 });
    for (const [x, y, dir] of [[nose + 0.02, 0.44, 1], [X_REAR - 0.075, 0.66, -1]]) {
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.17, 0.34), plateMat);
      back.position.set(x, y, 0);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(0.33, 0.165), faceMat);
      face.rotation.y = dir * Math.PI / 2;
      face.position.set(x + dir * 0.0115, y, 0);
      body.add(back, face);
    }
    // rear: chrome lower garnish, chrome strip over the plate, black diffuser, lip spoiler
    body.add(tube([
      new THREE.Vector3(-2.3, 0.4, 0.6), new THREE.Vector3(X_REAR - 0.035, 0.39, 0.35),
      new THREE.Vector3(X_REAR - 0.04, 0.39, 0), new THREE.Vector3(X_REAR - 0.035, 0.39, -0.35),
      new THREE.Vector3(-2.3, 0.4, -0.6),
    ], 0.014, chromeMat));
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.022, 0.52), chromeMat);
    strip.position.set(X_REAR - 0.07, 0.8, 0);
    body.add(strip);
    const lip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.018, 1.36), trimMat);
    lip.position.set(-2.27, 1.085, 0);
    lip.rotation.z = 0.12;
    body.add(lip);
    // flush door handles
    for (const sd of [-1, 1]) {
      for (const x of [0.15, -0.88]) {
        const p = surf(x, 0.9, 0.012);
        const h = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.03, 0.02), chromeMat);
        h.position.set(p.x, p.y, p.z * sd);
        body.add(h);
      }
    }
    this.#part('body', body, [-0.4, 0.62, W + 0.1]);

    // ---- glass & panels that can be tapped ----
    this.#part('engine', new THREE.Mesh(g.hood, this.bodyMat), [1.5, 0.98, 0]);
    this.#part('interior', new THREE.Mesh(g.roof, this.bodyMat), [-0.5, 1.48, 0]);
    this.#part('windshield', new THREE.Mesh(g.windshield, glassMat), [0.47, 1.2, 0]);
    this.#part('rear_window', new THREE.Mesh(g.rear, glassMat), [-1.4, 1.3, 0]);
    this.#part('side_window', new THREE.Mesh(g.side, glassMat), [-0.4, 1.12, 0.86]);

    // ---- wipers (resting at the base of the windshield) ----
    const wipers = new THREE.Group();
    for (const z of [-0.3, 0.3]) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.02, 0.6), trimMat);
      w.position.set(0.74, 0.99, z);
      w.rotation.set(0, 0.2, -0.6);
      wipers.add(w);
    }
    this.#part('wiper', wipers, [0.78, 1.04, 0.35]);

    // ---- lights: slim LED headlights wrapping the nose, L-shaped tail lights ----
    const heads = new THREE.Group();
    const tails = new THREE.Group();
    for (const sd of [1, -1]) {
      const m = (arr) => (sd > 0 ? arr : mirrorZ(arr));
      const hl = [surf(1.93, 0.75, 0.0), surf(2.06, 0.72, 0.0), surf(2.17, 0.68, 0.0),
        new THREE.Vector3(nose - 0.035, 0.665, 0.56), new THREE.Vector3(nose - 0.005, 0.655, 0.42)];
      heads.add(tube(m(hl), 0.042, lensMat));
      const led = hl.map((p, i) => new THREE.Vector3(p.x + 0.006, p.y + 0.012, p.z + (i < 3 ? 0.03 : 0.0)));
      heads.add(tube(m(led), 0.016, headMat));
      const lower = [new THREE.Vector3(nose - 0.02, 0.61, 0.5), new THREE.Vector3(nose - 0.06, 0.63, 0.62),
        surf(2.12, 0.66, 0.006)];
      heads.add(tube(m(lower), 0.008, headMat));

      const tl = [surf(-2.12, 0.98, 0.0), surf(-2.24, 0.97, 0.0),
        new THREE.Vector3(X_REAR - 0.035, 0.96, 0.66), new THREE.Vector3(X_REAR - 0.06, 0.955, 0.32)];
      tails.add(tube(m(tl), 0.05, tailLensMat));
      tails.add(tube(m(tl.map((p, i) => new THREE.Vector3(p.x - (i > 1 ? 0.04 : 0), p.y + 0.01, p.z + (i < 2 ? 0.04 : 0)))), 0.014, tailMat));
      const refl = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.025, 0.2), tailMat);
      refl.position.set(X_REAR - 0.02, 0.42, sd * 0.62);
      tails.add(refl);
    }
    this.#part('headlight', heads, [2.28, 0.74, 0.58]);
    this.#part('taillight', tails, [-2.46, 1.0, 0.55]);

    // ---- door mirrors (gloss black caps) ----
    const mirrors = new THREE.Group();
    for (const sd of [-1, 1]) {
      const base = surf(0.5, 0.93, 0);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.1, 24, 16), trimMat);
      cap.scale.set(0.95, 0.6, 1.15);
      cap.position.set(0.48, 1.02, sd * (base.z + 0.12));
      const stalk = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.04, 0.12), trimMat);
      stalk.position.set(0.52, 0.97, sd * (base.z + 0.04));
      const glass = new THREE.Mesh(new THREE.CircleGeometry(0.08, 20), glassMat);
      glass.scale.y = 0.62;
      glass.rotation.y = -Math.PI / 2;
      glass.position.set(0.39, 1.02, sd * (base.z + 0.13));
      mirrors.add(cap, stalk, glass);
    }
    this.#part('mirror', mirrors, [0.48, 1.17, W + 0.17]);

    // ---- fuel lid (left rear quarter) ----
    const lidPos = surf(-1.72, 0.86, 0.006);
    const lid = new THREE.Mesh(new THREE.CircleGeometry(0.085, 32), this.bodyMat);
    lid.scale.x = 1.15;
    lid.rotation.y = Math.PI;
    lid.position.set(lidPos.x, lidPos.y, -lidPos.z);
    const lidEdge = new THREE.Mesh(new THREE.RingGeometry(0.084, 0.09, 40), trimMat);
    lidEdge.scale.x = 1.15;
    lidEdge.rotation.y = Math.PI;
    lidEdge.position.set(lidPos.x, lidPos.y, -lidPos.z - 0.001);
    const fuel = new THREE.Group();
    fuel.add(lid, lidEdge);
    this.#part('fuel', fuel, [lidPos.x, lidPos.y + 0.05, -lidPos.z - 0.12]);

    // ---- wheels: 18-inch fine multi-spoke ----
    const wheelDefs = [
      ['tire_fl', WHEEL_X, -1], ['tire_fr', WHEEL_X, 1],
      ['tire_rl', -WHEEL_X, -1], ['tire_rr', -WHEEL_X, 1],
    ];
    this.wheels = [];
    for (const [id, x, sd] of wheelDefs) {
      const wheel = this.#wheel(tireMat, rimMat, rimDarkMat, sd);
      wheel.position.set(x, WHEEL_R, sd * 0.79);
      this.wheels.push(wheel);
      this.#part(id, wheel, [x, WHEEL_R + 0.05, sd * 1.04]);
    }

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

  // 18-inch fine multi-spoke wheel (EX Black Style): dark base with machined spoke faces
  #wheel(tireMat, rimMat, rimDarkMat, side) {
    const g = new THREE.Group();
    const tire = new THREE.Mesh(new THREE.TorusGeometry(0.262, 0.07, 20, 64), tireMat);
    tire.scale.z = 1.6;
    g.add(tire);
    const tread = new THREE.Mesh(new THREE.CylinderGeometry(0.332, 0.332, 0.2, 64, 1, true), tireMat);
    tread.rotation.x = Math.PI / 2;
    g.add(tread);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.228, 0.228, 0.21, 48), rimDarkMat);
    barrel.rotation.x = Math.PI / 2;
    g.add(barrel);
    const lip = new THREE.Mesh(new THREE.TorusGeometry(0.226, 0.01, 8, 64), rimMat);
    lip.position.z = side * 0.105;
    g.add(lip);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.035, 24), rimDarkMat);
    hub.rotation.x = Math.PI / 2;
    hub.position.z = side * 0.115;
    g.add(hub);
    const cap = new THREE.Mesh(new THREE.CircleGeometry(0.03, 24), rimMat);
    cap.position.z = side * 0.134;
    if (side < 0) cap.rotation.y = Math.PI;
    g.add(cap);
    // 10 Y-shaped spokes = 20 thin blades that split towards the rim
    const blade = new THREE.BoxGeometry(0.016, 0.175, 0.02);
    for (let i = 0; i < 10; i++) {
      const base = (i / 10) * Math.PI * 2;
      const stem = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.07, 0.022), rimMat);
      stem.position.set(Math.cos(base) * 0.085, Math.sin(base) * 0.085, side * 0.108);
      stem.rotation.z = base - Math.PI / 2;
      g.add(stem);
      for (const off of [-0.09, 0.09]) {
        const a = base + off;
        const sp = new THREE.Mesh(blade, i % 2 ? rimMat : rimMat);
        sp.position.set(Math.cos(a) * 0.15, Math.sin(a) * 0.15, side * 0.104);
        sp.rotation.z = a - Math.PI / 2 + off * 1.4;
        g.add(sp);
      }
    }
    return g;
  }

  #buildShadow() {
    // soft studio floor light so a dark car still stands out
    const spot = document.createElement('canvas');
    spot.width = spot.height = 256;
    const sctx = spot.getContext('2d');
    const sg = sctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    sg.addColorStop(0, 'rgba(150,175,215,0.35)');
    sg.addColorStop(0.6, 'rgba(110,135,180,0.12)');
    sg.addColorStop(1, 'rgba(90,110,150,0)');
    sctx.fillStyle = sg;
    sctx.fillRect(0, 0, 256, 256);
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(4.6, 64),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(spot), transparent: true, depthWrite: false }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.001;
    this.scene.add(floor);

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

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(3.45, 3.49, 96),
      new THREE.MeshBasicMaterial({ color: 0x8fb0e8, transparent: true, opacity: 0.22, side: THREE.DoubleSide }),
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
    let id = hit?.object.userData.partId || null;
    if (!hit && this.scanKind === 'splat') {
      // the splat scan is aligned to the built-in model, which stays as an invisible hit target
      hit = this.raycaster.intersectObjects(this.car.children, true).find((h) => h.object.isMesh && h.object !== this.focus);
      id = hit?.object.userData.partId || null;
    } else if (!hit && this.scan) {
      hit = this.raycaster.intersectObject(this.scan, true).find((h) => h.object.isMesh);
      if (hit) {
        const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
        id = this.#classify(hit.point, n);
      }
    } else if (!hit) {
      hit = this.raycaster.intersectObjects(this.car.children, true).find((h) => h.object.isMesh && h.object.visible);
      id = hit?.object.userData.partId || null;
    }
    this.select(id);
    this.onSelect(id);
  }

  select(id) {
    this.selected = id;
    if (id) this.controls.autoRotate = false;
    // a scanned model is one big mesh, so show a glow at the part instead of tinting it
    const anchor = id && this.parts.get(id)?.marker;
    this.focus.visible = !!(this.scan && anchor);
    if (this.focus.visible) this.focus.position.copy(anchor.position);
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

  // ---------- scanned model ----------
  async loadModel(source, { flip = false } = {}) {
    const loader = new GLTFLoader();
    const gltf = typeof source === 'string'
      ? await loader.loadAsync(source)
      : await new Promise((res, rej) => loader.parse(source, '', res, rej));
    this.clearModel();
    const obj = gltf.scene;
    obj.traverse((o) => {
      if (o.isMesh) {
        o.frustumCulled = false;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) if (m.map) m.map.anisotropy = 8;
      }
    });
    // lay the longest horizontal axis along X, then normalise to the real length
    const inner = new THREE.Group();
    inner.add(obj);
    let size = new THREE.Box3().setFromObject(inner).getSize(new THREE.Vector3());
    if (size.z > size.x) obj.rotation.y = Math.PI / 2;
    if (flip) obj.rotation.y += Math.PI;
    const wrap = new THREE.Group();
    wrap.add(inner);
    wrap.updateMatrixWorld(true);
    size = new THREE.Box3().setFromObject(wrap).getSize(new THREE.Vector3());
    wrap.scale.setScalar(REF.L / size.x);
    wrap.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(wrap);
    const c = box.getCenter(new THREE.Vector3());
    wrap.position.set(-c.x, -box.min.y, -c.z);
    wrap.updateMatrixWorld(true);
    const dims = new THREE.Box3().setFromObject(wrap).getSize(new THREE.Vector3());
    this.scanScale = new THREE.Vector3(dims.x / REF.L, dims.y / REF.H, dims.z / REF.W);
    this.scan = wrap;
    this.scanKind = 'mesh';
    this.scene.add(wrap);
    for (const o of this.car.children) if (!o.isSprite) o.visible = false;
    for (const p of this.parts.values()) {
      if (p.marker && p.anchor) p.marker.position.copy(p.anchor).multiply(this.scanScale);
    }
    this.select(this.selected);
    return dims;
  }

  /**
   * Shows a Gaussian-splat scan (.spz etc.) of the real car.
   * `matrix` (column-major 4x4) maps the scan into car space: front +X, up +Y, right +Z, metres, ground y = 0.
   */
  async loadSplat(source, matrix) {
    const { SplatMesh, SparkRenderer } = await import('../vendor/spark.module.min.js');
    if (!this.spark) {
      this.spark = new SparkRenderer({ renderer: this.renderer });
      this.scene.add(this.spark);
    }
    const opts = typeof source === 'string' ? { url: source } : { fileBytes: source, fileType: 'spz' };
    const splat = new SplatMesh(opts);
    await splat.initialized;
    this.clearModel();
    const wrap = new THREE.Group();
    if (matrix) {
      wrap.matrixAutoUpdate = false;
      wrap.matrix.fromArray(matrix);
    }
    wrap.add(splat);
    this.scan = new THREE.Group();
    this.scan.add(wrap, this.#splatCore());
    this.scanKind = 'splat';
    this.scanScale = new THREE.Vector3(1, 1, 1);
    this.scene.add(this.scan);
    for (const o of this.car.children) if (!o.isSprite) o.visible = false;
    this.select(this.selected);
  }

  // A matte black body slightly smaller than the scan, so the background never shows through
  // the semi-transparent splats of the dark paint and glass.
  #splatCore() {
    const g = buildBody();
    const mat = new THREE.MeshBasicMaterial({ color: 0x040506 });
    const core = new THREE.Group();
    for (const geo of Object.values(g)) core.add(new THREE.Mesh(geo, mat));
    core.scale.set(0.95, 0.9, 0.93);
    core.position.x = 0.03;
    return core;
  }

  clearModel() {
    if (!this.scan) return;
    this.scene.remove(this.scan);
    this.scan.traverse((o) => {
      if (o.dispose && !o.isMesh) o.dispose();
      if (!o.isMesh) return;
      o.geometry?.dispose();
      for (const m of [].concat(o.material || [])) { m.map?.dispose(); m.dispose(); }
    });
    this.scan = null;
    this.scanKind = null;
    for (const o of this.car.children) if (!o.isSprite) o.visible = true;
    for (const p of this.parts.values()) if (p.marker && p.anchor) p.marker.position.copy(p.anchor);
    this.focus.visible = false;
  }

  // Which part was tapped on the scanned model, judged from where it was hit.
  #classify(point, normal) {
    const k = this.scanScale;
    const x = point.x / k.x, y = point.y / k.y, z = point.z / k.z;
    const az = Math.abs(z), right = z > 0;
    for (const [wx, front] of [[REF.WHEEL_X, true], [-REF.WHEEL_X, false]]) {
      if (Math.hypot(x - wx, y - REF.WHEEL_R) < 0.37 && az > 0.45) {
        return `tire_${front ? 'f' : 'r'}${right ? 'r' : 'l'}`;
      }
    }
    if (x > 2.05 && y > 0.55 && y < 0.84 && az > 0.3) return 'headlight';
    if (x < -2.12 && y > 0.76 && y < 1.04 && az > 0.22) return 'taillight';
    if (x > 0.3 && x < 0.8 && y > 0.94 && y < 1.2 && az > 0.8) return 'mirror';
    if (y > 0.97) {
      if (x > 0.58 && x < 0.9 && y < 1.07 && az < 0.75) return 'wiper';
      if (az > 0.56 && y < 1.37 && x > -1.8 && x < 0.65) return 'side_window';
      if (x > -0.18 && x < 0.8 && az < 0.66) return 'windshield';
      if (x < -0.95 && x > -1.95 && az < 0.6) return 'rear_window';
      return 'interior';
    }
    if (x > 0.7 && y > 0.68 && az < 0.78 && normal.y > 0.45) return 'engine';
    return 'body';
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
    if (this.focus.visible) this.focus.scale.setScalar(0.55 + Math.sin(t * 4) * 0.08);
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

// reference dimensions of the car in metres (Insight ZE4)
const REF = { L: 4.675, H: 1.41, W: 1.82, WHEEL_X: 1.35, WHEEL_R: 0.33 };

function ringTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 20, 64, 64, 64);
  g.addColorStop(0, 'rgba(61,123,255,0)');
  g.addColorStop(0.55, 'rgba(61,123,255,0.25)');
  g.addColorStop(0.75, 'rgba(120,170,255,0.9)');
  g.addColorStop(1, 'rgba(61,123,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
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
