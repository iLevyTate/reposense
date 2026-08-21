/**
 * Static SVG renderer.
 *
 * The same model and layout the WebGL viewer uses, projected isometrically and
 * emitted as plain SVG. No DOM, no three.js, no browser — which is what makes
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
    bg0: '#070b16',
    bg1: '#04060d',
    haze: '#1b3a6b',
    text: '#dce6f5',
    dim: '#8697b0',
    faint: '#5b6a83',
    terraceTint: [0.42, 0.52, 0.68],
    terraceMix: 0.45,
    terraceAlpha: 0.95,
    faceTop: 1.25,
    faceLeft: 0.62,
    faceRight: 0.88,
    stroke: 'rgba(140,190,255,0.10)',
  },
  light: {
    bg0: '#f6f8fc',
    bg1: '#e9eef7',
    haze: '#c3d4ee',
    text: '#16202f',
    dim: '#4a5a70',
    faint: '#78879c',
    terraceTint: [0.62, 0.68, 0.78],
    terraceMix: 0.5,
    terraceAlpha: 0.95,
    faceTop: 1.1,
    faceLeft: 0.55,
    faceRight: 0.8,
    stroke: 'rgba(30,50,90,0.12)',
  },
};

const n = (v) => (Math.abs(v) < 0.005 ? '0' : v.toFixed(2));
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function shade(hex, factor, tint = null, mix = 0) {
  const v = parseInt(hex.slice(1), 16);
  let r = (v >> 16) & 255;
  let g = (v >> 8) & 255;
  let b = v & 255;
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

  /* ── terraces ─────────────────────────────────────────────────────────── */
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
    for (let s = 0; s <= segs; s += 1) {
      const a = d.a0 + (span * s) / segs;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      outer.push(track(iso(ca * r1, y, sa * r1)));
      inner.push(track(iso(ca * r0, y, sa * r0)));
    }
    const path = [
      `M${n(outer[0].x)} ${n(outer[0].y)}`,
      ...outer.slice(1).map((p) => `L${n(p.x)} ${n(p.y)}`),
      ...inner.reverse().map((p) => `L${n(p.x)} ${n(p.y)}`),
      'Z',
    ].join('');

    const base = shade(colorOf(d.lang), Math.max(0.4, 1 - d.depth * 0.1), theme.terraceTint, theme.terraceMix);
    shapes.push({
      depth: depthOf(Math.cos(d.aMid) * r0, Math.sin(d.aMid) * r0) - 1e6, // floors first
      svg: `<path d="${path}" fill="${base}" fill-opacity="${theme.terraceAlpha}" stroke="${theme.stroke}" stroke-width=".5"/>`,
    });
  }

  /* ── towers ───────────────────────────────────────────────────────────── */
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

    const poly = (pts) => pts.map((p) => `${n(p.x)},${n(p.y)}`).join(' ');
    const faces = [
      // Right face: the +x edge, catching the light.
      `<polygon points="${poly([iso(cx + w, y0, cz - w), iso(cx + w, y1, cz - w), iso(cx + w, y1, cz + w), iso(cx + w, y0, cz + w)])}" fill="${shade(color, theme.faceRight)}"/>`,
      // Left face: the +z edge, in shadow.
      `<polygon points="${poly([iso(cx - w, y0, cz + w), iso(cx - w, y1, cz + w), iso(cx + w, y1, cz + w), iso(cx + w, y0, cz + w)])}" fill="${shade(color, theme.faceLeft)}"/>`,
      `<polygon points="${poly(top)}" fill="${shade(color, theme.faceTop)}"/>`,
    ];

    shapes.push({ depth: depthOf(cx, cz), svg: faces.join('') });
  }

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

  // Keep the finished frame no narrower than 2:1 so the result sits well in a
  // README rather than becoming a tall column on a deep, narrow tree.
  //
  // The legend band is a fraction of the final width, which the width also
  // depends on, so solve it rather than iterate:
  //   W / (drawnH + k·W) >= R   ->   W >= R·drawnH / (1 - R·k)
  const MIN_RATIO = 2;
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

  /* ── legend and title ─────────────────────────────────────────────────── */
  let legend = '';
  if (showLegend) {
    const repo = payload.repo || {};
    const name = repo.owner ? `${repo.owner}/${repo.name}` : repo.name || 'repository';
    const s = model.stats;
    const unit = vbW / 100;
    const y = maxY + legendH * 0.42;

    const facts = [
      `${formatCount(s.fileCount)} files`,
      formatBytes(s.totalSize),
      `${formatCount(s.dirCount)} folders`,
      `depth ${s.maxDepth}`,
    ].join('   ·   ');

    // Chips are laid out until the row runs out of width, rather than taking a
    // fixed count and letting the last one clip off the edge.
    const limit = maxX - unit * 2;
    let chipX = minX + unit * 2;
    let chips = '';
    for (const l of model.languages.slice(0, 8)) {
      const label = `${l.name} ${(l.share * 100).toFixed(l.share >= 0.1 ? 0 : 1)}%`;
      // Monospace advance is ~0.6em; the chip also holds a dot and padding.
      const cw = unit * (4.6 + label.length * 1.9 * 0.6);
      if (chipX + cw > limit) break;
      chips +=
        `<rect x="${n(chipX)}" y="${n(y + unit * 2.6)}" width="${n(cw)}" height="${n(unit * 3.4)}" rx="${n(unit * 1.7)}" fill="${l.color}" fill-opacity=".14"/>` +
        `<circle cx="${n(chipX + unit * 1.5)}" cy="${n(y + unit * 4.3)}" r="${n(unit * 0.72)}" fill="${l.color}"/>` +
        `<text x="${n(chipX + unit * 2.8)}" y="${n(y + unit * 4.85)}" font-size="${n(unit * 1.9)}" fill="${theme.dim}">${esc(label)}</text>`;
      chipX += cw + unit * 0.9;
    }

    legend =
      `<g font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">` +
      `<text x="${n(minX + unit * 2)}" y="${n(y)}" font-size="${n(unit * 3.4)}" font-weight="600" fill="${theme.text}">${esc(name)}</text>` +
      `<text x="${n(minX + unit * 2)}" y="${n(y + unit * 1.9 + unit * 0.6)}" font-size="${n(unit * 1.9)}" fill="${theme.faint}">${esc(facts)}</text>` +
      chips +
      `<text x="${n(maxX - unit * 2)}" y="${n(y)}" font-size="${n(unit * 1.9)}" fill="${theme.faint}" text-anchor="end">RepoSense</text>` +
      `</g>`;
  }

  const hazeR = vbW * 0.6;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${n(minX)} ${n(minY)} ${n(vbW)} ${n(vbH)}" role="img" aria-label="${esc(describe(payload, model))}">
<title>${esc(describe(payload, model))}</title>
<defs>
<radialGradient id="bg" cx="50%" cy="42%" r="75%">
<stop offset="0%" stop-color="${theme.bg0}"/><stop offset="100%" stop-color="${theme.bg1}"/>
</radialGradient>
<radialGradient id="haze" cx="50%" cy="50%" r="50%">
<stop offset="0%" stop-color="${theme.haze}" stop-opacity=".55"/><stop offset="100%" stop-color="${theme.haze}" stop-opacity="0"/>
</radialGradient>
</defs>
<rect x="${n(minX)}" y="${n(minY)}" width="${n(vbW)}" height="${n(vbH)}" fill="url(#bg)"/>
<ellipse cx="0" cy="${n((minY + maxY) / 2)}" rx="${n(hazeR)}" ry="${n(hazeR * 0.5)}" fill="url(#haze)"/>
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
