#!/usr/bin/env node
/**
 * RepoSense — local repository scanner.
 *
 * Produces the same `reposense/1` document the hosted app builds from the
 * GitHub API, but from a local clone. That means no rate limits, private
 * repositories work, and the full commit history is available rather than the
 * recent slice the API can afford to hand back.
 *
 *   npx github:iLevyTate/reposense            scan . and open the viewer
 *   npx github:iLevyTate/reposense --json     just write reposense.json
 *
 * Node 18+. No dependencies.
 */

import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, relative, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

import { renderSvg } from '../src/svg.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');

/** Record separator for git's --format output; cannot occur in a commit field. */
const SEP = '\u0001';

/* ────────────────────────────────────────────────────────────────── args ── */

function parseArgs(argv) {
  const opts = {
    dir: '.',
    out: 'reposense.json',
    commits: Infinity,
    history: true,
    serve: true,
    open: true,
    port: 4173,
    quiet: false,
    svg: null,
    theme: 'dark',
    width: 1280,
    animate: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '-o': case '--out': opts.out = argv[++i]; break;
      case '-c': case '--commits': opts.commits = Number(argv[++i]); break;
      case '--no-history': opts.history = false; break;
      case '--json': opts.serve = false; opts.open = false; break;
      case '--serve': opts.serve = true; break;
      case '--no-open': opts.open = false; break;
      case '-p': case '--port': opts.port = Number(argv[++i]) || 4173; break;
      case '--svg':
        // The value is optional: `--svg` alone writes reposense.svg.
        opts.svg = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : 'reposense.svg';
        opts.serve = false;
        opts.open = false;
        break;
      case '--animate': opts.animate = true; break;
      case '--theme': opts.theme = argv[++i]; break;
      case '--width': opts.width = Number(argv[++i]) || 1280; break;
      case '-q': case '--quiet': opts.quiet = true; break;
      case '-h': case '--help': opts.help = true; break;
      case '-v': case '--version': opts.version = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`Unknown option: ${a}`);
        rest.push(a);
    }
  }
  if (rest[0]) opts.dir = rest[0];
  if (Number.isNaN(opts.commits)) opts.commits = Infinity;
  return opts;
}

const HELP = `
RepoSense — turn a repository into a cinematic 3D structure.

Usage
  reposense [directory] [options]

Options
  -o, --out <file>      where to write the JSON        (default reposense.json)
      --svg [file]      also render a static SVG        (default reposense.svg)
      --animate         svg builds itself in on a loop (CSS, no script)
      --theme <name>    svg theme: dark or light                 (default dark)
      --width <px>      svg width; height follows the ratio     (default 1280)
  -c, --commits <n>     limit history to the newest n commits
      --no-history      skip git history entirely (much faster on huge repos)
      --json            write the JSON and exit; do not open the viewer
      --no-open         start the viewer but do not open a browser
  -p, --port <n>        viewer port                              (default 4173)
  -q, --quiet           print only the output path
  -h, --help            this message

Examples
  reposense                        scan the current repo and open the viewer
  reposense ~/code/api --json      write ~/code/api's data to reposense.json
  reposense --no-history           structure only, skip the git log pass
  reposense --svg docs/repo.svg    render an SVG to embed in a README
  reposense --svg r.svg --animate  the same, but it builds itself in on a loop
`;

/* ─────────────────────────────────────────────────────────────────── git ── */

/** Runs a git command and streams stdout line by line. */
function gitLines(dir, args, onLine) {
  return new Promise((res, rej) => {
    const child = spawn('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', onLine);
    child.on('error', (err) =>
      rej(new Error(err.code === 'ENOENT' ? 'git is not installed or not on PATH.' : err.message)),
    );
    child.on('close', (code) => {
      rl.close();
      if (code === 0) res();
      else rej(new Error(stderr.trim() || `git ${args[0]} exited with ${code}`));
    });
  });
}

function gitText(dir, args) {
  return new Promise((res) => {
    const child = spawn('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.on('error', () => res(''));
    child.on('close', (code) => res(code === 0 ? out.trim() : ''));
  });
}

async function isGitRepo(dir) {
  return (await gitText(dir, ['rev-parse', '--is-inside-work-tree'])) === 'true';
}

/* ───────────────────────────────────────────────────────────── file tree ── */

/** Tracked files with their on-disk sizes. Honours .gitignore for free. */
async function trackedFiles(dir) {
  const paths = [];
  await gitLines(dir, ['ls-files', '-z'], (line) => {
    for (const p of line.split('\0')) if (p) paths.push(p);
  });

  const files = [];
  let cursor = 0;
  async function worker() {
    while (cursor < paths.length) {
      const path = paths[cursor++];
      try {
        const s = await stat(join(dir, path));
        // Symlinked directories and submodule gitlinks are not blobs.
        if (s.isFile()) files.push({ path, size: s.size });
      } catch {
        /* a tracked file missing on disk simply does not appear */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(64, paths.length) }, worker));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', 'target',
  '__pycache__', '.venv', 'venv', '.cache', '.turbo',
]);

/** Fallback walk for directories that are not git repositories. */
async function walkFiles(dir) {
  const files = [];
  async function recurse(current, depth) {
    if (depth > 24) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await recurse(full, depth + 1);
      } else if (entry.isFile()) {
        try {
          const s = await stat(full);
          files.push({ path: relative(dir, full).split(sep).join('/'), size: s.size });
        } catch {
          /* unreadable file */
        }
      }
    }
  }
  await recurse(dir, 0);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/* ─────────────────────────────────────────────────────────────── history ── */

/**
 * One pass over `git log --numstat` gives per-file churn, commit counts, author
 * attribution and last-touched times. A second pass restricted to additions
 * gives each file's creation date, which is what makes the growth timeline in
 * the viewer real rather than decorative.
 */
async function collectHistory(dir, byPath, { commits, onProgress }) {
  const activity = new Map(); // week start (unix seconds) -> commit count
  const authorCommits = new Map();
  let commitCount = 0;
  let when = 0;
  let author = '';

  const limit = Number.isFinite(commits) ? ['-n', String(commits)] : [];

  await gitLines(
    dir,
    ['log', '--no-renames', '--numstat', '--no-merges', ...limit, `--format=${SEP}%ct${SEP}%aN`],
    (line) => {
      if (line.startsWith(SEP)) {
        const parts = line.split(SEP);
        when = Number(parts[1]) || 0;
        author = parts[2] || '';
        commitCount += 1;
        if (when) {
          const week = when - (when % 604800);
          activity.set(week, (activity.get(week) || 0) + 1);
        }
        if (author) authorCommits.set(author, (authorCommits.get(author) || 0) + 1);
        if (commitCount % 500 === 0) onProgress?.(commitCount);
        return;
      }
      if (!line) return;
      // "<added>\t<deleted>\t<path>"; binary files report "-" for both counts.
      const tab1 = line.indexOf('\t');
      const tab2 = line.indexOf('\t', tab1 + 1);
      if (tab1 === -1 || tab2 === -1) return;
      const target = byPath.get(line.slice(tab2 + 1));
      if (!target) return; // touched historically but not present today

      target.churn += (Number(line.slice(0, tab1)) || 0) + (Number(line.slice(tab1 + 1, tab2)) || 0);
      target.commits += 1;
      if (when > target.lastTouched) target.lastTouched = when;
      if (author) {
        target.authors = target.authors || {};
        target.authors[author] = (target.authors[author] || 0) + 1;
      }
    },
  );

  // Creation dates. git log walks newest-first, so the last write per path wins
  // and that is the earliest add — exactly what the growth timeline needs.
  let addWhen = 0;
  await gitLines(
    dir,
    ['log', '--no-renames', '--diff-filter=A', '--name-only', ...limit, `--format=${SEP}%ct`],
    (line) => {
      if (line.startsWith(SEP)) {
        addWhen = Number(line.slice(1)) || 0;
        return;
      }
      if (!line) return;
      const target = byPath.get(line);
      if (target) target.addedAt = addWhen;
    },
  );

  return { activity, authorCommits, commitCount };
}

/* ───────────────────────────────────────────────────────────────── build ── */

async function buildPayload(opts, log) {
  const dir = resolve(opts.dir);
  const git = await isGitRepo(dir);

  log(git ? 'Reading tracked files…' : 'Walking the directory (not a git repository)…');
  const raw = git ? await trackedFiles(dir) : await walkFiles(dir);
  if (!raw.length) throw new Error(`No files found in ${dir}`);

  const files = raw.map((f) => ({
    path: f.path,
    size: f.size,
    churn: 0,
    commits: 0,
    lastTouched: 0,
    addedAt: 0,
  }));
  const byPath = new Map(files.map((f) => [f.path, f]));
  log(`Found ${files.length.toLocaleString()} files.`);

  let history = null;
  if (git && opts.history && opts.commits !== 0) {
    log('Replaying history…');
    try {
      history = await collectHistory(dir, byPath, {
        commits: opts.commits,
        onProgress: (n) => log(`  ${n.toLocaleString()} commits…`, true),
      });
      log(`Replayed ${history.commitCount.toLocaleString()} commits.`);
    } catch (err) {
      // An empty repository or a shallow clone should degrade, not abort.
      log(`History unavailable (${err.message}). Continuing with structure only.`);
    }
  }

  // Keep the payload small: only the top authors per file matter downstream.
  for (const f of files) {
    if (!f.authors) continue;
    f.authors = Object.fromEntries(
      Object.entries(f.authors).sort((a, b) => b[1] - a[1]).slice(0, 5),
    );
  }

  const [remote, branch, headDate] = git
    ? await Promise.all([
        gitText(dir, ['config', '--get', 'remote.origin.url']),
        gitText(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
        gitText(dir, ['log', '-1', '--format=%cI']),
      ])
    : ['', '', ''];

  const slug = parseRemote(remote) || { owner: '', name: dir.split(sep).pop() || 'repository' };

  return {
    schema: 'reposense/1',
    generatedAt: new Date().toISOString(),
    source: git ? 'local-git' : 'local-fs',
    repo: {
      owner: slug.owner,
      name: slug.name,
      description: '',
      branch: branch || 'HEAD',
      url: slug.owner ? `https://github.com/${slug.owner}/${slug.name}` : '',
      pushedAt: headDate || '',
      private: false,
      local: true,
    },
    languages: {},
    contributors: history
      ? [...history.authorCommits.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 40)
          .map(([login, commits]) => ({ login, commits, avatar: '', url: '' }))
      : [],
    activity: history
      ? [...history.activity.entries()].sort((a, b) => a[0] - b[0]).map(([week, commits]) => ({ week, commits }))
      : [],
    scan: history ? { commits: history.commitCount, source: 'git log' } : null,
    files,
  };
}

function parseRemote(url) {
  if (!url) return null;
  const m = url.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i);
  if (m) return { owner: m[1], name: m[2] };
  const generic = url.match(/[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  return generic ? { owner: generic[1], name: generic[2] } : null;
}

/* ──────────────────────────────────────────────────────────────── server ── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Serves the bundled viewer plus the freshly scanned payload at /__data.json. */
function serveViewer(payload, port, log) {
  const body = Buffer.from(JSON.stringify(payload));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/__data.json') {
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }

    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const target = resolve(PACKAGE_ROOT, rel);
    // Never serve outside the package directory.
    if (target !== PACKAGE_ROOT && !target.startsWith(PACKAGE_ROOT + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    try {
      const s = await stat(target);
      if (!s.isFile()) throw new Error('not a file');
      res.writeHead(200, {
        'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
        'Content-Length': s.size,
        'Cache-Control': 'no-cache',
      });
      createReadStream(target).pipe(res);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  });

  return new Promise((res, rej) => {
    server.on('error', (err) => {
      rej(
        err.code === 'EADDRINUSE'
          ? new Error(`Port ${port} is already in use. Pass --port to pick another.`)
          : err,
      );
    });
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${port}/#/local`;
      log(`\n  Viewer ready → ${url}\n  Press Ctrl+C to stop.\n`);
      res({ server, url });
    });
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  } catch {
    /* the URL is printed above; opening it is a convenience, not a requirement */
  }
}

/* ────────────────────────────────────────────────────────────────── main ── */

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (opts.help) {
    console.log(HELP);
    return;
  }
  if (opts.version) {
    try {
      console.log(JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version);
    } catch {
      console.log('unknown');
    }
    return;
  }

  let lastWasProgress = false;
  const CLEAR_LINE = '\r\u001b[K';
  const log = (msg, progress = false) => {
    if (opts.quiet) return;
    if (lastWasProgress && process.stderr.isTTY) process.stderr.write(CLEAR_LINE);
    if (progress && process.stderr.isTTY) {
      process.stderr.write(msg);
      lastWasProgress = true;
    } else {
      process.stderr.write(`${msg}\n`);
      lastWasProgress = false;
    }
  };

  try {
    const payload = await buildPayload(opts, log);
    const outPath = resolve(opts.out);
    await writeFile(outPath, JSON.stringify(payload));
    if (opts.quiet) console.log(outPath);
    else log(`Wrote ${outPath}`);

    if (opts.svg) {
      if (opts.theme !== 'dark' && opts.theme !== 'light') {
        throw new Error(`Unknown theme "${opts.theme}". Use dark or light.`);
      }
      const svgPath = resolve(opts.svg);
      await mkdir(dirname(svgPath), { recursive: true });
      await writeFile(
        svgPath,
        renderSvg(payload, { theme: opts.theme, width: opts.width, animate: opts.animate }),
      );
      if (opts.quiet) console.log(svgPath);
      else log(`Wrote ${svgPath}`);
    }

    if (opts.serve) {
      const { url } = await serveViewer(payload, opts.port, log);
      if (opts.open) openBrowser(url);
    }
  } catch (err) {
    console.error(`\nreposense: ${err.message}`);
    process.exit(1);
  }
}

main();
