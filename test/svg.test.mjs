import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderSvg } from '../src/svg.js';

const payload = {
  schema: 'reposense/1',
  repo: { owner: 'acme', name: 'widget', branch: 'main' },
  files: [
    { path: 'src/index.ts', size: 4200 },
    { path: 'src/core/parse.ts', size: 9100 },
    { path: 'src/core/deep/nested/x.py', size: 700 },
    { path: 'docs/guide.md', size: 3300 },
    { path: 'README.md', size: 1200 },
    { path: 'assets/logo.png', size: 24000 },
  ],
};

function attrs(svg) {
  const m = svg.match(/<svg[^>]*width="(\d+)" height="(\d+)" viewBox="([^"]+)"/);
  assert.ok(m, 'the root svg carries width, height and a viewBox');
  return { width: +m[1], height: +m[2], viewBox: m[3].split(' ').map(Number) };
}

test('renders a standalone, well-formed SVG document', () => {
  const svg = renderSvg(payload);
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.trimEnd().endsWith('</svg>'));
  // Tag balance is a cheap proxy for "a browser will not reject this".
  for (const tag of ['svg', 'defs', 'radialGradient', 'g']) {
    const open = (svg.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
    const close = (svg.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    assert.equal(open, close, `<${tag}> tags balance`);
  }
});

test('emits no NaN, Infinity or undefined coordinates', () => {
  // The isometric projection divides and trigs its way to every coordinate;
  // one bad input would litter the file with NaN and render nothing at all.
  const svg = renderSvg(payload);
  for (const bad of ['NaN', 'Infinity', 'undefined', 'null']) {
    assert.ok(!svg.includes(bad), `output contains "${bad}"`);
  }
});

test('every drawn point lies inside the viewBox', () => {
  const svg = renderSvg(payload);
  const { viewBox } = attrs(svg);
  const [vx, vy, vw, vh] = viewBox;
  // Allow a hair of slack for stroke width on the outermost edges.
  const slack = Math.max(vw, vh) * 0.02;

  const coords = [];
  for (const m of svg.matchAll(/points="([^"]+)"/g)) {
    for (const pair of m[1].trim().split(/\s+/)) {
      const [x, y] = pair.split(',').map(Number);
      coords.push([x, y]);
    }
  }
  assert.ok(coords.length > 0, 'there are polygons to check');
  for (const [x, y] of coords) {
    assert.ok(x >= vx - slack && x <= vx + vw + slack, `x ${x} within viewBox`);
    assert.ok(y >= vy - slack && y <= vy + vh + slack, `y ${y} within viewBox`);
  }
});

test('the legend never runs past the right edge', () => {
  // Regression: chip widths were estimated with the wrong glyph advance, so the
  // last chip clipped off the frame.
  const svg = renderSvg(payload);
  const { viewBox } = attrs(svg);
  const right = viewBox[0] + viewBox[2];
  for (const m of svg.matchAll(/<rect x="([-\d.]+)"[^>]*width="([\d.]+)"/g)) {
    assert.ok(Number(m[1]) + Number(m[2]) <= right + 0.5, 'a legend chip overflows the frame');
  }
});

test('output is deterministic', () => {
  assert.equal(renderSvg(payload), renderSvg(payload));
});

test('themes produce different output but the same geometry', () => {
  const dark = renderSvg(payload, { theme: 'dark' });
  const light = renderSvg(payload, { theme: 'light' });
  assert.notEqual(dark, light);
  assert.deepEqual(attrs(dark).viewBox, attrs(light).viewBox);
  // An unknown theme falls back rather than throwing.
  assert.equal(renderSvg(payload, { theme: 'chartreuse' }), dark);
});

test('width drives the output size and the frame stays at least 7:4', () => {
  for (const width of [600, 1280, 2400]) {
    const { width: w, height: h } = attrs(renderSvg(payload, { width }));
    assert.equal(w, width);
    assert.ok(h > 0);
    assert.ok(w / h >= 1.74, `ratio ${(w / h).toFixed(2)} is at least 7:4`);
  }
});

test('the accessible description reports real numbers', () => {
  const svg = renderSvg(payload);
  assert.match(svg, /<title>acme\/widget rendered by RepoSense: 6 files/);
  assert.match(svg, /role="img" aria-label="[^"]+"/);
});

test('repository names containing markup are escaped', () => {
  const svg = renderSvg({
    ...payload,
    repo: { owner: '<script>', name: 'a&b"c', branch: 'main' },
  });
  assert.ok(!svg.includes('<script>'), 'no raw markup reaches the output');
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('a&amp;b&quot;c'));
});

test('degenerate repositories still render', () => {
  for (const files of [[{ path: 'only.md', size: 10 }], [{ path: 'a/b/c/d/e/f/g.ts', size: 1 }]]) {
    const svg = renderSvg({ repo: { name: 'tiny' }, files });
    assert.ok(svg.startsWith('<svg'));
    assert.ok(!svg.includes('NaN'));
  }
});

test('the tower budget folds the tail instead of exploding the file', () => {
  const many = {
    repo: { owner: 'o', name: 'big' },
    files: Array.from({ length: 20000 }, (_, i) => ({ path: `p${i % 200}/f${i}.ts`, size: 100 + i })),
  };
  const svg = renderSvg(many, { maxTowers: 400 });
  assert.ok(!svg.includes('NaN'));
  // 20k files must not become 20k polygons.
  assert.ok(svg.length < 900_000, `output is ${(svg.length / 1024).toFixed(0)} KB`);
  assert.match(svg, /20k files/);
});

test('the legend can be turned off', () => {
  const withLegend = renderSvg(payload);
  const without = renderSvg(payload, { legend: false });
  // The drawn legend block goes; the <title> and aria-label stay, because the
  // image still has to describe itself to a screen reader.
  assert.ok(withLegend.includes('<g font-family='));
  assert.ok(!without.includes('<g font-family='));
  assert.match(without, /<title>acme\/widget/);
  assert.ok(without.length < withLegend.length);
});
