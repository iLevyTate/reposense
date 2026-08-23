/**
 * Proves the embedded SVG actually animates in the context GitHub renders it:
 * as an <img>, with no script allowed.
 *
 * Note on method: rasterising the image onto a canvas with drawImage does NOT
 * work here. That re-renders the SVG document from scratch and reports its
 * static state, so an animating image measures as perfectly still. Only a real
 * screenshot captures the composited frame.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { renderSvg } from '../../src/svg.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const payload = JSON.parse(readFileSync(resolve(ROOT, 'public/demo.json'), 'utf8'));

let browser;

before(async () => {
  browser = await chromium.launch();
}, { timeout: 60000 });

after(async () => {
  await browser?.close();
});

/** Screenshots the SVG as an <img> at each offset, returning raw PNG buffers. */
async function framesOf(svg, offsets) {
  const uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const page = await browser.newPage({ viewport: { width: 900, height: 460 } });
  await page.setContent(`<body style="margin:0"><img id="v" src="${uri}" width="900"></body>`);
  await page.waitForFunction(() => {
    const i = document.getElementById('v');
    return i && i.complete && i.naturalWidth > 0;
  });

  const frames = [];
  let elapsed = 0;
  for (const t of offsets) {
    if (t > elapsed) await page.waitForTimeout(t - elapsed);
    elapsed = t;
    frames.push(await page.screenshot());
  }
  await page.close();
  return frames;
}

test('the animated SVG moves when rendered as an image', async () => {
  const svg = renderSvg(payload, { animate: true });
  // Ring stagger runs to ~2.5s and the build completes around 1.3s per ring,
  // so these offsets straddle a genuinely different part of the cycle.
  const [early, mid, settled] = await framesOf(svg, [120, 900, 4000]);

  assert.ok(!early.equals(mid), 'the frame at 120ms differs from the one at 900ms');
  assert.ok(!mid.equals(settled), 'the frame at 900ms differs from the settled one');
}, { timeout: 60000 });

test('the static SVG does not move', async () => {
  const svg = renderSvg(payload, { animate: false });
  const [a, b] = await framesOf(svg, [120, 2500]);
  assert.ok(a.equals(b), 'a non-animated render must be byte-identical over time');
}, { timeout: 60000 });

test('the animation settles on the fully built structure', async () => {
  // Whatever the motion does, a reader arriving mid-cycle must mostly see the
  // finished thing, and the settled frame must match the static render.
  const settled = (await framesOf(renderSvg(payload, { animate: true }), [5000]))[0];
  const stat = (await framesOf(renderSvg(payload, { animate: false }), [400]))[0];

  const lit = (png) => png.length; // compressed size tracks how much is drawn
  const delta = Math.abs(lit(settled) - lit(stat)) / lit(stat);
  assert.ok(delta < 0.05, `settled frame is within 5% of the static render (was ${(delta * 100).toFixed(1)}%)`);
}, { timeout: 60000 });

test('the animated SVG carries no script and honours reduced motion', () => {
  const svg = renderSvg(payload, { animate: true });
  // GitHub strips <script> from SVG; relying on it would silently do nothing.
  assert.ok(!/<script/i.test(svg));
  assert.ok(!/\son\w+=/i.test(svg), 'no inline event handlers');
  assert.match(svg, /@media \(prefers-reduced-motion:reduce\)/);
});
