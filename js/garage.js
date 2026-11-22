// A clean, simple private garage around the car.
// Walls hide themselves (with everything mounted on them) whenever the camera is on their outside,
// so the car stays visible from every angle — the room works like a doll's house.
import * as THREE from 'three';

const W = 20; // length along the car (x)
const D = 16; // width (z)
const H = 5.5; // ceiling height

function canvasTex(w, h, draw, repeat) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); }
  return t;
}

// polished grey epoxy floor with faint speckles and tile joints
function floorTexture() {
  return canvasTex(512, 512, (c, w, h) => {
    c.fillStyle = '#7d838a';
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 5000; i++) {
      const v = 100 + Math.random() * 60;
      c.fillStyle = `rgba(${v},${v + 4},${v + 8},${0.15 + Math.random() * 0.2})`;
      c.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5);
    }
    c.strokeStyle = 'rgba(40,44,50,0.35)';
    c.lineWidth = 2;
    c.strokeRect(0, 0, w, h);
  }, [W / 1.2, D / 1.2]);
}

function doorTexture() {
  return canvasTex(512, 512, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#d9dce0');
    g.addColorStop(1, '#c7cbd0');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    const rows = 5;
    for (let i = 1; i < rows; i++) {
      const y = (h / rows) * i;
      c.fillStyle = 'rgba(0,0,0,0.18)'; c.fillRect(0, y - 3, w, 3);
      c.fillStyle = 'rgba(255,255,255,0.55)'; c.fillRect(0, y, w, 2);
    }
    for (let i = 0; i < rows; i++) { // ribs
      const y0 = (h / rows) * i;
      for (let k = 1; k < 4; k++) {
        c.fillStyle = 'rgba(0,0,0,0.06)';
        c.fillRect(0, y0 + (h / rows) * (k / 4), w, 2);
      }
    }
  });
}

function slatTexture() {
  return canvasTex(512, 256, (c, w, h) => {
    const n = 24;
    for (let i = 0; i < n; i++) {
      const x = (w / n) * i;
      const v = 120 + Math.random() * 30;
      c.fillStyle = `rgb(${v + 40},${v + 10},${v - 30})`;
      c.fillRect(x, 0, w / n - 3, h);
      c.fillStyle = 'rgba(20,12,6,0.85)';
      c.fillRect(x + w / n - 3, 0, 3, h);
    }
  });
}

export function buildGarage() {
  const root = new THREE.Group();
  root.name = 'garage';
  const walls = [];

  const wallMat = new THREE.MeshStandardMaterial({ color: 0xdedcd6, roughness: 0.9 });
  const baseMat = new THREE.MeshStandardMaterial({ color: 0x3b3f45, roughness: 0.6 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x2a2e34, roughness: 0.45, metalness: 0.3 });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0xb8bec6, roughness: 0.3, metalness: 0.8 });
  const ledMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfdfcf6, emissiveIntensity: 1.6 });
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.9 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0x9aa1a8, roughness: 0.35, metalness: 0.9 });

  // ---- floor ----
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(W, D),
    new THREE.MeshStandardMaterial({ map: floorTexture(), color: 0x8e949b, roughness: 0.38, metalness: 0.05, envMapIntensity: 0.5 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.002;
  root.add(floor);
  // parking guide lines
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.6 });
  for (const z of [-1.45, 1.45]) {
    const l = new THREE.Mesh(new THREE.PlaneGeometry(5.6, 0.07), lineMat);
    l.rotation.x = -Math.PI / 2;
    l.position.set(-0.2, 0.001, z);
    root.add(l);
  }
  // wheel stop at the front
  const stop = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.1, 1.5), new THREE.MeshStandardMaterial({ color: 0xd9a417, roughness: 0.6 }));
  stop.position.set(2.75, 0.05, 0);
  root.add(stop);

  // ---- a wall: plane facing into the room + whatever is mounted on it ----
  // `normal` points into the room; the group hides when the camera is behind the wall.
  function wall(width, normal, center) {
    const g = new THREE.Group();
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(width, H), wallMat);
    plane.position.copy(center).setY(H / 2);
    plane.lookAt(plane.position.clone().add(normal));
    g.add(plane);
    const base = new THREE.Mesh(new THREE.BoxGeometry(width, 0.12, 0.02), baseMat);
    base.position.copy(center).setY(0.06).addScaledVector(normal, 0.01);
    base.lookAt(base.position.clone().add(normal));
    g.add(base);
    root.add(g);
    walls.push({ group: g, normal: normal.clone(), point: center.clone() });
    return g;
  }
  const at = (x, y, z) => new THREE.Vector3(x, y, z);

  // front wall (ahead of the car's nose, +x): wood slat accent, shelf, wall lamps
  const front = wall(D, at(-1, 0, 0), at(W / 2, 0, 0));
  const slats = new THREE.Mesh(new THREE.PlaneGeometry(6, 3.4), new THREE.MeshStandardMaterial({ map: slatTexture(), roughness: 0.7 }));
  slats.position.set(W / 2 - 0.03, 1.9, 0);
  slats.rotation.y = -Math.PI / 2;
  front.add(slats);
  const shelf = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.04, 1.8), darkMat);
  shelf.position.set(W / 2 - 0.16, 1.55, -4.4);
  front.add(shelf);
  for (const [z, h, c] of [[-5.0, 0.28, 0x2f6fd6], [-4.65, 0.22, 0xe3e3e3], [-4.25, 0.32, 0x1d1d1f], [-3.85, 0.2, 0xd12a2a]]) {
    const can = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, h, 20), new THREE.MeshStandardMaterial({ color: c, roughness: 0.4 }));
    can.position.set(W / 2 - 0.16, 1.57 + h / 2, z);
    front.add(can);
  }
  for (const z of [-3.5, 3.5]) {
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.7, 0.08), ledMat);
    lamp.position.set(W / 2 - 0.04, 2.2, z);
    front.add(lamp);
  }

  // back wall (behind the car, -x): sectional garage door
  const back = wall(D, at(1, 0, 0), at(-W / 2, 0, 0));
  const door = new THREE.Mesh(new THREE.PlaneGeometry(5.4, 3.0), new THREE.MeshStandardMaterial({ map: doorTexture(), roughness: 0.5, metalness: 0.2 }));
  door.position.set(-W / 2 + 0.06, 1.5, 0); // in front of the baseboard so they never share a depth
  door.rotation.y = Math.PI / 2;
  back.add(door);
  const frameMat = darkMat;
  for (const z of [-2.75, 2.75]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 3.1, 0.1), frameMat);
    post.position.set(-W / 2 + 0.05, 1.55, z);
    back.add(post);
  }
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 5.6), frameMat);
  head.position.set(-W / 2 + 0.05, 3.06, 0);
  back.add(head);

  // left wall (-z): tire rack with the spare set of wheels
  const left = wall(W, at(0, 0, 1), at(0, 0, -D / 2));
  const rackX = -4.2;
  for (const dx of [-0.38, 0.38]) {
    const up = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.9, 0.05), steelMat);
    up.position.set(rackX + dx, 0.95, -D / 2 + 0.42);
    left.add(up);
  }
  for (const y of [0.55, 1.35]) {
    for (const zz of [-D / 2 + 0.14, -D / 2 + 0.7]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.04, 0.04), steelMat);
      bar.position.set(rackX, y - 0.27, zz);
      left.add(bar);
    }
    for (const dx of [-0.2, 0.2]) {
      const t = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.08, 14, 32), tireMat);
      t.scale.z = 1.4;
      t.position.set(rackX + dx, y, -D / 2 + 0.42);
      left.add(t);
      const r = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.2, 24), rimMat);
      r.rotation.x = Math.PI / 2;
      r.position.copy(t.position);
      left.add(r);
    }
  }
  // left wall light strip
  const lstrip = new THREE.Mesh(new THREE.BoxGeometry(10, 0.05, 0.05), ledMat);
  lstrip.position.set(0, 4.6, -D / 2 + 0.04);
  left.add(lstrip);

  // right wall (+z): tool cabinet and pegboard
  const right = wall(W, at(0, 0, -1), at(0, 0, D / 2));
  const cab = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.95, 0.5), darkMat);
  body.position.y = 0.475;
  cab.add(body);
  const top = new THREE.Mesh(new THREE.BoxGeometry(1.84, 0.04, 0.54), new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.5 }));
  top.position.y = 0.97;
  cab.add(top);
  for (let i = 0; i < 4; i++) {
    for (const x of [-0.45, 0.45]) {
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.02, 0.02), steelMat);
      h.position.set(x, 0.18 + i * 0.22, -0.26);
      cab.add(h);
    }
  }
  cab.position.set(1.6, 0, D / 2 - 0.27);
  right.add(cab);
  const peg = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.9), new THREE.MeshStandardMaterial({ color: 0x4a4f57, roughness: 0.8 }));
  peg.position.set(1.6, 1.65, D / 2 - 0.02);
  peg.rotation.y = Math.PI;
  right.add(peg);
  for (const [x, w, h] of [[1.0, 0.04, 0.4], [1.25, 0.05, 0.3], [1.5, 0.12, 0.08], [1.8, 0.04, 0.45], [2.1, 0.2, 0.05], [2.3, 0.05, 0.35]]) {
    const tool = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.03), steelMat);
    tool.position.set(x, 1.65, D / 2 - 0.05);
    right.add(tool);
  }
  const bench = new THREE.Group();
  const benchTop = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.06, 0.7), new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.5 }));
  benchTop.position.y = 0.92;
  bench.add(benchTop);
  for (const [x, z] of [[-1.1, -0.3], [1.1, -0.3], [-1.1, 0.3], [1.1, 0.3]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.9, 0.06), darkMat);
    leg.position.set(x, 0.45, z);
    bench.add(leg);
  }
  bench.position.set(-3.4, 0, D / 2 - 0.4);
  right.add(bench);
  const rstrip = lstrip.clone();
  rstrip.position.set(0, 4.6, D / 2 - 0.04);
  right.add(rstrip);

  // ---- props: things you'd find in a well kept garage ----
  const M = (color, rough = 0.5, metal = 0) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
  const box = (w, h, d, mat, x, y, z, parent, ry = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z); m.rotation.y = ry; parent.add(m); return m;
  };
  const cyl = (rt, rb, h, mat, x, y, z, parent, seg = 24) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
    m.position.set(x, y, z); parent.add(m); return m;
  };
  const RZ = D / 2; // right wall z

  // laptop on the workbench (screen shows a little dashboard)
  const screenTex = canvasTex(512, 320, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#0f1a2e'); g.addColorStop(1, '#1d3357');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    c.fillStyle = '#4f8cff'; c.fillRect(24, 24, 180, 14);
    c.fillStyle = 'rgba(255,255,255,0.7)';
    for (let i = 0; i < 5; i++) c.fillRect(24, 60 + i * 22, 120 + Math.random() * 60, 8);
    c.strokeStyle = '#34c77b'; c.lineWidth = 4; c.beginPath();
    for (let i = 0; i <= 10; i++) c.lineTo(250 + i * 23, 230 - Math.sin(i * 0.8) * 40 - i * 6);
    c.stroke();
    c.fillStyle = 'rgba(79,140,255,0.5)';
    for (let i = 0; i < 6; i++) c.fillRect(250 + i * 38, 270 - (20 + i * 8), 26, 20 + i * 8);
  });
  const laptop = new THREE.Group();
  box(0.36, 0.018, 0.25, M(0x9da3aa, 0.35, 0.8), 0, 0.009, 0, laptop);
  const lid = new THREE.Group();
  box(0.36, 0.24, 0.012, M(0x9da3aa, 0.35, 0.8), 0, 0.12, 0, lid);
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.33, 0.21),
    new THREE.MeshStandardMaterial({ map: screenTex, emissive: 0xffffff, emissiveMap: screenTex, emissiveIntensity: 0.9 }));
  scr.position.set(0, 0.12, -0.007); scr.rotation.y = Math.PI;
  lid.add(scr);
  lid.position.set(0, 0.018, 0.12); lid.rotation.x = 0.32;
  laptop.add(lid);
  laptop.position.set(-3.7, 0.95, RZ - 0.45); laptop.rotation.y = 0.15;
  right.add(laptop);
  // mug, desk lamp, notebook
  cyl(0.04, 0.035, 0.1, M(0xf2f2ee, 0.3), -3.2, 1.0, RZ - 0.5, right);
  box(0.21, 0.015, 0.29, M(0x2f6fd6, 0.6), -2.7, 0.96, RZ - 0.4, right, 0.3);
  cyl(0.08, 0.09, 0.02, M(0x1d1d1f, 0.4), -4.35, 0.96, RZ - 0.25, right);
  const arm = box(0.02, 0.45, 0.02, M(0x1d1d1f, 0.4), -4.35, 1.18, RZ - 0.28, right); arm.rotation.x = -0.25;
  const shade = cyl(0.03, 0.09, 0.12, M(0x1d1d1f, 0.4), -4.35, 1.38, RZ - 0.4, right); shade.rotation.x = 0.9;
  // two stools at the bench
  for (const x of [-4.0, -2.8]) {
    cyl(0.18, 0.18, 0.05, M(0x3a3f46, 0.5), x, 0.68, RZ - 1.05, right);
    cyl(0.025, 0.025, 0.66, M(0xb8bec6, 0.3, 0.8), x, 0.33, RZ - 1.05, right, 10);
    cyl(0.2, 0.2, 0.02, M(0xb8bec6, 0.3, 0.8), x, 0.01, RZ - 1.05, right);
  }
  // rubber mat under the bench
  const mat = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.6), M(0x24272c, 0.9));
  mat.rotation.x = -Math.PI / 2; mat.position.set(-3.4, 0.003, RZ - 0.9);
  right.add(mat);
  // rolling tool chest (red) next to the cabinet
  const chest = new THREE.Group();
  box(0.75, 1.0, 0.48, M(0xb3222a, 0.35, 0.3), 0, 0.58, 0, chest);
  for (let i = 0; i < 6; i++) box(0.6, 0.015, 0.015, M(0xd0d4d9, 0.3, 0.8), 0, 0.25 + i * 0.13, -0.245, chest);
  for (const [x, z] of [[-0.3, -0.18], [0.3, -0.18], [-0.3, 0.18], [0.3, 0.18]]) cyl(0.04, 0.04, 0.06, M(0x111111, 0.8), x, 0.04, z, chest, 12);
  chest.position.set(3.2, 0, RZ - 0.35);
  right.add(chest);
  // wall clock
  const clock = new THREE.Group();
  cyl(0.22, 0.22, 0.03, M(0xf5f5f2, 0.4), 0, 0, 0, clock, 40).rotation.x = Math.PI / 2;
  const hand1 = box(0.015, 0.15, 0.005, M(0x111111), 0, 0.06, -0.02, clock); hand1.rotation.z = 0.5;
  const hand2 = box(0.012, 0.11, 0.005, M(0x111111), 0, 0.04, -0.02, clock); hand2.rotation.z = -1.4;
  clock.position.set(0.5, 3.1, RZ - 0.03);
  right.add(clock);

  // left wall: metal shelving with storage boxes, plant, bucket & car care bottles
  const shelfUnit = new THREE.Group();
  for (const x of [-0.95, 0.95]) for (const z of [-0.22, 0.22]) box(0.04, 2.0, 0.04, M(0x7c838c, 0.4, 0.8), x, 1.0, z, shelfUnit);
  const boxColors = [0x2b2f35, 0x3d4a5c, 0xd9d4c7, 0x2b2f35, 0x5c3d2e, 0x3d4a5c];
  [0.35, 0.95, 1.55].forEach((y, row) => {
    box(1.95, 0.03, 0.5, M(0x9aa1a8, 0.4, 0.7), 0, y, 0, shelfUnit);
    for (let i = 0; i < 3; i++) box(0.52, 0.32, 0.4, M(boxColors[(row * 3 + i) % boxColors.length], 0.6), -0.62 + i * 0.62, y + 0.18, 0, shelfUnit);
  });
  shelfUnit.position.set(2.6, 0, -RZ + 0.3);
  left.add(shelfUnit);
  const pot = cyl(0.22, 0.17, 0.42, M(0x2b2f35, 0.6), 6.2, 0.21, -RZ + 0.5, left);
  pot.castShadow = false;
  for (let i = 0; i < 9; i++) {
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.16 + Math.random() * 0.06, 12, 10), M(0x2f6b3a + Math.floor(Math.random() * 3) * 0x020a02, 0.8));
    leaf.position.set(6.2 + (Math.random() - 0.5) * 0.35, 0.62 + Math.random() * 0.55, -RZ + 0.5 + (Math.random() - 0.5) * 0.35);
    left.add(leaf);
  }
  const bucket = cyl(0.17, 0.14, 0.32, M(0x2f6fd6, 0.5), 0.6, 0.16, -RZ + 0.45, left);
  bucket.material.side = THREE.DoubleSide;
  for (const [x, c] of [[0.95, 0x34c77b], [1.1, 0xf2f2ee], [1.25, 0xf5b83d]]) {
    cyl(0.04, 0.045, 0.24, M(c, 0.4), x, 0.12, -RZ + 0.35, left, 14);
    cyl(0.012, 0.012, 0.06, M(0x111111, 0.5), x, 0.27, -RZ + 0.35, left, 8);
  }
  // framed posters on the left wall
  const posterTex = (bg, fg, lines) => canvasTex(256, 360, (c, w, h) => {
    c.fillStyle = bg; c.fillRect(0, 0, w, h);
    c.fillStyle = fg;
    c.beginPath(); c.arc(w / 2, h * 0.38, 70, 0, Math.PI * 2); c.fill();
    c.fillStyle = 'rgba(255,255,255,0.85)';
    for (let i = 0; i < lines; i++) c.fillRect(40, h * 0.7 + i * 18, w - 80 - i * 30, 7);
  });
  for (const [x, bg, fg] of [[-1.2, '#1d2a44', '#4f8cff'], [0.0, '#2b2f35', '#d9a417']]) {
    box(0.82, 1.12, 0.03, M(0x111111, 0.4), x, 2.6, -RZ + 0.02, left);
    const pst = new THREE.Mesh(new THREE.PlaneGeometry(0.74, 1.04), new THREE.MeshStandardMaterial({ map: posterTex(bg, fg, 3), roughness: 0.6 }));
    pst.position.set(x, 2.6, -RZ + 0.04);
    left.add(pst);
  }

  // front wall: mini fridge and a wall TV
  const fridge = new THREE.Group();
  box(0.6, 0.85, 0.6, M(0xd9dce0, 0.3, 0.4), 0, 0.425, 0, fridge);
  box(0.02, 0.3, 0.03, M(0x6a7078, 0.3, 0.8), -0.31, 0.55, 0.2, fridge);
  fridge.position.set(W / 2 - 0.35, 0, 5.6);
  front.add(fridge);
  const tvTex = canvasTex(512, 288, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#0b1220'); g.addColorStop(1, '#22314d');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    c.fillStyle = 'rgba(255,255,255,0.9)'; c.font = 'bold 44px sans-serif'; c.fillText('INSIGHT', 40, 90);
    c.fillStyle = 'rgba(255,255,255,0.6)'; c.font = '24px sans-serif'; c.fillText('ZE4  ・  55-10', 40, 130);
    c.strokeStyle = '#4f8cff'; c.lineWidth = 3; c.strokeRect(40, 170, 430, 60);
  });
  box(1.5, 0.88, 0.05, M(0x111214, 0.3, 0.3), W / 2 - 0.05, 2.5, 5.0, front, Math.PI / 2);
  const tv = new THREE.Mesh(new THREE.PlaneGeometry(1.42, 0.8),
    new THREE.MeshStandardMaterial({ map: tvTex, emissive: 0xffffff, emissiveMap: tvTex, emissiveIntensity: 0.8 }));
  tv.position.set(W / 2 - 0.085, 2.5, 5.0); tv.rotation.y = -Math.PI / 2;
  front.add(tv);

  // back wall (shutter side): fire extinguisher, broom, air compressor
  const ext = new THREE.Group();
  cyl(0.08, 0.08, 0.5, M(0xd12a2a, 0.35), 0, 0.25, 0, ext);
  cyl(0.03, 0.03, 0.08, M(0x111111, 0.5), 0, 0.54, 0, ext, 10);
  ext.position.set(-W / 2 + 0.2, 0, -4.0);
  back.add(ext);
  const broom = box(0.03, 1.4, 0.03, M(0x8a6a4a, 0.6), -W / 2 + 0.12, 0.72, -4.6, back); broom.rotation.x = 0.08;
  box(0.32, 0.08, 0.08, M(0x1d1d1f, 0.8), -W / 2 + 0.14, 0.05, -4.65, back);
  const comp = new THREE.Group();
  const tank = cyl(0.2, 0.2, 0.6, M(0x2f6fd6, 0.35, 0.3), 0, 0.28, 0, comp); tank.rotation.z = Math.PI / 2;
  box(0.25, 0.18, 0.2, M(0x1d1d1f, 0.5), 0, 0.55, 0, comp);
  comp.position.set(-W / 2 + 0.45, 0, 4.3);
  back.add(comp);

  // floor (always visible): traffic cones in a corner
  for (const [x, z] of [[8.6, -6.6], [9.1, -7.2], [8.2, -7.3]]) {
    const cone = new THREE.Group();
    box(0.36, 0.03, 0.36, M(0x1d1d1f, 0.8), 0, 0.015, 0, cone);
    cyl(0.03, 0.15, 0.6, M(0xf07a1a, 0.5), 0, 0.33, 0, cone, 20);
    cyl(0.085, 0.11, 0.09, M(0xf5f5f2, 0.5), 0, 0.33, 0, cone, 20);
    cone.position.set(x, 0, z);
    root.add(cone);
  }

  // ---- ceiling with LED panels (hidden when looking from above) ----
  const ceiling = new THREE.Group();
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ color: 0xf4f3ef, roughness: 0.95 }));
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = H;
  ceiling.add(ceil);
  for (const x of [-6, 0, 6]) {
    for (const z of [-4, 0, 4]) {
      const led = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.03, 0.22), ledMat);
      led.position.set(x, H - 0.02, z);
      ceiling.add(led);
    }
  }
  root.add(ceiling);
  walls.push({ group: ceiling, normal: at(0, -1, 0), point: at(0, H, 0) });

  // soft light from the ceiling panels
  for (const x of [-5, 5]) {
    const fill = new THREE.PointLight(0xfff6e8, 9, 22, 1.4);
    fill.position.set(x, H - 0.4, 0);
    root.add(fill);
  }

  const tmp = new THREE.Vector3();
  root.userData.update = (camera) => {
    for (const w of walls) {
      // visible only while the camera is on the room side of the wall
      w.group.visible = tmp.copy(camera.position).sub(w.point).dot(w.normal) > 0;
    }
  };
  return root;
}
