// A reasonably realistic tyre + alloy wheel. Default size: 235/45R18 (Honda Insight ZE4 EX Black Style).
// The axle runs along the local Y axis; the outer (decorative) face is on +Y.
import * as THREE from 'three';

function tex(w, h, draw) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// tread pattern used as a bump map: blocks split by lateral and diagonal sipes
function treadTexture() {
  const t = tex(1024, 256, (c, w, h) => {
    c.fillStyle = '#808080';
    c.fillRect(0, 0, w, h);
    c.strokeStyle = '#000';
    const blocks = 72;
    for (let i = 0; i < blocks; i++) {
      const x = (w / blocks) * i;
      c.lineWidth = 3;
      c.beginPath(); c.moveTo(x, h * 0.28); c.lineTo(x + 8, h * 0.72); c.stroke(); // lateral groove
      c.lineWidth = 1;
      for (const k of [0.4, 0.6]) { c.beginPath(); c.moveTo(x + 4, h * k - 6); c.lineTo(x + 10, h * k + 6); c.stroke(); } // sipes
    }
  });
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

// sidewall lettering on a ring (size and a generic "STUDLESS" mark)
function sidewallTexture(text) {
  return tex(1024, 1024, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.translate(w / 2, h / 2);
    c.fillStyle = 'rgba(210,210,205,0.55)';
    c.font = 'bold 44px sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const r = w * 0.42;
    for (const [str, start] of [[text, -Math.PI * 0.72], ['STUDLESS  ・  M+S', Math.PI * 0.28]]) {
      const step = 0.052;
      let a = start;
      for (const ch of str) {
        c.save(); c.rotate(a); c.translate(0, -r); c.fillText(ch, 0, 0); c.restore();
        a += step;
      }
    }
  });
}

export function makeTyreWheel({ width = 0.235, aspect = 0.45, rimInch = 18, spokes = 5, rimColor = 0xc6ccd3 } = {}) {
  const g = new THREE.Group();
  const rimR = (rimInch * 0.0254) / 2; // 0.2286
  const outerR = rimR + width * aspect; // 0.3344
  const hw = width / 2;

  // ---- tyre: lathe of the cross-section (radius, axial position) ----
  const pts = [];
  const tread = (y) => {
    // four circumferential grooves
    for (const gy of [-0.6, -0.2, 0.2, 0.6]) if (Math.abs(y - gy * hw * 0.82) < 0.006) return outerR - 0.008;
    return outerR;
  };
  pts.push([rimR + 0.004, -hw * 0.86]);
  pts.push([rimR + 0.016, -hw * 0.98]);
  pts.push([rimR + (outerR - rimR) * 0.45, -hw * 1.03]); // sidewall bulge
  pts.push([outerR - 0.026, -hw * 0.98]);
  pts.push([outerR - 0.008, -hw * 0.9]); // shoulder
  for (let i = 0; i <= 40; i++) {
    const y = -hw * 0.84 + (hw * 1.68 * i) / 40;
    pts.push([tread(y), y]);
  }
  pts.push([outerR - 0.008, hw * 0.9]);
  pts.push([outerR - 0.026, hw * 0.98]);
  pts.push([rimR + (outerR - rimR) * 0.45, hw * 1.03]);
  pts.push([rimR + 0.016, hw * 0.98]);
  pts.push([rimR + 0.004, hw * 0.86]);
  const tyreGeo = new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), 96);
  const bump = treadTexture();
  bump.repeat.set(1, 1);
  const tyreMat = new THREE.MeshStandardMaterial({
    color: 0x1b1b1d, roughness: 0.92, metalness: 0, bumpMap: bump, bumpScale: 3, side: THREE.DoubleSide,
  });
  g.add(new THREE.Mesh(tyreGeo, tyreMat));
  // sidewall lettering on the outer face
  const label = new THREE.Mesh(
    new THREE.RingGeometry(rimR + 0.02, outerR - 0.03, 96, 1),
    new THREE.MeshStandardMaterial({ map: sidewallTexture(`${Math.round(width * 1000)}/${Math.round(aspect * 100)}R${rimInch}  94Q`), transparent: true, roughness: 0.9, depthWrite: false }),
  );
  // RingGeometry UVs are planar over the ring's bounding box, which is what the canvas expects
  label.rotation.x = -Math.PI / 2;
  label.position.y = hw * 1.035;
  g.add(label);

  // ---- alloy wheel ----
  const alloy = new THREE.MeshStandardMaterial({ color: rimColor, metalness: 0.95, roughness: 0.22 });
  const darkAlloy = new THREE.MeshStandardMaterial({ color: 0x2a2d32, metalness: 0.8, roughness: 0.35 });
  // barrel and lips
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(rimR - 0.004, rimR - 0.004, width * 0.9, 64, 1, true), darkAlloy);
  barrel.material.side = THREE.DoubleSide;
  g.add(barrel);
  for (const s of [-1, 1]) {
    const lip = new THREE.Mesh(new THREE.TorusGeometry(rimR, 0.009, 10, 72), alloy);
    lip.rotation.x = Math.PI / 2;
    lip.position.y = s * hw * 0.86;
    g.add(lip);
  }
  // inner dish (dark) seen between the spokes
  const dish = new THREE.Mesh(new THREE.CircleGeometry(rimR - 0.006, 48), darkAlloy.clone());
  dish.material.side = THREE.DoubleSide;
  dish.rotation.x = -Math.PI / 2;
  dish.position.y = hw * 0.2;
  g.add(dish);
  // twin spokes, extruded and slightly tapered
  const face = hw * 0.78;
  for (let i = 0; i < spokes; i++) {
    for (const off of [-0.11, 0.11]) {
      const sh = new THREE.Shape();
      sh.moveTo(-0.014, 0.055);
      sh.lineTo(0.014, 0.055);
      sh.lineTo(0.011, rimR - 0.012);
      sh.lineTo(-0.011, rimR - 0.012);
      sh.closePath();
      const geo = new THREE.ExtrudeGeometry(sh, { depth: 0.03, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.004, bevelSegments: 2 });
      const spoke = new THREE.Mesh(geo, alloy);
      spoke.rotation.x = -Math.PI / 2; // shape plane -> wheel face
      const holder = new THREE.Group();
      holder.add(spoke);
      holder.rotation.y = (i / spokes) * Math.PI * 2 + off;
      holder.position.y = face - 0.03;
      g.add(holder);
    }
  }
  // hub, lug nuts, centre cap
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.082, 0.05, 40), alloy);
  hub.position.y = face - 0.005;
  g.add(hub);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + Math.PI / 5;
    const nut = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.022, 6), new THREE.MeshStandardMaterial({ color: 0xd7dbe0, metalness: 1, roughness: 0.2 }));
    nut.position.set(Math.cos(a) * 0.05, face + 0.026, Math.sin(a) * 0.05);
    g.add(nut);
  }
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.032, 0.012, 32), darkAlloy);
  cap.position.y = face + 0.026;
  g.add(cap);

  g.userData.radius = outerR;
  g.userData.width = width;
  return g;
}
