import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodePath, githubUrlFor } from '../src/links.js';

const repo = { url: 'https://github.com/o/r', branch: 'main' };

test('encodePath keeps separators but escapes everything else', () => {
  assert.equal(encodePath('src/a.ts'), 'src/a.ts');
  assert.equal(encodePath('a b/c.ts'), 'a%20b/c.ts');
  assert.equal(encodePath('x/'), 'x');
  assert.equal(encodePath(''), '');
});

test('encodePath escapes # and ?, which encodeURI leaves as URL syntax', () => {
  // Regression: encodeURI('notes#2.md') === 'notes#2.md', so the path silently
  // became a fragment and GitHub served the repository root instead.
  assert.equal(encodePath('notes#2.md'), 'notes%232.md');
  assert.equal(encodePath('q?.txt'), 'q%3F.txt');
  assert.ok(!encodePath('a#b?c').includes('#'));
  assert.ok(!encodePath('a#b?c').includes('?'));
});

test('githubUrlFor builds a blob URL for a file', () => {
  assert.equal(githubUrlFor(repo, { path: 'src/a.ts' }), 'https://github.com/o/r/blob/main/src/a.ts');
});

test('githubUrlFor keeps slashes in branch names literal', () => {
  // A ref like claude/feature must not have its slash percent-encoded, or
  // GitHub cannot resolve it.
  const url = githubUrlFor({ ...repo, branch: 'claude/feat-1' }, { path: 'src/a.ts' });
  assert.equal(url, 'https://github.com/o/r/blob/claude/feat-1/src/a.ts');
});

test('githubUrlFor points a folded bundle at its directory', () => {
  assert.equal(
    githubUrlFor(repo, { path: 'docs/…3 more files', bundle: 3 }),
    'https://github.com/o/r/tree/main/docs',
  );
  // A bundle at the repository root has no directory to descend into.
  assert.equal(githubUrlFor(repo, { path: '…9 more files', bundle: 9 }), 'https://github.com/o/r/tree/main');
});

test('githubUrlFor returns empty when the dataset has no GitHub origin', () => {
  // A local scan of a repository with no remote: the UI must hide the link
  // rather than render one pointing at "undefined".
  assert.equal(githubUrlFor({ url: '', branch: 'main' }, { path: 'a.ts' }), '');
  assert.equal(githubUrlFor(null, { path: 'a.ts' }), '');
  assert.equal(githubUrlFor(repo, null), '');
});

test('githubUrlFor falls back to HEAD when no branch is recorded', () => {
  assert.equal(githubUrlFor({ url: 'https://github.com/o/r' }, { path: 'a.ts' }),
    'https://github.com/o/r/blob/HEAD/a.ts');
});
