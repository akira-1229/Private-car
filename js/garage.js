// A clean, simple private garage around the car.
// Walls hide themselves (with everything mounted on them) whenever the camera is on their outside,
// so the car stays visible from every angle — the room works like a doll's house.
import * as THREE from 'three';

const W = 8.4; // length along the car (x)
const D = 6.2; // width (z)
const H = 3.0; // ceiling height

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
  const slats = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 2.2), new THREE.MeshStandardMaterial({ map: slatTexture(), roughness: 0.7 }));
  slats.position.set(W / 2 - 0.02, 1.35, 0);
  slats.rotation.y = -Math.PI / 2;
  front.add(slats);
  const shelf = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.04, 1.8), darkMat);
  shelf.position.set(W / 2 - 0.16, 1.55, -2.1);
  front.add(shelf);
  for (const [z, h, c] of [[-2.7, 0.28, 0x2f6fd6], [-2.35, 0.22, 0xe3e3e3], [-1.95, 0.32, 0x1d1d1f], [-1.55, 0.2, 0xd12a2a]]) {
    const can = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, h, 20), new THREE.MeshStandardMaterial({ color: c, roughness: 0.4 }));
    can.position.set(W / 2 - 0.16, 1.57 + h / 2, z);
    front.add(can);
  }
  for (const z of [-1.9, 1.9]) {
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.5, 0.08), ledMat);
    lamp.position.set(W / 2 - 0.04, 1.9, z);
    front.add(lamp);
  }

  // back wall (behind the car, -x): sectional garage door
  const back = wall(D, at(1, 0, 0), at(-W / 2, 0, 0));
  const door = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 2.5), new THREE.MeshStandardMaterial({ map: doorTexture(), roughness: 0.5, metalness: 0.2 }));
  door.position.set(-W / 2 + 0.02, 1.25, 0);
  door.rotation.y = Math.PI / 2;
  back.add(door);
  const frameMat = darkMat;
  for (const z of [-2.35, 2.35]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.06, 2.6, 0.1), frameMat);
    post.position.set(-W / 2 + 0.03, 1.3, z);
    back.add(post);
  }
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 4.8), frameMat);
  head.position.set(-W / 2 + 0.03, 2.55, 0);
  back.add(head);

  // left wall (-z): tire rack with the spare set of wheels
  const left = wall(W, at(0, 0, 1), at(0, 0, -D / 2));
  const rackX = -2.4;
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
  const lstrip = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.05, 0.05), ledMat);
  lstrip.position.set(0.8, 2.55, -D / 2 + 0.04);
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
  const rstrip = lstrip.clone();
  rstrip.position.set(-0.8, 2.55, D / 2 - 0.04);
  right.add(rstrip);

  // ---- ceiling with LED panels (hidden when looking from above) ----
  const ceiling = new THREE.Group();
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ color: 0xf4f3ef, roughness: 0.95 }));
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = H;
  ceiling.add(ceil);
  for (const z of [-1.3, 1.3]) {
    const led = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.03, 0.18), ledMat);
    led.position.set(0, H - 0.02, z);
    ceiling.add(led);
  }
  root.add(ceiling);
  walls.push({ group: ceiling, normal: at(0, -1, 0), point: at(0, H, 0) });

  // soft light from the ceiling panels
  const fill = new THREE.PointLight(0xfff6e8, 3, 12, 1.6);
  fill.position.set(0, H - 0.3, 0);
  root.add(fill);

  const tmp = new THREE.Vector3();
  root.userData.update = (camera) => {
    for (const w of walls) {
      // visible only while the camera is on the room side of the wall
      w.group.visible = tmp.copy(camera.position).sub(w.point).dot(w.normal) > 0;
    }
  };
  return root;
}
