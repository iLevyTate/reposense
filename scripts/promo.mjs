#!/usr/bin/env node
/**
 * Promo recorder: the app as it looks in use, for a social post.
 *
 *   --layout tall  (default) the phone alone at 9:16, filling the frame.
 *   --layout wide  the desktop site in a browser window with the phone in
 *                  front of its right edge, at 16:9, for players and feeds
 *                  that show video wide.
 *
 * It films the real site at a phone viewport rather than cropping a desktop
 * capture, so the mobile layout is what ends up on screen: the compact dock,
 * the mode pills, the timeline row under the caption. The site is rendered at
 * a phone's CSS width and screenshotted at a device pixel ratio that lands the
 * frame exactly on the output size, which is why the text is sharp at 1080
 * wide instead of upscaled from 405.
 *
 * The cut is three beats:
 *   intro     the launch screen, a repository typed in, the button tapped
 *   tour      the cinematic tour with the phone HUD left visible
 *   end card  the URL over the closing pull-back
 *
 * Tour frames are asked for by timestamp through the same record hook the
 * offline recorder uses, so the motion is a smooth 30fps no matter how long
 * this machine took to draw each one. The intro holds a frozen page and moves
 * a slow push-in across it, which keeps the ambient starfield from stuttering
 * between shots that were seconds apart in real time.
 *
 * The wide layout films a desktop page and a phone page through the same
 * beats in lockstep: each character is typed on the same frame on both, and
 * every tour frame is the same timestamp under both cameras. The desktop gets
 * a mouse pointer where the phone gets a tap. Its end card is a still of its
 * own after a dip to black, because a lower third over the closing shot would
 * have to sit across two screens. Everything outside the screens is drawn in
 * a browser as PNGs with holes where the screens go and laid over the frames
 * in ffmpeg, so the corners of each recording are covered rather than clipped.
 *
 * Requires Chromium (via playwright) and ffmpeg with H.264.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `
reposense-promo: film the app for a social post

Usage
  node scripts/promo.mjs --data <reposense.json> [--out promo.mp4] [options]

Options
  --data <file>     a reposense.json to visualize            (required)
  --layout <name>   tall: the phone at 9:16; wide: the desktop page and
                    the phone side by side at 1920x1080  (default tall)
  --out <file>      .mp4 or .webm (wide: .mp4)
                    (default promo.mp4, or promo-wide.mp4 for wide)
  --width <px>      output width, tall only                 (default 1080)
  --height <px>     output height, tall only                (default 1920)
  --css-width <px>  phone width the site is laid out at,
                    tall only                                (default 405)
  --fps <n>         frames per second                         (default 30)
  --speed <n>       tour playback rate; 1.08 fits 54s into 50 (default 1.08)
  --start <n>       seconds of the tour to skip                (default 2.4)
  --cut <a-b,c-d>   film only these stretches of the tour, in seconds, and
                    hard cut between them; overrides --start
  --intro <n>       length of the launch screen beat            (default 2.2)
  --card-lead <n>   seconds of end card before the finish, tall (default 4.2)
  --repo <text>     what the intro types                (default: the data's)
  --url <text>      the end card's address    (default ilevytate.github.io/…)
  --no-intro        start on the tour
  --no-end-card     end on the tour
  --ffmpeg <path>   ffmpeg binary                          (default ffmpeg)
  --quiet           only print the output path
`;

function parseArgs(argv) {
  const o = {
    layout: 'tall',
    width: 1080,
    height: 1920,
    cssWidth: 405,
    fps: 30,
    speed: 1.08,
    start: 2.4,
    introSeconds: 2.2,
    cardLead: 4.2,
    intro: true,
    endCard: true,
    ffmpeg: 'ffmpeg',
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--data': o.data = argv[++i]; break;
      case '--layout': o.layout = argv[++i]; break;
      case '--out': o.out = argv[++i]; break;
      case '--width': o.width = Number(argv[++i]); break;
      case '--height': o.height = Number(argv[++i]); break;
      case '--css-width': o.cssWidth = Number(argv[++i]); break;
      case '--fps': o.fps = Number(argv[++i]); break;
      case '--speed': o.speed = Number(argv[++i]); break;
      case '--start': o.start = Number(argv[++i]); break;
      case '--cut': o.cut = parseCut(argv[++i]); break;
      case '--intro': o.introSeconds = Number(argv[++i]); break;
      case '--card-lead': o.cardLead = Number(argv[++i]); break;
      case '--repo': o.repo = argv[++i]; break;
      case '--url': o.url = argv[++i]; break;
      case '--no-intro': o.intro = false; break;
      case '--no-end-card': o.endCard = false; break;
      case '--ffmpeg': o.ffmpeg = argv[++i]; break;
      case '--quiet': o.quiet = true; break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`Unknown option: ${argv[i]}`);
    }
  }
  if (o.layout !== 'tall' && o.layout !== 'wide') {
    throw new Error(`Unknown --layout "${o.layout}". Use tall or wide.`);
  }
  o.out ??= o.layout === 'wide' ? 'promo-wide.mp4' : 'promo.mp4';
  return o;
}

/** "3-11,29-39" becomes [[3, 11], [29, 39]], in tour seconds. */
function parseCut(spec) {
  const out = (spec ?? '').split(',').filter(Boolean).map((part) => {
    const [a, b] = part.split('-').map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) {
      throw new Error(`Bad --cut segment "${part}". Write it as start-end in seconds.`);
    }
    return [a, b];
  });
  if (!out.length) throw new Error('--cut needs at least one start-end segment.');
  return out;
}

/*
 * Wide geometry, on a 1920x1080 canvas. Both screens are scaled by 0.9, so a
 * CSS pixel is the same size on each and the phone reads as the same page at a
 * narrower width rather than a zoomed one. The desktop HUD stops at x=1422 of
 * 1440. The phone's bezel covers the last 11 CSS pixels of that empty strip
 * and nothing of the app.
 */
const WIDE = { w: 1920, h: 1080 };
const DESKTOP = { width: 1440, height: 900 };
const HANDSET = { width: 393, height: 852 };
const WIN = { x: 128, y: 114, w: 1296, bar: 42, r: 14 };
const VIEWPORT = { x: WIN.x, y: WIN.y + WIN.bar, w: 1296, h: 810 };
const PHONE = { x: 1426, y: 157, w: 354, h: 767, bezel: 12, r: 34 };
// Seconds of end card, and of the dip to black before it.
const OUTRO = 5;
const DIP = 0.8;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** Serves the viewer plus the payload the recording is of. */
function serve(payloadJson) {
  const body = Buffer.from(payloadJson);
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/__data.json') {
      res.writeHead(200, { 'Content-Type': MIME['.json'] }).end(body);
      return;
    }
    const rel = path === '/' ? 'index.html' : decodeURIComponent(path).replace(/^\/+/, '');
    const target = resolve(ROOT, rel);
    if (target !== ROOT && !target.startsWith(ROOT + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const s = await stat(target);
      if (!s.isFile()) throw new Error('not a file');
      res.writeHead(200, { 'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream' });
      createReadStream(target).pipe(res);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((res) => {
    server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port }));
  });
}

function run(cmd, args) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', (e) =>
      rej(new Error(e.code === 'ENOENT' ? `${cmd} is not installed or not on PATH.` : e.message)),
    );
    child.on('close', (code) =>
      code === 0 ? res() : rej(new Error(`${cmd} exited with ${code}\n${err.trim().split('\n').slice(-6).join('\n')}`)),
    );
  });
}

// Every social platform re-encodes what it is given, so the upload is kept
// close to lossless: a low CRF here costs a few MB and survives one more
// generation of their compression.
const H264 = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
  '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.1',
  '-movflags', '+faststart', '-an'];

async function encode(ffmpeg, framePattern, out, fps) {
  const ext = extname(out).toLowerCase();
  await mkdir(dirname(resolve(out)), { recursive: true });
  if (ext === '.webm') {
    await run(ffmpeg, ['-y', '-framerate', String(fps), '-i', framePattern,
      '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-row-mt', '1', out]);
    return;
  }
  if (ext !== '.mp4') throw new Error(`Unsupported output "${ext}". Use .mp4 or .webm.`);
  await run(ffmpeg, ['-y', '-framerate', String(fps), '-i', framePattern, ...H264, out]);
}

const easeOut = (t) => 1 - (1 - t) ** 3;
const easeInOut = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * One frame of the launch screen. Runs in the page, so it carries everything
 * it needs in its arguments.
 */
function paintIntro({ kind, text, scale, tap, aim }) {
  const input = document.getElementById('repo-input');
  if (input.value !== text) input.value = text;
  // Typing keeps the caret in view. Setting the value does not, and a name
  // wider than the phone's field would lose its last characters instead of
  // its first.
  input.scrollLeft = input.scrollWidth;
  document.getElementById('launch').style.transform = `scale(${scale})`;
  const button = document.getElementById('go-button');
  const rect = button.getBoundingClientRect();

  if (kind === 'desktop') {
    // The mouse rests below and right of the field while the name is typed,
    // then glides onto the button and clicks it.
    const from = { x: rect.left + rect.width / 2 + 210, y: rect.bottom + 150 };
    const to = { x: rect.left + rect.width * 0.4, y: rect.top + rect.height * 0.62 };
    const x = from.x + (to.x - from.x) * aim;
    const y = from.y + (to.y - from.y) * aim;
    const down = tap && tap.t < 0.5;
    document.getElementById('rs-pointer').style.transform =
      `translate(${x - 1}px, ${y - 1}px) scale(${down ? 0.88 : 1})`;
    const ring = document.getElementById('rs-click');
    if (!tap) {
      ring.style.opacity = '0';
      return;
    }
    const size = 14 + 64 * tap.t;
    ring.style.left = `${x}px`;
    ring.style.top = `${y}px`;
    ring.style.width = `${size}px`;
    ring.style.height = `${size}px`;
    ring.style.opacity = String(0.8 * (1 - tap.t));
    button.style.transform = down ? 'scale(0.97)' : '';
    return;
  }

  const el = document.getElementById('rs-tap');
  if (!tap) {
    el.style.opacity = '0';
    return;
  }
  const size = 42 + 150 * tap.t;
  el.style.left = `${rect.left + rect.width / 2}px`;
  el.style.top = `${rect.top + rect.height / 2}px`;
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.style.opacity = String(0.85 * (1 - tap.t));
  // The button's own pressed state, held for the length of the tap.
  button.style.transform = tap.t < 0.5 ? 'scale(0.97)' : '';
}

/**
 * Beat one: the launch screen with a repository typed into it.
 *
 * The page is frozen (animations paused, the backdrop's loop stopped) and the
 * motion comes from a scripted push-in instead. Filming the live page here
 * would sample its ambient drift at whatever rate this machine screenshots,
 * which plays back as a stutter rather than as drift.
 */
async function filmIntro(screens, url, { repo, fps, seconds, shoot, log }) {
  await Promise.all(screens.map(async ({ page }) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#launch:not([hidden])');
  }));
  // Let the entrance animation land before freezing anything.
  await screens[0].page.waitForTimeout(1200);

  for (const { page, kind } of screens) {
    await page.addStyleTag({
      content: `
        *, *::before, *::after { animation-play-state: paused !important; transition: none !important; }
        #launch { transform-origin: 50% 42%; will-change: transform; }
        #rs-tap {
          position: fixed; z-index: 99; border-radius: 50%; pointer-events: none;
          background: radial-gradient(circle, rgba(255,255,255,0.5), rgba(102,224,255,0.18) 55%, transparent 72%);
          transform: translate(-50%, -50%);
        }
        #rs-pointer {
          position: fixed; left: 0; top: 0; z-index: 100; width: 20px; height: 28px; pointer-events: none;
          transform-origin: 1px 1px; filter: drop-shadow(0 2px 3px rgba(0,0,0,0.55));
        }
        #rs-click {
          position: fixed; z-index: 99; border-radius: 50%; pointer-events: none;
          border: 2px solid rgba(102,224,255,0.85); transform: translate(-50%, -50%);
        }`,
    });
    await page.evaluate((kind) => {
      // The starfield drives itself with requestAnimationFrame, which a paused
      // animation-play-state does not touch. Taking the callback away stops the
      // loop after the frame already in flight.
      window.requestAnimationFrame = () => 0;
      if (kind === 'desktop') {
        // A plain arrow, tip at (1, 1), not any one system's cursor.
        document.body.insertAdjacentHTML('beforeend', `
          <svg id="rs-pointer" viewBox="0 0 20 28" aria-hidden="true">
            <path d="M1 1v21.5l5.3-5.1 3.6 8.6 3.9-1.6-3.6-8.5H17.6Z"
              fill="#fff" stroke="#05070d" stroke-width="1.5" stroke-linejoin="round"/>
          </svg>
          <div id="rs-click" style="opacity: 0"></div>`);
      } else {
        const tap = document.createElement('div');
        tap.id = 'rs-tap';
        tap.style.opacity = '0';
        document.body.appendChild(tap);
      }
      document.getElementById('repo-input').focus();
    }, kind);
  }

  // Weights, not seconds: a Shorts cut wants the same three moments in half
  // the time, so the beat holds scale to whatever length is asked for. The
  // desktop's pointer travels during the pause before the tap.
  const weights = [
    { hold: 0.45, typed: 0 },
    ...Array.from({ length: repo.length }, (_, i) => ({ hold: 0.045, typed: i + 1 })),
    { hold: 0.55, typed: repo.length, aim: true },
    { hold: 0.5, typed: repo.length, tap: true },
  ];
  const natural = weights.reduce((sum, b) => sum + b.hold, 0);
  const beats = weights.map((b) => ({ ...b, hold: (b.hold * seconds) / natural }));
  const total = beats.reduce((sum, b) => sum + Math.max(1, Math.round(b.hold * fps)), 0);

  let i = 0;
  let aimed = 0;
  for (const beat of beats) {
    const count = Math.max(1, Math.round(beat.hold * fps));
    for (let k = 0; k < count; k += 1) {
      const p = i / Math.max(1, total - 1);
      const state = {
        text: repo.slice(0, beat.typed),
        scale: 1 + 0.045 * easeOut(p),
        tap: beat.tap ? { t: easeOut(k / Math.max(1, count - 1)) } : null,
        aim: beat.aim ? easeInOut(k / Math.max(1, count - 1)) : aimed,
      };
      await shoot(({ page, kind }) => page.evaluate(paintIntro, { ...state, kind }));
      i += 1;
    }
    if (beat.aim) aimed = 1;
  }
  log(`  intro: ${total} frames`);
  return total;
}

/**
 * Beat two and three: the tour, with the HUD left on so the video is the app
 * and not only the scene, and the end card faded over the closing shot when
 * there is one screen to fade it over.
 */
async function filmTour(screens, url, { fps, speed, start, cut, cardLead, endCard, urlText, shoot, log }) {
  await Promise.all(screens.map(async ({ page }) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#viewer:not([hidden])', { timeout: 120000 });
    await page.waitForFunction(() => document.documentElement.dataset.recordReady === '1', { timeout: 120000 });
    await page.evaluate(() => window.__reposense.setChrome(true));
  }));

  if (endCard) {
    for (const { page } of screens) {
      await page.evaluate((text) => {
        const card = document.createElement('div');
        card.id = 'rs-endcard';
        card.innerHTML = `
          <div class="rs-endcard-scrim"></div>
          <div class="rs-endcard-body">
            <h2>RepoSense</h2>
            <p>${text}</p>
          </div>`;
        const style = document.createElement('style');
        // A lower third rather than a centred card: the closing shot pulls back
        // until the structure is small, and covering it with a slab of text is
        // the one moment of the tour where the product disappears.
        style.textContent = `
          #rs-endcard { position: fixed; inset: 0; z-index: 60; opacity: 0; pointer-events: none; }
          #rs-endcard .rs-endcard-scrim { position: absolute; inset: 0; background: linear-gradient(to bottom, transparent 34%, rgba(4,6,13,0.5) 66%, rgba(4,6,13,0.88)); }
          #rs-endcard .rs-endcard-body {
            position: absolute; inset: auto 0 128px; display: grid; justify-items: center; text-align: center;
          }
          #rs-endcard h2 {
            margin: 0; font-size: 38px; font-weight: 700; letter-spacing: -0.035em;
            background: linear-gradient(96deg, #ffffff 12%, var(--accent) 48%, var(--accent-2) 78%, var(--accent-3));
            -webkit-background-clip: text; background-clip: text; color: transparent;
          }
          #rs-endcard p { margin: 8px 0 0; font-family: var(--mono); font-size: 13px; color: var(--text-dim); letter-spacing: 0.02em; }`;
        document.head.appendChild(style);
        document.body.appendChild(card);
      }, urlText);
    }
  }

  const duration = await screens[0].page.evaluate(() => window.__reposense.duration);
  // The tour opens a long way out, which reads as a distant speck on a phone
  // and wastes the seconds that decide whether anyone keeps watching. Skipping
  // into the approach starts the cut on a structure already worth looking at,
  // with the rest of the push-in still to come.
  const segments = (cut ?? [[start, duration]])
    .map(([a, b]) => [Math.max(0, a), Math.min(duration, b)])
    .filter(([a, b]) => b > a);
  const counts = segments.map(([a, b]) => Math.max(1, Math.round(((b - a) / speed) * fps)));
  const total = counts.reduce((sum, n) => sum + n, 0);
  // The card rides the closing pull-back, which is the only shot with no
  // caption of its own to collide with.
  const cardIn = total - Math.round(cardLead * fps);
  log(`  tour: ${total} frames (${(total / fps).toFixed(1)}s at ${speed}x, ${segments.length} segment${segments.length > 1 ? 's' : ''})`);

  let i = 0;
  for (const [index, [from]] of segments.entries()) {
    for (let k = 0; k < counts[index]; k += 1) {
      const t = from + (k / fps) * speed;
      const opacity = endCard ? easeOut(Math.min(1, Math.max(0, (i - cardIn) / (0.9 * fps)))) : null;
      await shoot(async ({ page }) => {
        await page.evaluate((time) => window.__reposense.seek(time), t);
        if (opacity !== null) {
          await page.evaluate((o) => {
            document.getElementById('rs-endcard').style.opacity = String(o);
          }, opacity);
        }
      });
      i += 1;
    }
  }
  return total;
}

/* ═══════════════════════════════════════════════════════ the wide frame ══ */

/**
 * A rounded rectangle as an SVG subpath. `top: false` leaves the top two
 * corners square, for a window's content under its title bar.
 */
function roundRect({ x, y, w, h }, r, top = true) {
  const t = top ? r : 0;
  return (
    `M${x + t} ${y}h${w - t - r}` +
    (top ? `a${r} ${r} 0 0 1 ${r} ${r}` : `h${r}`) +
    `v${h - t - r}a${r} ${r} 0 0 1 -${r} ${r}h-${w - 2 * r}a${r} ${r} 0 0 1 -${r} -${r}` +
    `v-${h - t - r}` +
    (top ? `a${r} ${r} 0 0 1 ${r} -${r}` : `h${t}`) +
    'z'
  );
}

/** A CSS mask image, opaque across the canvas except for the holes given. */
function holes(path) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDE.w}" height="${WIDE.h}">` +
    `<path fill="#fff" fill-rule="evenodd" d="M0 0H${WIDE.w}V${WIDE.h}H0Z${path}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** mulberry32: the ground's stars land in the same places on every render. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function starfield(count) {
  const rand = prng(0x5eed);
  const dots = [];
  for (let i = 0; i < count; i += 1) {
    const x = Math.round(rand() * WIDE.w);
    const y = Math.round(rand() * WIDE.h);
    const spread = rand() < 0.18 ? 0.6 : 0;
    dots.push(`${x}px ${y}px 0 ${spread}px rgba(220,230,245,${(0.1 + rand() * 0.4).toFixed(2)})`);
  }
  return `<i class="stars" style="box-shadow:${dots.join(',')}"></i>`;
}

/** The ground every still shares: the launch screen's night, a little lifted. */
function sheet(css, body) {
  return `<!doctype html><meta charset="utf-8"><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: ${WIDE.w}px; height: ${WIDE.h}px; background: transparent; }
    body {
      font-family: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: #dce6f5; -webkit-font-smoothing: antialiased;
    }
    .mono { font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace; }
    .ground {
      position: absolute; inset: 0; overflow: hidden;
      background:
        radial-gradient(60% 50% at 50% 46%, rgba(102,224,255,.09), rgba(102,224,255,0) 70%),
        radial-gradient(46% 46% at 4% 100%, rgba(143,107,255,.13), rgba(143,107,255,0) 72%),
        radial-gradient(40% 42% at 97% 98%, rgba(255,95,168,.08), rgba(255,95,168,0) 72%),
        radial-gradient(120% 90% at 50% 45%, #0a1020 0%, #070b16 48%, #03050a 100%);
    }
    .stars { position: absolute; left: 0; top: 0; width: 1px; height: 1px; border-radius: 50%; }
    ${css}
  </style>${body}`;
}

/**
 * Back layer: the ground and a browser window, with a hole where the desktop
 * recording shows through. Generic chrome, not any real browser's: three dots
 * and an address pill.
 */
function backHtml(address) {
  const slash = address.indexOf('/');
  const host = slash < 0 ? address : address.slice(0, slash);
  const rest = slash < 0 ? '' : address.slice(slash);
  return sheet(`
    .cut { position: absolute; inset: 0; -webkit-mask-image: ${holes(roundRect(VIEWPORT, WIN.r, false))}; }
    .window {
      position: absolute; left: ${WIN.x}px; top: ${WIN.y}px;
      width: ${WIN.w}px; height: ${WIN.bar + VIEWPORT.h}px; border-radius: ${WIN.r}px;
      background: #04060d;
      box-shadow:
        0 0 0 1px rgba(140,190,255,.14),
        0 40px 110px -30px rgba(0,0,0,.9),
        0 0 220px -40px rgba(102,224,255,.22);
    }
    .bar {
      position: absolute; left: 0; right: 0; top: 0; height: ${WIN.bar}px;
      border-radius: ${WIN.r}px ${WIN.r}px 0 0;
      background: linear-gradient(180deg, #161d2c, #0e1420);
      border-bottom: 1px solid rgba(0,0,0,.7);
    }
    .dots { position: absolute; left: 18px; top: 15px; display: flex; gap: 8px; }
    .dots i { width: 12px; height: 12px; border-radius: 50%; background: #2b3447; }
    .address {
      position: absolute; left: 50%; top: 8px; transform: translateX(-50%);
      min-width: 520px; height: 26px; padding: 0 22px; border-radius: 13px;
      background: #070b14; border: 1px solid rgba(140,190,255,.10);
      font-size: 13px; line-height: 24px; text-align: center; letter-spacing: .01em;
      color: #dce6f5; white-space: nowrap;
    }
    .address span { color: #8697b0; }`, `
    <div class="cut">
      <div class="ground">${starfield(140)}</div>
      <div class="window">
        <div class="bar">
          <div class="dots"><i></i><i></i><i></i></div>
          <div class="address mono"><span>${host}</span>${rest}</div>
        </div>
      </div>
    </div>`);
}

/**
 * Front layer: the phone alone on a transparent sheet, with a hole for its
 * screen. The shadow belongs to this layer, so it falls across the browser
 * window as well as the ground. No notch: the site sits flush to the top of
 * the viewport, and an island there would cover the repository's name.
 */
function phoneHtml() {
  const b = {
    x: PHONE.x - PHONE.bezel,
    y: PHONE.y - PHONE.bezel,
    w: PHONE.w + PHONE.bezel * 2,
    h: PHONE.h + PHONE.bezel * 2,
  };
  return sheet(`
    .cut { position: absolute; inset: 0; -webkit-mask-image: ${holes(roundRect(PHONE, PHONE.r))}; }
    .body {
      position: absolute; left: ${b.x}px; top: ${b.y}px; width: ${b.w}px; height: ${b.h}px;
      border-radius: ${PHONE.r + PHONE.bezel}px;
      background: linear-gradient(148deg, #5d6678 0%, #262d3b 16%, #0d111a 46%, #0a0e16 72%, #454e60 100%);
      box-shadow:
        0 0 0 1px rgba(140,190,255,.14),
        -18px 30px 70px -10px rgba(0,0,0,.85),
        0 0 120px -20px rgba(102,224,255,.20);
    }
    /* Glass edge: a bright hairline just inside the bezel, dark just outside. */
    .rim {
      position: absolute;
      left: ${PHONE.x - 1.5}px; top: ${PHONE.y - 1.5}px;
      width: ${PHONE.w + 3}px; height: ${PHONE.h + 3}px;
      border-radius: ${PHONE.r + 1.5}px;
      box-shadow: inset 0 0 0 1px rgba(0,0,0,.85), inset 0 0 0 2px rgba(220,230,245,.14);
    }`, `
    <div class="cut"><div class="body"></div></div>
    <div class="rim"></div>`);
}

/** The end card: the mark, the name in the launch screen's gradient, and how to get it. */
function cardHtml(logo, urlText) {
  return sheet(`
    .wrap {
      position: absolute; inset: 0; display: flex; flex-direction: column;
      align-items: center; justify-content: center; text-align: center;
    }
    .mark { width: 210px; height: 186px; }
    h1 {
      margin-top: 18px; font-size: 128px; font-weight: 700; letter-spacing: -.035em; line-height: 1;
      background: linear-gradient(96deg, #ffffff 12%, #66e0ff 48%, #8f6bff 78%, #ff5fa8);
      -webkit-background-clip: text; background-clip: text; color: transparent;
      padding-bottom: .08em;
    }
    .tag { margin-top: 22px; font-size: 36px; color: #8697b0; letter-spacing: .01em; }
    .cmd {
      margin-top: 44px; padding: 20px 36px; border-radius: 14px; font-size: 30px; color: #66e0ff;
      background: rgba(9,14,26,.72); border: 1px solid rgba(120,160,220,.16);
    }
    .url { margin-top: 26px; font-size: 26px; color: #dce6f5; letter-spacing: .02em; }`, `
    <div class="ground">${starfield(140)}</div>
    <div class="wrap">
      ${logo}
      <h1>RepoSense</h1>
      <p class="tag">Every file becomes a tower. Every folder becomes a terrace.</p>
      <div class="cmd mono">npx github:iLevyTate/reposense</div>
      <div class="url mono">${urlText}</div>
    </div>`);
}

/** Draws the wide layout's stills in the browser that filmed the screens. */
async function drawWide(browser, dir, { repo, urlText }) {
  await mkdir(dir, { recursive: true });
  const page = await browser.newPage({ viewport: { width: WIDE.w, height: WIDE.h }, deviceScaleFactor: 1 });
  const logo = (await readFile(join(ROOT, 'public', 'logo.svg'), 'utf8')).replace('<svg ', '<svg class="mark" ');
  const files = {
    launch: join(dir, 'back-launch.png'),
    tour: join(dir, 'back-tour.png'),
    phone: join(dir, 'phone.png'),
    card: join(dir, 'card.png'),
  };
  const draw = async (html, path, transparent) => {
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path, omitBackground: transparent });
  };
  // The address follows the click: the launch page first, then the route the
  // Visualize button sets.
  await draw(backHtml(urlText), files.launch, true);
  await draw(backHtml(`${urlText}/#/${repo}`), files.tour, true);
  await draw(phoneHtml(), files.phone, true);
  await draw(cardHtml(logo, urlText), files.card, false);
  await page.close();
  return files;
}

/** One ffmpeg pass: both screens scaled into their holes, the stills over them. */
async function composeWide(ffmpeg, { desk, phone, stills, out, fps, frames, introFrames, endCard }) {
  if (extname(out).toLowerCase() !== '.mp4') throw new Error('The wide layout writes .mp4 only.');
  await mkdir(dirname(resolve(out)), { recursive: true });
  const seconds = frames / fps;
  const still = (file, length) => ['-loop', '1', '-framerate', String(fps), '-t', String(length), '-i', file];
  // Halfway between the last intro frame and the first tour frame.
  const click = ((introFrames - 0.5) / fps).toFixed(4);
  const filter = [
    `[0:v]scale=${VIEWPORT.w}:${VIEWPORT.h}:flags=lanczos,setsar=1,` +
      `pad=${WIDE.w}:${WIDE.h}:${VIEWPORT.x}:${VIEWPORT.y}:color=0x04060d[desk]`,
    '[2:v]format=rgba[launch]',
    '[3:v]format=rgba[tour]',
    `[desk][launch]overlay=0:0:format=auto:enable='lt(t,${click})'[early]`,
    `[early][tour]overlay=0:0:format=auto:enable='gte(t,${click})'[room]`,
    `[1:v]scale=${PHONE.w}:${PHONE.h}:flags=lanczos,setsar=1[screen]`,
    `[room][screen]overlay=${PHONE.x}:${PHONE.y}[held]`,
    '[4:v]format=rgba[body]',
    `[held][body]overlay=0:0:format=auto,format=yuv420p,setsar=1` +
      (endCard ? `,fade=t=out:st=${(seconds - DIP).toFixed(3)}:d=${DIP}[main]` : '[v]'),
    ...(endCard
      ? [`[5:v]format=yuv420p,setsar=1,fade=t=in:st=0:d=${DIP}[card]`, '[main][card]concat=n=2:v=1:a=0[v]']
      : []),
  ].join(';');
  await run(ffmpeg, [
    '-y',
    '-framerate', String(fps), '-i', join(desk, 'f%06d.png'),
    '-framerate', String(fps), '-i', join(phone, 'f%06d.png'),
    ...still(stills.launch, seconds),
    ...still(stills.tour, seconds),
    ...still(stills.phone, seconds),
    ...(endCard ? still(stills.card, OUTRO) : []),
    '-filter_complex', filter,
    '-map', '[v]',
    ...H264,
    out,
  ]);
  return seconds + (endCard ? OUTRO : 0);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (opts.help) {
    console.log(HELP);
    return;
  }
  if (!opts.data) {
    console.error('--data is required. See --help.');
    process.exit(1);
  }

  const log = (m) => {
    if (!opts.quiet) process.stderr.write(`${m}\n`);
  };

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error('playwright is not installed. Run: npm i -D playwright && npx playwright install chromium');
    process.exit(1);
  }

  const wide = opts.layout === 'wide';
  const payload = await readFile(resolve(opts.data), 'utf8');
  const data = JSON.parse(payload);
  const repoText = opts.repo ?? [data.repo?.owner, data.repo?.name].filter(Boolean).join('/') ?? 'owner/repository';
  const urlText = opts.url ?? 'ilevytate.github.io/reposense';

  const { server, port } = await serve(payload);
  const frameDir = await mkdtemp(join(tmpdir(), 'reposense-promo-'));
  const browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars'],
  });

  try {
    const cssHeight = Math.round((opts.cssWidth * opts.height) / opts.width);
    const cameras = wide
      ? [
        { kind: 'desktop', viewport: DESKTOP, scale: 1 },
        { kind: 'phone', viewport: HANDSET, scale: 1 },
      ]
      : [{ kind: 'phone', viewport: { width: opts.cssWidth, height: cssHeight }, scale: opts.width / opts.cssWidth }];
    const errors = [];
    const screens = [];
    for (const camera of cameras) {
      const page = await browser.newPage({
        viewport: camera.viewport,
        deviceScaleFactor: camera.scale,
        reducedMotion: 'no-preference',
      });
      page.on('pageerror', (e) => errors.push(e.message));
      const dir = wide ? join(frameDir, camera.kind) : frameDir;
      await mkdir(dir, { recursive: true });
      screens.push({ page, kind: camera.kind, dir });
    }

    // Each screen runs its own prepare-then-screenshot with nothing between
    // the two, as the single-screen recorder always has. The screens run side
    // by side, and every one of them writes the same frame number.
    let n = 0;
    const shoot = async (prepare) => {
      const name = `f${String(n).padStart(6, '0')}.png`;
      await Promise.all(screens.map(async (screen) => {
        await prepare(screen);
        await screen.page.screenshot({ path: join(screen.dir, name) });
      }));
      n += 1;
      if (!opts.quiet && n % 30 === 0) process.stderr.write(`\r  ${n} frames`);
    };

    log(wide
      ? `Filming ${WIDE.w}x${WIDE.h} from a ${DESKTOP.width}x${DESKTOP.height} desktop and a ${HANDSET.width}x${HANDSET.height} phone…`
      : `Filming ${opts.width}x${opts.height} from a ${opts.cssWidth}x${cssHeight} phone…`);
    let introFrames = 0;
    if (opts.intro) {
      introFrames = await filmIntro(screens, `http://127.0.0.1:${port}/`, {
        repo: repoText,
        fps: opts.fps,
        seconds: opts.introSeconds,
        shoot,
        log,
      });
    }
    await filmTour(screens, `http://127.0.0.1:${port}/?record=1#/local`, {
      fps: opts.fps,
      speed: opts.speed,
      start: opts.start,
      cut: opts.cut,
      cardLead: opts.cardLead,
      endCard: opts.endCard && !wide,
      urlText,
      shoot,
      log,
    });
    if (!opts.quiet) process.stderr.write('\n');
    if (errors.length) throw new Error(`The page failed: ${errors[0]}`);

    let seconds = n / opts.fps;
    if (wide) {
      log('Drawing the frame…');
      const stills = await drawWide(browser, join(frameDir, 'stills'), { repo: repoText, urlText });
      log('Compositing…');
      seconds = await composeWide(opts.ffmpeg, {
        desk: screens[0].dir,
        phone: screens[1].dir,
        stills,
        out: resolve(opts.out),
        fps: opts.fps,
        frames: n,
        introFrames,
        endCard: opts.endCard,
      });
    } else {
      log('Encoding…');
      await encode(opts.ffmpeg, join(frameDir, 'f%06d.png'), resolve(opts.out), opts.fps);
    }

    const size = (await stat(resolve(opts.out))).size;
    if (opts.quiet) console.log(resolve(opts.out));
    else log(`Wrote ${resolve(opts.out)} (${(size / 1024 / 1024).toFixed(1)} MB, ${seconds.toFixed(1)}s)`);
  } finally {
    await browser.close();
    server.close();
    await rm(frameDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`\nreposense-promo: ${err.message}`);
  process.exit(1);
});
