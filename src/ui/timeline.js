/**
 * The Chronology scrubber.
 *
 * A repository's history is something you navigate, so the strip under the
 * playhead answers one question: where did the work happen? That is a single
 * measure — commit activity over time — drawn as bars.
 *
 * It deliberately does NOT also plot cumulative growth behind them. Commits per
 * week and total files are different scales, and putting both on one strip would
 * be a dual-axis chart: the reader cannot tell which curve belongs to which
 * scale, and the crossing point is an artefact of the axis choice rather than
 * anything real. The cumulative state is shown instead as the live readout beside
 * the strip, where an exact number beats a second silhouette.
 *
 * Progress is emphasis within one hue, not a second series: the played span is
 * lit, the rest is recessive.
 */

const MAX_BUCKETS = 72;
const VB_H = 40;
const BAR_STEP = 4;
const BAR_GAP = 1;

export class Timeline {
  /**
   * @param {{track:HTMLElement, svg:SVGElement, playhead:HTMLElement, readout:HTMLElement}} els
   */
  constructor(els) {
    this.els = els;
    this.buckets = [];
    this.range = { start: 0, end: 1 };
    this.onScrub = () => {};

    els.track.addEventListener('pointermove', (e) => this.#hover(e));
    els.track.addEventListener('pointerleave', () => this.#hover(null));
  }

  /**
   * Buckets the payload's weekly commit counts across the scrubber's own range.
   *
   * Falls back to counting files created per bucket when a dataset carries no
   * commit activity, and says so — the shape of the strip means something
   * different then, and a chart that quietly swaps its measure is lying.
   */
  setData(model, range) {
    this.range = range;
    const span = Math.max(1, range.end - range.start);
    const weeks = model.payload.activity || [];

    const inRange = weeks.filter((w) => w.week >= range.start - 604800 && w.week <= range.end + 604800);
    const useCommits = inRange.some((w) => w.commits > 0);

    const count = Math.max(8, Math.min(MAX_BUCKETS, Math.round(span / 604800) || 8));
    const buckets = Array.from({ length: count }, (_, i) => ({
      t0: range.start + (span * i) / count,
      t1: range.start + (span * (i + 1)) / count,
      value: 0,
    }));
    const indexOf = (t) => Math.max(0, Math.min(count - 1, Math.floor(((t - range.start) / span) * count)));

    if (useCommits) {
      for (const w of inRange) buckets[indexOf(w.week)].value += w.commits;
      this.measure = 'commits';
    } else {
      for (const f of model.payload.files || []) {
        if (f.addedAt) buckets[indexOf(f.addedAt)].value += 1;
      }
      this.measure = 'files added';
    }

    this.buckets = buckets;
    this.max = Math.max(1, ...buckets.map((b) => b.value));
    this.#draw();
  }

  #draw() {
    const svg = this.els.svg;
    const n = this.buckets.length;
    const w = n * BAR_STEP;
    svg.setAttribute('viewBox', `0 0 ${w} ${VB_H}`);
    // Bars stretch horizontally with the panel. No rounded ends: at three units
    // wide a radius is invisible, and non-uniform scaling would smear it.
    svg.setAttribute('preserveAspectRatio', 'none');

    const bars = this.buckets
      .map((b, i) => {
        // A floor of 1 unit so an empty week still reads as a tick rather than a
        // gap, which would otherwise look like missing data.
        const h = b.value ? Math.max(2, (b.value / this.max) * (VB_H - 2)) : 1;
        return `<rect x="${i * BAR_STEP}" y="${(VB_H - h).toFixed(2)}" width="${BAR_STEP - BAR_GAP}" height="${h.toFixed(2)}"/>`;
      })
      .join('');

    svg.innerHTML =
      `<defs><clipPath id="rs-spark-clip"><rect id="rs-spark-lit" x="0" y="0" width="0" height="${VB_H}"/></clipPath></defs>` +
      `<g class="rs-spark-base">${bars}</g>` +
      `<g class="rs-spark-on" clip-path="url(#rs-spark-clip)">${bars}</g>`;
    this.clip = svg.querySelector('#rs-spark-lit');
    this.width = w;
  }

  /** @param {number} t01 scrub position, 0..1 */
  setPosition(t01) {
    if (this.clip) this.clip.setAttribute('width', String(this.width * Math.max(0, Math.min(1, t01))));
    this.els.playhead.style.left = `${(t01 * 100).toFixed(3)}%`;
  }

  /** Value under the pointer, for the hover readout. */
  #hover(e) {
    const el = this.els.readout;
    if (!e || !this.buckets.length) {
      el.hidden = true;
      return;
    }
    const rect = this.els.track.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const b = this.buckets[Math.min(this.buckets.length - 1, Math.floor(p * this.buckets.length))];
    const when = new Date(b.t0 * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    el.textContent = `${when} · ${b.value} ${this.measure}`;
    el.hidden = false;
    el.style.left = `${(p * 100).toFixed(2)}%`;
  }

  /** Text describing what the bars are, for the panel. */
  describe() {
    return this.measure === 'commits' ? 'commits per period' : 'files created per period';
  }
}
