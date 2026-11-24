// The built-in Honda Insight (ZE4, EX Black Style) model.
// The body shell comes from js/body.js (a loft traced from a side photo); everything else is
// placed on that shell with surface probes (js/detail.js) so the details sit exactly on it.
// Coordinates: +X = front, +Y = up, +Z = right side, metres, ground at y = 0.
import * as THREE from 'three';
import { buildBody, dloOutline, GLASS, WHEELS, beltAt, topAt, creaseY } from './body.js';
import {
  Probe, sweep, gridGeo, bake, mirrored, polyRegion, bandRegion, exprRegion, glslLookup, clipMaterial,
  spline2, treadBump, sidewallTexture, labelTexture,
  boundaryChains, subsetGeo,
} from './detail.js';
import { mergeGeometries } from '../vendor/utils/BufferGeometryUtils.js';
import {
  hEmblem, chromeLettering, chromeMaterial, badgeBlackMaterial, hybridBadge, hybridBlueMaterial, smokedChromeMaterial,
} from './emblem.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

// ---------------------------------------------------------------------------------------------
// Openings and cut lines (right side; the shader works on |z| so they apply to both sides)
// ---------------------------------------------------------------------------------------------
const R = {
  // nose (angle around x = 1.45, degrees)
  // one large grille between the headlights (6 horizontal slats); the plate sits on its lower middle
  grille: polyRegion('f', [[0, 0.4], [18.5, 0.403], [21.5, 0.5], [21.6, 0.585], [19.5, 0.628], [0, 0.645]]),
  // narrow dark opening under the plate
  slot: polyRegion('f', [[0, 0.35], [23, 0.352], [24.5, 0.377], [0, 0.377]]),
  // corner intakes; the top edge slopes down towards the centre (FOG_TOP). The outer end runs out
  // onto the flared bumper corner, as on the real car (the housing reaches almost to the corner)
  fog: polyRegion('f', [[31.5, 0.362], [43.8, 0.366], [46.2, 0.425], [45.5, 0.49], [32, 0.43]]),
  head: bandRegion('f', [[21.5, 0.604, 0.638], [27, 0.606, 0.66], [34, 0.613, 0.681], [42, 0.628, 0.7], [49, 0.648, 0.716], [55, 0.668, 0.728], [59, 0.688, 0.733]]),
  // tail (angle around x = -1.55)
  tail: bandRegion('r', [[0, 0.944, 0.967], [17, 0.944, 0.969], [23, 0.926, 0.982], [32, 0.908, 0.992], [44, 0.902, 0.998], [54, 0.915, 0.998], [59, 0.935, 0.995]]),
  rearPlate: polyRegion('r', [[0, 0.565], [13.6, 0.568], [14.2, 0.752], [0, 0.756]]),
};
const FOG_TOP = [[32, 0.43], [45.5, 0.49]]; // inner -> outer
const BELT_GLSL = glslLookup(beltAt, -1.4, 0.95, 14);
const doorTest = (front, sd, withY) => (p) => {
  if (p.z * sd < 0.45) return false;
  if (front ? (p.x < -0.36 || p.x > 0.7) : (p.x < -1.1 || p.x > -0.36)) return false;
  if (!front && (p.x + 1.35) ** 2 + (p.y - 0.32) ** 2 < 0.2304) return false;
  return !withY || p.y < beltAt(p.x) + 0.03;
};
const doorGlsl = (front, sd, withY) => [
  `P.z*(${sd}.0) > 0.45`,
  front ? 'P.x > -0.36 && P.x < 0.7' : 'P.x > -1.1 && P.x < -0.36 && ((P.x+1.35)*(P.x+1.35)+(P.y-0.32)*(P.y-0.32) > 0.2304)',
  withY ? `P.y < ${BELT_GLSL} + 0.03` : 'true',
].join(' && ');
const DOORS = {
  door_fr: { front: true, sd: 1, label: '右前ドア', hinge: [0.69, 0, 0.87], angle: 68 },
  door_rr: { front: false, sd: 1, label: '右後ドア', hinge: [-0.37, 0, 0.88], angle: 62 },
  door_fl: { front: true, sd: -1, label: '左前ドア', hinge: [0.69, 0, -0.87], angle: -68 },
  door_rl: { front: false, sd: -1, label: '左後ドア', hinge: [-0.37, 0, -0.88], angle: -62 },
};
for (const d of Object.values(DOORS)) {
  d.paint = exprRegion(doorGlsl(d.front, d.sd, true), doorTest(d.front, d.sd, true));
  d.glass = exprRegion(doorGlsl(d.front, d.sd, false), doorTest(d.front, d.sd, false));
}
const TRUNK = exprRegion('P.x < -1.9 && az < 0.6 && P.y > 0.8', (p) => p.x < -1.9 && Math.abs(p.z) < 0.6 && p.y > 0.8);

/**
 * Builds the car. `part(id, object, anchor, parent)` registers a tappable part (see CarViewer).
 * Returns { panels } — the doors, hood and trunk that open on a double tap.
 */
export function buildModel({ part, car, bodyColor, plateTex, envMap = null }) {
  // ---------------- materials ----------------
  // deep pearl black: an almost non-metallic, slightly rough base under a mirror-like clear coat.
  // The clear coat carries the sharp highlights that draw the press lines; the base adds only a
  // faint pearl sheen, so the paint stays black instead of turning silver-grey in a bright room.
  // (CarViewer.tunePaint sets the environment strength per colour.)
  const paint = new THREE.MeshPhysicalMaterial({
    color: bodyColor, metalness: 0.08, roughness: 0.42, specularIntensity: 0.2,
    clearcoat: 1, clearcoatRoughness: 0.03,
  });
  paint.name = 'paint';
  const piano = new THREE.MeshPhysicalMaterial({ color: 0x050608, metalness: 0.2, roughness: 0.14, clearcoat: 1, clearcoatRoughness: 0.05 });
  const satin = new THREE.MeshStandardMaterial({ color: 0x0d0e10, roughness: 0.62, metalness: 0.15 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.85, metalness: 0.1, side: THREE.DoubleSide });
  const gapMat = new THREE.MeshBasicMaterial({ color: 0x020203 });
  const voidMat = new THREE.MeshBasicMaterial({ color: 0x010101, side: THREE.DoubleSide });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xeef1f4, metalness: 1, roughness: 0.06 });
  // badges: polished chrome with its own, stronger reflections (the scene-wide environment is kept
  // weak for the black paint), on gloss piano black
  const badgeChrome = chromeMaterial(envMap);
  const badgeBlack = badgeBlackMaterial(envMap);
  const hybridMats = {
    chrome: badgeChrome, field: smokedChromeMaterial(envMap),
    blue: hybridBlueMaterial(envMap), blueLight: hybridBlueMaterial(envMap, { light: true }),
  };
  const darkChrome = new THREE.MeshStandardMaterial({ color: 0x30353b, metalness: 1, roughness: 0.22 });
  const lining = new THREE.MeshStandardMaterial({ color: 0x16171a, roughness: 0.95, side: THREE.BackSide });
  const headliner = new THREE.MeshStandardMaterial({ color: 0x3b3c3f, roughness: 0.95, side: THREE.BackSide });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x0a0f14, metalness: 0.1, roughness: 0.06, side: THREE.DoubleSide, envMapIntensity: 0.7,
    transparent: true, opacity: 0.8, depthWrite: false,
  });
  const housing = new THREE.MeshStandardMaterial({ color: 0x15181c, metalness: 0.85, roughness: 0.32, side: THREE.DoubleSide });
  const drl = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xe8f1ff, emissiveIntensity: 2.2, roughness: 0.2 });
  const ledWhite = new THREE.MeshStandardMaterial({ color: 0xf4f7ff, emissive: 0xcfe0ff, emissiveIntensity: 0.55, roughness: 0.1, metalness: 0.2 });
  const projLens = new THREE.MeshPhysicalMaterial({ color: 0x0c1018, metalness: 0.3, roughness: 0.05, clearcoat: 1, emissive: 0x2a4a78, emissiveIntensity: 0.35 });
  const amber = new THREE.MeshStandardMaterial({ color: 0xffa33a, emissive: 0xff7a00, emissiveIntensity: 0.3, roughness: 0.25, metalness: 0.3 });
  const headLens = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, metalness: 0, roughness: 0.02, clearcoat: 1, transparent: true, opacity: 0.16, depthWrite: false,
  });
  const redLed = new THREE.MeshStandardMaterial({ color: 0xff2030, emissive: 0xff0018, emissiveIntensity: 1.5, roughness: 0.2 });
  const redDim = new THREE.MeshStandardMaterial({ color: 0x6a0710, emissive: 0x7a0010, emissiveIntensity: 0.5, roughness: 0.25, metalness: 0.4 });
  const tailHousing = new THREE.MeshStandardMaterial({ color: 0x1a0406, metalness: 0.7, roughness: 0.3, side: THREE.DoubleSide });
  const tailLens = new THREE.MeshPhysicalMaterial({
    color: 0xb0101c, metalness: 0, roughness: 0.03, clearcoat: 1, transparent: true, opacity: 0.38, depthWrite: false,
  });
  const reverseMat = new THREE.MeshStandardMaterial({ color: 0xe9eef5, metalness: 0.9, roughness: 0.15 });
  const plateMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 });
  const plateFace = new THREE.MeshStandardMaterial({ map: plateTex, roughness: 0.5 });
  const plateLight = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff6e0, emissiveIntensity: 1.2 });
  const mirrorGlass = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 1, roughness: 0.04 });

  // ---------------- shell ----------------
  const g = buildBody();
  const probe = new Probe([g.paint, g.hood, g.roof, g.windshield, g.rear, g.side]);
  const paintPlain = paint.clone(); // unclipped (recesses, press lines, fuel lid)
  const paintWall = paint.clone();
  paintWall.side = THREE.DoubleSide;
  // walls of the grille / intake recesses: dead black so the openings read as deep shadow
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  const doorPaintCuts = Object.values(DOORS).map((d) => d.paint);
  const doorGlassCuts = Object.values(DOORS).map((d) => d.glass);
  const holes = [R.grille, R.slot, R.fog, R.head, R.tail, R.rearPlate];
  clipMaterial(paint, { cut: [...holes, ...doorPaintCuts, TRUNK] });

  const body = new THREE.Group();
  const shell = new THREE.Mesh(g.paint, paint);
  shell.userData.shell = true;
  body.add(shell);
  const liningMesh = new THREE.Mesh(g.paint, lining);
  liningMesh.userData.noGlow = true;
  liningMesh.userData.shell = true;
  body.add(liningMesh);
  const underMesh = new THREE.Mesh(g.under, darkMat);
  underMesh.userData.noGlow = true;
  underMesh.userData.shell = true;
  body.add(underMesh);
  const floor = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.12, 1.3), darkMat);
  floor.position.set(-0.05, 0.27, 0);
  floor.userData.noGlow = true;
  floor.userData.shell = true;
  body.add(floor);

  // ---------------- helpers on the shell ----------------
  const pts = (list) => list.filter(Boolean);
  const tube = (points, r, mat, closed = false, seg) => new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points, closed, 'centripetal'), seg || Math.max(16, points.length * 3), r, 6, closed), mat);
  const nose = (a, y, off) => probe.nose(a, y, off);
  const tailP = (a, y, off) => probe.tail(a, y, off);
  const at = (coord) => (coord === 'f' ? nose : tailP);

  // fill a convex (angle, y) polygon with a conforming grid at `off` from the surface
  function polyRows(reg, off, rows = 10, cols = 24, coordFn) {
    const P = reg.pts;
    const ys = P.map((p) => p[1]);
    const y0 = Math.min(...ys), y1 = Math.max(...ys);
    const out = [], uvs = [];
    for (let i = 0; i <= rows; i++) {
      const y = y0 + 0.001 + (y1 - y0 - 0.002) * (i / rows);
      let lo = Infinity, hi = -Infinity;
      for (let k = 0; k < P.length; k++) {
        const [ax, ay] = P[k], [bx, by] = P[(k + 1) % P.length];
        if ((y - ay) * (y - by) > 0 || ay === by) continue;
        const a = ax + ((bx - ax) * (y - ay)) / (by - ay);
        lo = Math.min(lo, a); hi = Math.max(hi, a);
      }
      if (!Number.isFinite(lo)) { lo = 0; hi = 0.01; }
      const row = [], urow = [];
      for (let j = 0; j <= cols; j++) {
        const a = lo + (hi - lo) * (j / cols);
        const h = (coordFn || at(reg.coord))(a, y, off);
        const p = h ? h.p : (row[j - 1] || V(0, y, 0)).clone();
        row.push(p);
        urow.push([p.z, p.y]);
      }
      out.push(row); uvs.push(urow);
    }
    return { rows: out, uvs };
  }
  function bandRows(reg, off, a0, a1, rows = 6, cols = 40, t0 = 0, t1 = 1) {
    const out = [], uvs = [];
    for (let i = 0; i <= rows; i++) {
      const t = t0 + (t1 - t0) * (i / rows);
      const row = [], urow = [];
      for (let j = 0; j <= cols; j++) {
        const a = a0 + (a1 - a0) * (j / cols);
        const y = reg.ylo(a) + (reg.yhi(a) - reg.ylo(a)) * t;
        const h = at(reg.coord)(a, y, off);
        const p = h ? h.p : (row[j - 1] || V(0, y, 0)).clone();
        row.push(p); urow.push([j / cols, t]);
      }
      out.push(row); uvs.push(urow);
    }
    return { rows: out, uvs };
  }
  // closed outline of a region in (angle, y)
  function outline(reg, n = 60) {
    if (reg.pts) {
      const P = reg.pts, out = [];
      for (let k = 0; k < P.length; k++) {
        const [ax, ay] = P[k], [bx, by] = P[(k + 1) % P.length];
        const len = Math.max(2, Math.round(n / P.length));
        for (let i = 0; i < len; i++) out.push([ax + ((bx - ax) * i) / len, ay + ((by - ay) * i) / len]);
      }
      return out;
    }
    const a0 = reg.stops[0][0], a1 = reg.stops[reg.stops.length - 1][0];
    const lo = [], hi = [];
    for (let i = 0; i <= n / 2; i++) {
      const a = a0 + ((a1 - a0) * i) / (n / 2);
      lo.push([a, reg.ylo(a)]); hi.push([a, reg.yhi(a)]);
    }
    return [...lo, ...hi.reverse()];
  }
  const ring = (reg, list, off) => list.map(([a, y]) => at(reg.coord)(a, y, off)?.p).filter(Boolean);
  // recess walls from the surface down to `depth`
  // (centred openings: only the outer half, the mirror copy does the rest; bands: optional angle span)
  function walls(reg, depth, mat, n = 80, span = null) {
    let o, closed = true;
    if (span) {
      const [a0, a1] = span, lo = [], hi = [];
      for (let i = 0; i <= n / 2; i++) { const a = a0 + ((a1 - a0) * i) / (n / 2); lo.push([a, reg.ylo(a)]); hi.push([a, reg.yhi(a)]); }
      // the ends at a0 = 0 (centre line) and at the split stay open
      o = span[2] ? [...lo, ...hi.reverse()] : null;
      if (!o) {
        const outerEnd = [];
        for (let i = 0; i <= 4; i++) outerEnd.push([a1, reg.ylo(a1) + (reg.yhi(a1) - reg.ylo(a1)) * (i / 4)]);
        const parts = [lo, hi];
        const mk = (list) => {
          const outer = [], inner = [];
          for (const [a, y] of list) {
            const h0 = at(reg.coord)(a, y, 0.002), h1 = at(reg.coord)(a, y, -depth);
            if (h0 && h1) { outer.push(h0.p); inner.push(h1.p); }
          }
          return outer.length > 1 ? new THREE.Mesh(gridGeo([outer, inner]), mat) : null;
        };
        const grp = new THREE.Group();
        for (const l of span[3] ? [...parts, outerEnd] : parts) { const m = mk(l); if (m) grp.add(m); }
        return grp;
      }
    } else if (centred(reg)) { o = halfOutline(reg, n); closed = false; } else o = outline(reg, n);
    const outer = [], inner = [];
    for (const [a, y] of o) {
      const h0 = at(reg.coord)(a, y, 0.002), h1 = at(reg.coord)(a, y, -depth);
      if (h0 && h1) { outer.push(h0.p); inner.push(h1.p); }
    }
    if (closed) { outer.push(outer[0]); inner.push(inner[0]); }
    const geo = gridGeo([outer, inner]);
    return new THREE.Mesh(geo, mat);
  }
  // only the right half of a centred opening (angle >= 0); the left half is a mirror copy
  const centred = (reg) => reg.pts && reg.pts.some((p) => p[0] === 0);
  function halfOutline(reg, n = 60) {
    // open polyline: from the centre bottom, round the outer side, back to the centre top
    const o = outline(reg, n);
    const startIdx = o.findIndex((p, i) => p[0] === 0 && o[(i + 1) % o.length][0] > 0);
    const rot = [...o.slice(startIdx), ...o.slice(0, startIdx)];
    const end = rot.findIndex((p, i) => i > 0 && p[0] === 0);
    return rot.slice(0, end + 1);
  }

  /**
   * Bends a flat badge (local frame: x right, y up, z out) onto the curved paint so it sits flush
   * along its whole length, like the real stick-on badges. hitAt(u) returns the surface point and
   * outward normal at the badge's local x = u. Vertices and normals are moved into that frame;
   * the result is in the coordinates of the caller's group (= car coordinates).
   */
  function conform(badge, hitAt, lift = 0.0004) {
    badge.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(badge);
    const N = 16, u0 = box.min.x - 0.005, u1 = box.max.x + 0.005;
    const st = [];
    for (let i = 0; i <= N; i++) {
      const h = hitAt(u0 + ((u1 - u0) * i) / N);
      if (!h) return null;
      st.push(h);
    }
    // probe normals are per triangle: average neighbours for a smooth bend
    const nrm = st.map((_, i) => {
      const n = new THREE.Vector3();
      for (let k = Math.max(0, i - 2); k <= Math.min(N, i + 2); k++) n.add(st[k].n);
      return n.normalize();
    });
    const up = V(0, 1, 0), P = V(0, 0, 0), n = V(0, 0, 0), ey = V(0, 0, 0), ex = V(0, 0, 0), v = V(0, 0, 0);
    const frame = (u) => {
      const f = THREE.MathUtils.clamp(((u - u0) / (u1 - u0)) * N, 0, N - 1e-6), i = Math.floor(f), t = f - i;
      P.lerpVectors(st[i].p, st[i + 1].p, t);
      n.lerpVectors(nrm[i], nrm[i + 1], t).normalize();
      ey.copy(up).addScaledVector(n, -n.dot(up)).normalize();
      ex.crossVectors(ey, n);
    };
    const out = new THREE.Group();
    out.name = badge.name;
    badge.traverse((o) => {
      if (!o.isMesh) return;
      const geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
      const pos = geo.attributes.position, nor = geo.attributes.normal;
      for (let i = 0; i < pos.count; i++) {
        frame(pos.getX(i));
        const y = pos.getY(i), z = pos.getZ(i) + lift;
        v.copy(P).addScaledVector(ey, y).addScaledVector(n, z);
        const nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i);
        pos.setXYZ(i, v.x, v.y, v.z);
        v.set(0, 0, 0).addScaledVector(ex, nx).addScaledVector(ey, ny).addScaledVector(n, nz).normalize();
        nor.setXYZ(i, v.x, v.y, v.z);
      }
      pos.needsUpdate = true; nor.needsUpdate = true;
      geo.computeBoundingBox(); geo.computeBoundingSphere();
      out.add(new THREE.Mesh(geo, o.material));
    });
    return out;
  }

  // =============================================================================================
  // FRONT
  // =============================================================================================
  const front = new THREE.Group();
  const frontR = new THREE.Group(); // right half, mirrored afterwards
  {
    // ---- grille: stacked horizontal slats (solid bars with depth), as on the real ZE4 ----
    // left/right limit (angle) of a convex (angle, y) polygon at height y
    const spanAt = (reg, y) => {
      const P = reg.pts;
      let lo = Infinity, hi = -Infinity;
      for (let k = 0; k < P.length; k++) {
        const [ax, ay] = P[k], [bx, by] = P[(k + 1) % P.length];
        if ((y - ay) * (y - by) > 0 || ay === by) continue;
        const a = ax + ((bx - ax) * (y - ay)) / (by - ay);
        lo = Math.min(lo, a); hi = Math.max(hi, a);
      }
      return Number.isFinite(lo) ? [lo, hi] : null;
    };
    // one slat: a bar swept along the surface line [a, y(a)], set back by `inset`.
    // profile [u (outwards), v (up)]: the top face rises towards the back, so each bar leans back
    // slightly, catches the light on top and throws a shadow on the bar below.
    const slat = (line, inset, profile, mat) => {
      const f = line.map(([a, y]) => nose(a, y, -inset)).filter(Boolean);
      if (f.length < 3) return null;
      // average normal of the whole line keeps the bar straight (no twist from single triangles)
      return new THREE.Mesh(sweep(f, profile, { closedProfile: true, smoothN: 8 }), mat);
    };
    const slatLine = (a0, a1, y0, y1 = y0, n = 26) => Array.from({ length: n }, (_, i) => {
      const t = i / (n - 1);
      return [a0 + (a1 - a0) * t, y0 + (y1 - y0) * t];
    });
    // main bar (gloss black with a dark-chrome front lip), thinner black bar set further back
    const barMain = [[0.0015, -0.0062], [0.0015, 0.0052], [-0.004, 0.0072], [-0.04, 0.0135], [-0.04, 0.0015], [-0.006, -0.0062]];
    const barLip = [[0.0028, -0.0016], [0.0028, 0.0042], [0.0002, 0.006], [0.0002, -0.0016]];
    const barBack = [[0, -0.0035], [0, 0.0035], [-0.03, 0.0095], [-0.03, 0.002]];
    // bars: gloss black that does not mirror the bright room (low metalness, some roughness);
    // only a thin dark-metal front lip catches a grey line, as on the real grille
    const slatEdge = new THREE.MeshStandardMaterial({ color: 0x3c4148, metalness: 0.9, roughness: 0.32 });
    const slatMat = new THREE.MeshStandardMaterial({ color: 0x0a0b0d, metalness: 0.05, roughness: 0.48 });
    const slatBack = new THREE.MeshStandardMaterial({ color: 0x040405, metalness: 0, roughness: 0.85 });

    const G = R.grille, gDepth = 0.075;
    const [gy0, gy1] = [Math.min(...G.pts.map((p) => p[1])), Math.max(...G.pts.map((p) => p[1]))];
    // 6 main bars over the full height (the photo shows 6 bright bar edges; the plate covers the
    // lower middle) and a thin black bar half way between each pair
    const NB = 6, pitch = (gy1 - gy0) / NB;
    for (let i = 0; i < NB; i++) {
      const y = gy0 + pitch * (i + 0.42);
      const s = spanAt(G, y);
      if (!s) continue;
      const line = slatLine(0, s[1] + 0.4, y);
      const m = slat(line, 0.007, barMain, slatMat);
      if (m) frontR.add(m);
      const lip = slat(line, 0.007, barLip, slatEdge);
      if (lip) frontR.add(lip);
      const yb = y + pitch * 0.5;
      const sb = spanAt(G, yb);
      if (sb && yb < gy1 - 0.008) {
        const b = slat(slatLine(0, sb[1] + 0.4, yb), 0.026, barBack, slatBack);
        if (b) frontR.add(b);
      }
    }
    // vertical carriers behind the bars
    for (const a of [6, 13]) {
      const v = pts([gy0 + 0.004, (gy0 + gy1) / 2, gy1 - 0.004].map((y) => nose(a, y, -0.05)?.p));
      if (v.length === 3) frontR.add(tube(v, 0.004, slatBack));
    }
    // dark back wall (in shadow) and the recess walls
    const { rows: gb } = polyRows(G, -gDepth, 4, 12);
    frontR.add(new THREE.Mesh(gridGeo(gb), voidMat));
    frontR.add(walls(G, gDepth, wallMat));
    frontR.add(tube(ring(G, halfOutline(G, 70), 0.003), 0.0065, piano));

    // dark, narrow horizontal opening under the plate (fine black slats deep inside)
    const S = R.slot, sDepth = 0.05;
    const { rows: sb } = polyRows(S, -sDepth, 3, 10);
    frontR.add(new THREE.Mesh(gridGeo(sb), voidMat));
    frontR.add(walls(S, sDepth, wallMat));
    frontR.add(tube(ring(S, halfOutline(S, 40), 0.002), 0.0045, piano));
    {
      const [sy0, sy1] = [Math.min(...S.pts.map((p) => p[1])), Math.max(...S.pts.map((p) => p[1]))];
      for (let i = 1; i <= 3; i++) {
        const y = sy0 + ((sy1 - sy0) * i) / 4;
        const s = spanAt(S, y);
        if (s) { const m = slat(slatLine(0, s[1] + 0.3, y), 0.02, barBack, slatMat); if (m) frontR.add(m); }
      }
    }

    // chrome wing bar over the grille, running out under the headlights
    // the bar dips under the inner end of each headlight and follows its lower edge outwards
    const H = R.head;
    const wing = spline2([[0, 0.657], [9, 0.655], [15, 0.651], [19, 0.636], [21, H.ylo(21.5) - 0.006], [27, H.ylo(27) - 0.007], [34, H.ylo(34) - 0.008]], 48);
    const wf = wing.map(([a, y]) => nose(a, y, 0.004)).filter(Boolean);
    frontR.add(new THREE.Mesh(sweep(wf, [[-0.004, -0.008], [0.006, -0.0075], [0.0095, 0], [0.006, 0.0075], [-0.004, 0.008]], { closedProfile: true, smoothN: 6 }), chrome));

    // corner intakes: satin-black surround, 4 slats parallel to the sloping top edge,
    // LED fog lamp (4 small square lenses) on the top slat
    const F = R.fog, fDepth = 0.045;
    const { rows: fb } = polyRows(F, -fDepth, 4, 10);
    frontR.add(new THREE.Mesh(gridGeo(fb), voidMat));
    frontR.add(walls(F, fDepth, wallMat));
    frontR.add(tube(ring(F, outline(F, 60), 0.003), 0.0065, satin, true));
    {
      // top edge of the intake runs from fogTop[0] (inner) to fogTop[1] (outer)
      const [[ia, iy], [oa, oy]] = FOG_TOP;
      const yTop = (a) => iy + ((oy - iy) * (a - ia)) / (oa - ia);
      const fy0 = Math.min(...F.pts.map((p) => p[1]));
      for (let i = 0; i < 4; i++) {
        const drop = 0.014 + i * 0.022;
        // slat line parallel to the top edge, clipped to the opening
        const line = [];
        for (let k = 0; k <= 24; k++) {
          const a = ia - 1 + ((oa - ia + 2) * k) / 24;
          const y = yTop(a) - drop;
          if (y < fy0 + 0.006) continue;
          const s = spanAt(F, y);
          if (s && a >= s[0] - 0.3 && a <= s[1] + 0.3) line.push([a, y]);
        }
        if (line.length < 4) continue;
        const m = slat(line, 0.01, barMain.map(([u, v]) => [u * 0.8, v * 0.75]), slatMat);
        if (m) frontR.add(m);
        if (i === 0) {
          // 4 LED fog lamps sitting on the top slat, inner half
          for (const t of [0.34, 0.45, 0.56, 0.67]) {
            const a = oa + (ia - oa) * t;
            const h = nose(a, yTop(a) - drop + 0.009, -0.006);
            const h2 = nose(a + 0.5, yTop(a + 0.5) - drop + 0.009, -0.006);
            if (!h || !h2) continue;
            const led = new THREE.Group();
            const lens = new THREE.Mesh(new THREE.BoxGeometry(0.019, 0.0085, 0.005), ledWhite);
            const bez = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.011, 0.004), darkChrome);
            bez.position.z = -0.002;
            led.add(bez, lens);
            // local x along the slat, local z out of the surface
            const ex = h2.p.clone().sub(h.p).normalize();
            const ez = h.n.clone().addScaledVector(ex, -h.n.dot(ex)).normalize();
            led.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(ex, new THREE.Vector3().crossVectors(ez, ex), ez));
            led.position.copy(h.p);
            led.userData.lamp = true;
            frontR.add(led);
          }
        }
      }
    }
    // lower lip spoiler (piano black) under the bumper
    const lip = spline2([[0, 0.305], [15, 0.307], [28, 0.312], [38, 0.33], [46, 0.35]], 40)
      .map(([a, y]) => nose(a, y, -0.004)).filter(Boolean);
    if (lip.length > 4) {
      frontR.add(new THREE.Mesh(sweep(lip, [[0, 0.004], [0.028, 0.0], [0.034, -0.01], [0.022, -0.026], [-0.004, -0.028]], { closedProfile: true }), piano));
    }
    // bumper corner air-curtain groove and the hood press lines are on the paint (see below)
  }
  const frontBaked = bake(frontR);
  front.add(frontBaked, mirrored(frontBaked));

  // centre H emblem on the top of the grille: solid chrome frame + H with chamfered edges on a
  // recessed piano-black field, mounted on a black base that reaches back into the slats
  {
    const c = probe.front(0.588, 0, 0.0);
    const badge = hEmblem(0.106, { chrome: badgeChrome, black: badgeBlack, baseDepth: 0.024 });
    badge.position.copy(c.p).add(V(0.012, 0, 0));
    badge.lookAt(badge.position.clone().add(V(1, 0, 0)));
    front.add(badge);
  }
  // front plate on a piano-black holder over the lower middle of the grille
  {
    const PLATE_Y = 0.447; // plate centre (its lower edge overlaps the slot as on the real car)
    const c = probe.front(PLATE_Y, 0, 0.0);
    const holder = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.185, 0.355), piano);
    holder.position.set(c.p.x - 0.004, PLATE_Y, 0);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.167, 0.333), plateMat);
    back.position.set(c.p.x + 0.013, PLATE_Y, 0);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(0.33, 0.165), plateFace);
    face.rotation.y = Math.PI / 2;
    face.position.set(c.p.x + 0.0175, PLATE_Y, 0);
    front.add(holder, back, face);
  }
  body.add(front);

  // =============================================================================================
  // HEADLIGHTS (slim LED: DRL light guide, three projector modules, amber turn signal)
  // =============================================================================================
  const headR = new THREE.Group();
  {
    const H = R.head;
    const depth = 0.03;
    const { rows } = bandRows(H, -depth, 21.5, 59, 6, 44);
    headR.add(new THREE.Mesh(gridGeo(rows), housing));
    headR.add(walls(H, depth, housing, 100));
    // inner chrome reflector sweep in the lower half
    const { rows: refl } = bandRows(H, -depth + 0.006, 22, 47, 3, 30, 0.05, 0.42);
    headR.add(new THREE.Mesh(gridGeo(refl), darkChrome));
    // DRL light guide along the top edge, wrapping round the corner
    const drlLine = [];
    for (let a = 22; a <= 58.5; a += 1.5) {
      const h = nose(a, H.yhi(a) - 0.009, -0.01);
      if (h) drlLine.push(h.p);
    }
    headR.add(tube(drlLine, 0.0048, drl, false, 120));
    // a thin second guide under the projectors (signature "underline")
    const under = [];
    for (let a = 23; a <= 44; a += 1.5) {
      const h = nose(a, H.ylo(a) + 0.006, -0.012);
      if (h) under.push(h.p);
    }
    headR.add(tube(under, 0.0022, drl, false, 60));
    // three projector modules
    for (const a of [26.5, 32, 37.5]) {
      const y = (H.ylo(a) + H.yhi(a)) / 2 - 0.004;
      const h = nose(a, y, -0.016);
      if (!h) continue;
      const m = new THREE.Group();
      const cup = new THREE.Mesh(new THREE.LatheGeometry([[0.004, -0.012], [0.012, -0.009], [0.017, -0.004], [0.019, 0.002]].map(([r, z]) => new THREE.Vector2(r, z)), 28), chrome);
      cup.rotation.x = Math.PI / 2;
      m.add(cup);
      const lens = new THREE.Mesh(new THREE.SphereGeometry(0.0115, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), projLens);
      lens.rotation.x = Math.PI / 2;
      m.add(lens);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.0175, 0.0022, 8, 32), drl);
      ring.position.z = 0.004;
      m.add(ring);
      const bezel = new THREE.Mesh(new THREE.TorusGeometry(0.0205, 0.0018, 6, 32), darkChrome);
      bezel.position.z = 0.003;
      m.add(bezel);
      m.position.copy(h.p);
      m.lookAt(h.p.clone().add(h.n));
      headR.add(m);
    }
    // amber turn signal in the outer, lower part (with LED segments)
    const { rows: tr } = bandRows(H, -depth + 0.01, 45, 57.5, 2, 16, 0.08, 0.52);
    headR.add(new THREE.Mesh(gridGeo(tr), amber));
    for (let a = 45.8; a < 57.5; a += 1.6) {
      const p0 = nose(a, H.ylo(a) + (H.yhi(a) - H.ylo(a)) * 0.12, -depth + 0.012);
      const p1 = nose(a, H.ylo(a) + (H.yhi(a) - H.ylo(a)) * 0.48, -depth + 0.012);
      if (p0 && p1) headR.add(tube([p0.p, p1.p], 0.0012, darkChrome, false, 2));
    }
    // clear outer lens and its bezel
    const { rows: lens } = bandRows(H, 0.004, 21.5, 59, 6, 44);
    const lensMesh = new THREE.Mesh(gridGeo(lens), headLens);
    lensMesh.renderOrder = 3;
    lensMesh.userData.keep = true;
    headR.add(lensMesh);
    headR.add(tube(ring(H, outline(H, 100), 0.002), 0.0035, piano, true, 200));
  }
  const heads = new THREE.Group();
  const headBaked = bake(headR);
  heads.add(headBaked, mirrored(headBaked));
  part('headlight', heads, [2.28, 0.74, 0.58]);

  // =============================================================================================
  // HOOD (opens on its rear hinge) with two press lines
  // =============================================================================================
  const panels = new Map();
  const pivotAt = (hinge) => {
    const pivot = new THREE.Group();
    pivot.position.set(...hinge);
    const inner = new THREE.Group();
    inner.position.set(-hinge[0], -hinge[1], -hinge[2]);
    pivot.add(inner);
    car.add(pivot);
    return { pivot, inner };
  };
  {
    const hinge = [0.78, topAt(0.78) + 0.005, 0];
    const { pivot, inner } = pivotAt(hinge);
    const hood = new THREE.Group();
    hood.add(new THREE.Mesh(g.hood, paint));
    const hl = new THREE.Mesh(g.hood, lining);
    hl.userData.noGlow = true;
    hood.add(hl);
    // two raised press lines running from the cowl to the headlights
    for (const sd of [1, -1]) {
      const fr = [];
      for (let x = 0.86; x <= 2.06; x += 0.04) {
        const z = sd * (0.27 + 0.07 * ((x - 0.86) / 1.2) ** 1.5);
        const h = probe.top(x, z, 0);
        if (h) fr.push(h);
      }
      hood.add(new THREE.Mesh(sweep(fr, [[-0.0005, -0.016], [0.0028, -0.002], [0.0035, 0], [0.0028, 0.002], [-0.0005, 0.02]], { closedProfile: false }), paintPlain));
    }
    part('engine', hood, [1.5, 0.98, 0], inner);
    panels.set('hood', { pivot, label: 'ボンネット', t: 0, target: 0, axis: V(0, 0, 1), angle: THREE.MathUtils.degToRad(40) });
    pivot.userData.panelId = 'hood';
  }
  // engine bay (visible when the hood is open)
  {
    const bay = new THREE.Group();
    const box = (w, h, d, mat, x, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      bay.add(m);
      return m;
    };
    const cyl = (r, h, mat, x, y, z, seg = 20) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat);
      m.position.set(x, y, z);
      bay.add(m);
      return m;
    };
    const black = new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.7, metalness: 0.2 });
    const alu = new THREE.MeshStandardMaterial({ color: 0x8d939a, roughness: 0.4, metalness: 0.8 });
    const white = new THREE.MeshStandardMaterial({ color: 0xd9dcd6, roughness: 0.5, transparent: true, opacity: 0.85 });
    const yellow = new THREE.MeshStandardMaterial({ color: 0xf2c012, roughness: 0.45 });
    const blue = new THREE.MeshStandardMaterial({ color: 0x2a62c9, roughness: 0.45 });
    const red = new THREE.MeshStandardMaterial({ color: 0xc8202a, roughness: 0.5 });
    const orange = new THREE.MeshStandardMaterial({ color: 0xff6a00, roughness: 0.5 });
    box(1.2, 0.02, 1.25, black, 1.45, 0.5, 0); // bay floor / undertray
    box(0.55, 0.3, 0.6, alu, 1.45, 0.62, 0.05); // engine block
    box(0.56, 0.06, 0.62, black, 1.45, 0.8, 0.05); // engine cover
    const label = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.1), new THREE.MeshStandardMaterial({ map: labelTexture('HYBRID'), roughness: 0.5, metalness: 0.4 }));
    label.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
    label.position.set(1.45, 0.832, 0.05);
    bay.add(label);
    box(0.32, 0.16, 0.42, alu, 1.5, 0.76, -0.5); // power control unit
    for (const z of [-0.36, -0.44, -0.52, -0.6]) cyl(0.012, 0.3, orange, 1.32, 0.78, z, 8).rotation.z = Math.PI / 2; // HV cables
    box(0.24, 0.19, 0.17, black, 1.05, 0.72, -0.6); // 12V battery
    cyl(0.012, 0.02, red, 1.1, 0.82, -0.56);
    cyl(0.012, 0.02, black, 1.0, 0.82, -0.56);
    box(0.12, 0.12, 0.1, white, 1.92, 0.72, 0.52); // coolant reservoir
    cyl(0.025, 0.02, blue, 1.92, 0.79, 0.52);
    cyl(0.03, 0.03, blue, 1.95, 0.74, -0.62); // washer
    cyl(0.028, 0.025, yellow, 0.98, 0.82, 0.52); // brake fluid
    cyl(0.025, 0.02, yellow, 1.35, 0.84, 0.22); // oil filler
    const dip = cyl(0.008, 0.06, yellow, 1.6, 0.83, 0.32); // dipstick handle
    dip.rotation.z = 0.3;
    box(0.05, 0.05, 1.15, black, 2.05, 0.68, 0); // radiator support
    box(0.1, 0.05, 1.45, black, 0.86, 0.86, 0); // cowl
    for (const sd of [1, -1]) cyl(0.07, 0.08, black, 1.22, 0.76, sd * 0.66, 24); // strut tops
    box(0.3, 0.14, 0.24, black, 1.85, 0.72, -0.2); // air box
    part('engine', bake(bay));
  }

  // =============================================================================================
  // DOORS (cut from the shell along the shut lines; glass, handles and mirrors ride along)
  // =============================================================================================
  const mirrorGroups = [];
  for (const [id, d] of Object.entries(DOORS)) {
    const { pivot, inner } = pivotAt(d.hinge);
    const door = new THREE.Group();
    const geo = subsetGeo(g.paint, (p) => d.paint.js(p));
    const m = new THREE.Mesh(geo, clipMaterial(paint.clone(), { keep: d.paint }));
    door.add(m);
    const trim = new THREE.Mesh(geo, clipMaterial(new THREE.MeshStandardMaterial({ color: 0x1d1f23, roughness: 0.8, side: THREE.BackSide }), { keep: d.paint }));
    trim.userData.noGlow = true;
    door.add(trim);
    // door handle: chrome pull with a dark recess under it
    const hx = d.front ? -0.14 : -0.93;
    const hy = creaseY(hx) + 0.038;
    const hp = probe.side(hx, hy, 0.0, d.sd);
    if (hp) {
      const handle = new THREE.Mesh(new THREE.CapsuleGeometry(0.014, 0.17, 4, 12), chrome);
      handle.rotation.z = Math.PI / 2;
      handle.scale.set(1, 1, 0.55);
      handle.position.copy(hp.p).addScaledVector(hp.n, 0.008);
      const recess = new THREE.Mesh(new THREE.CircleGeometry(0.03, 24), satin);
      recess.scale.set(2.9, 0.75, 1);
      recess.position.copy(hp.p).addScaledVector(hp.n, 0.0015);
      recess.position.y -= 0.006;
      recess.lookAt(recess.position.clone().add(hp.n));
      door.add(recess, handle);
      if (d.front) {
        // key-less entry button / key cylinder cover on the driver-side front handle
        const btn = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.004, 12), satin);
        btn.rotation.x = Math.PI / 2;
        btn.position.copy(handle.position).add(V(0.075, 0, 0.004 * d.sd));
        door.add(btn);
      }
    }
    // inner door trim: armrest and pull handle
    const ip = probe.side(d.front ? 0.15 : -0.75, 0.7, -0.06, d.sd);
    if (ip) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(d.front ? 0.5 : 0.38, 0.05, 0.06), new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.7 }));
      arm.position.copy(ip.p);
      door.add(arm);
    }
    part('body', door, null, inner);
    // window glass moves with the door
    const gm = new THREE.Mesh(subsetGeo(g.side, (p) => d.glass.js(p)), clipMaterial(glassMat.clone(), { keep: d.glass }));
    gm.renderOrder = 2;
    part('side_window', gm, null, inner);
    panels.set(id, { pivot, label: d.label, t: 0, target: 0, axis: V(0, 1, 0), angle: THREE.MathUtils.degToRad(d.angle) });
    pivot.userData.panelId = id;
    if (d.front) mirrorGroups.push([inner, d.sd]);
  }

  // =============================================================================================
  // TRUNK LID (with the gloss-black lip spoiler and the centre section of the tail lamp)
  // =============================================================================================
  const trunkHinge = [-1.9, topAt(-1.9), 0];
  const trunk = pivotAt(trunkHinge);
  {
    const lid = new THREE.Group();
    const geo = subsetGeo(g.paint, (p) => TRUNK.js(p));
    lid.add(new THREE.Mesh(geo, clipMaterial(paint.clone(), { keep: TRUNK, cut: [R.tail] })));
    const tl = new THREE.Mesh(geo, clipMaterial(lining.clone(), { keep: TRUNK }));
    tl.userData.noGlow = true;
    lid.add(tl);
    // duck-tail lip spoiler along the rear edge of the deck
    const sp = [];
    for (let z = -0.585; z <= 0.586; z += 0.039) {
      const h = probe.back(topAt(-2.33) - 0.012, z, 0) || probe.top(-2.33, z, 0);
      if (h) sp.push({ p: h.p, n: h.n });
    }
    // fixed axes: u = backwards, v = up
    lid.add(new THREE.Mesh(sweep(sp, [[-0.004, -0.004], [0.012, -0.004], [0.026, 0.008], [0.02, 0.016], [-0.03, 0.012]], { axes: [V(-1, 0, 0), V(0, 1, 0)] }), piano));
    // chrome garnish bar + H emblem + raised model lettering
    // The garnish is a low, rounded chrome strip clipped flat onto the lid: its back sits 1 mm into
    // the paint (no gap at the edges) and the crown stands 4 mm proud. Along this path (a rising =
    // +z) the sweep's v axis points down, so the profile runs bottom -> crown -> top to keep the
    // triangles facing outwards; the reverse order culled the outer faces and left only the flat
    // back face showing, which z-fought with the paint (the broken white streak under the badge).
    const gar = [];
    for (let a = -27; a <= 27; a += 3) { const h = tailP(a, 0.835, 0); if (h) gar.push(h); }
    const garProfile = [
      [-0.001, 0.0072], [0.0015, 0.0068], [0.003, 0.0055], [0.0038, 0.003], [0.004, 0],
      [0.0038, -0.003], [0.003, -0.0055], [0.0015, -0.0068], [-0.001, -0.0072],
    ];
    const garGeo = sweep(gar, garProfile);
    // close both ends of the strip with flat caps (otherwise the hollow section shows at an angle)
    {
      const M = garProfile.length, P = garGeo.attributes.position, N = P.count / M;
      const ring = (i) => Array.from({ length: M }, (_, j) => new THREE.Vector3().fromBufferAttribute(P, i * M + j));
      const mid = (r) => r.reduce((s, v) => s.add(v), new THREE.Vector3()).divideScalar(r.length);
      const pos = [], idx = [];
      for (const [i, inner] of [[0, 1], [N - 1, N - 2]]) {
        const r = ring(i), out = mid(r).sub(mid(ring(inner))), base = pos.length / 3;
        r.forEach((v) => pos.push(v.x, v.y, v.z));
        for (let j = 1; j < M - 1; j++) {
          const nrm = new THREE.Vector3().subVectors(r[j], r[0]).cross(new THREE.Vector3().subVectors(r[j + 1], r[0]));
          idx.push(...(nrm.dot(out) > 0 ? [base, base + j, base + j + 1] : [base, base + j + 1, base + j]));
        }
      }
      const caps = new THREE.BufferGeometry();
      caps.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      caps.setIndex(idx);
      caps.computeVertexNormals();
      lid.add(new THREE.Mesh(mergeGeometries([garGeo, caps]), chrome));
    }
    const bc = probe.back(0.885, 0, 0.0);
    if (bc) {
      const badge = hEmblem(0.088, { chrome: badgeChrome, black: badgeBlack, baseDepth: 0.006 });
      badge.position.copy(bc.p).addScaledVector(bc.n, 0.005);
      badge.lookAt(badge.position.clone().add(bc.n));
      lid.add(badge);
    }
    // Badges under the tail lamps, on the lid (they swing up with it), placed from photos of the
    // real car: "INSIGHT" under the LEFT lamp (z < 0), the HYBRID badge under the RIGHT lamp.
    // Both sit about one letter height under the lamp, with their outer end ~4-5 cm inside the
    // lid's side cut, and follow the curve of the lid.
    const BADGE_Y = 0.878;
    const lidHit = (zc) => (u) => probe.back(BADGE_Y, zc + u, 0);
    {
      // raised chrome letters, wide and slightly italic as on the real badge (about 165 x 21 mm)
      const name = chromeLettering('INSIGHT', 0.021, { chrome: badgeChrome, depth: 0.0022, stroke: 0.2, gap: 0.34, slant: 0.1, fit: 0.165 });
      const m = conform(name, lidHit(-0.472));
      if (m) { m.name = 'insightLettering'; lid.add(m); }
    }
    {
      // smaller than the fender badge (115 mm vs 135 mm)
      const hb = conform(hybridBadge(0.115, hybridMats), lidHit(0.49));
      if (hb) { hb.name = 'hybridBadgeRear'; lid.add(hb); }
    }
    part('body', lid, null, trunk.inner);
    panels.set('trunk', { pivot: trunk.pivot, label: 'トランク', t: 0, target: 0, axis: V(0, 0, 1), angle: THREE.MathUtils.degToRad(-72) });
    trunk.pivot.userData.panelId = 'trunk';
    // boot floor
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.03, 1.2), new THREE.MeshStandardMaterial({ color: 0x2b2d31, roughness: 0.95 }));
    boot.position.set(-2.1, 0.62, 0);
    body.add(boot);
  }

  // =============================================================================================
  // TAIL LAMPS: full-width LED line across the lid, C-shaped LED units in the corners
  // =============================================================================================
  {
    const T = R.tail;
    // angle where the lamp crosses the trunk cut (|z| = 0.6)
    let split = 30;
    for (let a = 20; a < 50; a += 0.25) { const h = tailP(a, (T.ylo(a) + T.yhi(a)) / 2, 0); if (h && Math.abs(h.p.z) >= 0.6) { split = a; break; } }
    const build = (a0, a1, withCorner) => {
      const grp = new THREE.Group();
      const depth = 0.024;
      const { rows } = bandRows(T, -depth, a0, a1, 4, Math.max(6, Math.round((a1 - a0) * 1.2)));
      grp.add(new THREE.Mesh(gridGeo(rows), tailHousing));
      const { rows: lens } = bandRows(T, 0.003, a0, a1, 4, Math.max(6, Math.round((a1 - a0) * 1.2)));
      const lm = new THREE.Mesh(gridGeo(lens), tailLens);
      lm.renderOrder = 3;
      lm.userData.keep = true;
      grp.add(lm);
      // continuous LED light guide through the middle of the lamp
      const mid = [];
      for (let a = a0; a <= a1 + 1e-6; a += 1) { const h = tailP(a, (T.ylo(a) + T.yhi(a)) / 2 + 0.002, -0.012); if (h) mid.push(h.p); }
      if (withCorner && mid.length > 1) grp.add(tube(mid, 0.0042, redLed, false, mid.length * 3));
      // the lid section: a dim red strip with a row of LED dots in front of it
      if (!withCorner) grp.add(new THREE.Mesh(gridGeo(bandRows(T, -depth + 0.006, a0, a1, 1, 24, 0.2, 0.8).rows), redDim));
      // LED dots (instanced)
      const dots = [];
      for (let a = a0 + 0.6; a < a1; a += withCorner ? 1.15 : 1.25) {
        for (const t of withCorner ? (a > 24 ? [0.2, 0.8] : [0.5]) : [0.5]) {
          const y = T.ylo(a) + (T.yhi(a) - T.ylo(a)) * t;
          const h = tailP(a, y, -0.01);
          if (h) dots.push(h.p);
        }
      }
      if (dots.length) {
        const im = new THREE.InstancedMesh(new THREE.SphereGeometry(0.0034, 8, 6), redLed, dots.length);
        const mm = new THREE.Matrix4();
        dots.forEach((p, i) => im.setMatrixAt(i, mm.makeTranslation(p.x, p.y, p.z)));
        grp.add(im);
      }
      if (withCorner) {
        // C-shaped outline guide (upper and lower arms joined at the outer end)
        const c = [];
        for (let a = 26; a <= 56; a += 1.5) { const h = tailP(a, T.yhi(a) - 0.007, -0.009); if (h) c.push(h.p); }
        for (let a = 56; a >= 26; a -= 1.5) { const h = tailP(a, T.ylo(a) + 0.007, -0.009); if (h) c.push(h.p); }
        grp.add(tube(c, 0.0032, redLed, false, 160));
        // reverse lamp (inner) and amber turn signal (outer) segments, lower half
        const { rows: rv } = bandRows(T, -depth + 0.008, Math.max(a0, split + 1), Math.max(a0, split + 1) + 6, 1, 6, 0.28, 0.72);
        grp.add(new THREE.Mesh(gridGeo(rv), reverseMat));
        const { rows: am } = bandRows(T, -depth + 0.008, 44, 51, 1, 6, 0.3, 0.7);
        grp.add(new THREE.Mesh(gridGeo(am), amber));
        grp.add(new THREE.Mesh(gridGeo(bandRows(T, -depth + 0.004, a0, a1, 2, 20, 0.05, 0.95).rows), redDim));
      }
      grp.add(walls(T, depth, tailHousing, 60, [a0, a1, false, withCorner]));
      return grp;
    };
    // centre (on the lid): angles 0..split, mirrored
    const lidR = build(0, split, false);
    const lidBaked = bake(lidR);
    const lidLamps = new THREE.Group();
    lidLamps.add(lidBaked, mirrored(lidBaked));
    part('taillight', lidLamps, null, trunk.inner);
    const cornerR = build(split, 59, true);
    const cornerBaked = bake(cornerR);
    const tails = new THREE.Group();
    tails.add(cornerBaked, mirrored(cornerBaked));
    // reflectors low on the bumper corners
    for (const sd of [1, -1]) {
      const h = probe.back(0.5, 0.64, 0.002);
      if (!h) continue;
      const r = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.022, 0.11), redDim);
      r.position.set(h.p.x, h.p.y, h.p.z * sd);
      r.rotation.y = -sd * Math.atan2(h.n.z, -h.n.x);
      tails.add(r);
    }
    part('taillight', tails, [-2.46, 1.0, 0.55]);
  }

  // =============================================================================================
  // REAR BUMPER: plate recess with plate lights, diffuser with fins, chrome lower garnish
  // =============================================================================================
  const rear = new THREE.Group();
  {
    const depth = 0.03;
    const rp = new THREE.Group();
    const { rows } = polyRows(R.rearPlate, -depth, 4, 8);
    rp.add(new THREE.Mesh(gridGeo(rows), paintPlain));
    rp.add(walls(R.rearPlate, depth, paintWall));
    rp.add(tube(ring(R.rearPlate, halfOutline(R.rearPlate), 0.0), 0.003, gapMat));
    const rpb = bake(rp);
    rear.add(rpb, mirrored(rpb));
    const c = probe.back(0.66, 0, -depth);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.167, 0.333), plateMat);
    back.position.set(c.p.x - 0.006, 0.66, 0);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(0.33, 0.165), plateFace);
    face.rotation.y = -Math.PI / 2;
    face.position.set(c.p.x - 0.0105, 0.66, 0);
    rear.add(back, face);
    // plate lights in the top of the recess
    const lights = new THREE.Group();
    for (const z of [-0.09, 0.09]) {
      const h = probe.back(0.745, z, -0.012);
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.006, 0.045), plateLight);
      l.position.set(h ? h.p.x : c.p.x, 0.75, z);
      lights.add(l);
    }
    part('taillight', lights);
    // diffuser: textured black valance across the bottom of the bumper, a flat undertray and fins
    const dif = new THREE.Group();
    const val = [];
    for (let a = 0; a <= 46; a += 2) { const h = tailP(a, 0.425, 0); if (h) val.push(h); }
    dif.add(new THREE.Mesh(sweep(val, [[-0.004, -0.03], [0.006, -0.03], [0.008, 0.028], [-0.004, 0.03]]), satin));
    const tray = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.012, 0.62), satin);
    tray.position.set(-2.2, 0.305, 0.31);
    dif.add(tray);
    for (const z of [0.06, 0.18, 0.3, 0.42]) {
      const h = probe.back(0.4, z, 0);
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.075, 0.006), piano);
      fin.position.set((h ? h.p.x : -2.37) + 0.1, 0.35, z);
      dif.add(fin);
    }
    // chrome lower garnish line across the bumper
    const gl = [];
    for (let a = -40; a <= 40; a += 2.5) { const h = tailP(a, 0.452, 0.002); if (h) gl.push(h); }
    rear.add(new THREE.Mesh(sweep(gl, [[-0.002, -0.0045], [0.0035, -0.004], [0.0045, 0], [0.0035, 0.004], [-0.002, 0.0045]]), chrome));
  }
  body.add(rear);

  // =============================================================================================
  // SIDES: sills, window trims, B/C pillar appliques, shut lines, side markers
  // =============================================================================================
  const sideR = new THREE.Group();
  {
    // gloss-black side sill garnish along the bottom of the doors
    const sill = [];
    for (let x = -0.96; x <= 0.97; x += 0.06) { const h = probe.side(x, 0.335, 0); if (h) sill.push(h); }
    sideR.add(new THREE.Mesh(sweep(sill, [[-0.004, -0.045], [0.01, -0.044], [0.016, -0.03], [0.012, 0.0], [-0.004, 0.006]], { axes: [V(0, 0, 1), V(0, 1, 0)] }), piano));
    // window surround: chrome lower beltline, chrome upper frame, black inner seal
    const dlo = dloOutline(56);
    const fix = (arr, off) => arr.map((p) => V(p.x, p.y, p.z + off));
    sideR.add(tube(fix(dlo.lower, 0.012), 0.0085, chrome, false, 120));
    sideR.add(tube(fix(dlo.upper, 0.009), 0.0068, chrome, false, 120));
    sideR.add(tube(fix(dlo.upper, -0.002).map((p) => V(p.x, p.y - 0.012, p.z)), 0.004, gapMat, false, 120));
    // B pillar and quarter-glass divider: gloss-black appliques that follow the glass curvature
    for (const [a, b] of GLASS.pillars) {
      const rows = [];
      for (let i = 0; i <= 8; i++) {
        const row = [];
        for (const x of [a - 0.004, (a + b) / 2, b + 0.004]) {
          const lo = dlo.lower.reduce((p, q) => (Math.abs(q.x - x) < Math.abs(p.x - x) ? q : p));
          const hi = dlo.upper.reduce((p, q) => (Math.abs(q.x - x) < Math.abs(p.x - x) ? q : p));
          const y = lo.y + (hi.y - lo.y) * (i / 8);
          const h = probe.side(x, y, 0.004);
          row.push(h ? h.p : V(x, y, lo.z));
        }
        rows.push(row);
      }
      sideR.add(new THREE.Mesh(gridGeo(rows), piano));
    }
    // shut lines of the doors (thin dark gaps)
    const vline = (x, y0, y1) => {
      const l = [];
      for (let y = y0; y <= y1 + 1e-6; y += 0.03) { const h = probe.side(x, y, 0.0004); if (h) l.push(h.p); }
      return l;
    };
    const gap = (l) => { if (l.length > 1) sideR.add(tube(l, 0.0022, gapMat, false, l.length * 2)); };
    gap(vline(0.7, 0.33, beltAt(0.7) + 0.03));
    gap(vline(-0.36, 0.33, beltAt(-0.36) + 0.03));
    const yArc = 0.32 + Math.sqrt(0.2304 - 0.25 ** 2);
    const rl = vline(-1.1, yArc, beltAt(-1.1) + 0.03).reverse();
    for (let t = Math.atan2(yArc - 0.32, 0.25); t > -0.02; t -= 0.06) {
      const h = probe.side(-1.35 + 0.48 * Math.cos(t), 0.32 + 0.48 * Math.sin(t), 0.0004);
      if (h) rl.push(h.p);
    }
    gap(rl);
    // side turn-signal repeater is in the mirror; small black marker at the front fender vent
  }
  const sideBaked = bake(sideR);
  body.add(sideBaked, mirrored(sideBaked));

  // trunk and hood shut lines
  {
    const lines = new THREE.Group();
    const gapTube = (l) => { if (l.length > 1) lines.add(tube(l, 0.0022, gapMat, false, l.length * 2)); };
    for (const sd of [1, -1]) {
      const l = [];
      for (let x = -1.905; x >= -2.3; x -= 0.03) { const h = probe.top(x, sd * 0.6, 0.0004); if (h) l.push(h.p); }
      for (let y = topAt(-2.33) - 0.03; y >= 0.8; y -= 0.02) { const h = probe.back(y, sd * 0.6, 0.0004); if (h) l.push(h.p); }
      gapTube(l);
    }
    const across = [];
    for (let z = -0.6; z <= 0.601; z += 0.04) { const h = probe.back(0.8, z, 0.0004); if (h) across.push(h.p); }
    gapTube(across);
    const deck = [];
    for (let z = -0.6; z <= 0.601; z += 0.04) { const h = probe.top(-1.905, z, 0.0004); if (h) deck.push(h.p); }
    gapTube(deck);
    for (const chain of boundaryChains(g.hood)) {
      const l = chain.filter((_, i) => i % 2 === 0);
      // skip the edge hidden under the cowl at the base of the windshield
      if (l.every((p) => p.x < 0.8)) continue;
      gapTube(l.map((p) => p.clone().add(V(0, 0.0005, 0))));
    }
    body.add(lines);
  }

  // =============================================================================================
  // ROOF: shark-fin antenna and roof drip mouldings
  // =============================================================================================
  {
    const roof = new THREE.Group();
    const fin = new THREE.Shape();
    fin.moveTo(0, 0); fin.lineTo(0.17, 0); fin.quadraticCurveTo(0.03, 0.02, 0.012, 0.062); fin.quadraticCurveTo(0.0, 0.065, -0.005, 0.05); fin.closePath();
    const fg = new THREE.ExtrudeGeometry(fin, { depth: 0.03, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.008, bevelSegments: 4, curveSegments: 12 });
    fg.translate(0, 0, -0.015);
    const fm = new THREE.Mesh(fg, piano);
    const ft = probe.top(-1.0, 0, 0);
    fm.position.set(ft.p.x, ft.p.y - 0.004, 0);
    // shape runs from the tall rear end (x = 0) to the low front tip (x = 0.17)
    fm.position.x -= 0.06;
    roof.add(fm);
    for (const sd of [1, -1]) {
      const l = [];
      for (let x = -0.95; x <= 0.2; x += 0.05) {
        const h = probe.top(x, sd * 0.56, 0.0015);
        if (h) l.push(h.p);
      }
      roof.add(tube(l, 0.0032, gapMat, false, 60));
    }
    body.add(roof);
  }

  // fuel lid on the left rear quarter (conforming disc with its shut line)
  {
    const fuel = new THREE.Group();
    const cx = -1.72, cy = 0.86, rx = 0.098, ry = 0.085;
    const rows = [];
    for (let i = 0; i <= 6; i++) {
      const row = [];
      for (let j = 0; j <= 24; j++) {
        const t = (j / 24) * Math.PI * 2, r = i / 6;
        const h = probe.side(cx + Math.cos(t) * rx * r, cy + Math.sin(t) * ry * r, 0.0012, -1);
        row.push(h.p);
      }
      rows.push(row);
    }
    fuel.add(new THREE.Mesh(gridGeo(rows), paintPlain));
    fuel.add(tube(rows[6].slice(0, 24), 0.0018, gapMat, true, 72));
    const hit = new THREE.Mesh(new THREE.CircleGeometry(0.16, 32), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    const c = probe.side(cx, cy, 0.008, -1);
    hit.scale.x = 1.2;
    hit.position.copy(c.p);
    hit.lookAt(c.p.clone().add(c.n));
    fuel.add(hit);
    part('fuel', fuel, [c.p.x, c.p.y + 0.05, c.p.z - 0.12]);
  }

  // merge all trims of the body into one mesh per material (keeps the draw calls low on phones)
  {
    const extras = new THREE.Group();
    for (const c of [...body.children]) if (!c.userData.shell) extras.add(c);
    body.add(bake(extras));
  }
  // HYBRID badge on the LEFT front fender only (as on the owner's car): between the wheel arch
  // and the front door shut line (x = 0.7), its rear end ~9 cm ahead of the door, about 6.5 cm
  // under the fender character line. Measured from a side photo of the real car.
  {
    const xc = 0.858, yc = creaseY(0.858) - 0.065;
    // badge local +x = towards the rear on the left side
    const hb = conform(hybridBadge(0.135, hybridMats), (u) => probe.side(xc - u, yc, 0, -1));
    if (hb) { hb.name = 'hybridBadgeSide'; body.add(hb); }
  }
  part('body', body, [-0.4, 0.62, 1.0]);

  // ---- glass & panels that can be tapped ----
  part('interior', new THREE.Mesh(g.roof, paint), [-0.5, 1.48, 0]);
  const hd = new THREE.Mesh(g.roof, headliner);
  hd.userData.noGlow = true;
  part('interior', hd);
  const ws = new THREE.Mesh(g.windshield, glassMat);
  ws.renderOrder = 2;
  part('windshield', ws, [0.47, 1.2, 0]);
  const rw = new THREE.Mesh(g.rear, glassMat);
  rw.renderOrder = 2;
  part('rear_window', rw, [-1.4, 1.3, 0]);
  const sw = new THREE.Mesh(g.side, clipMaterial(glassMat.clone(), { cut: doorGlassCuts }));
  sw.renderOrder = 2;
  part('side_window', sw, [-0.4, 1.12, 0.86]);
  // ---- wipers (resting at the base of the windshield) ----
  {
    const wipers = new THREE.Group();
    for (const [z, len] of [[0.36, 0.62], [-0.22, 0.5]]) {
      const base = probe.top(0.79, z, 0.012);
      if (!base) continue;
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, len), satin);
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.014, len * 0.95), satin);
      const grp = new THREE.Group();
      arm.position.set(0.0, 0.006, -len / 2);
      blade.position.set(-0.016, 0.0, -len / 2 + 0.02);
      const pivotCap = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.02, 0.022, 16), satin);
      grp.add(arm, blade, pivotCap);
      grp.position.copy(base.p);
      grp.rotation.set(0, 0.12, -0.12);
      wipers.add(grp);
    }
    // cowl top panel
    const cowl = [];
    for (let z = -0.8; z <= 0.801; z += 0.08) { const h = probe.top(0.775, z, 0.002); if (h) cowl.push(h); }
    wipers.add(new THREE.Mesh(sweep(cowl, [[0, -0.035], [0.006, -0.03], [0.008, 0.02], [0, 0.03]], { axes: [V(0, 1, 0), V(1, 0, 0)] }), satin));
    part('windshield', wipers);
  }

  // ---- dash cam behind the windshield, next to the rear-view mirror (invisible hit area) ----
  {
    const camHit = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.07, 0.32), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    camHit.position.set(0.355, 1.243, 0);
    camHit.rotation.z = -0.57;
    part('dashcam', camHit, [0.37, 1.32, 0]);
    // the camera itself and the rear-view mirror
    const cam = new THREE.Group();
    const unit = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.045, 0.08), satin);
    unit.position.set(0.37, 1.2, 0.1);
    const rvm = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.06, 0.24), satin);
    rvm.position.set(0.32, 1.17, 0);
    cam.add(unit, rvm);
    part('dashcam', cam);
  }

  // =============================================================================================
  // DOOR MIRRORS (gloss-black caps with LED turn-signal strip) — ride on the front doors
  // =============================================================================================
  for (const [inner, sd] of mirrorGroups) {
    const m = new THREE.Group();
    const bx = 0.47, by = beltAt(0.47) + 0.012;
    const base = probe.side(bx, by, 0, 1);
    const z0 = base.p.z;
    // sail mount on the door
    const sail = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.05, 0.05), piano);
    sail.position.set(bx - 0.01, by + 0.015, z0 + 0.012);
    m.add(sail);
    const armM = new THREE.Mesh(new THREE.CapsuleGeometry(0.018, 0.07, 4, 10), piano);
    armM.rotation.x = Math.PI / 2;
    armM.position.set(bx - 0.02, by + 0.045, z0 + 0.06);
    m.add(armM);
    // housing: half ellipsoid facing forward, flat glass face backward
    const hc = V(bx - 0.035, by + 0.1, z0 + 0.15);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(1, 36, 20, 0, Math.PI), piano);
    cap.rotation.y = Math.PI / 2; // dome towards +X
    cap.scale.set(0.125, 0.07, 0.085);
    cap.position.copy(hc);
    m.add(cap);
    const rimGeo = new THREE.TorusGeometry(1, 0.06, 8, 48);
    const rim = new THREE.Mesh(rimGeo, piano);
    rim.rotation.y = Math.PI / 2;
    rim.scale.set(0.125, 0.07, 0.125);
    rim.position.copy(hc);
    m.add(rim);
    const glass = new THREE.Mesh(new THREE.CircleGeometry(1, 40), mirrorGlass);
    glass.rotation.y = -Math.PI / 2;
    glass.scale.set(0.118, 0.064, 1);
    glass.position.copy(hc).add(V(-0.004, 0, 0));
    m.add(glass);
    // LED repeater along the lower front edge of the cap
    const led = [];
    const el = -0.5;
    for (let az = -0.75; az <= 1.45; az += 0.1) {
      led.push(V(hc.x + Math.cos(el) * Math.cos(az) * 0.086, hc.y + Math.sin(el) * 0.071, hc.z + Math.cos(el) * Math.sin(az) * 0.126));
    }
    m.add(tube(led, 0.0035, amber, false, 40));
    const mm = bake(m);
    const placed = sd > 0 ? mm : mirrored(mm);
    part('mirror', placed, null, inner);
  }
  // marker for the mirror part (anchor only)
  part('mirror', new THREE.Group(), [0.48, 1.17, 1.07]);

  // =============================================================================================
  // INTERIOR (seen through the glass and the open doors)
  // =============================================================================================
  {
    const cabin = new THREE.Group();
    const seatMat = new THREE.MeshStandardMaterial({ color: 0x1a1b1e, roughness: 0.85 });
    const dashMat = new THREE.MeshStandardMaterial({ color: 0x111215, roughness: 0.7 });
    const accent = new THREE.MeshStandardMaterial({ color: 0x5a5d63, metalness: 0.8, roughness: 0.3 });
    const screen = new THREE.MeshStandardMaterial({ color: 0x0a1522, emissive: 0x1d3a66, emissiveIntensity: 0.6, roughness: 0.2 });
    const add = (m, x, y, z, rx = 0, ry = 0, rz = 0) => { m.position.set(x, y, z); m.rotation.set(rx, ry, rz); cabin.add(m); return m; };
    const carpet = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.04, 1.5), new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 1 }));
    add(carpet, -0.45, 0.33, 0);
    for (const z of [0.37, -0.37]) {
      add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.5), seatMat), -0.12, 0.47, z);
      add(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.62, 0.48), seatMat), -0.42, 0.8, z, 0, 0, 0.22);
      add(new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.16, 0.26), seatMat), -0.52, 1.18, z, 0, 0, 0.18);
    }
    add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 1.38), seatMat), -1.08, 0.47, 0);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.55, 1.38), seatMat), -1.36, 0.78, 0, 0, 0, 0.3);
    for (const z of [0.45, 0, -0.45]) add(new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.13, 0.24), seatMat), -1.47, 1.1, z, 0, 0, 0.25);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.2, 1.52), dashMat), 0.55, 0.86, 0);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.05, 1.5), dashMat), 0.42, 0.97, 0, 0, 0, -0.25);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.13, 0.2), screen), 0.34, 1.04, 0, 0, 0, 0.25);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.09, 0.3), screen), 0.4, 0.98, 0.37, 0, 0, 0.25);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.18, 0.2), dashMat), 0.05, 0.5, 0);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.008, 1.5), accent), 0.36, 0.9, 0);
    // steering wheel (right-hand drive)
    const sw = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.016, 10, 36), dashMat);
    add(sw, 0.2, 0.88, 0.37, 0, Math.PI / 2, 0).rotateX(-0.42);
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.04, 20), accent), 0.21, 0.88, 0.37, 0, 0, Math.PI / 2 - 0.42);
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.3, 12), dashMat), 0.34, 0.84, 0.37, 0, 0, Math.PI / 2 - 0.42);
    part('interior', bake(cabin));
  }

  // =============================================================================================
  // WHEELS: 235/45R18 tyre with tread and sidewall lettering, 10 Y-spoke alloy, disc and caliper
  // =============================================================================================
  // wheel-arch liners so the arches do not look into the body
  {
    const liners = new THREE.Group();
    const geo = new THREE.CylinderGeometry(0.4, 0.4, 0.27, 40, 1, true, -Math.PI * 0.5, Math.PI);
    for (const x of [WHEELS.x, -WHEELS.x]) {
      for (const sd of [1, -1]) {
        const l = new THREE.Mesh(geo, darkMat);
        l.rotation.x = -Math.PI / 2; // open half-cylinder over the wheel
        l.position.set(x, 0.29, sd * 0.7);
        l.userData.noGlow = true;
        liners.add(l);
      }
    }
    part('body', liners);
  }
  const wheelProto = bake(buildWheel());
  const wheelDefs = [['tire_fl', WHEELS.x, -1], ['tire_fr', WHEELS.x, 1], ['tire_rl', -WHEELS.x, -1], ['tire_rr', -WHEELS.x, 1]];
  const wheels = [];
  for (const [id, x, sd] of wheelDefs) {
    const w = wheelProto.clone();
    if (sd < 0) w.scale.z = -1;
    w.position.set(x, WHEELS.r, sd * 0.79);
    wheels.push(w);
    part(id, w, [x, WHEELS.r + 0.05, sd * 1.04]);
  }

  return { panels, wheels, paint };
}

// 18-inch wheel: face on +Z (mirrored for the left side)
function buildWheel() {
  const g = new THREE.Group();
  const rimR = 0.2286, outerR = 0.3344, hw = 0.1175;
  // ---- tyre: lathe of the cross-section (radius, axial) ----
  const prof = [];
  prof.push([rimR + 0.004, -hw * 0.86], [rimR + 0.018, -hw * 0.99], [rimR + (outerR - rimR) * 0.5, -hw * 1.04], [outerR - 0.022, -hw * 0.98], [outerR - 0.006, -hw * 0.86]);
  for (let i = 0; i <= 24; i++) prof.push([outerR, -hw * 0.8 + (hw * 1.6 * i) / 24]);
  prof.push([outerR - 0.006, hw * 0.86], [outerR - 0.022, hw * 0.98], [rimR + (outerR - rimR) * 0.5, hw * 1.04], [rimR + 0.018, hw * 0.99], [rimR + 0.004, hw * 0.86]);
  const tyreGeo = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 96);
  const bump = treadBump();
  bump.repeat.set(3, 1);
  // lathe uv: u around, v along the profile; the tread occupies the middle of v
  const tyreMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.9, bumpMap: bump, bumpScale: 4 });
  const tyre = new THREE.Mesh(tyreGeo, tyreMat);
  tyre.rotation.x = Math.PI / 2; // lathe axis Y -> Z
  g.add(tyre);
  // tyre UVs: rotate so the bump texture's long axis runs around the tyre
  {
    const uv = tyreGeo.attributes.uv;
    for (let i = 0; i < uv.count; i++) { const u = uv.getX(i), v = uv.getY(i); uv.setXY(i, u, (v - 5 / 34) / (24 / 34)); }
  }
  // sidewall lettering (outer face)
  const lettering = new THREE.Mesh(
    new THREE.RingGeometry(rimR + 0.022, outerR - 0.024, 96, 1),
    new THREE.MeshStandardMaterial({
      map: sidewallTexture([['235/45R18  94W', -Math.PI * 0.62, 54], ['RADIAL  TUBELESS', Math.PI * 0.35, 40]]),
      transparent: true, roughness: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
    }),
  );
  lettering.position.z = hw * 1.045;
  g.add(lettering);

  // ---- alloy ----
  const face = new THREE.MeshStandardMaterial({ color: 0xc9ced4, metalness: 1, roughness: 0.2 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1d2024, metalness: 0.7, roughness: 0.38 });
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(rimR - 0.004, rimR - 0.004, hw * 1.75, 64, 1, true), dark);
  barrel.material.side = THREE.DoubleSide;
  barrel.rotation.x = Math.PI / 2;
  g.add(barrel);
  const inner = new THREE.Mesh(new THREE.CircleGeometry(rimR, 48), dark);
  inner.position.z = -hw * 0.8;
  g.add(inner);
  const lip = new THREE.Mesh(new THREE.TorusGeometry(rimR - 0.002, 0.008, 8, 72), face);
  lip.position.z = hw * 0.88;
  g.add(lip);
  // 10 Y-spokes as one extruded shape: machined faces (bright) and dark sides
  const shapes = [];
  const pol = (r, a) => new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r);
  for (let i = 0; i < 10; i++) {
    const b = (i / 10) * Math.PI * 2;
    const s = new THREE.Shape();
    const rh = 0.062, rs = 0.118, rr = rimR - 0.008;
    const pts = [
      pol(rh, b - 0.13), pol(rs, b - 0.075), pol(rr, b - 0.135), pol(rr, b - 0.075), pol(rs + 0.022, b - 0.012),
      pol(rs + 0.022, b + 0.012), pol(rr, b + 0.075), pol(rr, b + 0.135), pol(rs, b + 0.075), pol(rh, b + 0.13),
    ];
    s.moveTo(pts[0].x, pts[0].y);
    for (const p of pts.slice(1)) s.lineTo(p.x, p.y);
    s.closePath();
    shapes.push(s);
  }
  const spokeGeo = new THREE.ExtrudeGeometry(shapes, { depth: 0.024, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.003, bevelSegments: 1, curveSegments: 1 });
  // dish the spokes: push the outer ends back slightly
  {
    const p = spokeGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const r = Math.hypot(p.getX(i), p.getY(i));
      p.setZ(i, p.getZ(i) - 0.03 * Math.max(0, (r - 0.06) / 0.17) ** 1.4);
    }
    spokeGeo.computeVertexNormals();
  }
  // ExtrudeGeometry makes a lid group (0) and a side group (1) per shape: split by material index
  for (const [i, mat] of [[0, face], [1, dark]]) {
    const sub = new THREE.BufferGeometry();
    for (const k of ['position', 'normal', 'uv']) {
      const a = spokeGeo.attributes[k];
      const parts = spokeGeo.groups.filter((gr) => gr.materialIndex === i)
        .map((gr) => a.array.slice(gr.start * a.itemSize, (gr.start + gr.count) * a.itemSize));
      const arr = new Float32Array(parts.reduce((n, q) => n + q.length, 0));
      let o = 0;
      for (const q of parts) { arr.set(q, o); o += q.length; }
      sub.setAttribute(k, new THREE.BufferAttribute(arr, a.itemSize));
    }
    const m = new THREE.Mesh(sub, mat);
    m.position.z = hw * 0.72;
    g.add(m);
  }
  // hub, centre cap and lug nuts
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.068, 0.074, 0.03, 40), dark);
  hub.rotation.x = Math.PI / 2;
  hub.position.z = hw * 0.78;
  g.add(hub);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.032, 0.012, 32), face);
  cap.rotation.x = Math.PI / 2;
  cap.position.z = hw * 0.78 + 0.02;
  g.add(cap);
  const nutGeo = new THREE.CylinderGeometry(0.0095, 0.0095, 0.02, 6);
  const nuts = new THREE.InstancedMesh(nutGeo, face, 5);
  const mm = new THREE.Matrix4(), q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + Math.PI / 10;
    nuts.setMatrixAt(i, mm.compose(V(Math.cos(a) * 0.05, Math.sin(a) * 0.05, hw * 0.78 + 0.018), q, V(1, 1, 1)));
  }
  g.add(nuts);
  // brake disc (ventilated look), hat, and a caliper visible between the spokes
  const discMat = new THREE.MeshStandardMaterial({ color: 0x6d7177, metalness: 0.9, roughness: 0.45 });
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.155, 0.024, 48), discMat);
  disc.rotation.x = Math.PI / 2;
  disc.position.z = 0.01;
  g.add(disc);
  const slots = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.152, 48, 1), new THREE.MeshStandardMaterial({ color: 0x55595e, metalness: 0.9, roughness: 0.25 }));
  slots.position.z = 0.0225;
  g.add(slots);
  const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.05, 32), dark);
  hat.rotation.x = Math.PI / 2;
  hat.position.z = 0.03;
  g.add(hat);
  const cal = new THREE.Shape();
  const a0 = Math.PI * 0.62, a1 = Math.PI * 0.95;
  cal.absarc(0, 0, 0.178, a0, a1, false);
  cal.absarc(0, 0, 0.118, a1, a0, true);
  cal.closePath();
  const calGeo = new THREE.ExtrudeGeometry(cal, { depth: 0.05, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 2, curveSegments: 10 });
  calGeo.translate(0, 0, -0.012);
  const caliper = new THREE.Mesh(calGeo, new THREE.MeshStandardMaterial({ color: 0x3a3d42, metalness: 0.6, roughness: 0.45 }));
  g.add(caliper);
  return g;
}
