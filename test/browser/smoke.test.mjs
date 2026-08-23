/**
 * Browser smoke test.
 *
 * Every defect found while building RepoSense was a runtime one: a renderer
 * that drew nothing, a HUD stuck at opacity 0, a handler wired to the wrong
 * argument. None of it is reachable without actually running the page, so this
 * boots the real static site in Chromium and drives it.
 *
 * Kept out of `npm test` because it needs a browser download; CI runs it as a
 * separate step.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.SMOKE_PORT) || 4319;
const BASE = `http://127.0.0.1:${PORT}/`;

let server;
let browser;
let page;
const jsErrors = [];
const failedRequests = [];

before(async () => {
  server = spawn(process.execPath, [join(ROOT, 'scripts', 'serve.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });

  // Wait for the server rather than sleeping a fixed amount.
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(BASE);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => jsErrors.push(String(e.message)));
  page.on('console', (m) => {
    // github.com is unreachable from CI; that is the environment, not the page.
    if (m.type() === 'error' && !/api\.github\.com|ERR_/.test(m.text())) jsErrors.push(m.text());
  });
  page.on('requestfailed', (r) => {
    if (!/api\.github\.com/.test(r.url())) failedRequests.push(`${r.url()} ${r.failure()?.errorText}`);
  });
}, { timeout: 120000 });

after(async () => {
  // Always leave the last frame on disk. CI uploads it when the job fails,
  // which is the difference between "a test failed" and seeing what the page
  // actually looked like.
  try {
    await page?.screenshot({ path: join(dirname(fileURLToPath(import.meta.url)), 'last-state.png') });
  } catch {
    /* the page may already be gone; the screenshot is a convenience */
  }
  await browser?.close();
  server?.kill();
});

test('the launch screen renders', async () => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#repo-input', { timeout: 20000 });
  assert.match(await page.title(), /RepoSense/);
});

test('the demo route builds a structure and draws it', async () => {
  await page.goto(`${BASE}#/demo`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#viewer:not([hidden])', { timeout: 60000 });

  // Wait for the reveal to finish rather than assuming a frame budget.
  await page.waitForFunction(
    () => {
      const c = document.querySelector('.rs-canvas');
      if (!c) return false;
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return false;
      const w = c.width;
      const h = c.height;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let lit = 0;
      for (let i = 0; i < px.length; i += 4 * 97) {
        if (px[i] + px[i + 1] + px[i + 2] > 120) lit += 1;
      }
      // Regression: the reveal integrated a capped frame delta, so on a slow
      // renderer the structure stayed invisible for a very long time.
      return lit > 200;
    },
    { timeout: 90000, polling: 500 },
  );

  assert.ok(await page.locator('.rs-label').count() > 0, 'directory labels are placed');
  assert.match(await page.locator('#repo-stats').innerText(), /FILES/i);
});

test('hovering a tower opens the inspector', async () => {
  let hit = null;
  outer: for (let y = 240; y <= 840; y += 40) {
    for (let x = 300; x <= 1380; x += 40) {
      await page.mouse.move(x, y);
      await page.waitForTimeout(50);
      if (await page.isVisible('#tooltip')) {
        hit = [x, y];
        break outer;
      }
    }
  }
  assert.ok(hit, 'some tower is pickable at the default framing');
  assert.match(await page.locator('#inspector').innerText(), /SIZE/i);
});

test('search filters and lists matches', async () => {
  await page.fill('#search-input', 'scene');
  // The search is debounced and the render loop shares the main thread with a
  // software rasteriser here, so wait for the result, not a fixed delay.
  await page.waitForFunction(
    () => document.querySelectorAll('#hitlist button').length > 0,
    { timeout: 15000 },
  );
  assert.ok(await page.locator('#hitlist button').count() > 0);
  await page.fill('#search-input', '');
  await page.waitForFunction(
    () => document.querySelectorAll('#hitlist button').length === 0,
    { timeout: 15000 },
  );
});

test('every enabled mode activates', async () => {
  for (const mode of ['chronology', 'constellation', 'arcology']) {
    const btn = page.locator(`[data-mode="${mode}"]`);
    if (await btn.isDisabled()) continue;
    await btn.click();
    await page.waitForTimeout(700);
    assert.ok(await btn.evaluate((el) => el.classList.contains('is-active')), `${mode} activates`);
  }
});

test('chronology says what its bars measure and how much history it has', async () => {
  await page.click('[data-mode="chronology"]');
  await page.waitForTimeout(400);
  assert.ok(await page.isVisible('#timeline'), 'the timeline dock appears');
  assert.ok(await page.locator('#time-spark rect').count() > 0, 'the activity strip has bars');
  // A chart whose measure has to be guessed is not explained: the label must
  // name the unit and the coverage, so a partial replay can never pass itself
  // off as the full log.
  const measure = await page.locator('#time-measure').innerText();
  assert.match(measure, /per period/, 'the measure is named');
  assert.match(measure, /full git log|newest [\d,]+ commits/, 'the coverage is named');
  await page.click('[data-mode="arcology"]');
  await page.waitForTimeout(300);
});

test('the tour hides the HUD and always gives it back', async () => {
  await page.click('#tour-button');
  await page.waitForTimeout(1500);
  assert.ok(await page.evaluate(() => document.getElementById('viewer').classList.contains('is-cinema')));

  // Regression: flying the camera mid-tour skipped the tour's teardown and left
  // the HUD at opacity 0 with pointer-events none, permanently unusable.
  await page.keyboard.press('0');
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(() => document.getElementById('viewer').classList.contains('is-cinema')), false);
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('dock')).opacity), '1');
});

test('returning to the launch screen leaves it alive', async () => {
  await page.click('#back-button');
  await page.waitForSelector('#repo-input', { timeout: 15000 });
  // Regression: the starfield's animation loop was cancelled for good on the
  // first visualize, leaving a frozen canvas that blanked on the next resize.
  const animating = await page.evaluate(
    () =>
      new Promise((res) => {
        const c = document.getElementById('launch-canvas');
        const ctx = c.getContext('2d');
        const grab = () =>
          ctx.getImageData(0, 0, Math.min(c.width, 300), Math.min(c.height, 300)).data.join(',');
        const first = grab();
        setTimeout(() => res(grab() !== first), 1500);
      }),
  );
  assert.ok(animating, 'the launch backdrop is still animating');
});

test('a phone-sized viewport gets a usable viewer', async () => {
  const phone = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const phoneErrors = [];
  phone.on('pageerror', (e) => phoneErrors.push(String(e.message)));
  try {
    await phone.goto(`${BASE}#/demo`, { waitUntil: 'domcontentloaded' });
    // A software rasteriser on a saturated runner can take a minute and a
    // half just to first paint at phone size; the budget reflects that.
    await phone.waitForSelector('#viewer:not([hidden])', { timeout: 150000 });
    await phone.waitForTimeout(1500);

    // The page must not scroll sideways; a horizontal overflow on a phone
    // means some fixed-width element is wider than the screen.
    assert.ok(
      await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'no horizontal overflow',
    );

    // The dock (modes + tools) must be on screen and inside the viewport.
    const dock = await phone.locator('#dock').boundingBox();
    assert.ok(dock, 'the dock renders');
    assert.ok(dock.x >= 0 && dock.x + dock.width <= 390.5, 'the dock fits the width');

    // Chronology stays usable: the strip stretches instead of collapsing.
    await phone.click('[data-mode="chronology"]');
    await phone.waitForTimeout(400);
    const track = await phone.locator('#time-track').boundingBox();
    assert.ok(track && track.width > 100, 'the activity strip has room to scrub');

    assert.deepEqual(phoneErrors, [], 'no JavaScript errors on the phone viewport');
  } finally {
    await phone.close();
  }
});

test('nothing threw and no asset failed to load', () => {
  assert.deepEqual(jsErrors, [], 'no JavaScript errors');
  assert.deepEqual(failedRequests, [], 'no failed requests');
});
