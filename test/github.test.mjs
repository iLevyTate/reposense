import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { parseRepoInput, fetchRepo, GitHubError } from '../src/github.js';

test('parseRepoInput accepts the forms people actually paste', () => {
  assert.deepEqual(parseRepoInput('owner/repo'), { owner: 'owner', name: 'repo' });
  assert.deepEqual(parseRepoInput('https://github.com/facebook/react'), { owner: 'facebook', name: 'react' });
  assert.deepEqual(parseRepoInput('http://www.github.com/a/b/'), { owner: 'a', name: 'b' });
  assert.deepEqual(parseRepoInput('git@github.com:a/b.git'), { owner: 'a', name: 'b' });
  assert.deepEqual(parseRepoInput('https://github.com/o/r/tree/main/src'), { owner: 'o', name: 'r' });
  assert.deepEqual(parseRepoInput('  owner/repo  '), { owner: 'owner', name: 'repo' });
});

test('parseRepoInput rejects anything that is not owner/repo', () => {
  for (const bad of ['', '   ', 'nope', '/', '//', 'a/b c', 'a/b?c', null, undefined]) {
    assert.equal(parseRepoInput(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('parseRepoInput is forgiving about empty path segments', () => {
  // Deliberate: a doubled slash usually comes from a concatenated URL, and
  // dropping empty segments is what makes https://github.com//o/r resolve.
  assert.deepEqual(parseRepoInput('a//b'), { owner: 'a', name: 'b' });
  assert.deepEqual(parseRepoInput('https://github.com//o/r'), { owner: 'o', name: 'r' });
});

/* ─────────────────────────── fetchRepo against a stubbed api.github.com ── */

const TOTAL_COMMITS = 400;
let requests;
let realFetch;

/** Minimal stand-in for the endpoints fetchRepo touches. */
function stubGitHub({ commitFiles = () => [] } = {}) {
  realFetch = globalThis.fetch;
  requests = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    requests.push(u.pathname + u.search);
    const json = (body) => ({ ok: true, status: 200, headers: new Map(), json: async () => body });

    if (u.pathname === '/repos/o/r') return json({ default_branch: 'main', stargazers_count: 5 });
    if (u.pathname === '/repos/o/r/git/trees/main') {
      return json({
        truncated: false,
        tree: [
          { path: 'src', type: 'tree' },
          { path: 'src/a.ts', type: 'blob', size: 1000 },
          { path: 'src/b.ts', type: 'blob', size: 2000 },
          { path: 'README.md', type: 'blob', size: 300 },
        ],
      });
    }
    if (u.pathname === '/repos/o/r/languages') return json({ TypeScript: 3000 });
    if (u.pathname === '/repos/o/r/contributors') return json([{ login: 'ada', contributions: 9 }]);
    if (u.pathname === '/repos/o/r/stats/commit_activity') return json([{ week: 1700000000, total: 3 }]);

    if (u.pathname === '/repos/o/r/commits') {
      const per = Number(u.searchParams.get('per_page'));
      const page = Number(u.searchParams.get('page'));
      const start = (page - 1) * per; // GitHub pages by offset, not by cursor
      const slice = [];
      for (let i = start; i < Math.min(start + per, TOTAL_COMMITS); i += 1) {
        slice.push({ sha: `sha${i + 1}` });
      }
      return json(slice);
    }
    const m = u.pathname.match(/^\/repos\/o\/r\/commits\/(sha\d+)$/);
    if (m) {
      return json({
        sha: m[1],
        commit: { author: { date: '2026-01-01T00:00:00Z', name: 'Ada' } },
        author: { login: 'ada' },
        files: commitFiles(m[1]),
      });
    }
    return { ok: false, status: 404, headers: new Map(), json: async () => ({ message: 'Not Found' }) };
  };
}

beforeEach(() => stubGitHub());
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('fetchRepo maps the tree into a reposense payload', async () => {
  const payload = await fetchRepo({ owner: 'o', name: 'r' });
  assert.equal(payload.schema, 'reposense/1');
  assert.equal(payload.source, 'github-api');
  assert.equal(payload.repo.branch, 'main');
  // Only blobs become files; the 'tree' entry is structure, not content.
  assert.deepEqual(payload.files.map((f) => f.path).sort(), ['README.md', 'src/a.ts', 'src/b.ts']);
  assert.equal(payload.files.find((f) => f.path === 'src/a.ts').lang, 'TypeScript');
});

test('fetchRepo makes no commit requests unless a deep scan is asked for', async () => {
  await fetchRepo({ owner: 'o', name: 'r' });
  assert.equal(requests.filter((r) => r.includes('/commits')).length, 0);
});

test('deep scan pages by a constant size and never repeats a commit', async () => {
  // Regression: per_page used to shrink on the final page while `page` stayed a
  // plain counter. Because GitHub pages by offset, requesting per_page=20&page=2
  // returned commits 21-40 a second time — double-counting their churn — and the
  // tail was never fetched at all.
  await fetchRepo({ owner: 'o', name: 'r' }, { deepScan: 120 });

  const listed = requests.filter((r) => r.startsWith('/repos/o/r/commits?'));
  const sizes = new Set(listed.map((r) => new URL(r, 'http://x').searchParams.get('per_page')));
  assert.equal(sizes.size, 1, `page size must not vary across requests, saw ${[...sizes]}`);

  const opened = requests.filter((r) => /\/commits\/sha\d+$/.test(r));
  assert.equal(opened.length, new Set(opened).size, 'no commit is opened twice');
  assert.equal(opened.length, 120, 'exactly the requested number of commits is scanned');

  // And the window is the newest 120 commits, contiguous with no gap.
  const nums = opened.map((r) => Number(r.match(/sha(\d+)$/)[1])).sort((a, b) => a - b);
  assert.equal(nums[0], 1);
  assert.equal(nums.at(-1), 120);
});

test('deep scan attributes churn to the right commits', async () => {
  // The two files are touched in disjoint windows chosen to expose offset
  // paging: with the old per_page shrink, commits 21-40 were replayed twice
  // and 101-120 never fetched, so a.ts doubled and b.ts vanished. A file
  // touched in *every* commit cannot show the difference — the inflated and
  // skipped counts cancel out — so neither of these is.
  stubGitHub({
    commitFiles: (sha) => {
      const n = Number(sha.slice(3));
      if (n >= 21 && n <= 40) return [{ filename: 'src/a.ts', additions: 2, deletions: 1, status: 'modified' }];
      if (n >= 101 && n <= 120) return [{ filename: 'src/b.ts', additions: 5, deletions: 0, status: 'modified' }];
      return [];
    },
  });
  const payload = await fetchRepo({ owner: 'o', name: 'r' }, { deepScan: 120 });
  const a = payload.files.find((f) => f.path === 'src/a.ts');
  const b = payload.files.find((f) => f.path === 'src/b.ts');

  assert.equal(a.commits, 20, 'commits in the first page are counted once, not twice');
  assert.equal(a.churn, 20 * 3);
  assert.equal(b.commits, 20, 'commits past the first page are not skipped');
  assert.equal(b.churn, 20 * 5);
});

test('deep scan limits that are not a multiple of the page size still work', async () => {
  for (const limit of [30, 150, 250]) {
    stubGitHub();
    await fetchRepo({ owner: 'o', name: 'r' }, { deepScan: limit });
    const opened = requests.filter((r) => /\/commits\/sha\d+$/.test(r));
    assert.equal(opened.length, limit, `limit ${limit}`);
    assert.equal(opened.length, new Set(opened).size, `limit ${limit}: no duplicates`);
  }
});

test('deep scan records creation dates for files added in scanned commits', async () => {
  stubGitHub({
    commitFiles: (sha) =>
      sha === 'sha1' ? [{ filename: 'src/b.ts', additions: 9, deletions: 0, status: 'added' }] : [],
  });
  const payload = await fetchRepo({ owner: 'o', name: 'r' }, { deepScan: 30 });
  assert.ok(payload.files.find((f) => f.path === 'src/b.ts').addedAt > 0);
});

test('fetchRepo reports an empty repository rather than rendering nothing', async () => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const json = (b) => ({ ok: true, status: 200, headers: new Map(), json: async () => b });
    if (u.pathname === '/repos/o/r') return json({ default_branch: 'main' });
    if (u.pathname.startsWith('/repos/o/r/git/trees')) return json({ tree: [], truncated: false });
    return json({});
  };
  await assert.rejects(() => fetchRepo({ owner: 'o', name: 'r' }), (err) => {
    assert.ok(err instanceof GitHubError);
    assert.match(err.message, /no files/i);
    return true;
  });
});
