/**
 * Turns a flat RepoSense payload into the hierarchy the renderer walks.
 *
 * The payload shape is identical whether it came from the GitHub API or from
 * the local `reposense` CLI, so everything downstream of here is source-blind.
 */

import { basename, languageOf, colorOf } from './palette.js';

/**
 * Files smaller than this contribute their real size to the layout weight;
 * above it we compress logarithmically so one 4 MB lockfile cannot swallow
 * the entire disc.
 */
const WEIGHT_FLOOR = 64;

export function weightOf(size) {
  return 1 + Math.log2(1 + Math.max(0, size) / WEIGHT_FLOOR);
}

/**
 * Build the directory tree.
 *
 * @param {object} payload  a reposense/1 document
 * @param {object} [opts]
 * @param {number} [opts.maxFiles]  render budget; the smallest files beyond it
 *   are folded into one "bundle" leaf per directory rather than dropped, so the
 *   totals in the HUD always match the real repository.
 */
export function buildModel(payload, opts = {}) {
  const maxFiles = opts.maxFiles ?? 14000;
  const files = (payload.files || []).filter((f) => f && f.path);

  // Deepest-first ordering is irrelevant here; we just need a stable, useful
  // priority for the render budget. Bigger and more-churned files win.
  const ranked = files.slice().sort((a, b) => score(b) - score(a));
  const kept = new Set(ranked.slice(0, maxFiles).map((f) => f.path));
  const overflow = ranked.slice(maxFiles);

  const root = makeDir('', '');
  let totalSize = 0;
  let maxSize = 0;
  let maxChurn = 0;
  const languageBytes = new Map();

  for (const f of files) {
    const size = Math.max(0, f.size | 0);
    totalSize += size;
    if (size > maxSize) maxSize = size;
    const churn = Math.max(0, f.churn || 0);
    if (churn > maxChurn) maxChurn = churn;
    const lang = f.lang || languageOf(f.path);
    languageBytes.set(lang, (languageBytes.get(lang) || 0) + size);
    if (kept.has(f.path)) insertFile(root, f, lang);
  }

  // Fold the budget overflow into per-directory bundle leaves.
  const bundles = new Map();
  for (const f of overflow) {
    const dirPath = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    let b = bundles.get(dirPath);
    if (!b) {
      b = { count: 0, size: 0, churn: 0, lastTouched: 0 };
      bundles.set(dirPath, b);
    }
    b.count += 1;
    b.size += Math.max(0, f.size | 0);
    b.churn += Math.max(0, f.churn || 0);
    b.lastTouched = Math.max(b.lastTouched, f.lastTouched || 0);
  }
  for (const [dirPath, b] of bundles) {
    insertFile(
      root,
      {
        path: dirPath ? `${dirPath}/…${b.count} more files` : `…${b.count} more files`,
        size: b.size,
        churn: b.churn,
        lastTouched: b.lastTouched,
        bundle: b.count,
      },
      'Other',
    );
  }

  finalize(root, null, 0);

  const languages = [...languageBytes.entries()]
    .map(([name, bytes]) => ({ name, bytes, color: colorOf(name), share: totalSize ? bytes / totalSize : 0 }))
    .sort((a, b) => b.bytes - a.bytes);

  // Reduced rather than spread into Math.min/Math.max: these are the one pair
  // of arrays not bounded by the render budget, and a large locally-scanned
  // monorepo would blow the argument limit and throw RangeError.
  let firstAdded = 0;
  let firstTouched = 0;
  let lastTouched = 0;
  let addedCount = 0;
  for (const f of files) {
    const t = f.lastTouched || 0;
    if (t) {
      if (t > lastTouched) lastTouched = t;
      if (!firstTouched || t < firstTouched) firstTouched = t;
    }
    const a = f.addedAt || 0;
    if (a) {
      addedCount += 1;
      if (!firstAdded || a < firstAdded) firstAdded = a;
    }
  }

  return {
    payload,
    root,
    stats: {
      fileCount: files.length,
      renderedCount: root.leafCount,
      truncated: overflow.length,
      dirCount: countDirs(root) - 1, // the synthetic root is not a real directory
      totalSize,
      maxSize,
      maxChurn,
      maxDepth: maxDepth(root),
      hasHistory: addedCount > 0,
      hasChurn: maxChurn > 0,
      firstTouched: firstAdded || firstTouched,
      lastTouched,
    },
    languages,
  };
}

function score(f) {
  return weightOf(f.size | 0) * (1 + Math.log2(1 + (f.churn || 0)));
}

function makeDir(path, name) {
  return {
    path,
    name,
    type: 'dir',
    children: [],
    childIndex: new Map(),
    size: 0,
    churn: 0,
    leafCount: 0,
    weight: 0,
    depth: 0,
    lastTouched: 0,
    addedAt: 0,
    lang: 'Other',
  };
}

function insertFile(root, f, lang) {
  const parts = f.path.split('/');
  const fileName = parts.pop();
  let node = root;
  let prefix = '';
  for (const part of parts) {
    prefix = prefix ? `${prefix}/${part}` : part;
    let next = node.childIndex.get(part);
    if (!next) {
      next = makeDir(prefix, part);
      node.childIndex.set(part, next);
      node.children.push(next);
    }
    node = next;
  }
  const leaf = {
    path: f.path,
    name: fileName,
    type: 'file',
    size: Math.max(0, f.size | 0),
    churn: Math.max(0, f.churn || 0),
    commits: f.commits || 0,
    lastTouched: f.lastTouched || 0,
    addedAt: f.addedAt || 0,
    authors: f.authors || null,
    bundle: f.bundle || 0,
    lang,
    depth: 0,
  };
  node.childIndex.set(fileName, leaf);
  node.children.push(leaf);
}

/** Second pass: roll sizes upward, assign depth, pick each directory's dominant language. */
function finalize(node, parent, depth) {
  node.depth = depth;
  node.parent = parent;
  if (node.type === 'file') {
    node.weight = weightOf(node.size);
    return;
  }
  const langBytes = new Map();
  let size = 0;
  let churn = 0;
  let leafCount = 0;
  let weight = 0;
  let lastTouched = 0;
  let addedAt = Infinity;

  for (const child of node.children) {
    finalize(child, node, depth + 1);
    size += child.size;
    churn += child.churn;
    weight += child.weight;
    leafCount += child.type === 'file' ? 1 : child.leafCount;
    lastTouched = Math.max(lastTouched, child.lastTouched || 0);
    if (child.addedAt) addedAt = Math.min(addedAt, child.addedAt);
    const lang = child.type === 'file' ? child.lang : child.lang;
    const bytes = child.type === 'file' ? child.size : child.size;
    langBytes.set(lang, (langBytes.get(lang) || 0) + bytes + 1);
  }

  node.size = size;
  node.churn = churn;
  node.leafCount = leafCount;
  // A directory's own weight includes a small constant so empty-ish folders
  // still claim a visible slice of the disc.
  node.weight = weight + 0.5;
  node.lastTouched = lastTouched;
  node.addedAt = addedAt === Infinity ? 0 : addedAt;
  node.lang = dominant(langBytes);

  // Directories before files, then heaviest first. Stable ordering matters:
  // the layout is deterministic, so the same repo always looks the same.
  node.children.sort((a, b) => {
    if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;
    if (b.weight !== a.weight) return b.weight - a.weight;
    return a.name.localeCompare(b.name);
  });
  node.childIndex = null; // only needed while inserting
}

function dominant(map) {
  let best = 'Other';
  let bestVal = -1;
  for (const [k, v] of map) {
    if (v > bestVal) {
      bestVal = v;
      best = k;
    }
  }
  return best;
}

function countDirs(node) {
  if (node.type === 'file') return 0;
  let n = 1;
  for (const c of node.children) n += countDirs(c);
  return n;
}

function maxDepth(node) {
  if (node.type === 'file') return node.depth;
  let d = node.depth;
  for (const c of node.children) d = Math.max(d, maxDepth(c));
  return d;
}

/** Depth-first walk over every node, root included. */
export function walk(node, visit) {
  visit(node);
  if (node.children) for (const c of node.children) walk(c, visit);
}

export function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatCount(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
