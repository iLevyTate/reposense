import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildModel, walk, formatBytes, formatCount } from '../src/model.js';

const files = [
  { path: 'src/a.ts', size: 4000, churn: 20, lastTouched: 1700000000, addedAt: 1600000000 },
  { path: 'src/deep/b.py', size: 900, churn: 3, lastTouched: 1690000000 },
  { path: 'README.md', size: 120 },
];

test('buildModel derives a hierarchy from flat paths', () => {
  const m = buildModel({ files });
  assert.equal(m.stats.fileCount, 3);
  assert.equal(m.stats.totalSize, 5020);
  assert.equal(m.stats.dirCount, 2); // src, src/deep — the synthetic root does not count
  assert.deepEqual(m.root.children.map((c) => `${c.name}:${c.type}`), ['src:dir', 'README.md:file']);
});

test('buildModel rolls sizes up and detects languages', () => {
  const m = buildModel({ files });
  const src = m.root.children.find((c) => c.name === 'src');
  assert.equal(src.size, 4900);
  assert.equal(src.leafCount, 2);
  assert.deepEqual(
    m.languages.map((l) => l.name),
    ['TypeScript', 'Python', 'Markdown'],
  );
  assert.ok(Math.abs(m.languages.reduce((s, l) => s + l.share, 0) - 1) < 1e-9);
});

test('buildModel reports history only when creation dates exist', () => {
  assert.equal(buildModel({ files }).stats.hasHistory, true);
  const noDates = files.map(({ addedAt, ...rest }) => rest);
  assert.equal(buildModel({ files: noDates }).stats.hasHistory, false);
});

test('buildModel folds the render-budget overflow instead of dropping it', () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ path: `pkg/f${i}.ts`, size: 100 + i }));
  const m = buildModel({ files: many }, { maxFiles: 50 });

  // Totals must still describe every file, not just the drawn ones.
  assert.equal(m.stats.fileCount, 500);
  assert.equal(m.stats.truncated, 450);
  assert.equal(m.stats.totalSize, many.reduce((s, f) => s + f.size, 0));

  let bundles = 0;
  let bundled = 0;
  walk(m.root, (n) => {
    if (n.type === 'file' && n.bundle) {
      bundles += 1;
      bundled += n.bundle;
    }
  });
  assert.equal(bundles, 1, 'one bundle leaf per directory');
  assert.equal(bundled, 450, 'every folded file is accounted for');
});

test('buildModel survives a repository too large to spread into Math.min', () => {
  // Regression: firstTouched/lastTouched spread one argument per file into
  // Math.min/Math.max. Those were the only arrays not capped by the render
  // budget, so a large local scan threw RangeError inside buildModel.
  const N = 200000;
  const huge = Array.from({ length: N }, (_, i) => ({
    path: `p${i % 300}/s${i % 30}/f${i}.ts`,
    size: 100 + (i % 5000),
    lastTouched: 1700000000 + (i % 1000),
    addedAt: 1600000000 + (i % 1000),
  }));

  const m = buildModel({ files: huge });
  assert.equal(m.stats.fileCount, N);
  assert.equal(m.stats.firstTouched, 1600000000);
  assert.equal(m.stats.lastTouched, 1700000999);
  assert.ok(m.stats.renderedCount <= 14000 + 400, 'render budget is respected');
});

test('buildModel takes the earliest creation and latest touch across files', () => {
  const m = buildModel({
    files: [
      { path: 'a.ts', size: 1, addedAt: 500, lastTouched: 900 },
      { path: 'b.ts', size: 1, addedAt: 100, lastTouched: 300 },
      { path: 'c.ts', size: 1 },
    ],
  });
  assert.equal(m.stats.firstTouched, 100);
  assert.equal(m.stats.lastTouched, 900);
});

test('buildModel handles an empty file list without throwing', () => {
  const m = buildModel({ files: [] });
  assert.equal(m.stats.fileCount, 0);
  assert.equal(m.stats.hasHistory, false);
  assert.equal(m.stats.lastTouched, 0);
});

test('layout ordering is deterministic', () => {
  const a = buildModel({ files });
  const b = buildModel({ files: [...files].reverse() });
  const names = (m) => {
    const out = [];
    walk(m.root, (n) => out.push(n.path));
    return out;
  };
  assert.deepEqual(names(a), names(b), 'the same repo always produces the same tree');
});

test('formatters', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1024 * 1024 * 3.5), '3.5 MB');
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(1500), '1.5k');
  assert.equal(formatCount(25000), '25k');
  assert.equal(formatCount(2_400_000), '2.4M');
});
