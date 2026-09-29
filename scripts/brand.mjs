#!/usr/bin/env node
/**
 * Draws the RepoSense logo and writes every file in public/ that carries it.
 *
 * The mark is the renderer's own picture reduced to one gesture: a lit core in
 * its pool, one terrace spiralling out of the pool, towers standing along it.
 * Two drawings come from the same geometry. The detailed one has floor lines,
 * stars and ground rings, and goes wherever the mark shows at 64px or more.
 * The bold one keeps five wide towers and thick light, because detail turns
 * to mush at 16px; it is only the browser tab's icon.
 *
 *   icon.svg                 detailed, on its own tile; works on any ground
 *   logo.svg                 detailed, bare, for dark grounds (launch screen)
 *   favicon.svg, .ico        bold, on its tile
 *   apple-touch-icon.png     180, full bleed so iOS can round it
 *   icon-192.png, -512.png   the tile, for the web manifest
 *   icon-maskable-512.png    full bleed, mark inside Android's safe zone
 *
 * The SVGs are string work and come out byte-identical run to run. Chromium
 * (via playwright) measures the bare mark for logo.svg's crop and rasterises
 * the rest. public/social-card.png carries the mark too, but it is a
 * screenshot with the mark composited in, not something this script makes.
 *
 *   node scripts/brand.mjs
 */

import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'public');

/* ───────────────────────────────────────────────────────────── geometry ── */

const DETAILED = {
  // The pool's centre and the camera: k squashes circles into the ground plane.
  cx: 30, cy: 39.5, k: 0.5,
  pool: 10.2,
  // Radius, deck width and wall height all grow linearly from tail to head,
  // so the terrace tapers out of the pool.
  terrace: { from: 140, to: 410, r: [12.6, 26], w: [2, 7.5], t: [0.6, 2.4] },
  core: 4.3, lift: 1.7,
  towerW: 3.8,
  // [angle on the terrace, height, brightest]. The view lights files by how
  // recently they changed, so one tower burns hotter than the rest.
  towers: [[200, 9], [226, 12], [250, 10.5], [291, 15.5, 1], [320, 12.5], [347, 10], [377, 7.5]],
  floors: true, details: true,
  rimW: 0.85, poolRimW: 1,
  deckTop: '#6f6c7c', deckMid: '#3d4460',
  bloom: 0.5, fadeR: 6,
  // [scale, x, y] that places the drawing on its 64-unit tile.
  fit: [1.12, -4.6, -4.6],
};

const BOLD = {
  ...DETAILED,
  terrace: { ...DETAILED.terrace, w: [3, 8.5], t: [0.8, 2.6] },
  core: 5,
  towerW: 5.2,
  towers: [[205, 11], [246, 13.5], [291, 17, 1], [333, 13], [373, 9]],
  floors: false, details: false,
  rimW: 1.7, poolRimW: 2,
  deckTop: '#8a8698', deckMid: '#4a5270',
  bloom: 0.45, fadeR: 5,
};

/* ──────────────────────────────────────────────────────────────── mark ── */

const f = (n) => { const v = +n.toFixed(2); return Object.is(v, -0) ? 0 : v; };
const rad = (d) => (d * Math.PI) / 180;
const XY = ([x, y]) => `${f(x)} ${f(y)}`;

function mark(G) {
  const T = G.terrace;
  const lerp = ([a, b], th) => a + (b - a) * (th - T.from) / (T.to - T.from);
  const R = (th) => lerp(T.r, th), W = (th) => lerp(T.w, th), H = (th) => lerp(T.t, th);
  const outer = (th) => R(th) + W(th) / 2, inner = (th) => R(th) - W(th) / 2;
  const P = (rf, th, dy = () => 0) => [G.cx + rf(th) * Math.cos(rad(th)), G.cy + G.k * rf(th) * Math.sin(rad(th)) + dy(th)];

  // A cubic path along r = rf(theta), tangents by central difference.
  function curve(rf, a, b, dy, move = true) {
    const n = Math.max(1, Math.ceil(Math.abs(b - a) / 20));
    const tan = (th) => {
      const e = 0.05, p = P(rf, th + e, dy), q = P(rf, th - e, dy);
      return [(p[0] - q[0]) / rad(2 * e), (p[1] - q[1]) / rad(2 * e)];
    };
    let d = move ? `M${XY(P(rf, a, dy))}` : '';
    for (let i = 0; i < n; i++) {
      const t0 = a + ((b - a) * i) / n, t1 = a + ((b - a) * (i + 1)) / n;
      const h = rad(t1 - t0) / 3, p0 = P(rf, t0, dy), p1 = P(rf, t1, dy), d0 = tan(t0), d1 = tan(t1);
      d += `C${XY([p0[0] + d0[0] * h, p0[1] + d0[1] * h])} ${XY([p1[0] - d1[0] * h, p1[1] - d1[1] * h])} ${XY(p1)}`;
    }
    return d;
  }
  // Split an arc where it crosses the far and near sides of the pool.
  const halves = (a, b) => {
    const back = [], front = [];
    for (let s = a; s < b;) {
      const e = Math.min(b, (Math.floor(s / 180) + 1) * 180);
      (Math.floor(s / 180) % 2 ? back : front).push([s, e]);
      s = e;
    }
    return { back, front };
  };
  const band = (a, b) => `${curve(outer, a, b)}L${XY(P(inner, b))}${curve(inner, b, a, undefined, false)}Z`;
  const wall = (rf, a, b) => `${curve(rf, a, b)}L${XY(P(rf, b, H))}${curve(rf, b, a, H, false)}Z`;

  // The wall you can see: the inner one across the back, the outer one in front.
  const { back, front } = halves(T.from, T.to);
  const terrace = (pieces, side) => pieces.map(([a, b]) => [
    `<path d="${wall(side === 'back' ? inner : outer, a, b)}" fill="url(#wall)"/>`,
    `<path d="${band(a, b)}" fill="url(#deck)"/>`,
    `<path d="${curve(inner, a, b)}" stroke="#dfe8ff" stroke-opacity=".28" stroke-width=".3"/>`,
    `<path d="${curve(outer, a, b)}" stroke="url(#rim)" stroke-width="${f(G.rimW * 2.6)}" stroke-opacity=".55" filter="url(#soft)"/>`,
    `<path d="${curve(outer, a, b)}" stroke="url(#rim)" stroke-width="${G.rimW}"/>`,
  ].join('\n')).join('\n');

  const towers = G.towers.map(([th, h, hot]) => {
    const sc = 1 + 0.08 * Math.sin(rad(th)); // nearer is a touch larger
    const [x, y] = P(R, th);
    const w = G.towerW * sc, hh = h * sc, d = w * 0.46, s = d * 0.52;
    const x0 = x - w / 2 - d / 4, yb = y + 0.35, top = yb - hh;
    const poly = (pts) => 'M' + pts.map(XY).join('L') + 'Z';
    const tone = hot ? 'hot' : 'warm';
    const out = [
      `<ellipse cx="${f(x + d / 4)}" cy="${f(yb - s / 2 + 0.2)}" rx="${f(w * 0.95)}" ry="${f(w * 0.32)}" fill="#000" fill-opacity=".45" filter="url(#soft)"/>`,
      `<path d="${poly([[x0, yb], [x0, top], [x0 + w, top], [x0 + w, yb]])}" fill="url(#face-${tone})"/>`,
      `<path d="${poly([[x0 + w, yb], [x0 + w, top], [x0 + w + d, top - s], [x0 + w + d, yb - s]])}" fill="url(#side-${tone})"/>`,
      `<path d="${poly([[x0, top], [x0 + d, top - s], [x0 + w + d, top - s], [x0 + w, top]])}" fill="${hot ? '#ffffff' : '#fff9ea'}"/>`,
    ];
    if (G.floors) {
      const lines = [];
      for (let yy = top + 1.35; yy < yb - 0.7; yy += 1.4) {
        lines.push(`M${XY([x0 + 0.4, yy])}H${f(x0 + w - 0.4)}M${XY([x0 + w + 0.25, yy - 0.1])}L${XY([x0 + w + d - 0.2, yy - s + 0.1])}`);
      }
      out.push(`<path d="${lines.join('')}" stroke="#6b4d17" stroke-opacity="${hot ? '.18' : '.26'}" stroke-width=".26"/>`);
    }
    out.push(`<path d="M${XY([x0 + w, top])}V${f(yb)}" stroke="#fffaf0" stroke-opacity=".55" stroke-width=".22"/>`);
    return {
      y, back: Math.sin(rad(th)) < 0, svg: `<g>\n${out.join('\n')}\n</g>`,
      glow: `<path d="${poly([[x0, yb], [x0, top - s], [x0 + w + d, top - s], [x0 + w + d, yb]])}"${hot ? ' fill="#fff0c4"' : ''}/>`,
    };
  }).sort((a, b) => a.y - b.y);

  const coreY = G.cy - G.lift, c = G.core;
  const pool = [
    `<ellipse cx="${G.cx}" cy="${G.cy}" rx="${G.pool}" ry="${f(G.pool * G.k)}" fill="url(#pool)"/>`,
    G.details ? `<g fill="none" stroke="#a8f0ff" stroke-opacity=".16" stroke-width=".26">\n<ellipse cx="${G.cx}" cy="${G.cy}" rx="${f(G.pool * 0.62)}" ry="${f(G.pool * 0.62 * G.k)}"/>\n<ellipse cx="${G.cx}" cy="${G.cy}" rx="${f(G.pool * 0.83)}" ry="${f(G.pool * 0.83 * G.k)}"/>\n</g>` : '',
    `<ellipse cx="${G.cx}" cy="${G.cy}" rx="${G.pool}" ry="${f(G.pool * G.k)}" fill="none" stroke="#66e0ff" stroke-width="${f(G.poolRimW * 2.6)}" stroke-opacity=".5" filter="url(#soft)"/>`,
    `<ellipse cx="${G.cx}" cy="${G.cy}" rx="${G.pool}" ry="${f(G.pool * G.k)}" fill="none" stroke="#7fe8ff" stroke-width="${G.poolRimW}"/>`,
  ].filter(Boolean).join('\n');
  const core = [
    `<ellipse cx="${G.cx}" cy="${f(G.cy + 0.5)}" rx="${f(c * 1.25)}" ry="${f(c * 0.34)}" fill="#bff4ff" fill-opacity=".55" filter="url(#soft)"/>`,
    `<circle cx="${G.cx}" cy="${f(coreY)}" r="${f(c * 2.1)}" fill="#66e0ff" fill-opacity=".5" filter="url(#bloom)"/>`,
    `<circle cx="${G.cx}" cy="${f(coreY)}" r="${c}" fill="url(#orb)"/>`,
    `<ellipse cx="${f(G.cx - c * 0.34)}" cy="${f(coreY - c * 0.4)}" rx="${f(c * 0.34)}" ry="${f(c * 0.2)}" fill="#fff" fill-opacity=".9" transform="rotate(-32 ${f(G.cx - c * 0.34)} ${f(coreY - c * 0.4)})"/>`,
  ].join('\n');

  const tail = P(R, T.from);
  const defs = [
    `<linearGradient id="deck" x1="0" y1="${f(G.cy - 14)}" x2="0" y2="${f(G.cy + 12)}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${G.deckTop}"/><stop offset=".55" stop-color="${G.deckMid}"/><stop offset="1" stop-color="#171c2c"/></linearGradient>`,
    `<linearGradient id="wall" x1="0" y1="${f(G.cy - 12)}" x2="0" y2="${f(G.cy + 14)}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#141827"/><stop offset="1" stop-color="#0a0d17"/></linearGradient>`,
    // The same cyan, violet and pink as the wordmark on the launch screen.
    `<linearGradient id="rim" x1="${f(G.cx - 16)}" y1="0" x2="${f(G.cx + 26)}" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#66e0ff"/><stop offset=".5" stop-color="#8f6bff"/><stop offset="1" stop-color="#ff5fa8"/></linearGradient>`,
    `<radialGradient id="fade" cx="${f(tail[0])}" cy="${f(tail[1])}" r="${G.fadeR}" gradientUnits="userSpaceOnUse"><stop offset=".1" stop-color="#000"/><stop offset="1" stop-color="#fff"/></radialGradient>`,
    `<mask id="tail" maskUnits="userSpaceOnUse" x="-8" y="-8" width="80" height="80"><rect x="-8" y="-8" width="80" height="80" fill="url(#fade)"/></mask>`,
    `<linearGradient id="face-warm" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff6de"/><stop offset=".6" stop-color="#f4d58a"/><stop offset="1" stop-color="#c79b45"/></linearGradient>`,
    `<linearGradient id="side-warm" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c9a257"/><stop offset="1" stop-color="#5c4318"/></linearGradient>`,
    `<linearGradient id="face-hot" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".6" stop-color="#fff0c4"/><stop offset="1" stop-color="#eac06a"/></linearGradient>`,
    `<linearGradient id="side-hot" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e6c47a"/><stop offset="1" stop-color="#735524"/></linearGradient>`,
    `<radialGradient id="pool" cx=".5" cy=".42" r=".6"><stop offset="0" stop-color="#9af0ff" stop-opacity=".55"/><stop offset=".55" stop-color="#2f86c2" stop-opacity=".38"/><stop offset="1" stop-color="#0b1f3d" stop-opacity=".7"/></radialGradient>`,
    `<radialGradient id="orb" cx=".38" cy=".32" r=".78"><stop offset="0" stop-color="#ffffff"/><stop offset=".35" stop-color="#dcfaff"/><stop offset=".75" stop-color="#6fdcff"/><stop offset="1" stop-color="#2aa0d8"/></radialGradient>`,
    `<filter id="soft" x="-20" y="-20" width="104" height="104" filterUnits="userSpaceOnUse"><feGaussianBlur stdDeviation=".7"/></filter>`,
    `<filter id="bloom" x="-20" y="-20" width="104" height="104" filterUnits="userSpaceOnUse"><feGaussianBlur stdDeviation="2.4"/></filter>`,
  ];

  const layers = [
    ['back of the terrace', `<g fill="none" mask="url(#tail)">\n${terrace(back, 'back')}\n</g>`],
    ['bloom off the towers', `<g fill="#ffcf70" opacity="${G.bloom}" filter="url(#bloom)">\n${towers.map((t) => t.glow).join('\n')}\n</g>`],
    ['towers behind the core', towers.filter((t) => t.back).map((t) => t.svg).join('\n')],
    ['pool', pool],
    ['core', core],
    ['front of the terrace', `<g fill="none" mask="url(#tail)">\n${terrace(front, 'front')}\n</g>`],
    ['towers in front of the core', towers.filter((t) => !t.back).map((t) => t.svg).join('\n')],
  ];
  return { defs, layers, G };
}

/* ──────────────────────────────────────────────────────────────── tile ── */

const STARS = [[9, 11, 0.35, 0.5], [17, 6.5, 0.25, 0.35], [46, 7, 0.3, 0.45], [56.5, 14, 0.25, 0.3], [6.5, 27, 0.25, 0.3], [58, 33, 0.3, 0.35], [38.5, 5, 0.22, 0.3], [12, 52, 0.22, 0.25]];

function tile(G, shape, sky) {
  const rx = shape === 'rounded' ? 14 : 0;
  // Where the core lands after fitting, so the light spills from it.
  const [s, tx, ty] = G.fit || [1, 0, 0];
  const lx = G.cx * s + tx, ly = (G.cy - 4) * s + ty, gx = G.cx * s + tx, gy = G.cy * s + ty;
  const defs = [
    `<linearGradient id="ground" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0c1326"/><stop offset="1" stop-color="#04060d"/></linearGradient>`,
    `<radialGradient id="spill" cx="${f(lx)}" cy="${f(ly)}" r="34" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#23467f" stop-opacity=".62"/><stop offset=".55" stop-color="#1a2f5c" stop-opacity=".22"/><stop offset="1" stop-color="#1a2f5c" stop-opacity="0"/></radialGradient>`,
    `<radialGradient id="vignette" cx=".5" cy=".5" r=".72"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".45"/></radialGradient>`,
    `<linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".35" stop-color="#fff" stop-opacity=".04"/><stop offset="1" stop-color="#fff" stop-opacity=".02"/></linearGradient>`,
    `<clipPath id="clip"><rect width="64" height="64" rx="${rx}"/></clipPath>`,
  ];
  const under = [
    `<rect width="64" height="64" rx="${rx}" fill="url(#ground)"/>`,
    `<g clip-path="url(#clip)">`,
    `<rect width="64" height="64" fill="url(#spill)"/>`,
    ...(sky ? [
      // Faint ground rings, as the 3D view draws under the structure.
      `<g fill="none" stroke="#8fb8ff" stroke-opacity=".07" stroke-width=".3">`,
      ...[34, 42, 51].map((r) => `<ellipse cx="${f(gx)}" cy="${f(gy)}" rx="${r}" ry="${f(r * G.k)}"/>`),
      `</g>`,
      `<g fill="#dbe8ff">`,
      ...STARS.map(([x, y, r, o]) => `<circle cx="${x}" cy="${y}" r="${r}" fill-opacity="${o}"/>`),
      `</g>`,
    ] : []),
    `</g>`,
  ];
  const over = [
    `<rect width="64" height="64" rx="${rx}" fill="url(#vignette)"/>`,
    rx ? `<rect x=".3" y=".3" width="63.4" height="63.4" rx="${rx - 0.3}" fill="none" stroke="url(#sheen)" stroke-width=".6"/>` : '',
  ].filter(Boolean);
  return { defs, under, over };
}

function svg({ viewBox, shape = null, sky = true, note = '', m }) {
  const t = shape ? tile(m.G, shape, sky) : { defs: [], under: [], over: [] };
  const ind = (s, n) => s.split('\n').map((l) => ' '.repeat(n) + l).join('\n');
  const fit = m.G.fit;
  const inner = m.layers.map(([label, s]) => `<!-- ${label} -->\n${s}`).join('\n');
  const body = fit ? ind(`<g transform="translate(${fit[1]} ${fit[2]}) scale(${fit[0]})">\n${ind(inner, 2)}\n</g>`, 2) : ind(inner, 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="RepoSense">
  <title>RepoSense</title>
  <!--
    RepoSense: a lit core in its pool, one terrace spiralling out of the pool,
    towers standing along the terrace. The brightest tower changed most
    recently. Painted far to near.${note}
  -->
  <defs>
${ind([...t.defs, ...m.defs].join('\n'), 4)}
  </defs>
${t.under.length ? ind(t.under.join('\n'), 2) + '\n' : ''}${body}
${t.over.length ? ind(t.over.join('\n'), 2) + '\n' : ''}</svg>
`;
}

/* ────────────────────────────────────────────────────────────── rasters ── */

/** An .ico holding PNGs, which every browser and Windows since Vista reads. */
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4); // colour planes
    head.writeUInt16LE(32, e + 6); // bits per pixel
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.data)]);
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error('playwright is not installed. Run: npm i -D playwright && npx playwright install chromium');
    process.exit(1);
  }

  const detailed = mark(DETAILED);
  const icon = svg({ viewBox: '0 0 64 64', shape: 'rounded', m: detailed });
  const favicon = svg({
    viewBox: '0 0 64 64', shape: 'rounded', sky: false, m: mark(BOLD),
    note: '\n\n    The favicon cut: fewer, wider towers and thicker light so it holds up\n    at 16 and 32 pixels. icon.svg is the detailed drawing.',
  });
  const square = svg({ viewBox: '0 0 64 64', shape: 'square', m: detailed });
  // Android crops maskable icons to as little as the central 80% circle, so
  // the mark shrinks by 15% about the tile's centre to stay inside it.
  const [s, tx, ty] = DETAILED.fit, k = 0.85, c = 32 * (1 - k);
  const maskable = svg({ viewBox: '0 0 64 64', shape: 'square', m: mark({ ...DETAILED, fit: [f(s * k), f(tx * k + c), f(ty * k + c)] }) });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();

    // logo.svg is cropped to what the bare mark paints, blurs excluded, with
    // room left around it for the bloom to fade out before the edge.
    const bare = mark({ ...DETAILED, fit: null });
    await page.setContent(svg({ viewBox: '0 0 64 64', m: bare }));
    const [x0, y0, x1, y1] = await page.evaluate(() => {
      let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
      for (const el of document.querySelectorAll('svg path, svg circle, svg ellipse')) {
        if (el.closest('defs') || el.closest('[filter]')) continue;
        const r = el.getBBox(), sw = parseFloat(el.getAttribute('stroke-width') || 0) / 2;
        a = Math.min(a, r.x - sw); b = Math.min(b, r.y - sw);
        c = Math.max(c, r.x + r.width + sw); d = Math.max(d, r.y + r.height + sw);
      }
      return [a, b, c, d];
    });
    const pad = 5;
    const crop = [x0 - pad, y0 - pad, x1 - x0 + pad * 2, y1 - y0 + pad * 2].map(f).join(' ');
    const logo = svg({ viewBox: crop, m: bare, note: '\n\n    Bare, for dark grounds. icon.svg carries its own tile and works anywhere.' });

    const raster = async (source, size) => {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${source}`);
      return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    };

    const out = {
      'icon.svg': icon,
      'logo.svg': logo,
      'favicon.svg': favicon,
      'favicon.ico': ico([{ size: 16, data: await raster(favicon, 16) }, { size: 32, data: await raster(favicon, 32) }]),
      'apple-touch-icon.png': await raster(square, 180),
      'icon-192.png': await raster(icon, 192),
      'icon-512.png': await raster(icon, 512),
      'icon-maskable-512.png': await raster(maskable, 512),
    };
    for (const [name, data] of Object.entries(out)) {
      await writeFile(join(PUBLIC, name), data);
      console.log(`public/${name}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
