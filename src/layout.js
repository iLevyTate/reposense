/**
 * Radial icicle layout.
 *
 * Every node owns an angular sector inherited from its parent and split among
 * its children by weight. Depth maps to a concentric ring *and* to altitude, so
 * the tree reads as a stepped ziggurat you can fly through rather than a flat
 * sunburst you look down at.
 *
 *   ring(d)   annulus [d*RING_GAP, d*RING_GAP + BAND]
 *   y(d)      d * lift              (lift is animated 0 -> LIFT for the reveal)
 *   tower     stands on its parent's terrace, height from file size
 */

import { walk } from './model.js';

export const RING_GAP = 16;
export const BAND = 11.5;
export const LIFT = 9.0;

/** Directories thinner than this (radians) are not worth drawing a label for. */
const LABEL_MIN_ARC = 0.055;

export function computeLayout(model, opts = {}) {
  const ringGap = opts.ringGap ?? RING_GAP;
  const band = opts.band ?? BAND;
  const root = model.root;

  root.a0 = 0;
  root.a1 = Math.PI * 2;
  root.ring = 0;
  assign(root, ringGap, band);

  // Tower geometry.
  //
  // Height is normalised against the 98th percentile file rather than the
  // largest one. Scaling to the maximum makes every tower tall whenever a
  // repository's files are of similar size — the common case — and once towers
  // exceed the ring spacing, neighbouring rings merge into one wall instead of
  // reading as terraces. Anchoring on p98 keeps the bulk comfortably below that
  // spacing and lets a genuinely huge file rise above it as a landmark.
  const maxChurn = Math.max(1, model.stats.maxChurn);
  const sizes = [];
  walk(root, (n) => {
    if (n.type === 'file' && n.size > 0) sizes.push(n.size);
  });
  sizes.sort((a, b) => a - b);
  const logOf = (v) => Math.log10(1 + Math.max(0, v) / 80);
  const refSize = sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * 0.98))] : 1;
  const floorSize = sizes.length ? sizes[Math.floor(sizes.length * 0.02)] : 0;
  const logFloor = logOf(floorSize);
  const logSpan = Math.max(0.12, logOf(refSize) - logFloor);
  const REF_HEIGHT = ringGap * 0.78;
  const MAX_HEIGHT = ringGap * 2.4;

  let maxRadius = 0;
  let maxRing = 0;
  const files = [];
  const dirs = [];

  walk(root, (n) => {
    if (!n.ring && n.ring !== 0) return;
    maxRadius = Math.max(maxRadius, n.r1);
    maxRing = Math.max(maxRing, n.ring);
    if (n.type === 'file') {
      n.height = Math.max(
        1.6,
        Math.min(MAX_HEIGHT, ((logOf(n.size) - logFloor) / logSpan) * REF_HEIGHT + 1.6),
      );
      // Footprint fills the tower's grid cell with a margin, so neighbours never
      // touch and every tower keeps a face wide enough to read and to hover.
      const cell = n.cell || (n.a1 - n.a0) * Math.max(n.rMid, 1);
      n.footprint = Math.max(0.85, Math.min(4.2, cell * 0.66));
      n.heat = maxChurn > 1 ? Math.min(1, Math.log2(1 + n.churn) / Math.log2(1 + maxChurn)) : 0;
      files.push(n);
    } else if (n !== root) {
      n.labelWorthy = n.a1 - n.a0 >= LABEL_MIN_ARC;
      dirs.push(n);
    }
  });

  return {
    files,
    dirs,
    maxRadius,
    maxRing,
    ringGap,
    band,
    ...frame(files, maxRadius, maxRing),
  };
}

/**
 * Where the camera should look, and from how far.
 *
 * A radial layout is only centred on the origin when the tree is balanced. Real
 * repositories are not: one vendored dependency or generated tree becomes a
 * long thin arm that drags the structure off-centre. Framing on the
 * weight-weighted centroid — and sizing by the spread around it, ignoring the
 * outermost few per cent — keeps the mass of the repository in shot.
 */
function frame(files, maxRadius, maxRing) {
  if (!files.length) {
    return { center: { x: 0, y: 0, z: 0 }, fitRadius: maxRadius, fitHeight: maxRing * LIFT };
  }

  let wSum = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const f of files) {
    const w = f.weight;
    wSum += w;
    cx += f.x * w;
    cz += f.z * w;
    cy += (f.ring * LIFT + f.height * 0.5) * w;
  }
  const center = { x: cx / wSum, y: cy / wSum, z: cz / wSum };

  const spread = files
    .map((f) => Math.hypot(f.x - center.x, f.ring * LIFT - center.y, f.z - center.z))
    .sort((a, b) => a - b);
  const p92 = spread[Math.min(spread.length - 1, Math.floor(spread.length * 0.92))];

  return {
    center,
    fitRadius: Math.max(24, p92),
    fitHeight: Math.max(maxRing * LIFT * 0.5, center.y * 1.6),
  };
}

function assign(node, ringGap, band) {
  node.r0 = node.ring * ringGap;
  node.r1 = node.r0 + band;
  node.rMid = node.r0 + band * 0.5;
  node.aMid = (node.a0 + node.a1) * 0.5;
  node.x = Math.cos(node.aMid) * node.rMid;
  node.z = Math.sin(node.aMid) * node.rMid;

  if (node.type === 'file' || !node.children || !node.children.length) return;

  const dirs = node.children.filter((c) => c.type === 'dir');
  const files = node.children.filter((c) => c.type === 'file');
  const span = node.a1 - node.a0;
  const childRing = node.ring + 1;

  // Sub-directories keep their weight-proportional angular slice, because they
  // extend outward and their width is what makes "a folder's slice of the disc
  // is its share of the codebase" true.
  //
  // Files do not. Splitting a folder's arc among its files alone gives each one
  // a razor-thin wedge as soon as a folder holds more than a handful, and a
  // hundred of them read as a striped wall rather than as buildings. They are
  // packed into a grid across the terrace instead — angular columns by radial
  // rows — so each gets a footprint you can actually see and hover. Nothing is
  // lost: a file's size is already its height.
  const dirWeight = dirs.reduce((t, c) => t + c.weight, 0);
  const fileWeight = files.reduce((t, c) => t + c.weight, 0);
  const total = dirWeight + fileWeight || 1;

  // A hairline gutter so neighbouring districts read as separate pieces of
  // architecture instead of one continuous ribbon.
  const gutter = Math.min(span * 0.02, 0.012) / Math.max(1, node.children.length);
  const gutters = gutter * Math.max(0, node.children.length - 1);
  const usable = Math.max(span * 0.05, span - gutters);

  let a = node.a0;
  if (dirs.length) {
    const dirSpan = (dirWeight / total) * usable;
    for (const child of dirs) {
      const slice = dirWeight ? (child.weight / dirWeight) * dirSpan : dirSpan / dirs.length;
      child.a0 = a;
      child.a1 = a + slice;
      child.ring = childRing;
      a += slice + gutter;
      assign(child, ringGap, band);
    }
  }

  if (files.length) {
    const fileSpan = Math.max(1e-4, node.a1 - a);
    packFiles(files, a, fileSpan, childRing, ringGap, band);
  }
}

/**
 * Lays a folder's files out as a grid on its terrace.
 *
 * Rows are chosen to make cells roughly square in world space, so towers read
 * as a block of buildings from any angle rather than as a picket fence.
 */
function packFiles(files, aStart, aSpan, ring, ringGap, band) {
  const r0 = ring * ringGap;
  const rMid = r0 + band * 0.5;
  const arcLen = Math.max(1e-3, aSpan * rMid);
  // aspect > 1 means the sector is wider than it is deep, so it wants more
  // columns than rows.
  const aspect = arcLen / band;
  const rows = Math.max(1, Math.min(6, Math.round(Math.sqrt(files.length / Math.max(aspect, 0.05)))));
  const cols = Math.ceil(files.length / rows);
  const cellA = aSpan / cols;
  const cellR = band / rows;

  files.forEach((f, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    f.a0 = aStart + col * cellA;
    f.a1 = f.a0 + cellA;
    f.ring = ring;
    f.r0 = r0 + row * cellR;
    f.r1 = f.r0 + cellR;
    f.rMid = f.r0 + cellR * 0.5;
    f.aMid = (f.a0 + f.a1) * 0.5;
    f.x = Math.cos(f.aMid) * f.rMid;
    f.z = Math.sin(f.aMid) * f.rMid;
    // The cell the tower must fit inside, in world units.
    f.cell = Math.min(cellA * f.rMid, cellR);
  });
}

/** World-space position of a node at the given terrace lift. */
export function positionAt(node, lift) {
  return { x: node.x, y: node.ring * lift, z: node.z };
}
