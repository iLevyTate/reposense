/**
 * Camera direction.
 *
 * Two jobs: a scripted tour that plays the repository like a title sequence,
 * and a `flyTo` used whenever the UI needs to move the camera somewhere
 * specific without teleporting.
 *
 * Shot framing is expressed in spherical coordinates scaled by the structure's
 * own radius, so a three-file repo and a ten-thousand-file monorepo are framed
 * identically well.
 */

import * as THREE from 'three';

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

/**
 * Shot list.
 *   r      multiple of the structure's radius
 *   phi    polar angle (0 = straight overhead, PI/2 = level with the horizon)
 *   theta  azimuth
 *   ty     look-at height, as a fraction of the structure's own height
 */
const SHOTS = [
  {
    name: 'Arrival',
    duration: 7,
    mode: 'arcology',
    from: { r: 4.6, theta: -0.9, phi: 1.44, ty: 0.10 },
    to: { r: 2.15, theta: -0.25, phi: 1.24, ty: 0.42 },
    ease: easeOut,
    caption: 'Arrival',
    sub: 'every file, placed by where it lives',
  },
  {
    name: 'Ascension',
    duration: 7,
    mode: 'arcology',
    from: { r: 2.15, theta: -0.25, phi: 1.24, ty: 0.42 },
    to: { r: 1.5, theta: 0.85, phi: 0.42, ty: 0.55 },
    ease: easeInOut,
    caption: 'Structure',
    sub: 'rings are depth · height is size · colour is language',
  },
  {
    name: 'Descent',
    duration: 8,
    mode: 'arcology',
    from: { r: 1.5, theta: 0.85, phi: 0.42, ty: 0.55 },
    to: { r: 0.9, theta: 2.4, phi: 1.30, ty: 0.62 },
    ease: easeInOut,
    caption: 'Districts',
    sub: 'each terrace is a directory, holding what it contains',
  },
  {
    name: 'Chronology',
    duration: 11,
    mode: 'chronology',
    from: { r: 1.45, theta: 2.4, phi: 1.05, ty: 0.55 },
    to: { r: 1.75, theta: 4.5, phi: 0.72, ty: 0.55 },
    ease: easeInOut,
    caption: 'Chronology',
    sub: 'the repository, rebuilt commit by commit',
  },
  {
    name: 'People',
    duration: 8,
    mode: 'constellation',
    from: { r: 1.25, theta: 4.5, phi: 1.18, ty: 0.75 },
    to: { r: 1.15, theta: 6.1, phi: 1.34, ty: 0.75 },
    ease: easeInOut,
    caption: 'The people',
    sub: 'who built which part of it',
  },
  {
    name: 'Departure',
    duration: 7,
    mode: 'arcology',
    from: { r: 1.4, theta: 6.1, phi: 1.2, ty: 0.6 },
    to: { r: 5.4, theta: 7.3, phi: 0.95, ty: 0.2 },
    ease: easeInOut,
    caption: '',
    sub: '',
  },
];

export const TOUR_DURATION = SHOTS.reduce((s, x) => s + x.duration, 0);
export { SHOTS };

export class Cinema {
  constructor(stage, { onShot, onProgress, onEnd } = {}) {
    this.stage = stage;
    this.onShot = onShot || (() => {});
    this.onProgress = onProgress || (() => {});
    this.onEnd = onEnd || (() => {});
    this.playing = false;
    this.startedAt = null;
    this.radius = 200;
    this.height = 40;
    this.center = new THREE.Vector3();
    this._pos = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._fly = null;
  }

  /** Frames every shot against the structure's real extent. */
  setBounds({ radius, height, center }) {
    this.radius = Math.max(40, radius);
    // A one-tier repository still needs a non-zero look-at height, or the
    // camera stares at the horizon line of a flat disc.
    this.height = Math.max(this.radius * 0.18, height);
    if (center) this.center.set(center.x, center.y, center.z);
  }

  /** Frames the whole structure; used on first load and by "reset view". */
  defaultView(instant = false) {
    const spec = { r: 2.05, theta: -0.55, phi: 1.02, ty: 0.5 };
    const { pos, target } = this.#resolve(spec);
    if (instant) {
      this.stage.camera.position.copy(pos);
      this.stage.controls.target.copy(target);
      this.stage.controls.update();
    } else {
      this.flyTo(pos, target, 1.6);
    }
  }

  /**
   * How much further back this viewport needs to sit than the 16:9 the shots
   * were framed against.
   *
   * three.js fixes the *vertical* field of view, so a narrow or portrait
   * viewport sees less horizontally at the same distance, and a radial
   * structure is far wider than it is tall. Without this correction a phone in
   * portrait crops the outer rings straight off the sides.
   */
  #aspectPullback() {
    const cam = this.stage.camera;
    const halfV = (cam.fov * Math.PI) / 360;
    const halfH = Math.atan(Math.tan(halfV) * cam.aspect);
    const halfRef = Math.atan(Math.tan(halfV) * (16 / 9));
    const exact = Math.sin(halfRef) / Math.sin(halfH);
    // Deliberately under-correct. Fitting the full width of a wide, flat
    // structure into a tall screen technically works, but leaves it stranded in
    // the middle of a mostly empty frame. Softening the exponent trades a
    // little crop at the extremes for a structure that still fills the shot.
    // The lower bound lets a very wide display push *in* a little: there the
    // vertical field is the constraint and horizontal room goes spare, so a
    // 16:9 framing leaves an ultrawide looking emptier than it needs to.
    return Math.min(2.2, Math.max(0.86, Math.pow(exact, 0.65)));
  }

  #resolve(spec) {
    const r = spec.r * this.radius * this.#aspectPullback();
    const sinPhi = Math.sin(spec.phi);
    // `ty` is a fraction of the structure's height, measured about the centre,
    // so 0.5 looks level at the middle of the mass.
    const target = this.center.clone();
    target.y += (spec.ty - 0.5) * this.height;
    return {
      pos: new THREE.Vector3(
        target.x + r * sinPhi * Math.cos(spec.theta),
        target.y + r * Math.cos(spec.phi),
        target.z + r * sinPhi * Math.sin(spec.theta),
      ),
      target,
    };
  }

  static lerpSpec(a, b, t) {
    return {
      r: a.r + (b.r - a.r) * t,
      theta: a.theta + (b.theta - a.theta) * t,
      phi: a.phi + (b.phi - a.phi) * t,
      ty: a.ty + (b.ty - a.ty) * t,
    };
  }

  /** Smoothly move the camera; cancels any tour in progress. */
  /**
   * Both the tour and fly-to run on wall-clock elapsed time rather than
   * accumulated frame deltas.
   *
   * `dt` is capped at 50ms so a backgrounded tab cannot make an animation jump.
   * Integrating that cap makes every animation advance per *frame* instead of
   * per second, so on a machine that cannot hold 60fps a 48-second tour quietly
   * stretches to several minutes, and the recorder promises 48 seconds.
   */
  flyTo(pos, target, duration = 1.2) {
    // stop() rather than clearing `playing`: the tour hides the entire HUD via
    // a class on #viewer, and only the stop path takes it off again. Flying
    // somewhere mid-tour used to leave the UI invisible and unclickable.
    if (this.playing) this.stop();
    this._fly = {
      startedAt: null,
      duration,
      fromPos: this.stage.camera.position.clone(),
      fromTarget: this.stage.controls.target.clone(),
      toPos: pos.clone(),
      toTarget: target.clone(),
    };
    this.stage.controls.enabled = false;
  }

  /**
   * Frames a single file tower.
   *
   * Three-quarter angle rather than head-on: rotated off the radial so the
   * selection beam is beside the building instead of between it and the
   * camera, pulled back and lifted so the shot reads as a establishing view
   * of the tower in its district, not a wall filling the frame.
   */
  flyToNode(node, lift) {
    const y = node.ring * lift;
    const target = new THREE.Vector3(node.x, y + node.height * 0.55, node.z);
    const outward = new THREE.Vector3(node.x, 0, node.z).normalize();
    const swing = 0.5; // radians off the radial
    const dir = new THREE.Vector3(
      outward.x * Math.cos(swing) - outward.z * Math.sin(swing),
      0,
      outward.x * Math.sin(swing) + outward.z * Math.cos(swing),
    );
    const dist = Math.max(40, node.height * 3.6);
    const pos = target
      .clone()
      .add(dir.multiplyScalar(dist * 0.85))
      .add(new THREE.Vector3(0, dist * 0.55, 0));
    this.flyTo(pos, target, 1.1);
  }

  play() {
    this.cancelFly();
    this.playing = true;
    this.time = 0;
    this.startedAt = null; // stamped on the first update, from the wall clock
    this.shotIndex = -1;
    this.stage.controls.enabled = false;
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    this.stage.controls.enabled = true;
    this.onShot(null, 0);
    this.onEnd();
  }

  cancelFly() {
    if (this._fly) {
      this._fly = null;
      this.stage.controls.enabled = true;
    }
  }

  /** Seconds into the tour, used to drive the chronology scrub. */
  shotProgress() {
    return this.playing ? this.time / TOUR_DURATION : 0;
  }

  /** @param {number} time seconds of wall-clock time since the stage started */
  update(dt, time) {
    if (this._fly) {
      const f = this._fly;
      if (f.startedAt === null) f.startedAt = time;
      const elapsed = time - f.startedAt;
      const t = easeInOut(Math.min(1, elapsed / f.duration));
      this.stage.camera.position.lerpVectors(f.fromPos, f.toPos, t);
      this.stage.controls.target.lerpVectors(f.fromTarget, f.toTarget, t);
      if (elapsed >= f.duration) {
        this._fly = null;
        this.stage.controls.enabled = true;
      }
      return;
    }

    if (!this.playing) return;

    if (this.startedAt === null) this.startedAt = time;
    this.time = time - this.startedAt;
    if (this.time >= TOUR_DURATION) {
      this.stop();
      return;
    }

    const shot = this.applyAt(this.time);
    if (this.shotIndex !== shot.index) {
      this.shotIndex = shot.index;
      this.onShot(shot.shot, shot.index);
    }
    this.onProgress(this.time / TOUR_DURATION);
  }

  /**
   * Places the camera for an absolute point in the tour, without advancing any
   * clock.
   *
   * This is what makes offline recording possible: a frame can be asked for by
   * timestamp and comes back identical however long the renderer took, so a
   * runner managing three frames a second still produces smooth 60fps output.
   *
   * @param {number} t seconds into the tour
   * @returns {{shot: object, index: number, local: number}}
   */
  applyAt(t) {
    let acc = 0;
    let index = 0;
    for (let i = 0; i < SHOTS.length; i += 1) {
      if (t < acc + SHOTS[i].duration) {
        index = i;
        break;
      }
      acc += SHOTS[i].duration;
      index = i;
    }
    const shot = SHOTS[index];
    const local = Math.min(1, Math.max(0, (t - acc) / shot.duration));

    const spec = Cinema.lerpSpec(shot.from, shot.to, shot.ease(local));
    const { pos, target } = this.#resolve(spec);
    // A slow handheld drift keeps the tour from feeling like a turntable render.
    // Derived from t, not from elapsed time, so it is reproducible frame to frame.
    const wobble = t * 0.4;
    pos.x += Math.sin(wobble) * this.radius * 0.012;
    pos.y += Math.cos(wobble * 0.77) * this.radius * 0.009;

    this.stage.camera.position.copy(pos);
    this.stage.controls.target.copy(target);
    this.stage.camera.lookAt(target);
    return { shot, index, local };
  }
}

/**
 * Records the live canvas to a WebM file.
 *
 * MediaRecorder captures exactly what is on screen, so the export always
 * matches what the viewer just watched, including their own camera moves.
 */
export class Recorder {
  static supported() {
    return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
  }

  static pickMimeType() {
    const candidates = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
      'video/mp4',
    ];
    return candidates.find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
  }

  constructor(canvas, { fps = 60 } = {}) {
    this.canvas = canvas;
    this.fps = fps;
    this.chunks = [];
    this.recording = false;
  }

  start() {
    if (this.recording) return;
    const mimeType = Recorder.pickMimeType();
    if (!mimeType) throw new Error('This browser cannot record canvas video.');
    this.stream = this.canvas.captureStream(this.fps);
    this.recorder = new MediaRecorder(this.stream, { mimeType, videoBitsPerSecond: 12_000_000 });
    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) this.chunks.push(e.data);
    };
    this.recorder.start(250);
    this.recording = true;
    this.mimeType = mimeType;
  }

  /** @returns {Promise<Blob|null>} */
  stop() {
    if (!this.recording) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.recorder.onstop = () => {
        this.recording = false;
        this.stream.getTracks().forEach((t) => t.stop());
        resolve(new Blob(this.chunks, { type: this.mimeType }));
      };
      this.recorder.stop();
    });
  }
}
