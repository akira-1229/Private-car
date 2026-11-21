// 3D car model built from primitives (front of the car points to +X, right side is +Z).
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { RoomEnvironment } from '../vendor/RoomEnvironment.js';

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

  // Proportions follow a mid-size fastback sedan (Honda Insight ZE4: L4675 / W1820 / H1410 / WB2700 mm).
  #buildCar(bodyColor) {
    this.bodyMat = new THREE.MeshPhysicalMaterial({
      color: bodyColor, metalness: 0.3, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.05,
    });
    this.bodyMat.name = 'paint';
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x0c0e11, roughness: 0.6, metalness: 0.3 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x050607, roughness: 0.35, metalness: 0.4 });
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0x16222a, metalness: 0.1, roughness: 0.08, side: THREE.DoubleSide, envMapIntensity: 0.8,
    });
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x18181a, roughness: 0.9 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xc9ced4, metalness: 1, roughness: 0.22 });
    const rimDarkMat = new THREE.MeshStandardMaterial({ color: 0x3a3e44, metalness: 0.8, roughness: 0.35 });
    const chromeMat = new THREE.MeshStandardMaterial({ color: 0xe3e7ec, metalness: 1, roughness: 0.08 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xe8f0ff, emissiveIntensity: 0.9, roughness: 0.1 });
    const headHousingMat = new THREE.MeshStandardMaterial({ color: 0x1a1d22, metalness: 0.7, roughness: 0.15 });
    const tailMat = new THREE.MeshStandardMaterial({ color: 0x9e0d16, emissive: 0x7a0008, emissiveIntensity: 0.6, roughness: 0.2 });
    const plateMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 });

    const W = 0.86; // half width before bevel (≈1.82m overall)
    const WHEEL_X = 1.35, WHEEL_R = 0.33;

    // ---- Lower body: side profile extruded across the width ----
    const s = new THREE.Shape();
    s.moveTo(-2.26, 0.3);
    s.lineTo(-WHEEL_X - 0.43, 0.3);
    s.absarc(-WHEEL_X, WHEEL_R, 0.43, Math.PI, 0, true);
    s.lineTo(WHEEL_X - 0.43, 0.29);
    s.absarc(WHEEL_X, WHEEL_R, 0.43, Math.PI, 0, true);
    s.lineTo(2.22, 0.27);
    s.quadraticCurveTo(2.33, 0.3, 2.34, 0.46); // chin
    s.quadraticCurveTo(2.33, 0.64, 2.24, 0.71); // nose
    s.quadraticCurveTo(1.6, 0.86, 0.72, 0.95); // long, low hood
    s.lineTo(-1.7, 1.02); // rising beltline
    s.lineTo(-2.22, 1.03); // short deck
    s.lineTo(-2.3, 1.0); // ducktail lip
    s.quadraticCurveTo(-2.36, 0.85, -2.33, 0.62);
    s.quadraticCurveTo(-2.33, 0.36, -2.26, 0.3);
    const bodyGeo = new THREE.ExtrudeGeometry(s, {
      depth: W * 2, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.05, bevelSegments: 5, curveSegments: 32,
    });
    bodyGeo.translate(0, 0, -W);
    taperZ(bodyGeo, (x) => {
      if (x > 1.65) return 1 - 0.13 * ((x - 1.65) / 0.75) ** 2; // rounded nose corners
      if (x < -1.9) return 1 - 0.07 * ((-1.9 - x) / 0.5) ** 2;
      return 1;
    });
    const body = new THREE.Group();
    body.add(new THREE.Mesh(bodyGeo, this.bodyMat));
    // underbody / wheel wells
    const under = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.2, 1.36), darkMat);
    under.position.set(0, 0.38, 0);
    body.add(under);
    // side sills (dark garnish)
    for (const z of [-1, 1]) {
      const sill = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.07, 0.04), trimMat);
      sill.position.set(0, 0.33, z * (W + 0.07));
      body.add(sill);
    }
    // front: wide lower grille, chrome wing bar, fog garnish
    const grille = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.2, 1.05), trimMat);
    grille.position.set(2.35, 0.44, 0);
    grille.rotation.z = 0.12;
    const wing = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.78), chromeMat);
    wing.position.set(2.37, 0.6, 0);
    wing.rotation.z = 0.5;
    body.add(grille, wing);
    for (const z of [-1, 1]) {
      const fog = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.26), trimMat);
      fog.position.set(2.29, 0.38, z * 0.68);
      fog.rotation.y = z * 0.35;
      body.add(fog);
    }
    // number plates
    this.plateTex = new THREE.CanvasTexture(document.createElement('canvas'));
    this.plateTex.colorSpace = THREE.SRGBColorSpace;
    this.plateTex.anisotropy = 8;
    const faceMat = new THREE.MeshStandardMaterial({ map: this.plateTex, roughness: 0.5 });
    for (const [x, y, dir] of [[2.385, 0.4, 1], [-2.39, 0.62, -1]]) {
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.17, 0.34), plateMat);
      back.position.set(x, y, 0);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(0.33, 0.165), faceMat);
      face.rotation.y = dir * Math.PI / 2;
      face.position.set(x + dir * 0.0115, y, 0);
      body.add(back, face);
    }
    // rear: chrome strip above the plate & diffuser
    const rstrip = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.025, 0.7), chromeMat);
    rstrip.position.set(-2.395, 0.74, 0);
    const diff = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 1.3), trimMat);
    diff.position.set(-2.33, 0.36, 0);
    body.add(rstrip, diff);
    // body-coloured flush door handles
    for (const z of [-1, 1]) {
      for (const x of [0.05, -0.95]) {
        const h = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.035, 0.03), this.bodyMat);
        h.position.set(x, 0.9, z * (W + 0.07));
        body.add(h);
      }
    }
    this.#part('body', body, [-0.45, 0.7, W + 0.14]);

    // ---- Hood (engine room) ----
    const hood = new THREE.Group();
    hood.add(this.#quad([2.18, 0.73], [1.4, 0.875], W - 0.08, 0.062, this.bodyMat));
    hood.add(this.#quad([1.4, 0.875], [0.72, 0.95], W - 0.06, 0.062, this.bodyMat));
    this.#part('engine', hood, [1.5, 0.96, 0]);

    // ---- Cabin / greenhouse (fastback) => interior ----
    const c = new THREE.Shape();
    c.moveTo(0.92, 0.9);
    c.lineTo(0.72, 0.97);
    c.lineTo(-0.2, 1.39); // windshield top
    c.quadraticCurveTo(-0.55, 1.44, -0.92, 1.38); // roof
    c.lineTo(-1.88, 1.07); // long sloping rear glass
    c.lineTo(-1.98, 1.0);
    c.lineTo(-2.0, 0.92);
    c.closePath();
    const CW = 0.69;
    const cabinGeo = new THREE.ExtrudeGeometry(c, {
      depth: CW * 2, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.04, bevelSegments: 4, curveSegments: 24,
    });
    cabinGeo.translate(0, 0, -CW);
    taperZ(cabinGeo, (x, y) => tumble(y));
    this.#part('interior', new THREE.Mesh(cabinGeo, this.bodyMat), [-0.55, 1.52, 0]);

    // ---- Glass ----
    this.#part('windshield', this.#quad([0.72, 0.97], [-0.2, 1.39], CW - 0.01, 0.045, glassMat, tumble), [0.26, 1.22, 0]);
    this.#part('rear_window', this.#quad([-0.95, 1.375], [-1.86, 1.08], CW - 0.04, 0.045, glassMat, tumble), [-1.4, 1.27, 0]);

    // side windows with chrome surround
    const side = new THREE.Group();
    const winA = [[0.6, 1.02], [-0.18, 1.355], [-0.4, 1.385], [-0.4, 1.02]];
    const winB = [[-0.5, 1.02], [-0.5, 1.39], [-0.88, 1.36], [-1.42, 1.13], [-1.42, 1.02]];
    const winC = [[-1.5, 1.04], [-1.5, 1.1], [-1.72, 1.04]]; // small rear quarter glass
    const zSide = CW + 0.065;
    for (const pts of [winA, winB, winC]) {
      const g = new THREE.ShapeGeometry(new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y))));
      for (const z of [-1, 1]) {
        const gz = g.clone();
        const pos = gz.attributes.position;
        for (let i = 0; i < pos.count; i++) pos.setZ(i, z * zSide * tumble(pos.getY(i)));
        gz.computeVertexNormals();
        side.add(new THREE.Mesh(gz, glassMat));
      }
    }
    this.#part('side_window', side, [-0.4, 1.22, CW + 0.12]);

    // chrome beltline, part of the body
    const trim = new THREE.Group();
    for (const z of [-1, 1]) {
      const belt = new THREE.Mesh(new THREE.BoxGeometry(2.35, 0.02, 0.02), chromeMat);
      belt.position.set(-0.55, 1.005, z * (zSide + 0.005));
      trim.add(belt);
    }
    this.parts.get('body').meshes.push(...this.#adopt(trim, 'body'));
    this.car.add(trim);

    // ---- Wipers ----
    const wipers = new THREE.Group();
    for (const z of [-0.3, 0.32]) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.022, 0.62), darkMat);
      w.position.set(0.74, 1.02, z);
      w.rotation.y = 0.2;
      wipers.add(w);
    }
    this.#part('wiper', wipers, [0.8, 1.06, 0.36]);

    // ---- Lights ----
    const heads = new THREE.Group();
    const tails = new THREE.Group();
    for (const z of [-1, 1]) {
      // slim LED headlight on the front corner
      const housing = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.085, 0.44), headHousingMat);
      housing.position.set(2.3, 0.66, z * 0.56);
      housing.rotation.set(0, z * -0.38, -0.55);
      const led = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.018, 0.4), headMat);
      led.position.set(2.325, 0.69, z * 0.56);
      led.rotation.set(0, z * -0.38, -0.55);
      heads.add(housing, led);
      // wide, thin tail light that wraps into the side
      const t = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.07, 0.5), tailMat);
      t.position.set(-2.355, 0.9, z * 0.6);
      const wrap = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.07, 0.05), tailMat);
      wrap.position.set(-2.24, 0.9, z * (W + 0.04));
      tails.add(t, wrap);
    }
    // thin light bar between the tail lights
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.02, 0.72), tailMat);
    bar.position.set(-2.36, 0.93, 0);
    tails.add(bar);
    this.#part('headlight', heads, [2.4, 0.72, 0.56]);
    this.#part('taillight', tails, [-2.44, 0.92, 0.6]);

    // ---- Mirrors ----
    const mirrors = new THREE.Group();
    for (const z of [-1, 1]) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), this.bodyMat);
      m.scale.set(0.9, 0.55, 1.1);
      m.position.set(0.55, 1.07, z * (W + 0.1));
      const stalk = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.04, 0.12), trimMat);
      stalk.position.set(0.58, 1.02, z * (W + 0.02));
      const g = new THREE.Mesh(new THREE.CircleGeometry(0.075, 16), glassMat);
      g.scale.y = 0.6;
      g.rotation.y = -Math.PI / 2;
      g.position.set(0.475, 1.07, z * (W + 0.11));
      mirrors.add(m, stalk, g);
    }
    this.#part('mirror', mirrors, [0.55, 1.22, W + 0.16]);

    // ---- Wheels (215/55R17 with two-tone split-spoke alloys) ----
    const wheelDefs = [
      ['tire_fl', WHEEL_X, -1], ['tire_fr', WHEEL_X, 1],
      ['tire_rl', -WHEEL_X, -1], ['tire_rr', -WHEEL_X, 1],
    ];
    this.wheels = [];
    for (const [id, x, sd] of wheelDefs) {
      const wheel = this.#wheel(tireMat, rimMat, rimDarkMat, sd);
      wheel.position.set(x, WHEEL_R, sd * 0.8);
      this.wheels.push(wheel);
      this.#part(id, wheel, [x, WHEEL_R + 0.05, sd * 1.04]);
    }

    // ---- Markers (status dots shown over parts) ----
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

  // tag meshes of an object as belonging to a part (used for extra trim)
  #adopt(obj, id) {
    const out = [];
    obj.traverse((o) => {
      if (!o.isMesh) return;
      o.userData.partId = id;
      o.material = o.material.clone();
      o.userData.baseEmissive = o.material.emissive ? o.material.emissive.clone() : null;
      o.userData.baseEmissiveIntensity = o.material.emissiveIntensity ?? 1;
      out.push(o);
    });
    return out;
  }

  #quad([x1, y1], [x2, y2], halfW, offset, mat, widthAt = () => 1) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    // outward normal (pointing up / away from the car)
    let nx = -dy / len, ny = dx / len;
    if (ny < 0) { nx = -nx; ny = -ny; }
    const ox = nx * offset, oy = ny * offset;
    const v = new Float32Array([
      x1 + ox, y1 + oy, -halfW * widthAt(y1),
      x1 + ox, y1 + oy, halfW * widthAt(y1),
      x2 + ox, y2 + oy, halfW * widthAt(y2),
      x2 + ox, y2 + oy, -halfW * widthAt(y2),
    ]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(v, 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.computeVertexNormals();
    const m = mat.clone();
    m.side = THREE.DoubleSide;
    return new THREE.Mesh(g, m);
  }

  #wheel(tireMat, rimMat, rimDarkMat, side) {
    const g = new THREE.Group();
    const tire = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.08, 18, 48), tireMat);
    tire.scale.z = 1.4;
    g.add(tire);
    const tread = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.19, 48, 1, true), tireMat);
    tread.rotation.x = Math.PI / 2;
    g.add(tread);
    // dark rim barrel
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.215, 0.215, 0.2, 40), rimDarkMat);
    barrel.rotation.x = Math.PI / 2;
    g.add(barrel);
    // bright lip
    const lip = new THREE.Mesh(new THREE.TorusGeometry(0.212, 0.012, 8, 48), rimMat);
    lip.position.z = side * 0.1;
    g.add(lip);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.03, 16), rimMat);
    hub.rotation.x = Math.PI / 2;
    hub.position.z = side * 0.115;
    g.add(hub);
    // 5 twisted split spokes (10 blades)
    for (let i = 0; i < 5; i++) {
      for (const off of [-0.11, 0.11]) {
        const a = (i / 5) * Math.PI * 2 + off;
        const sp = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.17, 0.022), rimMat);
        sp.position.set(Math.cos(a) * 0.125, Math.sin(a) * 0.125, side * 0.106);
        sp.rotation.z = a - Math.PI / 2 + off * 0.8;
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

// narrow the cabin towards the roof (tumblehome)
function tumble(y) {
  return y > 0.98 ? 1 - (y - 0.98) * 0.32 : 1;
}
function taperZ(geo, fn) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) * fn(p.getX(i), p.getY(i)));
  geo.computeVertexNormals();
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
