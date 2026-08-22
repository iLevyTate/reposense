/**
 * HUD rendering: the panels, inspector, tooltip and toasts around the canvas.
 *
 * This module owns DOM only. It never touches three.js — main.js wires the two
 * together — which keeps the renderer testable and the UI replaceable.
 */

import { formatBytes, formatCount } from '../model.js';
import { githubUrlFor } from '../links.js';
import { colorOf } from '../palette.js';

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.el = {
      repoLink: $('repo-link'),
      repoDesc: $('repo-desc'),
      repoStats: $('repo-stats'),
      spectrum: $('spectrum'),
      legend: $('legend'),
      metrics: $('metrics'),
      modelNote: $('model-note'),
      inspector: $('inspector'),
      hitlist: $('hitlist'),
      searchCount: $('search-count'),
      tooltip: $('tooltip'),
      toast: $('toast'),
      caption: $('caption'),
      captionTitle: $('caption-title'),
      captionSub: $('caption-sub'),
      timeDate: $('time-date'),
      timeDetail: $('time-detail'),
      loading: $('loading'),
      loadingPhase: $('loading-phase'),
      loadingDetail: $('loading-detail'),
      loadingFill: $('loading-fill'),
    };
    this.onFocusFile = () => {};
    // Offline recording drives frames by timestamp, so CSS entrance animations
    // and transient toasts have no meaningful time to play against.
    this.silent = false;
    this.animateCaptions = true;
  }

  /* ------------------------------------------------------------ repo header */

  showRepo(payload, model) {
    const r = payload.repo || {};
    const slug = `${r.owner}/${r.name}`;
    this.el.repoLink.textContent = slug;
    this.el.repoLink.href = r.url || `https://github.com/${slug}`;
    this.el.repoDesc.textContent = r.description || '';
    this.repo = r;

    const stats = [
      ['Files', formatCount(model.stats.fileCount)],
      ['Size', formatBytes(model.stats.totalSize)],
      ['Folders', formatCount(model.stats.dirCount)],
      ['Depth', String(model.stats.maxDepth)],
    ];
    if (r.stars) stats.unshift(['Stars', formatCount(r.stars)]);

    this.el.repoStats.innerHTML = stats
      .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
      .join('');
  }

  /* ----------------------------------------------------------- composition */

  showComposition(model) {
    const langs = model.languages.filter((l) => l.share > 0);
    const shown = langs.slice(0, 12);
    const rest = langs.slice(12);
    const restShare = rest.reduce((s, l) => s + l.share, 0);

    this.el.spectrum.innerHTML = langs
      .slice(0, 24)
      .map(
        (l) =>
          `<span style="width:${(l.share * 100).toFixed(3)}%;background:${l.color}" title="${esc(l.name)} — ${pct(l.share)}"></span>`,
      )
      .join('');

    const rows = shown.map(
      (l) => `<li>
        <span class="dot" style="background:${l.color};color:${l.color}"></span>
        <span class="name">${esc(l.name)}</span>
        <span class="pct">${pct(l.share)}</span>
      </li>`,
    );
    if (restShare > 0.0005) {
      rows.push(`<li>
        <span class="dot" style="background:#5f6b7a;color:#5f6b7a"></span>
        <span class="name">${rest.length} more</span>
        <span class="pct">${pct(restShare)}</span>
      </li>`);
    }
    this.el.legend.innerHTML = rows.join('');

    const s = model.stats;
    const metrics = [
      ['Largest file', formatBytes(s.maxSize)],
      ['Avg file', formatBytes(s.fileCount ? Math.round(s.totalSize / s.fileCount) : 0)],
      ['Languages', String(langs.length)],
      ['Towers drawn', formatCount(s.renderedCount)],
    ];
    this.el.metrics.innerHTML = metrics
      .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
      .join('');

    const notes = [];
    if (s.truncated) {
      notes.push(
        `${formatCount(s.truncated)} of the smallest files are folded into “…more files” towers to keep the frame rate up. Totals above still count every file.`,
      );
    }
    if (model.payload.repo?.truncatedTree) {
      notes.push('GitHub truncated this repository’s file tree — it is too large to return in full.');
    }
    if (!s.hasChurn) {
      notes.push('No history data: run a deep scan, or generate a file with the local CLI, to light the towers by churn.');
    }
    this.el.modelNote.hidden = notes.length === 0;
    this.el.modelNote.innerHTML = notes.map(esc).join('<br><br>');
  }

  /* ------------------------------------------------------------- inspector */

  showFile(file, model) {
    if (!file) {
      this.el.inspector.innerHTML =
        '<p class="inspector-empty">Hover a tower to inspect it. Click to keep it selected; shift-click opens it on GitHub.</p>';
      return;
    }
    const color = colorOf(file.lang);
    const dir = file.path.includes('/') ? `${file.path.slice(0, file.path.lastIndexOf('/'))}/` : '';
    const base = file.name;

    const rows = [
      ['Size', formatBytes(file.size)],
      ['Depth', String(file.depth)],
    ];
    if (file.commits) rows.push(['Commits', formatCount(file.commits)]);
    if (file.churn) rows.push(['Churn', `${formatCount(file.churn)} ±`]);
    if (file.lastTouched) rows.push(['Last touched', relTime(file.lastTouched)]);
    if (file.addedAt) rows.push(['Created', relTime(file.addedAt)]);
    if (file.bundle) rows.push(['Files folded', formatCount(file.bundle)]);

    const url = githubUrlFor(this.repo, file);

    this.el.inspector.innerHTML = `
      <p class="insp-path"><span class="dir">${esc(dir)}</span><span class="base">${esc(base)}</span></p>
      <span class="insp-lang"><span class="dot" style="background:${color};color:${color}"></span>${esc(file.lang)}</span>
      <dl class="insp-grid">${rows
        .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
        .join('')}</dl>
      <div class="insp-actions">
        <button type="button" data-act="focus">Fly to</button>
        ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">Open on GitHub</a>` : ''}
      </div>`;

    const focusBtn = this.el.inspector.querySelector('[data-act="focus"]');
    if (focusBtn) focusBtn.addEventListener('click', () => this.onFocusFile(file));
  }

  /* ---------------------------------------------------------------- search */

  showHits(hits, query) {
    this.el.searchCount.textContent = query ? `${hits.length}` : '';
    if (!query) {
      this.el.hitlist.innerHTML = '';
      return;
    }
    if (!hits.length) {
      this.el.hitlist.innerHTML = '<li><button type="button" disabled>No matches</button></li>';
      return;
    }
    const q = query.toLowerCase();
    this.el.hitlist.innerHTML = hits
      .slice(0, 200)
      .map((f, i) => `<li><button type="button" data-i="${i}">${highlight(f.path, q)}</button></li>`)
      .join('');
    this.el.hitlist.querySelectorAll('button[data-i]').forEach((btn) => {
      btn.addEventListener('click', () => this.onFocusFile(hits[Number(btn.dataset.i)]));
    });
  }

  /* --------------------------------------------------------------- tooltip */

  showTooltip(file, x, y) {
    const el = this.el.tooltip;
    if (!file) {
      el.hidden = true;
      return;
    }
    const bits = [formatBytes(file.size), file.lang];
    if (file.commits) bits.push(plural(file.commits, 'commit'));
    if (file.lastTouched) bits.push(relTime(file.lastTouched));
    el.innerHTML = `<div class="tt-name">${esc(file.name)}</div><div class="tt-meta">${esc(bits.join(' · '))}</div>`;
    el.hidden = false;
    // Flip the tooltip near the viewport edges so it never clips.
    const rect = el.getBoundingClientRect();
    const left = x + 16 + rect.width > innerWidth ? x - rect.width - 16 : x + 16;
    const top = y + 14 + rect.height > innerHeight ? y - rect.height - 14 : y + 14;
    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${Math.max(8, top)}px`;
  }

  /* ---------------------------------------------------------------- timeline */

  showTime(t, detail) {
    this.el.timeDate.textContent = t ? new Date(t * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
    this.el.timeDetail.textContent = detail || '';
  }

  /* --------------------------------------------------------------- captions */

  showCaption(shot) {
    if (!shot || !shot.caption) {
      this.el.caption.hidden = true;
      return;
    }
    const same = this.el.captionTitle.textContent === shot.caption;
    this.el.captionTitle.textContent = shot.caption;
    this.el.captionSub.textContent = shot.sub || '';
    this.el.caption.hidden = false;

    if (!this.animateCaptions) {
      // Every seek would otherwise restart the fade-in, and a frame captured
      // straight afterwards catches it at opacity 0 — captions never appeared
      // in a recording at all.
      this.el.caption.style.animation = 'none';
      this.el.caption.style.opacity = '1';
      return;
    }
    if (same) return; // only retrigger when the shot actually changes
    this.el.caption.style.animation = 'none';
    void this.el.caption.offsetWidth;
    this.el.caption.style.animation = '';
  }

  /* ---------------------------------------------------------------- loading */

  showLoading(on) {
    this.el.loading.hidden = !on;
    if (on) {
      this.el.loadingFill.style.width = '0%';
      this.el.loadingDetail.textContent = '';
    }
  }

  setProgress({ phase, detail, progress }) {
    if (phase) this.el.loadingPhase.textContent = phase;
    this.el.loadingDetail.textContent = detail || '';
    if (typeof progress === 'number') this.el.loadingFill.style.width = `${Math.round(progress * 100)}%`;
  }

  /* ------------------------------------------------------------------ toast */

  toast(message, { error = false, ms = 3200 } = {}) {
    if (this.silent) return;
    const el = this.el.toast;
    el.textContent = message;
    el.classList.toggle('is-error', error);
    el.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      el.hidden = true;
    }, ms);
  }
}

/* ---------------------------------------------------------------- helpers */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function highlight(path, q) {
  const i = path.toLowerCase().indexOf(q);
  if (i === -1) return esc(path);
  return `${esc(path.slice(0, i))}<span class="hl">${esc(path.slice(i, i + q.length))}</span>${esc(path.slice(i + q.length))}`;
}

/** "1 commit" / "12 commits" — counts above 999 use the compact form. */
function plural(n, word) {
  return `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`;
}

function pct(share) {
  const v = share * 100;
  if (v >= 10) return `${Math.round(v)}%`;
  if (v >= 1) return `${v.toFixed(1)}%`;
  return `${v.toFixed(2)}%`;
}

export function relTime(epochSeconds) {
  const diff = Date.now() / 1000 - epochSeconds;
  const units = [
    [60, 'second', 1],
    [3600, 'minute', 60],
    [86400, 'hour', 3600],
    [86400 * 30, 'day', 86400],
    [86400 * 365, 'month', 86400 * 30],
    [Infinity, 'year', 86400 * 365],
  ];
  if (diff < 45) return 'just now';
  for (const [limit, unit, div] of units) {
    if (diff < limit) {
      const n = Math.round(diff / div);
      return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'a long time ago';
}
