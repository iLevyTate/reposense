import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'scripts', 'reposense.mjs');

/** Runs the scanner with --json so it never starts a server. */
async function scan(dir, extra = []) {
  const out = join(await mkdtemp(join(tmpdir(), 'reposense-')), 'out.json');
  await run(process.execPath, [CLI, dir, '--json', '--out', out, ...extra]);
  return JSON.parse(await readFile(out, 'utf8'));
}

test('--help exits cleanly and documents the flags', async () => {
  const { stdout } = await run(process.execPath, [CLI, '--help']);
  for (const flag of ['--out', '--commits', '--no-history', '--json', '--port']) {
    assert.match(stdout, new RegExp(flag.replace(/-/g, '\\-')));
  }
});

test('an unknown flag fails loudly rather than being ignored', async () => {
  await assert.rejects(() => run(process.execPath, [CLI, '--definitely-not-a-flag']), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr || err.stdout || '', /Unknown option/);
    return true;
  });
});

test('scanning this repository produces a valid reposense/1 payload', async () => {
  const payload = await scan(ROOT);

  assert.equal(payload.schema, 'reposense/1');
  assert.equal(payload.source, 'local-git');
  assert.ok(Array.isArray(payload.files) && payload.files.length > 0);
  assert.ok(payload.files.some((f) => f.path === 'src/main.js'), 'tracked sources appear');
  assert.ok(!payload.files.some((f) => f.path.startsWith('node_modules/')), 'gitignored paths do not');

  for (const f of payload.files.slice(0, 20)) {
    assert.equal(typeof f.path, 'string');
    assert.equal(typeof f.size, 'number');
    assert.ok(f.size >= 0);
    assert.equal(typeof f.churn, 'number');
    assert.equal(typeof f.lastTouched, 'number');
  }
  assert.ok(Array.isArray(payload.contributors));
  assert.ok(Array.isArray(payload.activity));
});

test('history gives files real churn and creation dates', async () => {
  const payload = await scan(ROOT);
  assert.ok(payload.scan?.commits > 0, 'commits were replayed');
  assert.ok(payload.files.some((f) => f.churn > 0), 'churn is recorded');
  assert.ok(payload.files.some((f) => f.addedAt > 0), 'creation dates are recorded');
  assert.ok(payload.files.some((f) => f.authors), 'authorship is attributed');
});

test('--no-history skips the git log pass entirely', async () => {
  const payload = await scan(ROOT, ['--no-history']);
  assert.equal(payload.scan, null);
  assert.deepEqual(payload.contributors, []);
  assert.ok(payload.files.every((f) => f.churn === 0));
  assert.ok(payload.files.length > 0, 'structure is still scanned');
});

test('--commits bounds the diff pass without truncating the timeline', async () => {
  // The budget applies to the expensive per-file pass only. Dating every
  // commit and finding when each file first appeared are cheap traversals, so
  // they always cover everything: a bounded scan of a ten-year repository must
  // still produce a ten-year chronology, not a chronology of last week.
  const full = await scan(ROOT);
  const bounded = await scan(ROOT, ['--commits', '1']);

  assert.equal(bounded.scan.diffed, 1, 'only one commit is diffed');
  assert.equal(bounded.scan.limited, true);
  assert.equal(bounded.scan.commits, full.scan.commits, 'every commit is still dated');
  assert.deepEqual(bounded.activity, full.activity, 'the activity strip is unbounded');

  const firstAdd = (p) => Math.min(...p.files.filter((f) => f.addedAt).map((f) => f.addedAt));
  assert.equal(firstAdd(bounded), firstAdd(full), 'creation dates reach as far back as ever');
});

/**
 * Builds a repository whose history shape is fully controlled: `count` commits,
 * each touching its own still-present file, spaced a week apart.
 */
async function historyFixture(count) {
  const dir = await mkdtemp(join(tmpdir(), 'reposense-hist-'));
  const git = (args, env = {}) => run('git', args, { cwd: dir, env: { ...process.env, ...env } });
  await git(['init', '-q']);
  await git(['config', 'user.email', 'fixture@example.invalid']);
  await git(['config', 'user.name', 'Fixture']);
  for (let i = 1; i <= count; i += 1) {
    await writeFile(join(dir, `file-${String(i).padStart(2, '0')}.js`), `export const v = ${i};\n`);
    const when = `${1600000000 + i * 604800} +0000`;
    await git(['add', '.']);
    await git(['commit', '-q', '-m', `c${i}`], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
  }
  return dir;
}

test('--spread samples the diff pass across the whole history', async () => {
  // Not run against this repository: lastTouched is only recorded for files
  // that still exist, so the reach-back comparison below depends on the shape
  // the live history happens to have, and a tip commit touching most files (a
  // merge, the CI bot refreshing the SVGs) collapses the difference between
  // the two samples. One commit per still-present file makes it deterministic.
  const dir = await historyFixture(12);
  const newest = await scan(dir, ['--commits', '4']);
  const spread = await scan(dir, ['--commits', '4', '--spread']);

  assert.equal(spread.scan.spread, true);
  assert.equal(newest.scan.spread, false);
  assert.ok(spread.scan.diffed <= 4, 'the budget is still a budget');

  // The spread sample has to reach further back than the contiguous one. Both
  // include the newest commits, so only the oldest end can differ.
  const oldestTouch = (p) => Math.min(...p.files.filter((f) => f.lastTouched).map((f) => f.lastTouched));
  assert.ok(
    oldestTouch(spread) < oldestTouch(newest),
    `spread reaches back to ${oldestTouch(spread)}, newest-first only to ${oldestTouch(newest)}`,
  );
  await rm(dir, { recursive: true, force: true });
});

test('a directory that is not a git repository is labelled local-fs', async () => {
  // Regression: this used to claim source "local-git", implying git history the
  // scanner never read.
  const dir = await mkdtemp(join(tmpdir(), 'plain-'));
  await mkdir(join(dir, 'sub'), { recursive: true });
  await writeFile(join(dir, 'a.py'), 'print(1)\n');
  await writeFile(join(dir, 'sub', 'b.go'), 'package main\n');

  const payload = await scan(dir);
  assert.equal(payload.source, 'local-fs');
  assert.equal(payload.files.length, 2);
  assert.deepEqual(payload.files.map((f) => f.path).sort(), ['a.py', 'sub/b.go']);
  assert.equal(payload.scan, null);
  await rm(dir, { recursive: true, force: true });
});

test('an empty directory fails with a clear message instead of an empty scene', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'empty-'));
  await assert.rejects(
    () => run(process.execPath, [CLI, dir, '--json', '--out', join(dir, 'o.json')]),
    (err) => {
      assert.match(err.stderr || '', /No files found/);
      return true;
    },
  );
  await rm(dir, { recursive: true, force: true });
});

test('the committed example dataset is loadable and current', async () => {
  const demo = JSON.parse(await readFile(join(ROOT, 'public', 'demo.json'), 'utf8'));
  assert.equal(demo.schema, 'reposense/1');
  assert.ok(demo.files.length > 0);
  // The landing page links to this file; a malformed one breaks the demo route.
  assert.ok(demo.files.every((f) => typeof f.path === 'string' && typeof f.size === 'number'));
});
