// Solid chrome badges for the built-in Insight model: the "H" emblem (front grille / trunk lid) and
// the raised "INSIGHT" lettering. Everything is real geometry (bevelled extrusions), no textures.
// Local frame of every badge: x = right, y = up, z = out of the car surface; z = 0 is the mounting face.
import * as THREE from 'three';

// ------------------------------------------------------------------------------------------
// Materials
// ------------------------------------------------------------------------------------------
/**
 * Polished chrome. It gets its own envMap so its reflections can be much stronger than the
 * scene-wide environment strength, which is kept low for the deep black paint (see tunePaint).
 */
export function chromeMaterial(envMap, { intensity = 1.6, roughness = 0.06 } = {}) {
  const m = new THREE.MeshStandardMaterial({ color: 0xf4f6f9, metalness: 1, roughness });
  if (envMap) { m.envMap = envMap; m.envMapIntensity = intensity; }
  m.name = 'badgeChrome';
  return m;
}
/** glossy piano black for the emblem field and its mounting base */
export function badgeBlackMaterial(envMap, { roughness = 0.06, intensity = 0.5 } = {}) {
  const m = new THREE.MeshPhysicalMaterial({ color: 0x030405, metalness: 0.1, roughness, clearcoat: 1, clearcoatRoughness: 0.03 });
  if (envMap) { m.envMap = envMap; m.envMapIntensity = intensity; }
  return m;
}

// ------------------------------------------------------------------------------------------
// Outline helpers
// ------------------------------------------------------------------------------------------
const quad = (a, c, b, t) => {
  const u = 1 - t;
  return new THREE.Vector2(u * u * a.x + 2 * u * t * c.x + t * t * b.x, u * u * a.y + 2 * u * t * c.y + t * t * b.y);
};

/**
 * Closed outline of the Honda emblem frame (counter-clockwise points).
 * The real frame is a rounded, slightly trapezoidal box: wider than tall (about 1 : 0.81),
 * the top edge bows up a little and the sides lean inwards towards the bottom.
 * w, h: outer size; inset: offset inwards (for the inner edge of the chrome ring).
 */
function frameOutline(w, h, inset = 0) {
  const top = h / 2 - inset, bot = -h / 2 + inset;
  const tw = w / 2 - inset, bw = w * 0.44 - inset * 0.95; // half widths at top / bottom
  const arch = h * 0.03; // the top edge bows up by this much in the middle
  const rT = Math.max(0.001, w * 0.13 - inset * 0.7), rB = Math.max(0.001, w * 0.16 - inset * 0.7);
  const TL = new THREE.Vector2(-tw, top), TR = new THREE.Vector2(tw, top);
  const BR = new THREE.Vector2(bw, bot), BL = new THREE.Vector2(-bw, bot);
  const toward = (a, b, d) => a.clone().add(b.clone().sub(a).setLength(d));
  const pts = [];
  const corner = (prev, c, next, r, n = 10) => {
    const a = toward(c, prev, r), b = toward(c, next, r);
    for (let i = 0; i <= n; i++) pts.push(quad(a, c, b, i / n));
  };
  // counter-clockwise: bottom-left -> bottom-right -> top-right -> (arched top) -> top-left
  corner(TL, BL, BR, rB);
  corner(BL, BR, TR, rB);
  corner(BR, TR, TL, rT);
  // arched top edge between the two top corners
  const a = toward(TR, TL, rT), b = toward(TL, TR, rT);
  const ctl = new THREE.Vector2(0, top + arch * 2);
  for (let i = 1; i < 16; i++) pts.push(quad(a, ctl, b, i / 16));
  corner(TR, TL, BL, rT);
  return pts;
}

/**
 * The "H" as one closed outline, in units of the frame width (scaled by w).
 * Read off the real badge: the uprights reach almost to the frame at both ends, they get wider
 * towards the curved crossbar (the upper notch is a tall trapezoid, the lower one short and
 * narrow), and the crossbar sags slightly in the middle.
 */
function hOutline(w, h) {
  const k = h / 0.785; // vertical scale relative to the reference proportions
  const P = (x, y) => new THREE.Vector2(x * w, y * k);
  const yT = 0.334, yB = -0.334;
  const pts = [];
  const curve = (a, c, b, n = 10) => { for (let i = 1; i < n; i++) pts.push(quad(P(...a), P(...c), P(...b), i / n)); };
  pts.push(P(-0.252, yB), P(-0.14, yB), P(-0.072, -0.142));
  curve([-0.072, -0.142], [0, -0.17], [0.072, -0.142]); // crossbar underside
  pts.push(P(0.072, -0.142), P(0.14, yB), P(0.252, yB), P(0.29, yT), P(0.172, yT), P(0.1, -0.022));
  curve([0.1, -0.022], [0, -0.075], [-0.1, -0.022]); // crossbar top
  pts.push(P(-0.1, -0.022), P(-0.172, yT), P(-0.29, yT));
  return pts;
}

/** Extrudes a shape with a chamfer whose outer edge stays on the outline (bevelOffset = -bevelSize). */
function extrude(shapes, depth, bevel, seg = 3) {
  const geo = new THREE.ExtrudeGeometry(shapes, {
    depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.85, bevelOffset: -bevel * 0.85,
    bevelSegments: seg, curveSegments: 6, steps: 1,
  });
  // ExtrudeGeometry spans z = -bevel .. depth + bevel: put the back face on z = 0
  geo.translate(0, 0, bevel);
  return geo;
}

/**
 * Bends the normals of the front face (normal +z) so a flat extrusion shades like a polished,
 * gently curved part: `tilt(x, y)` returns the in-plane tilt vector (its length = tan of the angle).
 * A flat chrome face mirrors a single direction and reads as a dull grey plate; with the bent
 * normals the reflection sweeps across the part and the edges flash, as on the real badge.
 */
function shapeFront(geo, tilt) {
  const pos = geo.attributes.position, nor = geo.attributes.normal;
  const v = new THREE.Vector3();
  for (let i = 0; i < nor.count; i++) {
    if (nor.getZ(i) < 0.999) continue;
    const t = tilt(pos.getX(i), pos.getY(i));
    v.set(t.x, t.y, 1).normalize();
    nor.setXYZ(i, v.x, v.y, v.z);
  }
  nor.needsUpdate = true;
  return geo;
}

// ------------------------------------------------------------------------------------------
// H emblem
// ------------------------------------------------------------------------------------------
/**
 * Honda-style "H" emblem: chrome frame and H with chamfered edges, a recessed piano-black field
 * and a black mounting base behind it.
 * @param {number} w  outer width of the chrome frame (m); height is 0.785 w (≈ 0.81 w including the arched top) as on the real badge
 * @param {object} o  { chrome, black, baseDepth }
 */
export function hEmblem(w, { chrome, black, baseDepth = 0.02 } = {}) {
  const h = w * 0.785;
  const g = new THREE.Group();
  g.name = 'hEmblem';
  const ring = w * 0.05; // chrome ring width
  const relief = w * 0.05; // how far the chrome stands out of the base
  const bevel = w * 0.022;

  // mounting base: a gloss-black plinth slightly larger than the frame, with a soft rounded edge,
  // reaching back into the grille
  const bb = Math.min(baseDepth * 0.45, w * 0.045);
  const base = new THREE.Mesh(extrude(new THREE.Shape(frameOutline(w * 1.06, h * 1.075)), Math.max(0.0005, baseDepth - 2 * bb), bb, 5), black);
  base.position.z = -baseDepth;
  g.add(base);

  // piano-black field inside the ring, a little below the chrome
  const field = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(frameOutline(w, h, ring * 0.5)), 4), black);
  field.position.z = 0.0004;
  g.add(field);

  // chrome ring (outline with a hole)
  const ringShape = new THREE.Shape(frameOutline(w, h));
  ringShape.holes.push(new THREE.Path(frameOutline(w, h, ring).reverse()));
  // rounded ring profile: the normals roll from the inner edge (tilted inwards) to the outer edge
  const ringGeo = extrude(ringShape, relief - 2 * bevel, bevel, 4);
  const rhoIn = 1 - ring / (h / 2), rhoMid = (1 + rhoIn) / 2;
  shapeFront(ringGeo, (x, y) => {
    const ex = x / (w / 2), ey = y / (h / 2);
    const rho = Math.max(Math.hypot(ex, ey) * 0.82, Math.abs(ex) ** 4 + ey ** 4 > 0 ? (Math.abs(ex) ** 4 + ey ** 4) ** 0.25 : 0);
    const k = THREE.MathUtils.clamp((rho - rhoMid) / (1 - rhoMid), -1, 1);
    const d = new THREE.Vector2(ex, ey).normalize();
    return d.multiplyScalar(Math.tan(k * 0.55));
  });
  const frame = new THREE.Mesh(ringGeo, chrome);
  g.add(frame);

  // the H, almost flush with the ring
  // the face is crowned slightly so the reflection runs across it
  const hGeo = extrude(new THREE.Shape(hOutline(w, h)), relief * 0.92 - 2 * bevel, bevel, 4);
  shapeFront(hGeo, (x, y) => new THREE.Vector2(x / (w / 2) * 0.62, y / (h / 2) * 0.34 + 0.05));
  const hMesh = new THREE.Mesh(hGeo, chrome);
  g.add(hMesh);

  g.userData.size = { w, h, depth: relief };
  return g;
}

// ------------------------------------------------------------------------------------------
// Raised lettering (stroked glyphs, thin wide sans-serif like the INSIGHT badge)
// ------------------------------------------------------------------------------------------
/** closed outline of a polyline stroked with width s (mitred joins, butt caps) */
function strokeOutline(pts, s) {
  const n = pts.length, L = [], Rr = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const d0 = i > 0 ? p.clone().sub(pts[i - 1]).normalize() : null;
    const d1 = i < n - 1 ? pts[i + 1].clone().sub(p).normalize() : null;
    let nrm, scale = 1;
    if (d0 && d1) {
      const t = d0.clone().add(d1).normalize();
      nrm = new THREE.Vector2(-t.y, t.x);
      const c = nrm.dot(new THREE.Vector2(-d1.y, d1.x));
      scale = 1 / Math.max(0.35, c);
    } else {
      const d = d0 || d1;
      nrm = new THREE.Vector2(-d.y, d.x);
    }
    L.push(p.clone().addScaledVector(nrm, s / 2 * scale));
    Rr.push(p.clone().addScaledVector(nrm, -s / 2 * scale));
  }
  return [...L, ...Rr.reverse()];
}
const arc = (cx, cy, rx, ry, a0, a1, n = 18) => {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = THREE.MathUtils.degToRad(a0 + (a1 - a0) * i / n);
    out.push(new THREE.Vector2(cx + rx * Math.cos(a), cy + ry * Math.sin(a)));
  }
  return out;
};

/**
 * stroke centre lines of each glyph in a unit box (cap height 1, baseline 0); returns { w, strokes }.
 * k widens the letters (1 = the base proportions; the real badges use a wide, extended face).
 */
function glyph(ch, s, k = 1) {
  const V2 = (x, y) => new THREE.Vector2(x, y);
  const lo = s / 2, hi = 1 - s / 2; // keep the stroke edges on the baseline / cap height
  // bowl: from the stem at height yTop round the right-hand side down to the stem at yBot
  const bowl = (x0, xr, yTop, yBot) => {
    const ry = (yTop - yBot) / 2, rx = Math.min(ry * 1.15, (xr - x0) * 0.9);
    return [V2(x0, yTop), ...arc(xr - rx, (yTop + yBot) / 2, rx, ry, 90, -90, 16), V2(x0, yBot)];
  };
  switch (ch) {
    case 'I': return { w: s, strokes: [[V2(s / 2, 0), V2(s / 2, 1)]] };
    case 'Y': {
      const w = 0.86 * k, yJ = 0.46;
      return { w, strokes: [[V2(s * 0.6, 1 - s * 0.2), V2(w / 2, yJ), V2(w - s * 0.6, 1 - s * 0.2)], [V2(w / 2, yJ + s * 0.4), V2(w / 2, 0)]] };
    }
    case 'B': {
      const w = 0.84 * k, m = 0.53;
      return { w, strokes: [[V2(s / 2, 0), V2(s / 2, 1)], bowl(s / 2, w - s / 2 - 0.05 * k, hi, m), bowl(s / 2, w - s / 2, m, lo)] };
    }
    case 'R': {
      const w = 0.86 * k, m = 0.47;
      return { w, strokes: [[V2(s / 2, 0), V2(s / 2, 1)], bowl(s / 2, w - s / 2, hi, m), [V2(w * 0.5, m), V2(w - s * 0.55, s * 0.2)]] };
    }
    case 'D': {
      const w = 0.9 * k;
      return { w, strokes: [[V2(s / 2, 0), V2(s / 2, 1)], bowl(s / 2, w - s / 2, hi, lo)] };
    }
    case 'N': {
      const w = 0.86 * k;
      return { w, strokes: [[V2(s / 2, 0), V2(s / 2, 1)], [V2(s / 2, 1), V2(w - s / 2, 0)], [V2(w - s / 2, 0), V2(w - s / 2, 1)]] };
    }
    case 'H': {
      const w = 0.86 * k;
      return { w, strokes: [[V2(s / 2, 0), V2(s / 2, 1)], [V2(w - s / 2, 0), V2(w - s / 2, 1)], [V2(s / 2, 0.5), V2(w - s / 2, 0.5)]] };
    }
    case 'T': {
      const w = 0.84 * k;
      return { w, strokes: [[V2(0, hi), V2(w, hi)], [V2(w / 2, 0), V2(w / 2, hi)]] };
    }
    case 'S': {
      const w = 0.8 * k, rx = (w - s) / 2, cx = w / 2, ry = (hi - lo) / 4;
      const up = arc(cx, lo + 3 * ry, rx, ry, 25, 270, 22);
      const dn = arc(cx, lo + ry, rx, ry, 90, -155, 22);
      return { w, strokes: [[...up, ...dn.slice(1)]] };
    }
    case 'G': {
      const w = 0.92 * k, rx = (w - s) / 2, cx = w / 2, cy = 0.5, ry = (hi - lo) / 2;
      return {
        w,
        strokes: [
          arc(cx, cy, rx, ry, 40, 360, 30),
          [V2(cx + 0.05, 0.47), V2(w, 0.47)],
          [V2(w - s / 2, 0.47 + s / 2), V2(w - s / 2, 0.12)],
        ],
      };
    }
    default: return { w: 0.6, strokes: [] };
  }
}

/**
 * Outline shapes of a line of stroked letters, centred on the origin (cap height `cap`, m).
 * slant: italic shear (x += slant * y); widen: letter width factor; fit: if set, the letters are
 * widened / narrowed so the whole line is exactly this wide.
 */
function letterShapes(text, cap, { stroke = 0.13, gap = 0.42, slant = 0, widen = 1, fit = 0 } = {}) {
  const s = stroke;
  const measure = (k) => [...text].map((ch) => glyph(ch, s, k));
  const span = (gl) => gl.reduce((a, g) => a + g.w, 0) + gap * (gl.length - 1) + slant;
  let k = widen;
  if (fit > 0) {
    // the width is linear in k: solve span(k) = fit / cap
    const a = span(measure(0)), b = span(measure(1)) - a;
    k = THREE.MathUtils.clamp((fit / cap - a) / b, 0.6, 2.2);
  }
  const glyphs = measure(k);
  const total = span(glyphs);
  const shapes = [];
  let x = 0;
  for (const gl of glyphs) {
    for (const st of gl.strokes) {
      const pts = strokeOutline(st, s).map((p) => new THREE.Vector2((p.x + x + slant * p.y - total / 2) * cap, (p.y - 0.5) * cap));
      shapes.push(new THREE.Shape(pts));
    }
    x += gl.w + gap;
  }
  return { shapes, w: total * cap };
}

/**
 * Raised chrome lettering, centred on the origin. cap: letter height (m).
 * Built from extruded strokes with a small chamfer so the edges catch the light.
 * `face`: optional material for the letter faces (the chamfers and sides stay chrome), e.g. the
 * blue HYBRID lettering.
 */
export function chromeLettering(text, cap, { chrome, face = null, stroke = 0.13, gap = 0.42, depth = 0.0016, slant = 0, widen = 1, fit = 0 } = {}) {
  const { shapes, w } = letterShapes(text, cap, { stroke, gap, slant, widen, fit });
  const bevel = cap * 0.035;
  const geo = extrude(shapes, Math.max(0.0002, depth - 2 * bevel), bevel, 2);
  if (!face) {
    const mesh = new THREE.Mesh(geo, chrome);
    mesh.userData.size = { w, h: cap };
    return mesh;
  }
  // coloured faces with chrome chamfers: split the extrusion by its groups
  // (0 = front / back caps, 1 = sides and chamfers) into two single-material meshes, since the
  // viewer clones and highlights one material per mesh
  const grp = new THREE.Group();
  grp.add(new THREE.Mesh(geometryOfGroup(geo, 0), face), new THREE.Mesh(geometryOfGroup(geo, 1), chrome));
  grp.userData.size = { w, h: cap };
  return grp;
}

/** the triangles of one material group of a non-indexed geometry, as a geometry of their own */
function geometryOfGroup(geo, materialIndex) {
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geo.attributes)) {
    const k = attr.itemSize, src = attr.array, parts = [];
    for (const gr of geo.groups) if (gr.materialIndex === materialIndex) parts.push(src.subarray(gr.start * k, (gr.start + gr.count) * k));
    const arr = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) { arr.set(p, o); o += p.length; }
    out.setAttribute(name, new THREE.BufferAttribute(arr, k));
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// HYBRID badge (front fender, trunk lid)
// ------------------------------------------------------------------------------------------
/** metallic Honda "hybrid blue" for the badge lettering and the square mark */
export function hybridBlueMaterial(envMap, { light = false } = {}) {
  const m = new THREE.MeshPhysicalMaterial({
    color: light ? 0x7cc4ff : 0x1f4ee6, metalness: 0.55, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.04,
    emissive: light ? 0x1a3a66 : 0x07164a, emissiveIntensity: 0.6,
  });
  if (envMap) { m.envMap = envMap; m.envMapIntensity = 1.1; }
  return m;
}
/** dark smoked chrome for the inset field of the HYBRID plate */
export function smokedChromeMaterial(envMap) {
  const m = new THREE.MeshStandardMaterial({ color: 0x272c34, metalness: 1, roughness: 0.16 });
  if (envMap) { m.envMap = envMap; m.envMapIntensity = 1.2; }
  return m;
}

/** rounded rectangle outline (counter-clockwise), centred on the origin */
function roundRect(w, h, r, n = 6) {
  const pts = [];
  const c = [[w / 2 - r, -h / 2 + r, -90], [w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, 90], [-w / 2 + r, -h / 2 + r, 180]];
  for (const [cx, cy, a0] of c) pts.push(...arc(cx, cy, r, r, a0, a0 + 90, n));
  return pts;
}

/**
 * HYBRID badge as on the ZE4: a slim chrome plate with a dark inset field, the blue square mark
 * (with its light-blue arc) on the left and slightly italic blue "HYBRID" letters with chrome
 * edges. All solid, bevelled geometry.
 * @param {number} w  plate width (m); the plate is 0.15 w tall
 * @param {object} o  { chrome, field, blue, blueLight }
 */
export function hybridBadge(w, { chrome, field, blue, blueLight } = {}) {
  const h = w * 0.15;
  const g = new THREE.Group();
  g.name = 'hybridBadge';
  const rim = h * 0.1; // chrome rim width
  const relief = h * 0.13; // how far the plate stands off the paint
  const bevel = h * 0.035;

  // chrome rim: rounded plate outline with the field cut out; the rim face is crowned so the
  // highlight runs along its length
  const outer = roundRect(w, h, h * 0.22);
  const inner = roundRect(w - 2 * rim, h - 2 * rim, h * 0.14);
  const rimShape = new THREE.Shape(outer);
  rimShape.holes.push(new THREE.Path(inner.slice().reverse()));
  const rimGeo = extrude(rimShape, relief - 2 * bevel, bevel, 3);
  shapeFront(rimGeo, (x, y) => new THREE.Vector2(Math.sign(x) * Math.max(0, Math.abs(x) - (w / 2 - h)) / h * 0.5, y / (h / 2) * 0.45));
  g.add(new THREE.Mesh(rimGeo, chrome));

  // dark field, set a little below the rim
  const fieldGeo = extrude(new THREE.Shape(inner), relief * 0.35, relief * 0.08, 1);
  g.add(new THREE.Mesh(fieldGeo, field));
  const zField = relief * 0.35 + relief * 0.16;

  // square mark at the left end: blue tile with a light-blue arc (open to the right)
  const sq = h - 2 * rim - h * 0.16;
  const sqX = -w / 2 + rim + h * 0.1 + sq / 2;
  const tile = new THREE.Mesh(extrude(new THREE.Shape(roundRect(sq, sq, sq * 0.12)), relief * 0.35, relief * 0.08, 1), blue);
  tile.position.set(sqX, 0, zField - relief * 0.05);
  g.add(tile);
  const arcPts = arc(sqX + sq * 0.12, 0, sq * 0.3, sq * 0.3, 70, 290, 20);
  const arcGeo = extrude(new THREE.Shape(strokeOutline(arcPts, sq * 0.16)), relief * 0.1, relief * 0.05, 1);
  const arcMesh = new THREE.Mesh(arcGeo, blueLight);
  arcMesh.position.z = zField - relief * 0.05 + relief * 0.5;
  g.add(arcMesh);

  // italic blue letters filling the rest of the field
  const x0 = sqX + sq / 2 + h * 0.2, x1 = w / 2 - rim - h * 0.22;
  const cap = (h - 2 * rim) * 0.7;
  const letters = chromeLettering('HYBRID', cap, {
    chrome, face: blue, stroke: 0.25, gap: 0.28, slant: 0.22, depth: relief * 0.6, fit: x1 - x0,
  });
  letters.position.set((x0 + x1) / 2, 0, zField - relief * 0.08);
  g.add(letters);

  g.userData.size = { w, h, depth: relief };
  return g;
}
