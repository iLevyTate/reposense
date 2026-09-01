/**
 * GitHub REST client.
 *
 * Everything runs in the browser against api.github.com, which serves CORS
 * headers, so RepoSense needs no backend and deploys as static files.
 *
 * Unauthenticated callers get 60 requests/hour per IP. The structure costs
 * about five requests; the deep history scan costs one more per commit, which
 * is why main.js clamps it for anonymous callers. A personal access token
 * (kept in localStorage, never transmitted anywhere but GitHub) raises the
 * ceiling to 5000/hour and lifts the clamp.
 */

import { languageOf } from './palette.js';

const API = 'https://api.github.com';
const TOKEN_KEY = 'reposense.token';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private browsing: token simply does not persist */
  }
}

export class GitHubError extends Error {
  constructor(message, { status = 0, rateLimited = false, resetAt = 0 } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.rateLimited = rateLimited;
    this.resetAt = resetAt;
  }
}

export function parseRepoInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  // Accept owner/repo, a full URL, or a git@ remote.
  const cleaned = raw
    .replace(/^git@github\.com:/, '')
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\.git$/, '')
    .replace(/^\/+|\/+$/g, '');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, name] = parts;
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return null;
  return { owner, name };
}

async function request(path, { signal, token = getToken(), accept = 'application/vnd.github+json' } = {}) {
  // Only `Accept` is set for anonymous calls. Accept is CORS-safelisted, so
  // the request stays a "simple" one and the browser skips the preflight
  // entirely. That halves the round trips and removes a failure mode behind
  // strict proxies.
  // A token adds Authorization, which forces a preflight; GitHub answers it.
  const headers = { Accept: accept };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(API + path, { headers, signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new GitHubError('Could not reach github.com. Check your connection.', { status: 0 });
  }

  if (res.status === 202) return { accepted: true }; // statistics still being computed
  if (res.ok) return res.json();

  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000;
  if ((res.status === 403 || res.status === 429) && remaining === '0') {
    throw new GitHubError(
      token
        ? 'GitHub API rate limit reached for your token.'
        : 'GitHub API rate limit reached (60 requests/hour for anonymous users). Add a token to keep going.',
      { status: res.status, rateLimited: true, resetAt: reset },
    );
  }
  if (res.status === 404) {
    throw new GitHubError(
      token
        ? 'Repository not found. Check the name, or whether your token can see it.'
        : 'Repository not found. Private repositories need a token.',
      { status: 404 },
    );
  }
  if (res.status === 401) throw new GitHubError('Token rejected by GitHub. It may be expired.', { status: 401 });
  if (res.status === 409) throw new GitHubError('This repository is empty. There is nothing to visualize yet.', { status: 409 });

  let detail = '';
  try {
    detail = (await res.json()).message || '';
  } catch {
    /* body was not JSON */
  }
  throw new GitHubError(detail || `GitHub returned HTTP ${res.status}.`, { status: res.status });
}

/**
 * Fetch a whole repository as a reposense/1 payload.
 *
 * @param {{owner:string,name:string}} repo
 * @param {object} opts
 * @param {(p:{phase:string,detail?:string,progress?:number})=>void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.deepScan]  number of commits to open for file-level
 *   churn. 0 disables it. Each commit costs one request.
 * @param {boolean} [opts.spread]  spend that budget across the whole history
 *   rather than on the newest commits. Costs extra listing requests, so it is
 *   only worth offering to a caller with a token.
 */
export async function fetchRepo(repo, opts = {}) {
  const { onProgress = () => {}, signal, deepScan = 0, spread = false } = opts;
  const slug = `${repo.owner}/${repo.name}`;

  onProgress({ phase: 'Locating repository', progress: 0.05 });
  const meta = await request(`/repos/${slug}`, { signal });
  const branch = meta.default_branch || 'main';

  onProgress({ phase: 'Reading the file tree', detail: branch, progress: 0.18 });
  const tree = await request(`/repos/${slug}/git/trees/${encodeURIComponent(branch)}?recursive=1`, { signal });

  const files = (tree.tree || [])
    .filter((e) => e.type === 'blob')
    .map((e) => ({
      path: e.path,
      size: e.size || 0,
      lang: languageOf(e.path),
      churn: 0,
      commits: 0,
      lastTouched: 0,
    }));

  if (!files.length) throw new GitHubError('This repository has no files on its default branch.', { status: 409 });

  onProgress({ phase: 'Measuring languages', progress: 0.34 });
  const [languages, contributors, activity] = await Promise.all([
    request(`/repos/${slug}/languages`, { signal }).catch(() => ({})),
    request(`/repos/${slug}/contributors?per_page=40`, { signal }).catch(() => []),
    request(`/repos/${slug}/stats/commit_activity`, { signal }).catch(() => []),
  ]);

  const payload = {
    schema: 'reposense/1',
    generatedAt: new Date().toISOString(),
    source: 'github-api',
    repo: {
      owner: repo.owner,
      name: repo.name,
      description: meta.description || '',
      stars: meta.stargazers_count || 0,
      forks: meta.forks_count || 0,
      watchers: meta.subscribers_count || 0,
      openIssues: meta.open_issues_count || 0,
      branch,
      url: meta.html_url || `https://github.com/${slug}`,
      license: meta.license?.spdx_id || '',
      createdAt: meta.created_at || '',
      pushedAt: meta.pushed_at || '',
      private: !!meta.private,
      truncatedTree: !!tree.truncated,
    },
    languages: languages && !languages.accepted ? languages : {},
    contributors: Array.isArray(contributors)
      ? contributors
          .filter((c) => c && c.login)
          .map((c) => ({
            login: c.login,
            commits: c.contributions || 0,
            avatar: c.avatar_url || '',
            url: c.html_url || '',
          }))
      : [],
    activity: normalizeActivity(activity),
    files,
  };

  if (deepScan > 0) {
    await applyDeepScan(payload, slug, deepScan, { signal, onProgress, spread });
  }

  onProgress({ phase: 'Building the model', progress: 1 });
  return payload;
}

function normalizeActivity(weeks) {
  if (!Array.isArray(weeks)) return [];
  return weeks
    .filter((w) => w && typeof w.week === 'number')
    .map((w) => ({ week: w.week, commits: w.total || 0 }));
}

/**
 * Open recent commits to recover per-file churn and last-touched timestamps.
 *
 * The commit list endpoint does not include file lists, so this costs one
 * request per commit. That cost is why main.js clamps the depth for
 * anonymous callers instead of replaying everything.
 */
async function applyDeepScan(payload, slug, limit, { signal, onProgress, spread = false }) {
  onProgress({ phase: 'Listing commits', progress: 0.45 });

  // Page size must stay constant across requests: GitHub pages by offset, so
  // shrinking per_page on the last page re-requests commits already collected
  // and skips the tail. Over-fetch a whole page and trim instead.
  const PAGE = 100;
  // Listing is a hundred commits per request; opening one for its file list is
  // a request each. So walking further back than the budget costs almost
  // nothing next to the budget itself, and it is the difference between
  // replaying the newest four hundred commits of a ten-year repository and
  // replaying four hundred spread across the ten years. Only offered to token
  // holders: an anonymous caller has sixty requests an hour in total, and
  // spending a third of them on listing is not a trade they can afford.
  const maxPages = spread
    ? Math.min(60, Math.max(4, Math.ceil(limit / 4)))
    : Math.ceil(limit / PAGE);
  const listed = [];
  for (let page = 1; page <= maxPages; page += 1) {
    if (!spread && listed.length >= limit) break;
    const list = await request(`/repos/${slug}/commits?per_page=${PAGE}&page=${page}`, { signal });
    if (!Array.isArray(list) || !list.length) break;
    for (const c of list) if (c.sha) listed.push(c.sha);
    if (list.length < PAGE) break;
  }
  // Without spread this stays exactly what it was: the newest `limit` commits,
  // contiguous, no gaps.
  const shas = spread ? pickCommits(listed, limit) : listed.slice(0, limit);
  if (!shas.length) return;

  const byPath = new Map(payload.files.map((f) => [f.path, f]));
  const seenFirst = new Map();
  let done = 0;

  // Bounded concurrency: fast enough to feel live, gentle enough that a token
  // budget is not vaporised on one repository.
  const CONCURRENCY = 6;
  const queue = shas.slice();
  async function worker() {
    while (queue.length) {
      if (signal?.aborted) return;
      const sha = queue.shift();
      let commit;
      try {
        commit = await request(`/repos/${slug}/commits/${sha}`, { signal });
      } catch (err) {
        if (err.name === 'AbortError') return;
        if (err.rateLimited) {
          queue.length = 0; // stop cleanly and keep whatever we already have
          return;
        }
        continue;
      }
      const when = Date.parse(commit.commit?.author?.date || commit.commit?.committer?.date || 0) / 1000 || 0;
      const author = commit.author?.login || commit.commit?.author?.name || '';
      for (const file of commit.files || []) {
        const target = byPath.get(file.filename);
        if (!target) continue;
        target.churn += (file.additions || 0) + (file.deletions || 0);
        target.commits += 1;
        if (when > (target.lastTouched || 0)) target.lastTouched = when;
        if (author) {
          target.authors = target.authors || {};
          target.authors[author] = (target.authors[author] || 0) + 1;
        }
        if (file.status === 'added') seenFirst.set(file.filename, when);
      }
      done += 1;
      onProgress({
        phase: 'Replaying history',
        detail: `${done} / ${shas.length} commits`,
        progress: 0.45 + 0.5 * (done / shas.length),
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, shas.length) }, worker));

  for (const [path, when] of seenFirst) {
    const target = byPath.get(path);
    if (target) target.addedAt = when;
  }
  payload.scan = {
    commits: done,
    partial: done < shas.length,
    spread: spread && listed.length > shas.length,
    listed: listed.length,
  };
}

/**
 * Which of the listed commits to open, given a budget smaller than the list.
 *
 * The newest third of the budget is spent contiguously so recent history stays
 * exact, and the rest is spread evenly over everything older. Recency is what a
 * uniform sample is worst at, and it is what the heat in the viewer reads; the
 * spread is what makes the growth timeline cover a repository's whole life
 * rather than its last few weeks. Commits that add files turn up in every era,
 * so sampling widely finds more creation dates than sampling deeply, not
 * fewer: nothing here is approximated.
 */
function pickCommits(listed, limit) {
  if (listed.length <= limit) return listed;
  const recent = Math.min(Math.floor(limit / 3), listed.length);
  const picked = listed.slice(0, recent);
  const older = listed.length - recent;
  const want = limit - recent;
  if (want > 0 && older > 0) {
    const step = older / want;
    for (let i = 0; i < want; i += 1) picked.push(listed[recent + Math.floor(i * step)]);
  }
  return picked;
}

/** Current rate-limit headroom, for the HUD. */
export async function fetchRateLimit(signal) {
  try {
    const data = await request('/rate_limit', { signal });
    return data?.resources?.core || null;
  } catch {
    return null;
  }
}
