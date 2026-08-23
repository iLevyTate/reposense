/**
 * Static SVG renderer.
 *
 * The same model and layout the WebGL viewer uses, projected isometrically and
 * emitted as plain SVG. No DOM, no three.js, no browser. That is what makes
 * it usable from a GitHub Action, and what makes the output a few hundred
 * kilobytes of vector rather than a screenshot.
 *
 * The projection matches the viewer's reading: rings are depth, terraces are
 * directories, towers are files, height is size, colour is language.
 */

import { buildModel, formatBytes, formatCount } from './model.js';
import { computeLayout, LIFT } from './layout.js';
import { colorOf } from './palette.js';

/* Isometric projection. A 30° cabinet projection reads as depth without the
   foreshortening maths a true perspective camera would need. */
const COS30 = Math.cos(Math.PI / 6);
const SIN30 = Math.sin(Math.PI / 6);

function iso(x, y, z) {
  return { x: (x - z) * COS30, y: (x + z) * SIN30 - y };
}

/** Painter's algorithm key: larger is nearer the viewer, so drawn later. */
function depthOf(x, z) {
  return x + z;
}

const THEMES = {
  dark: {
    dark: true,
    bg0: '#0a101f',
    bg1: '#04060d',
    haze: '#25508f',
    text: '#e6edf8',
    dim: '#93a4bd',
    faint: '#5b6a83',
    rule: 'rgba(160,190,235,0.10)',
    // Terrace floors sit back as cool structure; the language colour lives in
    // the luminous rim along each outer edge, exactly as in the 3D scene.
    terraceTint: [0.35, 0.44, 0.62],
    terraceMix: 0.68,
    terraceFloor: 0.34,
    terraceAlpha: 0.96,
    skirt: 0.16,
    rimOpacity: 0.8,
    // Tower faces shade from a grounded base into a lit top; the pure colour
    // is reserved for the crown stroke, which is what reads as light.
    faceTopLo: 0.32,
    faceTopHi: 0.66,
    sideTint: [0.3, 0.38, 0.56],
    sideMix: 0.22,
    rightLo: 0.18,
    rightHi: 0.92,
    leftLo: 0.11,
    leftHi: 0.58,
    crownOpacity: 0.75,
    // The premium grade: bodies desaturate toward architecture and the
    // saturated colour survives only in rims, crowns and the legend, the same
    // trade the WebGL scene makes.
    desat: 0.32,
    winFill: '#ffe3b0',
    winLitOp: 0.9,
    winShadeOp: 0.3,
    shadowOp: 0.5,
    ring: '#7fa8e8',
    ringOp: 0.07,
    core: '#bfeaff',
    coreOp: 0.85,
    pools: true,
    stars: true,
  },
  light: {
    dark: false,
    bg0: '#f7f9fd',
    bg1: '#e8edf6',
    haze: '#c9d9f2',
    text: '#16202f',
    dim: '#4a5a70',
    faint: '#78879c',
    rule: 'rgba(30,50,90,0.14)',
    terraceTint: [0.72, 0.77, 0.85],
    terraceMix: 0.62,
    terraceFloor: 1.0,
    terraceAlpha: 0.96,
    skirt: 0.74,
    rimOpacity: 0.85,
    faceTopLo: 1.02,
    faceTopHi: 1.22,
    sideTint: [0.5, 0.56, 0.68],
    sideMix: 0.16,
    rightLo: 0.62,
    rightHi: 1.0,
    leftLo: 0.44,
    leftHi: 0.78,
    crownOpacity: 0.9,
    desat: 0.22,
    // On white the windows read as dark glass rather than lit panes.
    winFill: '#31415c',
    winLitOp: 0.28,
    winShadeOp: 0.15,
    shadowOp: 0.16,
    ring: '#5a7ab0',
    ringOp: 0.1,
    core: '#7fb4d9',
    coreOp: 0.5,
    pools: false,
    stars: false,
  },
};

/** Rings beyond this share the last stagger step, so the CSS stays small. */
const RING_CLASSES = 10;

const n = (v) => (Math.abs(v) < 0.005 ? '0' : v.toFixed(2));

/**
 * Build-in animation, as CSS inside the SVG.
 *
 * GitHub strips <script> from SVG but renders it as an image, and CSS
 * animation inside an image still runs. That is what lets a README show
 * motion without shipping a multi-megabyte GIF.
 *
 * The cycle spends most of its length fully built, so a reader arriving at any
 * moment sees the finished structure rather than a half-drawn one, and any
 * renderer that ignores the CSS shows the final state anyway.
 */
function animationCss(rise) {
  const rules = [];
  for (let r = 0; r < RING_CLASSES; r += 1) {
    rules.push(`.r${r}{animation:rs 14s cubic-bezier(.16,1,.3,1) ${(r * 0.28).toFixed(2)}s infinite}`);
  }
  return `<style>
@keyframes rs{0%{opacity:0;transform:translateY(${n(rise)}px)}9%{opacity:1;transform:translateY(0)}88%{opacity:1;transform:translateY(0)}100%{opacity:0;transform:translateY(${n(rise)}px)}}
${rules.join('')}
@media (prefers-reduced-motion:reduce){.r0,.r1,.r2,.r3,.r4,.r5,.r6,.r7,.r8,.r9{animation:none}}
</style>`;
}
/** Deterministic PRNG; renderSvg must produce identical bytes every run. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Linear blend of two hex colours; t = 0 keeps a, t = 1 gives b. */
function mixHex(a, b, t) {
  const va = parseInt(a.slice(1), 16);
  const vb = parseInt(b.slice(1), 16);
  const c = (sa, sb) => Math.round(sa + (sb - sa) * t);
  const r = c((va >> 16) & 255, (vb >> 16) & 255);
  const g = c((va >> 8) & 255, (vb >> 8) & 255);
  const bl = c(va & 255, vb & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
}

function shade(hex, factor, tint = null, mix = 0, desat = 0) {
  const v = parseInt(hex.slice(1), 16);
  let r = (v >> 16) & 255;
  let g = (v >> 8) & 255;
  let b = v & 255;
  if (desat) {
    const lum = r * 0.2126 + g * 0.7152 + b * 0.0722;
    r += (lum - r) * desat;
    g += (lum - g) * desat;
    b += (lum - b) * desat;
  }
  if (tint) {
    r = r * (1 - mix) + tint[0] * 255 * mix;
    g = g * (1 - mix) + tint[1] * 255 * mix;
    b = b * (1 - mix) + tint[2] * 255 * mix;
  }
  const c = (x) => Math.max(0, Math.min(255, Math.round(x * factor)));
  return `#${((1 << 24) | (c(r) << 16) | (c(g) << 8) | c(b)).toString(16).slice(1)}`;
}

/**
 * @param {object} payload  a reposense/1 document
 * @param {object} [opts]
 * @param {'dark'|'light'} [opts.theme]
 * @param {number} [opts.width]   output width in px (height follows the ratio)
 * @param {number} [opts.maxTowers]  drawn-tower budget; the rest fold into
 *   bundle towers exactly as they do in the viewer
 * @param {boolean} [opts.legend]  draw the title block and language legend
 * @returns {string} a complete standalone SVG document
 */
export function renderSvg(payload, opts = {}) {
  const theme = THEMES[opts.theme] || THEMES.dark;
  const width = opts.width || 1280;
  const maxTowers = opts.maxTowers ?? 2200;
  const showLegend = opts.legend !== false;
  const animate = !!opts.animate;

  const model = buildModel(payload, { maxFiles: maxTowers });
  const layout = computeLayout(model);

  const shapes = [];

  // Bounds follow the geometry actually drawn. Deriving them from a bounding
  // cylinder instead leaves most of the frame empty, because a radial structure
  // fills nothing like its circumscribed volume.
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  const track = (p) => {
    if (p.x < bounds.minX) bounds.minX = p.x;
    if (p.x > bounds.maxX) bounds.maxX = p.x;
    if (p.y < bounds.minY) bounds.minY = p.y;
    if (p.y > bounds.maxY) bounds.maxY = p.y;
    return p;
  };

  /* ── depth fade ───────────────────────────────────────────────────────────
     Atmospheric perspective: the far side of the structure recedes instead of
     competing with the front. Normalised from the largest ring, in closed form
     so it can be applied while shapes are still being built. */
  const maxR = ((layout.maxRing ?? 6) + 2) * layout.ringGap + layout.band;
  const fadeOf = (depth) => {
    const t = Math.max(0, Math.min(1, (depth + maxR * 1.45) / (maxR * 2.9)));
    return 0.7 + 0.3 * t; // far 0.7 → near 1
  };

  /* ── terraces ─────────────────────────────────────────────────────────── */
  const SKIRT = Math.max(2, layout.band * 0.16);
  for (const d of [model.root, ...layout.dirs]) {
    const ring = d.ring + 1;
    const r0 = ring * layout.ringGap;
    const r1 = r0 + layout.band;
    const span = d.a1 - d.a0;
    if (span <= 0.002) continue;
    const y = ring * LIFT;

    const segs = Math.max(2, Math.min(64, Math.ceil((span * r1) / 3)));
    const outer = [];
    const inner = [];
    const hem = [];
    for (let s = 0; s <= segs; s += 1) {
      const a = d.a0 + (span * s) / segs;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      outer.push(track(iso(ca * r1, y, sa * r1)));
      inner.push(track(iso(ca * r0, y, sa * r0)));
      hem.push(track(iso(ca * r1, y - SKIRT, sa * r1)));
    }
    const ln = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${n(p.x)} ${n(p.y)}`).join('');
    const path = `${ln(outer)}${[...inner].reverse().map((p) => `L${n(p.x)} ${n(p.y)}`).join('')}Z`;
    // The platform's visible thickness: the outer edge extruded downward.
    const skirtPath = `${ln(outer)}${[...hem].reverse().map((p) => `L${n(p.x)} ${n(p.y)}`).join('')}Z`;
    // The rim is the outer arc alone: an open stroke, not the whole outline.
    const rimPath = ln(outer);

    const depth = depthOf(Math.cos(d.aMid) * r0, Math.sin(d.aMid) * r0) - 1e6; // floors first
    const fade = fadeOf(depth + 1e6);
    // Distant terraces blend toward the haze instead of going black: the same
    // atmospheric fog the WebGL scene applies, so far districts read as far
    // rather than dead.
    const color = colorOf(d.lang);
    const fog = (1 - fade) / 0.3;
    const fogTo = theme.dark ? '#101b33' : '#dfe7f3';
    const floor = mixHex(
      shade(color, theme.terraceFloor * Math.max(0.66, 1 - d.depth * 0.06), theme.terraceTint, theme.terraceMix),
      fogTo,
      fog * 0.55,
    );
    const skirtFill = mixHex(shade(color, theme.skirt, theme.terraceTint, theme.terraceMix + 0.1), fogTo, fog * 0.4);
    const cls = animate ? ` class="r${Math.min(ring, RING_CLASSES - 1)}"` : '';
    shapes.push({
      depth,
      svg:
        `<g${cls}>` +
        `<path d="${skirtPath}" fill="${skirtFill}"/>` +
        `<path d="${path}" fill="${floor}" fill-opacity="${theme.terraceAlpha}"/>` +
        // Two passes make the rim glow: a wide soft halo under a thin core,
        // which is what bloom does to the same edge in the WebGL scene.
        `<path d="${rimPath}" fill="none" stroke="${color}" stroke-opacity="${n(0.16 * fade)}" stroke-width="${n(Math.max(2, layout.band * 0.14))}" stroke-linecap="round"/>` +
        `<path d="${rimPath}" fill="none" stroke="${color}" stroke-opacity="${n(theme.rimOpacity * fade)}" stroke-width="${n(Math.max(0.7, layout.band * 0.035))}" stroke-linecap="round"/>` +
        `</g>`,
    });
  }

  /* ── towers ───────────────────────────────────────────────────────────────
     Faces carry vertical gradients, grounded dark at the base rising into a
     lit top, and the pure language colour is reserved for a thin crown
     stroke around the top face. Buildings read as buildings lit from within,
     not extruded swatches. Gradients are shared per colour, so a repository
     with twenty languages costs forty defs, not one per tower. */
  const grads = new Map(); // color -> gradient id index
  const gradIdOf = (color) => {
    let id = grads.get(color);
    if (id === undefined) {
      id = grads.size;
      grads.set(color, id);
    }
    return id;
  };

  // Per-tower window brightness; seeded so every render is byte-identical.
  const trand = mulberry32(0x70e35eed);
  // Only buildings tall enough to have floors get windows.
  const WIN_MIN_H = layout.ringGap * 0.7;

  for (const f of layout.files) {
    const y0 = f.ring * LIFT;
    const y1 = y0 + f.height;
    const w = Math.max(0.7, f.footprint * 0.5);
    const ca = Math.cos(f.aMid);
    const sa = Math.sin(f.aMid);
    // Axis-aligned footprint keeps the polygon count at three faces per tower.
    const cx = ca * f.rMid;
    const cz = sa * f.rMid;

    const corners = [
      [cx - w, cz - w],
      [cx + w, cz - w],
      [cx + w, cz + w],
      [cx - w, cz + w],
    ];
    const top = corners.map(([x, z]) => track(iso(x, y1, z)));
    for (const [x, z] of corners) track(iso(x, y0, z));
    const color = colorOf(f.lang);
    const gid = gradIdOf(color);
    const depth = depthOf(cx, cz);
    const fade = fadeOf(depth);

    const poly = (pts) => pts.map((p) => `${n(p.x)},${n(p.y)}`).join(' ');
    const faces = [
      // Right face: the +x edge, catching the light.
      `<polygon points="${poly([iso(cx + w, y0, cz - w), iso(cx + w, y1, cz - w), iso(cx + w, y1, cz + w), iso(cx + w, y0, cz + w)])}" fill="url(#fr${gid})"/>`,
      // Left face: the +z edge, in shadow.
      `<polygon points="${poly([iso(cx - w, y0, cz + w), iso(cx - w, y1, cz + w), iso(cx + w, y1, cz + w), iso(cx + w, y0, cz + w)])}" fill="url(#fl${gid})"/>`,
    ];

    // Window grids on both visible faces, inset from the edges. The panes
    // come from two shared skewed patterns, so a thousand towers cost two
    // defs and one polygon per face.
    const lit = 0.55 + trand() * 0.45;
    if (f.height >= WIN_MIN_H) {
      const wz0 = cz - w * 0.66;
      const wz1 = cz + w * 0.66;
      const wx0 = cx - w * 0.66;
      const wx1 = cx + w * 0.66;
      const wy0 = y0 + 0.7;
      const wy1 = y1 - 1.1;
      faces.push(
        `<polygon points="${poly([iso(cx + w, wy0, wz0), iso(cx + w, wy1, wz0), iso(cx + w, wy1, wz1), iso(cx + w, wy0, wz1)])}" fill="url(#wr)" opacity="${n(theme.winLitOp * lit)}"/>`,
        `<polygon points="${poly([iso(wx0, wy0, cz + w), iso(wx0, wy1, cz + w), iso(wx1, wy1, cz + w), iso(wx1, wy0, cz + w)])}" fill="url(#wl)" opacity="${n(theme.winShadeOp * lit)}"/>`,
      );
    }
    // Top face last, ringed by the crown light.
    faces.push(
      `<polygon points="${poly(top)}" fill="url(#ft${gid})" stroke="${color}" stroke-opacity="${n(theme.crownOpacity * fade)}" stroke-width="${n(Math.min(0.8, w * 0.22))}" stroke-linejoin="round"/>`,
    );

    const cls = animate ? ` class="r${Math.min(f.ring, RING_CLASSES - 1)}"` : '';
    // The contact shadow is what sets a building down on its terrace instead
    // of floating it a millimetre above; it sorts just behind its tower.
    const base = iso(cx, y0, cz);
    const shR = w * 1.7 * Math.SQRT2;
    shapes.push({
      depth: depth - 0.01,
      svg: `<g${cls}><ellipse cx="${n(base.x)}" cy="${n(base.y)}" rx="${n(shR * COS30)}" ry="${n(shR * SIN30)}" fill="url(#sh)" opacity="${n(theme.shadowOp * fade)}"/></g>`,
    });

    const body = `<g${cls}${fade < 0.98 ? ` opacity="${n(fade)}"` : ''}>${faces.join('')}</g>`;
    shapes.push({ depth, svg: body });
  }

  // The core: a glowing orb in the centre well, where the WebGL scene keeps
  // its own. It sorts above every floor and behind every tower.
  shapes.push({
    depth: -1e5,
    svg: `<circle cx="0" cy="${n(-LIFT * 0.55)}" r="${n(layout.ringGap * 0.55)}" fill="url(#core)"/>`,
  });

  shapes.sort((a, b) => a.depth - b.depth);

  /* ── frame the drawing ────────────────────────────────────────────────── */
  if (!Number.isFinite(bounds.minX)) {
    bounds.minX = -100;
    bounds.maxX = 100;
    bounds.minY = -50;
    bounds.maxY = 50;
  }
  const pad = Math.max(8, (bounds.maxX - bounds.minX) * 0.045);
  let minX = bounds.minX - pad;
  let maxX = bounds.maxX + pad;
  let minY = bounds.minY - pad;
  let maxY = bounds.maxY + pad;

  // Keep the finished frame no narrower than 7:4 so the result sits well in a
  // README rather than becoming a tall column on a deep, narrow tree. Wider
  // than that trades drawing for empty margin, which is the worse deal.
  //
  // The legend band is a fraction of the final width, which the width also
  // depends on, so solve it rather than iterate:
  //   W / (drawnH + k·W) >= R   ->   W >= R·drawnH / (1 - R·k)
  const MIN_RATIO = 1.75;
  const LEGEND_K = showLegend ? 0.14 : 0;
  const drawnW = maxX - minX;
  const drawnH = maxY - minY;
  const needW = (MIN_RATIO * drawnH) / (1 - MIN_RATIO * LEGEND_K);
  if (drawnW < needW) {
    const grow = (needW - drawnW) / 2;
    minX -= grow;
    maxX += grow;
  }

  const vbW = maxX - minX;
  const legendH = LEGEND_K * vbW;
  const vbH = maxY - minY + legendH;
  const height = Math.round((width * vbH) / vbW);

  /* ── legend and title ─────────────────────────────────────────────────────
     A hairline rule, restrained type, and the app's own composition spectrum
     instead of pill chips: the languages read as one proportioned bar with a
     quiet key beneath it. */
  let legend = '';
  if (showLegend) {
    const repo = payload.repo || {};
    const name = repo.owner ? `${repo.owner}/${repo.name}` : repo.name || 'repository';
    const s = model.stats;
    const unit = vbW / 100;
    const left = minX + unit * 2;
    const right = maxX - unit * 2;
    const yRule = maxY + legendH * 0.1;
    const yTitle = maxY + legendH * 0.35;

    const facts = [
      `${formatCount(s.fileCount)} files`,
      formatBytes(s.totalSize),
      `${formatCount(s.dirCount)} folders`,
      `depth ${s.maxDepth}`,
    ].join('  ·  ');

    // The spectrum: language shares as one segmented bar, gaps included.
    // Shares below one percent fold into a single muted tail segment; a row
    // of crumb-sized dots communicates nothing but clutter.
    const langs = model.languages.slice(0, 12).filter((l) => l.share >= 0.01);
    const tail = Math.max(0, 1 - langs.reduce((t, l) => t + l.share, 0));
    const segs2 = langs.length + (tail >= 0.005 ? 1 : 0);
    const barY = maxY + legendH * 0.62;
    const barH = unit * 0.55;
    const gap = unit * 0.18;
    const barW = right - left - gap * Math.max(0, segs2 - 1);
    let bx = left;
    let bar = '';
    for (const l of langs) {
      const w = Math.max(unit * 0.3, l.share * barW);
      if (bx + w > right + 0.5) break;
      bar += `<rect x="${n(bx)}" y="${n(barY)}" width="${n(w)}" height="${n(barH)}" rx="${n(barH / 2)}" fill="${l.color}"/>`;
      bx += w + gap;
    }
    if (tail >= 0.005 && bx + unit * 0.3 <= right + 0.5) {
      const w = Math.min(right - bx, Math.max(unit * 0.3, tail * barW));
      bar += `<rect x="${n(bx)}" y="${n(barY)}" width="${n(w)}" height="${n(barH)}" rx="${n(barH / 2)}" fill="${theme.faint}" fill-opacity="0.4"/>`;
    }

    // The key: dot, name, share, laid out until the row runs out of width.
    const keyY = barY + unit * 2.1;
    let kx = left;
    let key = '';
    for (const l of model.languages.slice(0, 8)) {
      const label = `${l.name} ${(l.share * 100).toFixed(l.share >= 0.1 ? 0 : 1)}%`;
      const kw = unit * (2.1 + label.length * 1.7 * 0.62);
      if (kx + kw > right) break;
      key +=
        `<circle cx="${n(kx + unit * 0.55)}" cy="${n(keyY - unit * 0.55)}" r="${n(unit * 0.55)}" fill="${l.color}"/>` +
        `<text x="${n(kx + unit * 1.7)}" y="${n(keyY)}" font-size="${n(unit * 1.7)}" fill="${theme.dim}">${esc(label)}</text>`;
      kx += kw + unit * 1.6;
    }

    legend =
      `<g font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">` +
      `<line x1="${n(left)}" y1="${n(yRule)}" x2="${n(right)}" y2="${n(yRule)}" stroke="${theme.rule}" stroke-width="${n(unit * 0.06)}"/>` +
      `<text x="${n(left)}" y="${n(yTitle)}" font-size="${n(unit * 2.6)}" font-weight="600" letter-spacing="${n(unit * 0.03)}" fill="${theme.text}">${esc(name)}</text>` +
      `<text x="${n(right)}" y="${n(yTitle)}" font-size="${n(unit * 1.7)}" letter-spacing="${n(unit * 0.14)}" fill="${theme.faint}" text-anchor="end">REPOSENSE</text>` +
      `<text x="${n(left)}" y="${n(maxY + legendH * 0.52)}" font-size="${n(unit * 1.7)}" fill="${theme.faint}">${esc(facts)}</text>` +
      bar +
      key +
      `</g>`;
  }

  /* ── shared face gradients, one pair-of-three per language colour ─────── */
  let gradDefs = '';
  for (const [color, gid] of grads) {
    const g = (id, lo, hi, tint, mix) =>
      `<linearGradient id="${id}${gid}" x1="0" y1="1" x2="0" y2="0">` +
      `<stop offset="0%" stop-color="${shade(color, lo, tint, mix, theme.desat)}"/>` +
      `<stop offset="100%" stop-color="${shade(color, hi, tint, mix * 0.5, theme.desat)}"/>` +
      `</linearGradient>`;
    gradDefs +=
      g('fr', theme.rightLo, theme.rightHi, theme.sideTint, theme.sideMix) +
      g('fl', theme.leftLo, theme.leftHi, theme.sideTint, theme.sideMix) +
      g('ft', theme.faceTopLo, theme.faceTopHi, theme.sideTint, theme.sideMix * 0.4);
  }
  // Shared scene defs: the contact-shadow falloff, the core glow, and the two
  // window grids. The pattern skews match the 30 degree isometric slope, so
  // the panes follow each face's floors exactly.
  gradDefs +=
    `<radialGradient id="sh">` +
    `<stop offset="0%" stop-color="#000" stop-opacity=".55"/>` +
    `<stop offset="65%" stop-color="#000" stop-opacity=".22"/>` +
    `<stop offset="100%" stop-color="#000" stop-opacity="0"/>` +
    `</radialGradient>` +
    `<radialGradient id="core">` +
    `<stop offset="0%" stop-color="${theme.core}" stop-opacity="${n(theme.coreOp)}"/>` +
    `<stop offset="40%" stop-color="${theme.core}" stop-opacity="${n(theme.coreOp * 0.3)}"/>` +
    `<stop offset="100%" stop-color="${theme.core}" stop-opacity="0"/>` +
    `</radialGradient>` +
    `<pattern id="wr" width="1.35" height="1.8" patternUnits="userSpaceOnUse" patternTransform="skewY(-30)">` +
    `<rect x="0.3" y="0.4" width="0.72" height="1.02" rx="0.14" fill="${theme.winFill}"/>` +
    `</pattern>` +
    `<pattern id="wl" width="1.35" height="1.8" patternUnits="userSpaceOnUse" patternTransform="skewY(30)">` +
    `<rect x="0.3" y="0.4" width="0.72" height="1.02" rx="0.14" fill="${theme.winFill}"/>` +
    `</pattern>`;
  if (theme.pools) {
    gradDefs +=
      `<radialGradient id="poolc">` +
      `<stop offset="0%" stop-color="#4fd8ff" stop-opacity=".08"/>` +
      `<stop offset="100%" stop-color="#4fd8ff" stop-opacity="0"/>` +
      `</radialGradient>` +
      `<radialGradient id="poolv">` +
      `<stop offset="0%" stop-color="#8f6bff" stop-opacity=".07"/>` +
      `<stop offset="100%" stop-color="#8f6bff" stop-opacity="0"/>` +
      `</radialGradient>`;
  }

  /* ── star field: sparse, seeded, and identical on every render ────────── */
  let stars = '';
  if (theme.stars) {
    const rand = mulberry32(0x5eba5eed);
    const drawn = maxY - minY;
    let dots = '';
    for (let i = 0; i < 90; i += 1) {
      const x = minX + rand() * vbW;
      const yy = minY + rand() * drawn * 0.92;
      const r = vbW * (0.0004 + rand() * 0.0009);
      const o = 0.12 + rand() * 0.4;
      const cool = rand() < 0.75;
      dots += `<circle cx="${n(x)}" cy="${n(yy)}" r="${n(r)}" fill="${cool ? '#a8c8f5' : '#d9c9f2'}" opacity="${n(o)}"/>`;
    }
    stars = `<g>${dots}</g>`;
  }

  // The glow pools *under* the structure, like city light on the ground
  // plane, instead of a fog bank floating through its middle.
  const glowCX = (minX + maxX) / 2;
  const glowCY = maxY - (maxY - minY) * 0.16;
  const glowRX = (maxX - minX) * 0.36;

  // Concentric ground guides, the quiet survey lines the WebGL floor draws.
  // Projected circles at y=0 come out as plain axis-aligned ellipses.
  let ground = '';
  {
    const ringsN = (layout.maxRing ?? 4) + 2;
    let rr = '';
    for (let k = 1; k <= ringsN; k += 1) {
      const r = k * layout.ringGap + layout.band * 0.5;
      rr +=
        `<ellipse cx="0" cy="0" rx="${n(Math.SQRT2 * r * COS30)}" ry="${n(Math.SQRT2 * r * SIN30)}"` +
        ` fill="none" stroke="${theme.ring}" stroke-opacity="${n(theme.ringOp)}" stroke-width="${n(vbW * 0.0009)}"/>`;
    }
    ground = `<g>${rr}</g>`;
  }

  // Two faint colour pools give the void an atmosphere, matching the graded
  // sky dome in the viewer: cool cyan low on one side, violet on the other.
  let pools = '';
  if (theme.pools) {
    const drawnHNow = maxY - minY;
    pools =
      `<ellipse cx="${n(minX + vbW * 0.2)}" cy="${n(maxY - drawnHNow * 0.12)}" rx="${n(vbW * 0.36)}" ry="${n(drawnHNow * 0.5)}" fill="url(#poolc)"/>` +
      `<ellipse cx="${n(maxX - vbW * 0.18)}" cy="${n(minY + drawnHNow * 0.14)}" rx="${n(vbW * 0.33)}" ry="${n(drawnHNow * 0.5)}" fill="url(#poolv)"/>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${n(minX)} ${n(minY)} ${n(vbW)} ${n(vbH)}" role="img" aria-label="${esc(describe(payload, model))}">
<title>${esc(describe(payload, model))}</title>
<defs>
<radialGradient id="bg" cx="50%" cy="38%" r="80%">
<stop offset="0%" stop-color="${theme.bg0}"/><stop offset="100%" stop-color="${theme.bg1}"/>
</radialGradient>
<radialGradient id="haze" cx="50%" cy="50%" r="50%">
<stop offset="0%" stop-color="${theme.haze}" stop-opacity=".4"/><stop offset="100%" stop-color="${theme.haze}" stop-opacity="0"/>
</radialGradient>
${gradDefs}
</defs>
${animate ? animationCss((maxY - minY) * 0.06) : ''}
<rect x="${n(minX)}" y="${n(minY)}" width="${n(vbW)}" height="${n(vbH)}" fill="url(#bg)"/>
${pools}${stars}
<ellipse cx="${n(glowCX)}" cy="${n(glowCY)}" rx="${n(glowRX)}" ry="${n(glowRX * 0.32)}" fill="url(#haze)"/>
${ground}
${shapes.map((s) => s.svg).join('')}
${legend}
</svg>
`;
}

function describe(payload, model) {
  const repo = payload.repo || {};
  const name = repo.owner ? `${repo.owner}/${repo.name}` : repo.name || 'repository';
  const top = model.languages
    .slice(0, 3)
    .map((l) => l.name)
    .join(', ');
  return `${name} rendered by RepoSense: ${formatCount(model.stats.fileCount)} files across ${formatCount(
    model.stats.dirCount,
  )} folders, ${formatBytes(model.stats.totalSize)}${top ? `, mostly ${top}` : ''}.`;
}
