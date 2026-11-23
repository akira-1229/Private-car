// Detail parts for the built-in Insight (ZE4) model: surface probing, swept trims, clip regions
// (openings cut into the paint by the shader), canvas textures and the hand-built parts
// (slatted grille, LED headlights, tail lamps, wheels, mirrors, trims, interior).
// Coordinates: +X = front, +Y = up, +Z = right side, metres, ground at y = 0.
import * as THREE from 'three';
import { mergeGeometries } from '../vendor/utils/BufferGeometryUtils.js';

const D2R = Math.PI / 180;
export const NOSE_C = 1.45; // centre of the angular "nose" coordinates (degrees around the front)
export const TAIL_C = -1.55; // same for the tail

// ------------------------------------------------------------------------------------------
// Surface probe: fast ray casts against the body shell (triangles in a uniform 3D grid).
// ------------------------------------------------------------------------------------------
export class Probe {
  constructor(geos) {
    const tris = [];
    for (const g of geos) {
      const p = g.attributes.position.array;
      const idx = g.index.array;
      for (let i = 0; i < idx.length; i += 3) {
        const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
        tris.push(p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2], p[c], p[c + 1], p[c + 2]);
      }
    }
    const t = (this.t = new Float32Array(tris));
    // uniform 3D grid over the car; each cell lists the triangles whose bounding box touches it
    this.min = [-2.8, -0.05, -1.05];
    this.cs = 0.08;
    this.n = [Math.ceil(5.6 / this.cs), Math.ceil(1.75 / this.cs), Math.ceil(2.1 / this.cs)];
    const [nx, ny, nz] = this.n;
    const counts = new Uint32Array(nx * ny * nz + 1);
    const cellRange = (i) => {
      const lo = [], hi = [];
      for (let k = 0; k < 3; k++) {
        const a = Math.min(t[i + k], t[i + 3 + k], t[i + 6 + k]), b = Math.max(t[i + k], t[i + 3 + k], t[i + 6 + k]);
        lo.push(this.#clampCell(k, Math.floor((a - this.min[k]) / this.cs)));
        hi.push(this.#clampCell(k, Math.floor((b - this.min[k]) / this.cs)));
      }
      return [lo, hi];
    };
    const each = (fn) => {
      for (let i = 0; i < t.length; i += 9) {
        const [lo, hi] = cellRange(i);
        for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) fn((x * ny + y) * nz + z, i / 9);
      }
    };
    each((c) => counts[c + 1]++);
    for (let c = 1; c < counts.length; c++) counts[c] += counts[c - 1];
    const fill = counts.slice();
    this.items = new Uint32Array(counts[counts.length - 1]);
    each((c, tri) => { this.items[fill[c]++] = tri; });
    this.start = counts;
    this.mail = new Int32Array(t.length / 9).fill(-1);
    this.rayId = 0;
  }
  #clampCell(k, v) { return Math.max(0, Math.min(this.n[k] - 1, v)); }

  /** first hit of the ray o + t*d: { p, n } with n facing the ray origin, or null */
  cast(o, d) {
    const t = this.t, [nx, ny, nz] = this.n, cs = this.cs;
    const O = [o.x, o.y, o.z], Dd = [d.x, d.y, d.z];
    // clip the ray to the grid box
    let t0 = 0, t1 = Infinity;
    for (let k = 0; k < 3; k++) {
      const lo = this.min[k], hi = this.min[k] + this.n[k] * cs;
      if (Math.abs(Dd[k]) < 1e-12) { if (O[k] < lo || O[k] > hi) return null; continue; }
      let a = (lo - O[k]) / Dd[k], b = (hi - O[k]) / Dd[k];
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    }
    if (t0 > t1) return null;
    const cell = [], step = [], tMax = [], tDelta = [];
    for (let k = 0; k < 3; k++) {
      const p = O[k] + Dd[k] * (t0 + 1e-7);
      cell[k] = this.#clampCell(k, Math.floor((p - this.min[k]) / cs));
      if (Dd[k] > 0) { step[k] = 1; tMax[k] = (this.min[k] + (cell[k] + 1) * cs - O[k]) / Dd[k]; tDelta[k] = cs / Dd[k]; }
      else if (Dd[k] < 0) { step[k] = -1; tMax[k] = (this.min[k] + cell[k] * cs - O[k]) / Dd[k]; tDelta[k] = -cs / Dd[k]; }
      else { step[k] = 0; tMax[k] = Infinity; tDelta[k] = Infinity; }
    }
    const ray = ++this.rayId;
    let best = Infinity, bi = -1;
    for (let guard = 0; guard < 4000; guard++) {
      const c = (cell[0] * ny + cell[1]) * nz + cell[2];
      for (let q = this.start[c]; q < this.start[c + 1]; q++) {
        const tri = this.items[q];
        if (this.mail[tri] === ray) continue;
        this.mail[tri] = ray;
        const i = tri * 9;
        const e1x = t[i + 3] - t[i], e1y = t[i + 4] - t[i + 1], e1z = t[i + 5] - t[i + 2];
        const e2x = t[i + 6] - t[i], e2y = t[i + 7] - t[i + 1], e2z = t[i + 8] - t[i + 2];
        const px = d.y * e2z - d.z * e2y, py = d.z * e2x - d.x * e2z, pz = d.x * e2y - d.y * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det;
        const sx = o.x - t[i], sy = o.y - t[i + 1], sz = o.z - t[i + 2];
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (d.x * qx + d.y * qy + d.z * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (tt > 1e-5 && tt < best) { best = tt; bi = i; }
      }
      // next cell (3D DDA); stop once the best hit lies before the next cell boundary
      const k = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
      if (bi >= 0 && best <= tMax[k]) break;
      if (tMax[k] > t1) break;
      cell[k] += step[k];
      if (cell[k] < 0 || cell[k] >= this.n[k]) break;
      tMax[k] += tDelta[k];
    }
    if (bi < 0) return null;
    const i = bi;
    const n = new THREE.Vector3(
      (t[i + 4] - t[i + 1]) * (t[i + 8] - t[i + 2]) - (t[i + 5] - t[i + 2]) * (t[i + 7] - t[i + 1]),
      (t[i + 5] - t[i + 2]) * (t[i + 6] - t[i]) - (t[i + 3] - t[i]) * (t[i + 8] - t[i + 2]),
      (t[i + 3] - t[i]) * (t[i + 7] - t[i + 1]) - (t[i + 4] - t[i + 1]) * (t[i + 6] - t[i]),
    ).normalize();
    if (n.dot(d) > 0) n.negate();
    return { p: new THREE.Vector3(o.x + d.x * best, o.y + d.y * best, o.z + d.z * best), n };
  }

  // offsets go back along the probe ray (not the per-triangle normal) so recesses and trims built
  // from neighbouring probes stay smooth
  #at(o, d, off) {
    const h = this.cast(o, d);
    if (!h) return null;
    h.p.addScaledVector(d, -off);
    return h;
  }
  /** point on the nose at `a` degrees around NOSE_C (0 = straight ahead, + towards the right side) */
  nose(a, y, off = 0) {
    const c = Math.cos(a * D2R), s = Math.sin(a * D2R);
    return this.#at(new THREE.Vector3(NOSE_C + c * 3, y, s * 3), new THREE.Vector3(-c, 0, -s), off);
  }
  /** point on the tail at `a` degrees around TAIL_C (0 = straight behind) */
  tail(a, y, off = 0) {
    const c = Math.cos(a * D2R), s = Math.sin(a * D2R);
    return this.#at(new THREE.Vector3(TAIL_C - c * 3, y, s * 3), new THREE.Vector3(c, 0, -s), off);
  }
  front(y, z, off = 0) { return this.#at(new THREE.Vector3(4, y, z), new THREE.Vector3(-1, 0, 0), off); }
  back(y, z, off = 0) { return this.#at(new THREE.Vector3(-4, y, z), new THREE.Vector3(1, 0, 0), off); }
  side(x, y, off = 0, sd = 1) { return this.#at(new THREE.Vector3(x, y, 3 * sd), new THREE.Vector3(0, 0, -sd), off); }
  top(x, z, off = 0) { return this.#at(new THREE.Vector3(x, 4, z), new THREE.Vector3(0, -1, 0), off); }
}

// ------------------------------------------------------------------------------------------
// Geometry helpers
// ------------------------------------------------------------------------------------------
/** densify a 2D control polyline (Catmull-Rom) into n points */
export function spline2(ctrl, n, closed = false) {
  const c = new THREE.CatmullRomCurve3(ctrl.map(([a, b]) => new THREE.Vector3(a, b, 0)), closed, 'centripetal');
  return c.getSpacedPoints(closed ? n : n - 1).slice(0, n).map((v) => [v.x, v.y]);
}

/**
 * Sweeps a 2D profile along a path. frames[i] = { p, n } (n = outward normal). Profile points are
 * [u, v]: u along the normal, v along the binormal (perpendicular to the path, on the surface).
 */
export function sweep(frames, profile, { closedPath = false, closedProfile = true, axes = null, smoothN = 4 } = {}) {
  const pos = [];
  const N = frames.length, M = profile.length;
  // probe normals come from single triangles: average them along the path for a clean sweep
  if (!axes && smoothN > 0) {
    frames = frames.map((f, i) => {
      const n = new THREE.Vector3();
      for (let k = Math.max(0, i - smoothN); k <= Math.min(N - 1, i + smoothN); k++) n.add(frames[k].n);
      return { p: f.p, n: n.normalize() };
    });
  }
  const T = new THREE.Vector3(), B = new THREE.Vector3(), Nn = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    const p = frames[i].p;
    if (axes) { Nn.copy(axes[0]); B.copy(axes[1]); } else {
      const a = frames[Math.max(0, i - 1)].p, b = frames[Math.min(N - 1, i + 1)].p;
      T.subVectors(b, a).normalize();
      if (closedPath && (i === 0 || i === N - 1)) T.subVectors(frames[1].p, frames[N - 2].p).normalize();
      Nn.copy(frames[i].n);
      B.crossVectors(T, Nn).normalize();
      Nn.crossVectors(B, T).normalize();
    }
    for (const [u, v] of profile) pos.push(p.x + Nn.x * u + B.x * v, p.y + Nn.y * u + B.y * v, p.z + Nn.z * u + B.z * v);
  }
  const idx = [];
  const segs = closedProfile ? M : M - 1;
  for (let i = 0; i < N - 1; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * M + j, b = i * M + ((j + 1) % M), c = (i + 1) * M + j, d = (i + 1) * M + ((j + 1) % M);
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** quad grid through rows of points (rows[i][j] = Vector3), with optional uv per point */
export function gridGeo(rows, uvs) {
  const R = rows.length, C = rows[0].length;
  const pos = [], uv = [], idx = [];
  for (let i = 0; i < R; i++) {
    for (let j = 0; j < C; j++) {
      const p = rows[i][j];
      pos.push(p.x, p.y, p.z);
      if (uvs) uv.push(...uvs[i][j]); else uv.push(j / (C - 1), i / (R - 1));
    }
  }
  for (let i = 0; i < R - 1; i++) {
    for (let j = 0; j < C - 1; j++) {
      const a = i * C + j, b = a + 1, c = a + C, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // make the normals face outwards (away from the car centre line plane / body centre)
  const n = g.attributes.normal, p = g.attributes.position;
  let dot = 0;
  for (let i = 0; i < n.count; i++) dot += n.getX(i) * p.getX(i) * 0.3 + n.getY(i) * (p.getY(i) - 0.7) + n.getZ(i) * p.getZ(i);
  if (dot < 0) { g.setIndex(idx.map((_, k) => idx[k - (k % 3) + [0, 2, 1][k % 3]])); g.computeVertexNormals(); }
  return g;
}

/** merges the meshes of a group into one mesh per material (fewer draw calls) */
export function bake(group) {
  group.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const byMat = new Map();
  group.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || o.userData.keep) return;
    if (!byMat.has(o.material)) byMat.set(o.material, []);
    byMat.get(o.material).push(o);
  });
  const out = new THREE.Group();
  for (const [mat, meshes] of byMat) {
    const geos = meshes.map((m) => {
      let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
      if (!g.attributes.normal) g.computeVertexNormals();
      if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      g.clearGroups();
      const mat4 = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld);
      g.applyMatrix4(mat4);
      // a mirrored transform turns the triangles inside out: swap two corners of each one
      if (mat4.determinant() < 0) {
        for (const a of Object.values(g.attributes)) {
          const n = a.itemSize, arr = a.array;
          for (let t = 0; t < a.count; t += 3) {
            for (let k = 0; k < n; k++) {
              const i1 = (t + 1) * n + k, i2 = (t + 2) * n + k;
              const tmp = arr[i1]; arr[i1] = arr[i2]; arr[i2] = tmp;
            }
          }
        }
      }
      return g;
    });
    const merged = mergeGeometries(geos, false);
    const mesh = new THREE.Mesh(merged, mat);
    mesh.renderOrder = meshes[0].renderOrder;
    out.add(mesh);
  }
  group.traverse((o) => { if (o.userData.keep || o.isInstancedMesh) out.userData.keepers = (out.userData.keepers || []).concat(o); });
  for (const k of out.userData.keepers || []) {
    k.updateMatrixWorld(true);
    k.matrix.multiplyMatrices(inv, k.matrixWorld);
    k.matrix.decompose(k.position, k.quaternion, k.scale);
    out.add(k);
  }
  return out;
}

/** mirror copy of a right-hand part to the left side */
export function mirrored(obj) {
  const m = obj.clone();
  m.scale.z *= -1;
  m.position.z *= -1;
  return m;
}

// ------------------------------------------------------------------------------------------
// Clip regions: openings in the paint (grille, lamps, plate recess) and the cut lines of the
// doors / trunk. The same definition drives the shader (discard) and the tap test (JS).
// ------------------------------------------------------------------------------------------
function glslNum(v) { const s = (+v).toFixed(5); return s.includes('.') ? s : `${s}.0`; }

/** convex polygon in (angle, y) space; coord = 'f' (nose angle) or 'r' (tail angle) */
export function polyRegion(coord, pts) {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [a, b] = pts[i], [c, d] = pts[(i + 1) % pts.length];
    area += a * d - c * b;
  }
  const P = area < 0 ? [...pts].reverse() : pts;
  const A = coord === 'f' ? 'aF' : 'aR';
  const edges = P.map((p, i) => [p, P[(i + 1) % P.length]]);
  const glsl = `(${edges.map(([[ax, ay], [bx, by]]) => `((${glslNum(bx - ax)})*(P.y-(${glslNum(ay)})) - (${glslNum(by - ay)})*(${A}-(${glslNum(ax)})) >= 0.0)`).join(' && ')})`;
  const js = (p) => {
    const a = coord === 'f' ? angF(p) : angR(p);
    return edges.every(([[ax, ay], [bx, by]]) => (bx - ax) * (p.y - ay) - (by - ay) * (a - ax) >= 0);
  };
  return { glsl, js, coord, pts: P };
}

/** band in (angle, y) space: stops = [[a, ylo, yhi], ...] with increasing a */
export function bandRegion(coord, stops) {
  const A = coord === 'f' ? 'aF' : 'aR';
  const chain = (k) => {
    let s = glslNum(stops[stops.length - 1][k]);
    for (let i = stops.length - 2; i >= 0; i--) {
      const [a0] = stops[i], [a1] = stops[i + 1];
      s = `(${A} < ${glslNum(a1)} ? mix(${glslNum(stops[i][k])}, ${glslNum(stops[i + 1][k])}, (${A}-(${glslNum(a0)}))/${glslNum(a1 - a0)}) : ${s})`;
    }
    return s;
  };
  const a0 = stops[0][0], a1 = stops[stops.length - 1][0];
  const glsl = `(${A} >= ${glslNum(a0)} && ${A} <= ${glslNum(a1)} && P.y > ${chain(1)} && P.y < ${chain(2)})`;
  const lerp = (a, k) => {
    for (let i = 0; i < stops.length - 1; i++) {
      if (a <= stops[i + 1][0]) return stops[i][k] + (stops[i + 1][k] - stops[i][k]) * ((a - stops[i][0]) / (stops[i + 1][0] - stops[i][0]));
    }
    return stops[stops.length - 1][k];
  };
  const js = (p) => {
    const a = coord === 'f' ? angF(p) : angR(p);
    return a >= a0 && a <= a1 && p.y > lerp(a, 1) && p.y < lerp(a, 2);
  };
  return { glsl, js, coord, stops, ylo: (a) => lerp(a, 1), yhi: (a) => lerp(a, 2) };
}

/** free-form region: GLSL expression + matching JS test */
export function exprRegion(glsl, js) { return { glsl: `(${glsl})`, js }; }

export const angF = (p) => (p.x > NOSE_C ? Math.atan2(Math.abs(p.z), p.x - NOSE_C) / D2R : 999);
export const angR = (p) => (p.x < TAIL_C ? Math.atan2(Math.abs(p.z), TAIL_C - p.x) / D2R : 999);

/** piecewise-linear lookup in GLSL for f(x) sampled on [x0, x1] */
export function glslLookup(f, x0, x1, n, v = 'P.x') {
  const xs = Array.from({ length: n }, (_, i) => x0 + ((x1 - x0) * i) / (n - 1));
  let s = glslNum(f(xs[n - 1]));
  for (let i = n - 2; i >= 0; i--) {
    s = `(${v} < ${glslNum(xs[i + 1])} ? mix(${glslNum(f(xs[i]))}, ${glslNum(f(xs[i + 1]))}, clamp((${v}-(${glslNum(xs[i])}))/${glslNum(xs[i + 1] - xs[i])}, 0.0, 1.0)) : ${s})`;
  }
  return s;
}

/**
 * Adds clipping to a material: fragments inside any `cut` region are discarded; with `keep`,
 * only fragments inside that region are drawn. Positions are the geometry's own (car-space) ones,
 * so a clipped panel keeps its cut lines when it swings open.
 */
export function clipMaterial(mat, { cut = [], keep = null } = {}) {
  mat.userData.clip = { cut, keep };
  const conds = [];
  if (cut.length) conds.push(`if (${cut.map((r) => r.glsl).join(' || ')}) discard;`);
  if (keep) conds.push(`if (!${keep.glsl}) discard;`);
  const code = conds.join('\n');
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vClipPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvClipPos = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vClipPos;')
      .replace('void main() {', `void main() {
  {
  vec3 P = vClipPos;
  float az = abs(P.z);
  float aF = P.x > ${glslNum(NOSE_C)} ? degrees(atan(az, P.x - ${glslNum(NOSE_C)})) : 999.0;
  float aR = P.x < ${glslNum(TAIL_C)} ? degrees(atan(az, ${glslNum(TAIL_C)} - P.x)) : 999.0;
  ${code}
  }`);
  };
  const key = code;
  mat.customProgramCacheKey = () => key;
  mat.needsUpdate = true;
  return mat;
}

/** true when the point (car space) is cut away by the material's clip regions */
export function isClipped(mat, p) {
  const c = mat?.userData?.clip;
  if (!c) return false;
  if (c.cut.some((r) => r.js(p))) return true;
  if (c.keep && !c.keep.js(p)) return true;
  return false;
}

/** clone keeping the clip shader (Material.clone does not copy onBeforeCompile) */
export function cloneMaterial(m) {
  const c = m.clone();
  if (m.userData.clip) clipMaterial(c, m.userData.clip);
  return c;
}

// ------------------------------------------------------------------------------------------
// Canvas textures
// ------------------------------------------------------------------------------------------
function canvasTex(w, h, draw, { repeat = false, srgb = true } = {}) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** simplified oval badge with an "H"-like mark (not the real logo) */
export function badgeTexture() {
  return canvasTex(256, 200, (c, w, h) => {
    c.fillStyle = '#0b0d10';
    c.fillRect(0, 0, w, h);
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.45, '#c8ced6'); g.addColorStop(0.55, '#8f969f'); g.addColorStop(1, '#f2f4f7');
    c.strokeStyle = g;
    c.lineWidth = 14;
    c.beginPath();
    c.ellipse(w / 2, h / 2, w / 2 - 12, h / 2 - 12, 0, 0, Math.PI * 2);
    c.stroke();
    c.fillStyle = g;
    // two slightly flared uprights and a crossbar
    const top = h * 0.22, bot = h * 0.78, cx = w / 2;
    c.beginPath();
    c.moveTo(cx - 62, top); c.lineTo(cx - 34, top); c.lineTo(cx - 38, bot); c.lineTo(cx - 56, bot); c.closePath();
    c.moveTo(cx + 62, top); c.lineTo(cx + 34, top); c.lineTo(cx + 38, bot); c.lineTo(cx + 56, bot); c.closePath();
    c.fill();
    c.fillRect(cx - 40, h * 0.45, 80, 18);
  });
}

/** chrome lettering on a transparent background */
export function textTexture(text, { w = 512, h = 96, font = '700 70px "Helvetica Neue", Arial, sans-serif', spacing = 10 } = {}) {
  return canvasTex(w, h, (c) => {
    c.clearRect(0, 0, w, h);
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.5, '#9aa1aa'); g.addColorStop(1, '#eef1f4');
    c.fillStyle = g;
    c.font = font;
    c.textBaseline = 'middle';
    if ('letterSpacing' in c) c.letterSpacing = `${spacing}px`;
    c.textAlign = 'center';
    c.fillText(text, w / 2, h / 2 + 2, w - 10);
  });
}

/** tread pattern (bump map) wrapped around the tyre: 4 grooves + lateral sipes */
export function treadBump() {
  const t = canvasTex(1024, 128, (c, w, h) => {
    c.fillStyle = '#9a9a9a';
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#000';
    for (const k of [0.18, 0.4, 0.6, 0.82]) c.fillRect(0, h * k - 4, w, 8);
    c.strokeStyle = '#1a1a1a';
    const blocks = 80;
    for (let i = 0; i < blocks; i++) {
      const x = (w / blocks) * i;
      c.lineWidth = 3;
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x + 6, h * 0.18); c.stroke();
      c.beginPath(); c.moveTo(x + 3, h); c.lineTo(x + 9, h * 0.82); c.stroke();
      c.lineWidth = 1.5;
      for (const [a, b] of [[0.2, 0.4], [0.42, 0.58], [0.62, 0.8]]) {
        c.beginPath(); c.moveTo(x + 2, h * a); c.lineTo(x + 7, h * b); c.stroke();
      }
    }
  }, { repeat: true, srgb: false });
  return t;
}

/** raised sidewall lettering as a transparent texture for a ring */
export function sidewallTexture(lines) {
  return canvasTex(1024, 1024, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.translate(w / 2, h / 2);
    c.fillStyle = 'rgba(150,150,150,0.9)';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const r = w * 0.425;
    for (const [str, start, px] of lines) {
      c.font = `700 ${px}px "Arial Black", Arial, sans-serif`;
      const step = (px * 0.8) / r;
      let a = start;
      for (const ch of str) {
        c.save(); c.rotate(a); c.translate(0, -r); c.fillText(ch, 0, 0); c.restore();
        a += step;
      }
    }
  });
}

/** small canvas with dark background and a light label (engine cover etc.) */
export function labelTexture(text, bg = '#16181b', fg = '#c9ced6') {
  return canvasTex(512, 160, (c, w, h) => {
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);
    // fine ribbed texture
    c.strokeStyle = 'rgba(255,255,255,0.04)';
    for (let x = 0; x < w; x += 6) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
    c.fillStyle = fg;
    c.font = '800 64px Arial, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, w / 2, h / 2);
  });
}

/** boundary edges (used by one triangle only) of an indexed geometry, chained into polylines */
export function boundaryChains(geo) {
  const idx = geo.index.array, pos = geo.attributes.position;
  const count = new Map();
  const key = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  for (let i = 0; i < idx.length; i += 3) {
    for (const [a, b] of [[idx[i], idx[i + 1]], [idx[i + 1], idx[i + 2]], [idx[i + 2], idx[i]]]) {
      const k = key(a, b);
      count.set(k, (count.get(k) || 0) + 1);
    }
  }
  const adj = new Map();
  for (const [k, c] of count) {
    if (c !== 1) continue;
    const [a, b] = k.split('_').map(Number);
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b); adj.get(b).push(a);
  }
  const used = new Set();
  const chains = [];
  for (const start of adj.keys()) {
    if (used.has(start)) continue;
    // walk from an end point when there is one
    let s = start;
    const seen = new Set([s]);
    for (let guard = 0; guard < 100000; guard++) {
      const nx = adj.get(s).find((v) => !seen.has(v));
      if (nx === undefined || adj.get(s).length === 1) break;
      seen.add(nx); s = nx;
    }
    const chain = [s];
    used.add(s);
    let cur = s;
    for (;;) {
      const nx = adj.get(cur).find((v) => !used.has(v));
      if (nx === undefined) break;
      used.add(nx); chain.push(nx); cur = nx;
    }
    if (chain.length > 3) chains.push(chain.map((i) => new THREE.Vector3().fromBufferAttribute(pos, i)));
  }
  return chains;
}

/** index subset of a geometry: triangles touching the region (shares the position buffer) */
export function subsetGeo(geo, test) {
  const idx = geo.index.array, pos = geo.attributes.position;
  const out = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), m = new THREE.Vector3();
  for (let i = 0; i < idx.length; i += 3) {
    a.fromBufferAttribute(pos, idx[i]); b.fromBufferAttribute(pos, idx[i + 1]); c.fromBufferAttribute(pos, idx[i + 2]);
    m.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    if (test(a) || test(b) || test(c) || test(m)) out.push(idx[i], idx[i + 1], idx[i + 2]);
  }
  const g = new THREE.BufferGeometry();
  for (const k of Object.keys(geo.attributes)) g.setAttribute(k, geo.attributes[k]);
  g.setIndex(out);
  return g;
}
