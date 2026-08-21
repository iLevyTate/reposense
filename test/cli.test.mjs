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

test('--commits bounds how much history is replayed', async () => {
  const payload = await scan(ROOT, ['--commits', '1']);
  assert.equal(payload.scan.commits, 1);
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
