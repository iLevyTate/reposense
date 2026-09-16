#!/usr/bin/env node
/**
 * Vertical promo recorder: the app as it looks in the hand, at 9:16, for a
 * social post.
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
reposense-promo: film the app at 9:16 for a social post

Usage
  node scripts/promo.mjs --data <reposense.json> [--out promo.mp4] [options]

Options
  --data <file>     a reposense.json to visualize            (required)
  --out <file>      .mp4 or .webm                     (default promo.mp4)
  --width <px>      output width                            (default 1080)
  --height <px>     output height                           (default 1920)
  --css-width <px>  phone width the site is laid out at      (default 405)
  --fps <n>         frames per second                         (default 30)
  --speed <n>       tour playback rate; 1.08 fits 54s into 50 (default 1.08)
  --start <n>       seconds of the tour to skip                (default 2.4)
  --cut <a-b,c-d>   film only these stretches of the tour, in seconds, and
                    hard cut between them; overrides --start
  --intro <n>       length of the launch screen beat            (default 2.2)
  --card-lead <n>   seconds of end card before the finish       (default 4.2)
  --repo <text>     what the intro types                (default: the data's)
  --url <text>      the end card's address    (default ilevytate.github.io/…)
  --no-intro        start on the tour
  --no-end-card     end on the tour
  --ffmpeg <path>   ffmpeg binary                          (default ffmpeg)
  --quiet           only print the output path
`;

function parseArgs(argv) {
  const o = {
    out: 'promo.mp4',
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

async function encode(ffmpeg, framePattern, out, fps) {
  const ext = extname(out).toLowerCase();
  await mkdir(dirname(resolve(out)), { recursive: true });
  if (ext === '.webm') {
    await run(ffmpeg, ['-y', '-framerate', String(fps), '-i', framePattern,
      '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-row-mt', '1', out]);
    return;
  }
  if (ext !== '.mp4') throw new Error(`Unsupported output "${ext}". Use .mp4 or .webm.`);
  // Every social platform re-encodes what it is given, so the upload is kept
  // close to lossless: a low CRF here costs a few MB and survives one more
  // generation of their compression.
  await run(ffmpeg, ['-y', '-framerate', String(fps), '-i', framePattern,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.1',
    '-movflags', '+faststart', '-an', out]);
}

const easeOut = (t) => 1 - (1 - t) ** 3;

/**
 * Beat one: the launch screen with a repository typed into it.
 *
 * The page is frozen (animations paused, the backdrop's loop stopped) and the
 * motion comes from a scripted push-in instead. Filming the live page here
 * would sample its ambient drift at whatever rate this machine screenshots,
 * which plays back as a stutter rather than as drift.
 */
async function filmIntro(page, url, { repo, fps, seconds, frame, log }) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#launch:not([hidden])');
  // Let the entrance animation land before freezing anything.
  await page.waitForTimeout(1200);

  await page.addStyleTag({
    content: `
      *, *::before, *::after { animation-play-state: paused !important; transition: none !important; }
      #launch { transform-origin: 50% 42%; will-change: transform; }
      #rs-tap {
        position: fixed; z-index: 99; border-radius: 50%; pointer-events: none;
        background: radial-gradient(circle, rgba(255,255,255,0.5), rgba(102,224,255,0.18) 55%, transparent 72%);
        transform: translate(-50%, -50%);
      }`,
  });
  await page.evaluate(() => {
    // The starfield drives itself with requestAnimationFrame, which a paused
    // animation-play-state does not touch. Taking the callback away stops the
    // loop after the frame already in flight.
    window.requestAnimationFrame = () => 0;
    const tap = document.createElement('div');
    tap.id = 'rs-tap';
    tap.style.opacity = '0';
    document.body.appendChild(tap);
    document.getElementById('repo-input').focus();
  });

  // Weights, not seconds: a Shorts cut wants the same three moments in half
  // the time, so the beat holds scale to whatever length is asked for.
  const weights = [
    { hold: 0.45, typed: 0 },
    ...Array.from({ length: repo.length }, (_, i) => ({ hold: 0.045, typed: i + 1 })),
    { hold: 0.55, typed: repo.length },
    { hold: 0.5, typed: repo.length, tap: true },
  ];
  const natural = weights.reduce((sum, b) => sum + b.hold, 0);
  const beats = weights.map((b) => ({ ...b, hold: (b.hold * seconds) / natural }));
  const total = beats.reduce((sum, b) => sum + Math.max(1, Math.round(b.hold * fps)), 0);

  let i = 0;
  for (const beat of beats) {
    const count = Math.max(1, Math.round(beat.hold * fps));
    for (let k = 0; k < count; k += 1) {
      const p = i / Math.max(1, total - 1);
      await page.evaluate(({ text, scale, tap }) => {
        const input = document.getElementById('repo-input');
        if (input.value !== text) input.value = text;
        document.getElementById('launch').style.transform = `scale(${scale})`;
        const el = document.getElementById('rs-tap');
        if (!tap) {
          el.style.opacity = '0';
          return;
        }
        const rect = document.getElementById('go-button').getBoundingClientRect();
        const size = 42 + 150 * tap.t;
        el.style.left = `${rect.left + rect.width / 2}px`;
        el.style.top = `${rect.top + rect.height / 2}px`;
        el.style.width = `${size}px`;
        el.style.height = `${size}px`;
        el.style.opacity = String(0.85 * (1 - tap.t));
        // The button's own pressed state, held for the length of the tap.
        document.getElementById('go-button').style.transform = tap.t < 0.5 ? 'scale(0.97)' : '';
      }, {
        text: repo.slice(0, beat.typed),
        scale: 1 + 0.045 * easeOut(p),
        tap: beat.tap ? { t: easeOut(k / Math.max(1, count - 1)) } : null,
      });
      await frame();
      i += 1;
    }
  }
  log(`  intro: ${total} frames`);
  return total;
}

/**
 * Beat two and three: the tour, with the HUD left on so the video is the app
 * and not only the scene, and the end card faded over the closing shot.
 */
async function filmTour(page, url, { fps, speed, start, cut, cardLead, endCard, urlText, frame, log }) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#viewer:not([hidden])', { timeout: 120000 });
  await page.waitForFunction(() => document.documentElement.dataset.recordReady === '1', { timeout: 120000 });
  await page.evaluate(() => window.__reposense.setChrome(true));

  if (endCard) {
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

  const duration = await page.evaluate(() => window.__reposense.duration);
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
      await page.evaluate((time) => window.__reposense.seek(time), t);
      if (endCard) {
        const p = Math.min(1, Math.max(0, (i - cardIn) / (0.9 * fps)));
        await page.evaluate((o) => {
          document.getElementById('rs-endcard').style.opacity = String(o);
        }, easeOut(p));
      }
      await frame();
      i += 1;
    }
  }
  return total;
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
    const page = await browser.newPage({
      viewport: { width: opts.cssWidth, height: cssHeight },
      deviceScaleFactor: opts.width / opts.cssWidth,
      reducedMotion: 'no-preference',
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    let n = 0;
    const frame = async () => {
      await page.screenshot({ path: join(frameDir, `f${String(n).padStart(6, '0')}.png`) });
      n += 1;
      if (!opts.quiet && n % 30 === 0) process.stderr.write(`\r  ${n} frames`);
    };

    log(`Filming ${opts.width}x${opts.height} from a ${opts.cssWidth}x${cssHeight} phone…`);
    if (opts.intro) {
      await filmIntro(page, `http://127.0.0.1:${port}/`, {
        repo: repoText,
        fps: opts.fps,
        seconds: opts.introSeconds,
        frame,
        log,
      });
    }
    await filmTour(page, `http://127.0.0.1:${port}/?record=1#/local`, {
      fps: opts.fps,
      speed: opts.speed,
      start: opts.start,
      cut: opts.cut,
      cardLead: opts.cardLead,
      endCard: opts.endCard,
      urlText,
      frame,
      log,
    });
    if (!opts.quiet) process.stderr.write('\n');
    if (errors.length) throw new Error(`The page failed: ${errors[0]}`);

    log('Encoding…');
    await encode(opts.ffmpeg, join(frameDir, 'f%06d.png'), resolve(opts.out), opts.fps);

    const size = (await stat(resolve(opts.out))).size;
    if (opts.quiet) console.log(resolve(opts.out));
    else log(`Wrote ${resolve(opts.out)} (${(size / 1024 / 1024).toFixed(1)} MB, ${(n / opts.fps).toFixed(1)}s)`);
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
