// Smooth car body built by lofting cross-sections along the length of the car.
// The side silhouette was traced from a side-view photo of a Honda Insight (ZE4)
// and scaled to the real size (L4675 / W1820 / H1410 / WB2700 mm).
// Coordinates: +X = front, +Y = up, +Z = right side, metres, ground at y = 0.
import * as THREE from 'three';

// ---- traced profiles: [x, y] pairs, ordered rear -> front ----
const TOP = [
  [-2.37, 1.03], [-2.28, 1.065], [-2.1, 1.085], [-1.9, 1.115], [-1.6, 1.2], [-1.25, 1.31],
  [-0.85, 1.385], [-0.45, 1.408], [-0.1, 1.39], [0.18, 1.335], [0.48, 1.16],
  [0.765, 0.96], [1.1, 0.915], [1.5, 0.865], [1.9, 0.81], [2.12, 0.77], [2.22, 0.72], [2.25, 0.66],
];
const BOTTOM = [
  [-2.37, 0.4], [-2.3, 0.32], [-2.12, 0.29], [-1.9, 0.235], [1.9, 0.22], [2.1, 0.23], [2.21, 0.28], [2.25, 0.34],
];
const BELT = [ // shoulder / window-sill line
  [-2.37, 1.0], [-1.98, 1.08], [-1.485, 1.105], [-0.585, 1.0], [0.513, 0.9], [1.35, 0.85], [2.1, 0.77], [2.25, 0.64],
];

export const X_REAR = -2.37, X_FRONT = 2.25;
export const WHEELS = { x: 1.35, r: 0.33 };
// glass areas along X
export const GLASS = {
  windshield: [0.18, 0.765],
  rear: [-1.9, -0.9],
  dlo: [-1.485, 0.513], // side window opening
  pillars: [[-0.42, -0.25], [-1.14, -1.1]], // B pillar, small divider in front of the quarter glass
};

// Centripetal Catmull-Rom through the traced points, sampled densely, then looked up by x.
function smoothTable(pts) {
  const curve = new THREE.SplineCurve(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const dense = curve.getSpacedPoints(600).map((v) => [v.x, v.y]);
  dense.sort((p, q) => p[0] - q[0]);
  return dense;
}
const cache = new Map();
function interp(pts, x) {
  if (!cache.has(pts)) cache.set(pts, smoothTable(pts));
  const t = cache.get(pts);
  if (x <= t[0][0]) return t[0][1];
  let lo = 0, hi = t.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (t[m][0] < x) lo = m; else hi = m;
  }
  const [x0, y0] = t[lo], [x1, y1] = t[hi];
  return x1 === x0 ? y0 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
}

// plan-view half width
export function halfWidth(x) {
  let w = 0.905;
  if (x > 1.55) w -= 0.2 * ((x - 1.55) / 0.7) ** 2;
  if (x < -1.85) w -= 0.09 * ((-1.85 - x) / 0.52) ** 2;
  return w;
}

export function topAt(x) { return interp(TOP, x); }
export function beltAt(x) { return Math.min(interp(BELT, x), topAt(x) - 0.04); }
export function bottomAt(x) {
  let y = interp(BOTTOM, x);
  for (const wx of [WHEELS.x, -WHEELS.x]) {
    const d = Math.abs(x - wx);
    const R = 0.405;
    if (d < R) y = Math.max(y, 0.29 + Math.sqrt(R * R - d * d) * 0.93);
  }
  return y;
}

// segment sample counts for one half of a cross-section (bottom centre -> top centre)
// the side band carries 4 extra samples packed around the character line so the crease stays sharp
const SEG = { bottom: 6, side: 22, shoulder: 5, house: 10, roof: 14 };
const CREASE_PTS = [-0.016, -0.006, 0.006, 0.016];

// fade in / out helper
const ramp = (v, a, b) => Math.min(1, Math.max(0, (v - a) / (b - a)));
const smooth = (t) => t * t * (3 - 2 * t);

// Upper character line: runs just under the door handles from behind the headlight into the tail lamp.
export function creaseY(x) { return beltAt(x) - 0.095; }
function creaseAmp(x) { return 0.0055 * smooth(ramp(x, -2.3, -1.95)) * smooth(ramp(-x, -2.05, -1.8)); }
// Lower sculpted line on the doors: rises towards the rear (a soft concave groove).
export function lowerLineY(x) { return 0.47 + 0.16 * ((0.75 - x) / 2.0); }
function lowerAmp(x) { return -0.007 * smooth(ramp(x, -1.75, -1.35)) * smooth(ramp(-x, -1.05, -0.75)); }

function sideOffset(x, y) {
  let o = 0;
  const dc = y - creaseY(x);
  // sharp ridge: steeper below the line (the lit "blade"), softer fall-off above it
  if (dc > 0) o += creaseAmp(x) * Math.max(0, 1 - dc / 0.06);
  else o += creaseAmp(x) * Math.max(0, 1 + dc / 0.028);
  const dl = y - lowerLineY(x);
  o += lowerAmp(x) * Math.exp(-(dl * dl) / (2 * 0.022 * 0.022));
  return o;
}

/**
 * Plan-view curvature of the nose and the tail: the corners are pulled back so the front face is
 * rounded in plan instead of flat (a straight loft ring would give a boxy bumper).
 */
export function bowX(x, z, y = 1) {
  const k = (z / 0.9) ** 2;
  // the lower bumper corners are pulled back less: they stand forward, squarer in plan
  if (x > 1.55) return x - 0.15 * smooth(ramp(x, 1.55, X_FRONT)) * k * (1 - 0.3 * lowCorner(y));
  if (x < -1.85) return x + 0.075 * smooth(ramp(-x, 1.85, -X_REAR)) * k;
  return x;
}
/**
 * Front bumper corners: on the real car the lower bumper (intakes down to the bumper corners)
 * flares out to almost the full body width, while the headlight level is tapered in plan. The plan
 * taper of halfWidth() is relaxed below the headlights, fading out before the headlight cut so the
 * lamps and the hood keep their place. lowCorner: 1 at bumper / intake height, 0 from y = 0.6 up.
 */
function lowCorner(y) { return 1 - smooth(ramp(y, 0.4, 0.6)); }
export function cornerFlare(x, y) {
  if (x <= 1.55) return 0;
  return 0.2 * ((x - 1.55) / 0.7) ** 2 * 0.45 * lowCorner(y);
}
const HALF = SEG.bottom + SEG.side + SEG.shoulder + SEG.house + SEG.roof + 1;

function quad(p0, c, p1, t) {
  const u = 1 - t;
  return [u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]];
}

// returns [ [z, y, segName], ... ] for the right half
function section(x) {
  const W = halfWidth(x);
  const yb = bottomAt(x);
  const yT = topAt(x);
  const yS = beltAt(x);
  const out = [];
  const push = (p, seg) => out.push([p[0], p[1], seg]);

  // bottom: centre -> rounded lower corner
  const b0 = [0, yb], bC = [W - 0.02, yb], b1 = [W - 0.01, yb + 0.09];
  for (let i = 0; i < SEG.bottom; i++) {
    const t = i / SEG.bottom;
    push(t < 0.6 ? [b0[0] + (W - 0.1) * (t / 0.6), yb] : quad([W - 0.1, yb], bC, b1, (t - 0.6) / 0.4), 'bottom');
  }
  // side: slight outward bulge, tucked in at the bottom, with the press lines
  const s0 = yb + 0.09, s1 = Math.max(s0 + 0.001, yS - 0.07);
  const n = SEG.side - CREASE_PTS.length;
  const ys = [];
  for (let i = 0; i < n; i++) ys.push(s0 + (s1 - s0) * (i / n));
  const yc = Math.min(s1 - 0.02, Math.max(s0 + 0.02, creaseY(x)));
  for (const d of CREASE_PTS) ys.push(Math.min(s1 - 0.001, Math.max(s0 + 0.001, yc + d)));
  ys.sort((a, b) => a - b);
  for (const y of ys) {
    const t = (y - s0) / (s1 - s0);
    const bulge = Math.sin(Math.PI * (0.25 + 0.6 * t));
    push([W - 0.03 + 0.03 * bulge + sideOffset(x, y), y], 'side');
  }
  // shoulder: round over to the base of the greenhouse / hood
  const Wg = W - 0.07;
  for (let i = 0; i < SEG.shoulder; i++) {
    const t = i / SEG.shoulder;
    push(quad([W - 0.005, s1], [W - 0.01, yS + 0.01], [Wg, yS + 0.025], t), 'shoulder');
  }
  // greenhouse (side glass band) with tumblehome; collapses where there is no cabin (hood / deck)
  const h3 = Math.max(0, yT - 0.08 - (yS + 0.025));
  const zTop = Wg - 0.62 * h3;
  for (let i = 0; i < SEG.house; i++) {
    const t = i / SEG.house;
    push([Wg + (zTop - Wg) * t, yS + 0.025 + h3 * t], 'house');
  }
  // roof / hood top: rounded edge then a gentle crown to the centre line
  const r0 = [zTop, yS + 0.025 + h3];
  const crown = h3 > 0.05 ? 0.0 : 0.03;
  for (let i = 0; i <= SEG.roof; i++) {
    const t = i / SEG.roof;
    push(quad(r0, [zTop * 0.82, yT + crown * 0.5], [0, yT + crown], t), 'roof');
  }
  // front bumper corner flare (scaled by z / W so the underside centre stays put)
  if (x > 1.55) {
    for (const p of out) {
      const f = cornerFlare(x, p[1]);
      if (f > 0) p[0] += f * Math.min(1, (p[0] / W) ** 2);
    }
  }
  return out;
}

/**
 * Builds the body. Returns one shared position/normal buffer and an index list per surface kind:
 * paint, under (wheel wells / underside), side, windshield, rear, roof, hood.
 */
export function buildBody() {
  const xs = [];
  const N = 240;
  for (let i = 0; i <= N; i++) xs.push(X_REAR + (X_FRONT - X_REAR) * (i / N));
  const rings = xs.map((x) => ({ x, pts: section(x) }));

  // rounded end caps: shrink the last ring towards its centre over a few extra rings
  function capRings(ring, dir) {
    const extra = [];
    const steps = [[0.012, 0.97], [0.03, 0.9], [0.048, 0.78], [0.06, 0.6], [0.066, 0.35]];
    const cy = ring.pts.reduce((a, p) => a + p[1], 0) / ring.pts.length;
    for (const [dx, k] of steps) {
      extra.push({
        x: ring.x + dir * dx,
        pts: ring.pts.map(([z, y, seg]) => [z * (0.35 + 0.65 * k), cy + (y - cy) * (0.55 + 0.45 * k), seg]),
        cap: true,
      });
    }
    return extra;
  }
  const all = [...capRings(rings[0], -1).reverse(), ...rings, ...capRings(rings[rings.length - 1], 1)];

  const M = HALF * 2 - 2; // full ring: right half + mirrored left half without duplicating centre points
  const pos = [];
  const segOf = [];
  for (const r of all) {
    const right = r.pts;
    const ring = [...right.map(([z, y, s]) => [z, y, s])];
    for (let i = HALF - 2; i >= 1; i--) ring.push([-right[i][0], right[i][1], right[i][2]]);
    for (const [z, y, s] of ring) {
      pos.push(bowX(r.x, z, y), y, z);
      segOf.push(r.cap ? 'cap' : s);
    }
  }
  const idx = { paint: [], under: [], side: [], windshield: [], rear: [], roof: [], hood: [] };
  const inRange = (x, [a, b]) => x >= a && x <= b;
  for (let i = 0; i < all.length - 1; i++) {
    for (let j = 0; j < M; j++) {
      const a = i * M + j, b = i * M + ((j + 1) % M), c = (i + 1) * M + j, d = (i + 1) * M + ((j + 1) % M);
      const x = (all[i].x + all[i + 1].x) / 2;
      const seg = segOf[a] === 'cap' || segOf[c] === 'cap' ? 'cap' : segOf[a];
      let kind = 'paint';
      if (seg === 'bottom') kind = 'under';
      else if (seg === 'house') {
        const pillar = GLASS.pillars.some((p) => inRange(x, p));
        if (inRange(x, GLASS.dlo) && !pillar) kind = 'side';
        else if (inRange(x, GLASS.windshield)) kind = 'windshield';
        else if (inRange(x, GLASS.rear)) kind = 'rear';
      } else if (seg === 'roof') {
        if (inRange(x, GLASS.windshield)) kind = 'windshield';
        else if (inRange(x, GLASS.rear)) kind = 'rear';
        else if (x > GLASS.windshield[1]) kind = 'hood';
        else if (x > GLASS.rear[1] && x < GLASS.windshield[0]) kind = 'roof';
      }
      // A-pillars: keep the outer edge of the windshield in paint
      if (kind === 'windshield' && seg === 'house') kind = 'paint';
      idx[kind].push(a, c, b, b, c, d);
    }
  }
  // flat caps closing the very ends
  for (const [ri, flip] of [[0, true], [all.length - 1, false]]) {
    const base = ri * M;
    const cx = all[ri].x;
    let cy = 0;
    for (let j = 0; j < M; j++) cy += pos[(base + j) * 3 + 1];
    cy /= M;
    const centre = pos.length / 3;
    pos.push(bowX(cx, 0), cy, 0);
    for (let j = 0; j < M; j++) {
      const a = base + j, b = base + ((j + 1) % M);
      if (flip) idx.paint.push(centre, a, b); else idx.paint.push(centre, b, a);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const all3 = Object.values(idx).flat();
  geo.setIndex(all3);
  geo.computeVertexNormals();
  const make = (list) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', geo.attributes.position);
    g.setAttribute('normal', geo.attributes.normal);
    g.setIndex(list);
    return g;
  };
  const geos = {};
  for (const [k, list] of Object.entries(idx)) geos[k] = make(list);
  return geos;
}

/** Point on the right-hand body surface at (x, y), pushed out by `off` along the side. */
export function surfacePoint(x, y, off = 0) {
  const pts = section(x);
  let best = pts[0], bd = Infinity;
  for (const p of pts) {
    const d = Math.abs(p[1] - y) + (p[2] === 'bottom' ? 1 : 0);
    if (d < bd) { bd = d; best = p; }
  }
  return new THREE.Vector3(bowX(x, best[0], y), y, best[0] + off);
}

/** Window opening outline on the right side (for the chrome surround). */
export function dloOutline(samples = 40) {
  const [x0, x1] = GLASS.dlo;
  const lower = [], upper = [];
  for (let i = 0; i <= samples; i++) {
    const x = x0 + (x1 - x0) * (i / samples);
    const pts = section(x).filter((p) => p[2] === 'house');
    const lo = pts[0], hi = pts[pts.length - 1];
    lower.push(new THREE.Vector3(x, lo[1], lo[0]));
    const top = section(x).find((p) => p[2] === 'roof');
    upper.push(new THREE.Vector3(x, top[1], top[0]));
  }
  return { lower, upper };
}
