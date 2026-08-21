/**
 * RepoSense — application entry point.
 *
 * Owns routing, loading, and every interaction that crosses the boundary
 * between the DOM and the 3D scene.
 */

import * as THREE from 'three';
import { fetchRepo, parseRepoInput, getToken, setToken, fetchRateLimit, GitHubError } from './github.js';
import { buildModel, formatBytes } from './model.js';
import { computeLayout, LIFT } from './layout.js';
import { Stage } from './scene/stage.js';
import { Arcology } from './scene/arcology.js';
import { Constellation } from './scene/constellation.js';
import { Cinema, Recorder, TOUR_DURATION } from './scene/cinema.js';
import { githubUrlFor } from './links.js';
import { Hud } from './ui/hud.js';

const $ = (id) => document.getElementById(id);
const REVEAL_SECONDS = 2.6;
const TIMELINE_SWEEP_SECONDS = 24;

const app = {
  stage: null,
  arcology: null,
  constellation: null,
  cinema: null,
  hud: new Hud(),
  model: null,
  layout: null,
  mode: 'arcology',
  revealStart: null,
  selected: null,
  hovered: null,
  hits: [],
  timePlaying: false,
  timePlayFrom: null,
  timeT: 1,
  recorder: null,
  abort: null,
};

/* ══════════════════════════════════════════════════════════ launch screen ══ */

function initLaunch() {
  const form = $('repo-form');
  const input = $('repo-input');
  const errorEl = $('launch-error');

  const showError = (msg) => {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const repo = parseRepoInput(input.value);
    if (!repo) {
      showError('That does not look like a repository. Try “owner/repository” or a GitHub URL.');
      input.focus();
      return;
    }
    showError('');
    location.hash = `#/${repo.owner}/${repo.name}`;
  });

  $('examples').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-repo]');
    if (!btn) return;
    input.value = btn.dataset.repo;
    form.requestSubmit();
  });

  $('demo-link').addEventListener('click', () => {
    location.hash = '#/demo';
  });

  // Deep-scan controls
  const deep = $('deep-scan');
  const deepRow = $('deep-count-row');
  const deepCount = $('deep-count');
  deep.addEventListener('change', () => {
    deepRow.hidden = !deep.checked;
  });
  deepCount.addEventListener('input', () => {
    $('deep-count-out').textContent = deepCount.value;
  });

  // Token
  const tokenInput = $('token-input');
  tokenInput.value = getToken();
  tokenInput.addEventListener('change', () => {
    setToken(tokenInput.value.trim());
    refreshRateHint();
  });

  // Local file: drag-and-drop or picker
  const dz = $('dropzone');
  const fileInput = $('file-input');
  dz.addEventListener('click', () => fileInput.click());
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.[0]) loadFile(fileInput.files[0]).catch((err) => showError(err.message));
  });
  for (const type of ['dragenter', 'dragover']) {
    dz.addEventListener(type, (e) => {
      e.preventDefault();
      dz.classList.add('is-over');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    dz.addEventListener(type, () => dz.classList.remove('is-over'));
  }
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    // The document-level handler below would otherwise load the same file again.
    e.stopPropagation();
    const file = e.dataTransfer?.files?.[0];
    if (file) loadFile(file).catch((err) => showError(err.message));
  });

  // Accept a drop anywhere on the launch screen, not just the small target.
  // Both handlers must preventDefault unconditionally: the browser's default
  // action for a dropped file is to navigate to it, which would throw away the
  // whole session if you missed the dropzone or dropped onto the viewer.
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!$('launch').hidden && e.dataTransfer?.files?.[0]) {
      loadFile(e.dataTransfer.files[0]).catch((err) => showError(err.message));
    }
  });

  refreshRateHint();
  drawLaunchBackdrop();
  app.showLaunchError = showError;
}

async function refreshRateHint() {
  const hint = $('rate-hint');
  hint.textContent = getToken() ? 'token saved' : '';
  const core = await fetchRateLimit();
  if (!core) return;
  hint.textContent = `${core.remaining}/${core.limit} API requests left`;
}

/** A slow drifting starfield behind the launch screen, echoing the 3D view. */
function drawLaunchBackdrop() {
  const canvas = $('launch-canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let stars = [];
  let raf = 0;

  const resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.min(240, Math.round((innerWidth * innerHeight) / 9000));
    stars = Array.from({ length: count }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: Math.random() * 1.5 + 0.3,
      a: Math.random() * 0.6 + 0.15,
      s: Math.random() * 0.012 + 0.002,
      h: 190 + Math.random() * 90,
    }));
  };

  const frame = (t) => {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const s of stars) {
      if (!reduced) s.y -= s.s * 0.004;
      if (s.y < -0.02) s.y = 1.02;
      const tw = reduced ? 1 : 0.7 + 0.3 * Math.sin(t * 0.001 + s.x * 30);
      ctx.beginPath();
      ctx.arc(s.x * innerWidth, s.y * innerHeight, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${s.h}, 90%, 72%, ${s.a * tw})`;
      ctx.fill();
    }
    raf = requestAnimationFrame(frame);
  };

  addEventListener('resize', resize);
  resize();

  // Start/stop rather than a one-way cancel: returning to the launch screen
  // used to leave a frozen starfield that went blank on the next resize.
  app.stopLaunchBackdrop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
  };
  app.startLaunchBackdrop = () => {
    if (raf) return;
    resize();
    raf = requestAnimationFrame(frame);
  };
  app.startLaunchBackdrop();
}

/* ══════════════════════════════════════════════════════════════ loading ══ */

async function loadFromRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  if (!hash) {
    showLaunch();
    return;
  }

  // The local CLI serves the scanned payload alongside this page.
  if (hash === 'local') {
    await withLoading(async (signal) => {
      app.hud.setProgress({ phase: 'Reading the local scan', progress: 0.3 });
      const res = await fetch('./__data.json', { signal });
      if (!res.ok) {
        throw new Error('No local scan found. This route is served by the `reposense` CLI.');
      }
      return res.json();
    });
    return;
  }

  if (hash === 'demo') {
    await withLoading(async () => {
      app.hud.setProgress({ phase: 'Loading the example', progress: 0.3 });
      const res = await fetch('./public/demo.json');
      if (!res.ok) throw new Error('The bundled example could not be loaded.');
      return res.json();
    });
    return;
  }

  const repo = parseRepoInput(hash);
  if (!repo) {
    showLaunch();
    app.showLaunchError?.('That does not look like a repository.');
    return;
  }

  $('repo-input').value = `${repo.owner}/${repo.name}`;
  const deepScan = $('deep-scan').checked ? Number($('deep-count').value) : 0;

  await withLoading(async (signal) =>
    fetchRepo(repo, { signal, deepScan, onProgress: (p) => app.hud.setProgress(p) }),
  );
}

/** Shared loading shell: progress overlay, cancellation, error routing. */
async function withLoading(producer) {
  app.abort?.abort();
  const controller = new AbortController();
  app.abort = controller;

  app.hud.showLoading(true);
  app.hud.setProgress({ phase: 'Connecting…', progress: 0.04 });

  try {
    const payload = await producer(controller.signal);
    if (controller.signal.aborted) return;
    await present(payload);
  } catch (err) {
    if (err.name === 'AbortError') return;
    app.hud.showLoading(false);
    showLaunch();
    let msg = err.message || 'Something went wrong.';
    if (err instanceof GitHubError && err.rateLimited && err.resetAt) {
      msg += ` Resets at ${new Date(err.resetAt).toLocaleTimeString()}.`;
    }
    app.showLaunchError?.(msg);
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  } finally {
    if (app.abort === controller) app.abort = null;
  }
}

async function loadFile(file) {
  await withLoading(async () => {
    app.hud.setProgress({ phase: 'Reading file', detail: file.name, progress: 0.35 });
    let payload;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      throw new Error('That file is not valid JSON.');
    }
    if (!payload || !Array.isArray(payload.files)) {
      throw new Error('That JSON is not a RepoSense export — it has no "files" array.');
    }
    return payload;
  });
}

/* ══════════════════════════════════════════════════════════ presentation ══ */

async function present(payload) {
  app.hud.setProgress({ phase: 'Building the structure', progress: 0.94 });
  // Yield once so the progress bar paints before the synchronous build.
  await new Promise((r) => setTimeout(r, 16));

  teardownScene();

  app.model = buildModel(payload);
  app.layout = computeLayout(app.model);

  $('launch').hidden = true;
  $('viewer').hidden = false;
  app.stopLaunchBackdrop?.();

  if (!app.stage) {
    app.stage = new Stage($('stage'), $('labels'));
    app.cinema = new Cinema(app.stage, {
      onShot: (shot) => {
        app.hud.showCaption(shot);
        if (shot?.mode) applyTourMode(shot.mode);
      },
      onProgress: (p) => onTourProgress(p),
      onEnd: () => endTour(),
    });
    wireViewer();
    app.stage.onUpdate(tick);
    app.stage.start();
  }

  app.arcology = new Arcology(app.model, app.layout);
  app.arcology.setLift(0);
  app.arcology.setFade(1);
  app.stage.scene.add(app.arcology.group);

  app.constellation = new Constellation(app.model, app.layout);
  app.stage.scene.add(app.constellation.group);

  app.cinema.setBounds({
    radius: app.layout.fitRadius,
    height: app.layout.fitHeight,
    center: app.layout.center,
  });
  app.cinema.defaultView(true);

  app.hud.showRepo(payload, app.model);
  app.hud.showComposition(app.model);
  app.hud.showFile(null);
  app.hud.showHits([], '');

  // Chronology needs at least one timestamp to scrub against.
  const canTime = app.model.stats.lastTouched > 0;
  document.querySelector('[data-mode="chronology"]').disabled = !canTime;
  document.querySelector('[data-mode="constellation"]').disabled = app.constellation.empty;

  setMode('arcology');
  app.revealStart = app.stage.clock.elapsedTime;
  app.selected = null;
  $('search-input').value = '';

  app.hud.showLoading(false);

  const src = { 'local-git': 'local git history', 'local-fs': 'a local directory scan' }[payload.source]
    || 'the GitHub API';
  app.hud.toast(`${app.model.stats.fileCount.toLocaleString()} files from ${src}`);

  updateShareUrl(payload);
}

function updateShareUrl(payload) {
  const r = payload.repo;
  if (payload.source === 'github-api' && r?.owner && r?.name) {
    const want = `#/${r.owner}/${r.name}`;
    if (location.hash !== want) history.replaceState(null, '', want);
  }
  document.title = r?.owner ? `${r.owner}/${r.name} — RepoSense` : 'RepoSense';
}

function teardownScene() {
  if (app.arcology) {
    app.stage.scene.remove(app.arcology.group);
    app.arcology.dispose();
    app.arcology = null;
  }
  if (app.constellation) {
    app.stage.scene.remove(app.constellation.group);
    app.constellation.dispose();
    app.constellation = null;
  }
}

function showLaunch() {
  $('viewer').hidden = true;
  $('launch').hidden = false;
  app.startLaunchBackdrop?.();
  app.hud.showLoading(false);
  document.title = 'RepoSense — Visualize Your Repo Cinematically';
  refreshRateHint();
}

/* ══════════════════════════════════════════════════════════ interaction ══ */

function wireViewer() {
  const canvas = app.stage.renderer.domElement;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let pointerX = 0;
  let pointerY = 0;
  let needsPick = false;
  let downAt = null;

  canvas.addEventListener('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    pointerX = e.clientX;
    pointerY = e.clientY;
    needsPick = true;
  });
  canvas.addEventListener('pointerleave', () => {
    setHover(null);
    needsPick = false;
  });
  canvas.addEventListener('pointerdown', (e) => {
    downAt = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointerup', (e) => {
    // Only treat it as a click if the pointer barely moved, so orbiting the
    // camera never opens a file by accident.
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    downAt = null;
    if (moved > 5) return;
    if (!app.hovered) {
      selectFile(null);
      return;
    }
    selectFile(app.hovered);
    // A modifier turns the click into "open on GitHub". Plain click selects,
    // because clicking is also how you pick a tower to read in the inspector.
    if (e.shiftKey || e.metaKey || e.ctrlKey) openOnGitHub(app.hovered);
  });

  // Picking runs at most once per frame, from the render loop.
  app.pick = () => {
    if (!needsPick || !app.arcology || app.cinema.playing) return;
    needsPick = false;
    raycaster.setFromCamera(pointer, app.stage.camera);
    const hit = raycaster.intersectObject(app.arcology.towers, false)[0];
    const file = hit && hit.instanceId != null ? app.arcology.fileByInstance[hit.instanceId] : null;
    setHover(file, pointerX, pointerY);
  };

  const setHover = (file, x, y) => {
    if (file !== app.hovered) {
      app.hovered = file;
      app.arcology?.focus(file || app.selected);
      canvas.style.cursor = file ? 'pointer' : '';
      app.hud.showFile(file || app.selected, app.model);
    }
    app.hud.showTooltip(file, x ?? pointerX, y ?? pointerY);
  };

  // Panels
  $('left-toggle').addEventListener('click', () => {
    const body = $('left-body');
    const open = body.hidden;
    body.hidden = !open;
    $('left-toggle').setAttribute('aria-expanded', String(open));
  });
  $('back-button').addEventListener('click', () => {
    location.hash = '';
  });

  // Modes
  document.querySelectorAll('.mode').forEach((btn) => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  // Search
  const search = $('search-input');
  let searchTimer;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => applySearch(search.value.trim()), 110);
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      search.value = '';
      applySearch('');
      search.blur();
    }
  });

  // Timeline
  $('time-play').addEventListener('click', () => toggleTimePlay());
  $('time-range').addEventListener('input', (e) => {
    app.timePlaying = false;
    app.timePlayFrom = null;
    syncPlayIcon();
    setTime(Number(e.target.value) / 1000);
  });

  // Tools
  $('tour-button').addEventListener('click', () => (app.cinema.playing ? stopTour() : startTour()));
  $('record-button').addEventListener('click', () => toggleRecording());
  $('shot-button').addEventListener('click', () => snapshot());
  $('export-button').addEventListener('click', () => exportJson());
  $('help-button').addEventListener('click', () => $('help-dialog').showModal());

  app.hud.onFocusFile = (file) => {
    selectFile(file);
    app.cinema.flyToNode(file, app.arcology.lift);
  };

  addEventListener('keydown', onKey);

  // Rotating a phone flips the aspect ratio, and the framing correction that
  // keeps a wide structure on screen depends on it. Re-frame on an actual
  // orientation change only — never on an ordinary desktop window resize,
  // which would yank the camera out from under the viewer.
  let wasPortrait = innerWidth < innerHeight;
  let reframeTimer;
  addEventListener('resize', () => {
    const isPortrait = innerWidth < innerHeight;
    if (isPortrait === wasPortrait) return;
    wasPortrait = isPortrait;
    clearTimeout(reframeTimer);
    reframeTimer = setTimeout(() => {
      if (!app.cinema.playing) app.cinema.defaultView();
    }, 220);
  });
}

function onKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if ($('viewer').hidden) return;

  switch (e.key) {
    case '1': setMode('arcology'); break;
    case '2': setMode('chronology'); break;
    case '3': setMode('constellation'); break;
    case 't': case 'T': app.cinema.playing ? stopTour() : startTour(); break;
    case 'r': case 'R': toggleRecording(); break;
    case 'p': case 'P': snapshot(); break;
    case 'f': case 'F': e.preventDefault(); $('search-input').focus(); break;
    case '0': app.cinema.defaultView(); break;
    case ' ':
      if (app.mode === 'chronology') {
        e.preventDefault();
        toggleTimePlay();
      }
      break;
    case 'Escape':
      if (app.cinema.playing) stopTour();
      else selectFile(null);
      break;
    case '?': $('help-dialog').showModal(); break;
    default: break;
  }
}

function selectFile(file) {
  app.selected = file;
  app.arcology?.focus(file);
  app.hud.showFile(file, app.model);
}

function applySearch(query) {
  if (!app.arcology) return;
  if (!query) {
    app.arcology.applyFilter(null);
    app.hits = [];
    app.hud.showHits([], '');
    return;
  }
  const q = query.toLowerCase();
  const predicate = (f) => f.path.toLowerCase().includes(q);
  app.arcology.applyFilter(predicate);
  app.hits = app.layout.files.filter(predicate).sort((a, b) => a.path.length - b.path.length);
  app.hud.showHits(app.hits, query);
}

/* ═════════════════════════════════════════════════════════════════ modes ══ */

function modeAvailable(mode) {
  const btn = document.querySelector(`[data-mode="${mode}"]`);
  return !!btn && !btn.disabled;
}

/**
 * Switches mode for a tour shot.
 *
 * Falls back to the Arcology when a shot's mode has no data behind it, and
 * stays silent about it — the HUD is hidden during a tour, so the toast
 * setMode() would raise has nowhere to go.
 */
function applyTourMode(mode) {
  const target = modeAvailable(mode) ? mode : 'arcology';
  if (app.mode !== target) setMode(target);
}

function openOnGitHub(file) {
  const url = githubUrlFor(app.model?.payload?.repo, file);
  if (!url) {
    app.hud.toast('This dataset has no GitHub origin to open.', { error: true });
    return;
  }
  window.open(url, '_blank', 'noopener');
}

function setMode(mode) {
  const btn = document.querySelector(`[data-mode="${mode}"]`);
  if (btn?.disabled) {
    app.hud.toast(
      mode === 'chronology'
        ? 'No history in this dataset. Enable the deep scan, or use the local CLI.'
        : 'No contributor data in this dataset.',
      { error: true },
    );
    return;
  }
  app.mode = mode;
  document.querySelectorAll('.mode').forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', String(on));
  });

  $('timeline').hidden = mode !== 'chronology';
  app.constellation?.setVisible(mode === 'constellation');

  if (mode === 'chronology') {
    setTime(app.timeT);
  } else {
    app.timePlaying = false;
    app.timePlayFrom = null;
    syncPlayIcon();
    app.arcology?.resetTime();
    app.hud.showTime(0, '');
  }
}

/* ════════════════════════════════════════════════════════════ chronology ══ */

function timeRange() {
  const s = app.model.stats;
  const start = s.firstTouched || s.lastTouched - 86400 * 365;
  const end = s.lastTouched || Date.now() / 1000;
  return { start, end: Math.max(end, start + 86400) };
}

function setTime(t01) {
  if (!app.arcology) return;
  app.timeT = Math.min(1, Math.max(0, t01));
  const { start, end } = timeRange();
  const t = start + (end - start) * app.timeT;
  const { visible, bytes } = app.arcology.applyTime(t, { hasHistory: app.model.stats.hasHistory });
  $('time-range').value = String(Math.round(app.timeT * 1000));

  const detail = app.model.stats.hasHistory
    ? `${visible.toLocaleString()} files · ${formatBytes(bytes)}`
    : 'heat only — no creation dates in this dataset';
  app.hud.showTime(t, detail);
}

function toggleTimePlay() {
  app.timePlaying = !app.timePlaying;
  if (app.timePlaying && app.timeT >= 0.999) app.timeT = 0;
  app.timePlayFrom = null;
  syncPlayIcon();
}

function syncPlayIcon() {
  const btn = $('time-play');
  btn.querySelector('.i-play').hidden = app.timePlaying;
  btn.querySelector('.i-pause').hidden = !app.timePlaying;
  btn.setAttribute('aria-label', app.timePlaying ? 'Pause timeline' : 'Play timeline');
}

/* ═════════════════════════════════════════════════════════════════ tour ══ */

function startTour() {
  if (!app.arcology) return;
  app.modeBeforeTour = app.mode;
  app.hud.showTooltip(null);
  document.getElementById('viewer').classList.add('is-cinema');
  $('tour-bar').hidden = false;
  $('tour-button').classList.add('is-active');
  app.cinema.play();
}

function stopTour() {
  app.cinema.stop();
}

function endTour() {
  document.getElementById('viewer').classList.remove('is-cinema');
  $('tour-bar').hidden = true;
  $('tour-button').classList.remove('is-active');
  app.hud.showCaption(null);
  $('tour-fill').style.width = '0%';
  // The tour drives the mode from its shot list; put the viewer back where the
  // viewer left it.
  setMode(app.modeBeforeTour || 'arcology');
}

function onTourProgress(p) {
  $('tour-fill').style.width = `${(p * 100).toFixed(1)}%`;
}

/* ══════════════════════════════════════════════════════════════ exports ══ */

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function slug() {
  const r = app.model?.payload?.repo;
  return r?.owner ? `${r.owner}-${r.name}` : 'reposense';
}

function snapshot() {
  // The composer renders on demand, so the buffer is valid right now.
  app.stage.renderer.domElement.toBlob((blob) => {
    if (!blob) {
      app.hud.toast('Could not capture the canvas.', { error: true });
      return;
    }
    download(blob, `${slug()}-reposense.png`);
    app.hud.toast('Snapshot saved');
  }, 'image/png');
}

async function toggleRecording() {
  const btn = $('record-button');

  if (app.recorder?.recording) {
    const blob = await app.recorder.stop();
    app.recorder = null;
    btn.classList.remove('is-active');
    btn.querySelector('span:last-child').textContent = 'Record';
    if (blob) {
      const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
      download(blob, `${slug()}-reposense.${ext}`);
      app.hud.toast('Recording saved');
    }
    return;
  }

  if (!Recorder.supported()) {
    app.hud.toast('This browser cannot record canvas video.', { error: true });
    return;
  }

  try {
    app.recorder = new Recorder(app.stage.renderer.domElement, { fps: 60 });
    app.recorder.start();
  } catch (err) {
    app.recorder = null;
    app.hud.toast(err.message, { error: true });
    return;
  }

  btn.classList.add('is-active');
  btn.querySelector('span:last-child').textContent = 'Stop';
  app.hud.toast(`Recording — the tour runs ${Math.round(TOUR_DURATION)}s`);
  if (!app.cinema.playing) startTour();
}

function exportJson() {
  const payload = app.model.payload;
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  download(blob, `${slug()}-reposense.json`);
  app.hud.toast('Data exported');
}

/* ══════════════════════════════════════════════════════════════ the loop ══ */

function tick(dt, time) {
  if (!app.arcology) return;

  // Reveal: the structure lifts out of a flat disc and fades in ring by ring.
  //
  // Driven by wall-clock elapsed time, not by accumulating `dt`. `dt` is capped
  // at 50ms so a backgrounded tab cannot jump the animation, but that cap also
  // means a slow frame rate advances the reveal per *frame* rather than per
  // second — on a 5120x1440 display at a few frames per second the structure
  // stayed invisible for close to a minute.
  if (app.revealStart !== null) {
    const p = Math.min(1, (time - app.revealStart) / REVEAL_SECONDS);
    const e = 1 - Math.pow(1 - p, 4);
    app.arcology.setLift(LIFT * e);
    app.arcology.setFade(1 - e);
    if (p >= 1) {
      app.arcology.setLift(LIFT);
      app.arcology.setFade(0);
      app.revealStart = null;
    }
  }

  app.cinema.update(dt, time);

  // The tour drives the chronology scrub itself so the shot lands on "today".
  if (app.cinema.playing && app.mode === 'chronology') {
    const shotT = Math.min(1, Math.max(0, (app.cinema.shotProgress() - 0.55) / 0.28));
    setTime(shotT);
  } else if (app.timePlaying) {
    // Wall clock, for the same reason as the tour and the reveal: a sweep
    // advertised as 24 seconds must not stretch with the frame rate.
    if (app.timePlayFrom === null) {
      app.timePlayFrom = { at: time, from: app.timeT };
    }
    const t = app.timePlayFrom.from + (time - app.timePlayFrom.at) / TIMELINE_SWEEP_SECONDS;
    if (t >= 1) {
      app.timePlaying = false;
      app.timePlayFrom = null;
      syncPlayIcon();
      setTime(1);
    } else {
      setTime(t);
    }
  }

  app.arcology.update(dt, time, app.stage.camera);
  app.constellation?.update(dt, time);
  app.pick?.();
}


/* ═══════════════════════════════════════════════════════════════════ boot ══ */

function boot() {
  if (!hasWebGL()) {
    document.body.innerHTML =
      '<div class="noscript">RepoSense needs WebGL, which this browser has disabled or does not support.</div>';
    return;
  }
  initLaunch();
  // Routing must be live before the first load: the launch form navigates by
  // setting location.hash, and nothing would answer it otherwise.
  addEventListener('hashchange', () => loadFromRoute());
  // A ?repo= query is rewritten to the hash route so links normalise.
  const q = new URLSearchParams(location.search).get('repo');
  if (q && !location.hash) {
    const repo = parseRepoInput(q);
    if (repo) {
      history.replaceState(null, '', `${location.pathname}#/${repo.owner}/${repo.name}`);
    }
  }
  loadFromRoute();
}

function hasWebGL() {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

// Cinema mode is a "shot" concept the cancel button needs to reach too.
$('loading-cancel').addEventListener('click', () => {
  app.abort?.abort();
  app.hud.showLoading(false);
  showLaunch();
  history.replaceState(null, '', location.pathname);
});

boot();
