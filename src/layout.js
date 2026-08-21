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

  // Tower geometry. Height is logarithmic in bytes so a 40-byte file is still
  // a visible spike and a 4 MB blob does not leave the frame.
  const maxSize = Math.max(1, model.stats.maxSize);
  const maxChurn = Math.max(1, model.stats.maxChurn);
  const heightScale = 26 / Math.log10(1 + maxSize / 80);

  let maxRadius = 0;
  let maxRing = 0;
  const files = [];
  const dirs = [];

  walk(root, (n) => {
    if (!n.ring && n.ring !== 0) return;
    maxRadius = Math.max(maxRadius, n.r1);
    maxRing = Math.max(maxRing, n.ring);
    if (n.type === 'file') {
      n.height = Math.max(1.4, Math.log10(1 + n.size / 80) * heightScale);
      // Footprint is capped by the arc length available so towers never overlap.
      const arcLen = (n.a1 - n.a0) * Math.max(n.rMid, 1);
      n.footprint = Math.max(0.8, Math.min(3.4, arcLen * 0.62));
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

  const total = node.children.reduce((s, c) => s + c.weight, 0) || 1;
  // Sectors get a hairline gutter so neighbouring districts read as separate
  // pieces of architecture instead of one continuous ribbon.
  const span = node.a1 - node.a0;
  const gutter = Math.min(span * 0.02, 0.012) / Math.max(1, node.children.length);
  let a = node.a0;
  for (const child of node.children) {
    const slice = (child.weight / total) * (span - gutter * (node.children.length - 1));
    child.a0 = a;
    child.a1 = a + slice;
    child.ring = node.ring + 1;
    a += slice + gutter;
    assign(child, ringGap, band);
  }
}

/** World-space position of a node at the given terrace lift. */
export function positionAt(node, lift) {
  return { x: node.x, y: node.ring * lift, z: node.z };
}
