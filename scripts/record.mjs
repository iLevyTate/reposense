#!/usr/bin/env node
/**
 * Offline recorder — renders the cinematic tour to a GIF, MP4 or WebM.
 *
 * Frames are asked for by timestamp rather than captured in real time. That is
 * the whole trick: a CI runner falls back to software rasterisation and manages
 * a few frames a second, but because each frame is requested at an exact point
 * in the tour, the encoded result is smooth 60fps regardless of how long the
 * machine took to draw it.
 *
 * Requires Chromium (via playwright) and ffmpeg. Both are opt-in; the SVG path
 * needs neither.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `
reposense-record — render the tour to a video or GIF

Usage
  node scripts/record.mjs --data <reposense.json> --out <file> [options]

Options
  --data <file>     a reposense.json to visualize            (required)
  --out <file>      .gif, .mp4 or .webm                      (required)
  --width <px>      frame width                           (default 1280)
  --height <px>     frame height                           (default 720)
  --fps <n>         frames per second                        (default 30)
  --seconds <n>     length; defaults to the tour's own length
  --start <n>       seconds into the tour to begin             (default 0)
  --chrome          keep the HUD visible (default: scene only)
  --quiet           only print the output path
`;

function parseArgs(argv) {
  const o = { width: 1280, height: 720, fps: 30, start: 0, chrome: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--data': o.data = argv[++i]; break;
      case '--out': o.out = argv[++i]; break;
      case '--width': o.width = Number(argv[++i]); break;
      case '--height': o.height = Number(argv[++i]); break;
      case '--fps': o.fps = Number(argv[++i]); break;
      case '--seconds': o.seconds = Number(argv[++i]); break;
      case '--start': o.start = Number(argv[++i]); break;
      case '--chrome': o.chrome = true; break;
      case '--quiet': o.quiet = true; break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`Unknown option: ${argv[i]}`);
    }
  }
  return o;
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

/**
 * GIF gets a generated palette; the default 216-colour web palette turns a dark
 * gradient backdrop into visible banding.
 */
async function encode(framePattern, out, fps) {
  const ext = extname(out).toLowerCase();
  await mkdir(dirname(resolve(out)), { recursive: true });

  if (ext === '.gif') {
    const palette = join(dirname(framePattern), 'palette.png');
    await run('ffmpeg', ['-y', '-framerate', String(fps), '-i', framePattern,
      '-vf', 'palettegen=stats_mode=diff', palette]);
    await run('ffmpeg', ['-y', '-framerate', String(fps), '-i', framePattern, '-i', palette,
      '-lavfi', 'paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle', '-loop', '0', out]);
    return;
  }
  if (ext === '.mp4') {
    await run('ffmpeg', ['-y', '-framerate', String(fps), '-i', framePattern,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart',
      // H.264 requires even dimensions.
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', out]);
    return;
  }
  if (ext === '.webm') {
    await run('ffmpeg', ['-y', '-framerate', String(fps), '-i', framePattern,
      '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1', out]);
    return;
  }
  throw new Error(`Unsupported output "${ext}". Use .gif, .mp4 or .webm.`);
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
  if (!opts.data || !opts.out) {
    console.error('Both --data and --out are required. See --help.');
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
  const { server, port } = await serve(payload);
  const frameDir = await mkdtemp(join(tmpdir(), 'reposense-frames-'));
  const browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars'],
  });

  try {
    const page = await browser.newPage({
      viewport: { width: opts.width, height: opts.height },
      deviceScaleFactor: 1,
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    log('Loading the scene…');
    await page.goto(`http://127.0.0.1:${port}/?record=1#/local`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#viewer:not([hidden])', { timeout: 120000 });
    await page.waitForFunction(() => document.documentElement.dataset.recordReady === '1', { timeout: 120000 });
    if (errors.length) throw new Error(`The page failed to start: ${errors[0]}`);

    await page.evaluate((chrome) => window.__reposense.setChrome(chrome), opts.chrome);
    const duration = opts.seconds ?? (await page.evaluate(() => window.__reposense.duration));
    const total = Math.max(1, Math.round(duration * opts.fps));
    log(`Rendering ${total} frames (${duration.toFixed(1)}s at ${opts.fps}fps)…`);

    for (let i = 0; i < total; i += 1) {
      const t = opts.start + (i / opts.fps);
      // seek() draws synchronously and screenshot() reads that draw, so no
      // wait is needed. Yielding a frame first is actively wrong: it lets the
      // DOM overlay settle by a variable amount, and measurably makes the same
      // timestamp render differently from one capture to the next.
      await page.evaluate((time) => window.__reposense.seek(time), t);
      await page.screenshot({ path: join(frameDir, `f${String(i).padStart(6, '0')}.png`) });
      if (!opts.quiet && (i % 30 === 0 || i === total - 1)) {
        process.stderr.write(`\r  ${i + 1}/${total} frames`);
      }
    }
    if (!opts.quiet) process.stderr.write('\n');

    log('Encoding…');
    await encode(join(frameDir, 'f%06d.png'), resolve(opts.out), opts.fps);

    const size = (await stat(resolve(opts.out))).size;
    if (opts.quiet) console.log(resolve(opts.out));
    else log(`Wrote ${resolve(opts.out)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  } finally {
    await browser.close();
    server.close();
    await rm(frameDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`\nreposense-record: ${err.message}`);
  process.exit(1);
});
