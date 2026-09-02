/**
 * The offline recording hook.
 *
 * Its contract is determinism: a frame asked for by timestamp must come back
 * identical however long the machine took to draw it. That is what lets a CI
 * runner managing a few frames a second still produce smooth 60fps video.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.RECORD_PORT) || 4321;
const BASE = `http://127.0.0.1:${PORT}/`;

let server;
let browser;
let page;

before(async () => {
  server = spawn(process.execPath, [join(ROOT, 'scripts', 'serve.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(BASE)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await page.goto(`${BASE}?record=1#/demo`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.recordReady === '1', { timeout: 120000 });
}, { timeout: 180000 });

after(async () => {
  await browser?.close();
  server?.kill();
});

// No frame yield between seek and capture: seek() draws synchronously, and
// yielding lets the DOM overlay settle by a variable amount, which measurably
// breaks the determinism this file exists to assert.
const seek = async (t) => {
  await page.evaluate((time) => window.__reposense.seek(time), t);
  return page.screenshot();
};

test('the hook is present only with ?record=1', async () => {
  assert.ok(await page.evaluate(() => typeof window.__reposense?.seek === 'function'));
  assert.ok((await page.evaluate(() => window.__reposense.duration)) > 10);

  const plain = await browser.newPage();
  await plain.goto(`${BASE}#/demo`, { waitUntil: 'domcontentloaded' });
  await plain.waitForSelector('#viewer:not([hidden])', { timeout: 60000 });
  assert.equal(await plain.evaluate(() => typeof window.__reposense), 'undefined');
  await plain.close();
});

test('seeking is deterministic', async () => {
  // The same timestamp twice must be pixel-identical, or exported video would
  // shimmer between frames that ought to match.
  await page.evaluate(() => window.__reposense.setChrome(false));
  const a = await seek(4);
  await seek(19);
  const b = await seek(4);
  assert.ok(a.equals(b), 'the same timestamp produced different pixels');
});

test('every shot seeks deterministically, however it was reached', async () => {
  // Regression: the constellation's fade was accumulated per update() call
  // instead of derived from the timestamp, so one moment of the People shot
  // rendered differently the second time it was asked for, and a frame's
  // content depended on which frame came before it. The check above only
  // samples the opening shots, where nothing is mid-transition, so it passed
  // throughout. One mark inside each shot covers every mode change.
  await page.evaluate(() => window.__reposense.setChrome(false));
  for (const t of [3, 10, 18, 25, 33, 42, 50]) {
    const first = await seek(t);
    const again = await seek(t);
    assert.ok(first.equals(again), `t=${t} changed when asked for twice running`);

    // The same moment, reached from the far end of the tour.
    await seek(t > 27 ? 3 : 50);
    const detoured = await seek(t);
    assert.ok(detoured.equals(first), `t=${t} changed when reached from another shot`);
  }
});

test('different timestamps render different frames', async () => {
  const early = await seek(2);
  const later = await seek(18);
  assert.ok(!early.equals(later), 'the camera did not move between shots');
});

test('the HUD can be hidden for a clean recording', async () => {
  await page.evaluate(() => window.__reposense.setChrome(false));
  await seek(6);
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('dock')).opacity), '0');

  await page.evaluate(() => window.__reposense.setChrome(true));
  await seek(6);
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('dock')).opacity), '1');
  await page.evaluate(() => window.__reposense.setChrome(false));
});

test('captions render rather than sitting at the start of their fade', async () => {
  // Regression: showCaption restarted its entrance animation on every seek, so
  // a frame captured straight afterwards always caught it at opacity 0 and no
  // caption ever appeared in a recording.
  await seek(12);
  const caption = await page.evaluate(() => {
    const el = document.getElementById('caption');
    return { hidden: el.hidden, opacity: getComputedStyle(el).opacity, text: el.textContent.trim() };
  });
  assert.equal(caption.hidden, false);
  assert.equal(caption.opacity, '1');
  assert.ok(caption.text.length > 0);
});

test('no transient toast can land in a frame', async () => {
  await seek(3);
  assert.ok(await page.evaluate(() => document.getElementById('toast').hidden));
});
