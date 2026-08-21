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

export class Cinema {
  constructor(stage, { onShot, onProgress, onEnd } = {}) {
    this.stage = stage;
    this.onShot = onShot || (() => {});
    this.onProgress = onProgress || (() => {});
    this.onEnd = onEnd || (() => {});
    this.playing = false;
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

  #resolve(spec) {
    const r = spec.r * this.radius;
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
  flyTo(pos, target, duration = 1.2) {
    this.playing = false;
    this._fly = {
      t: 0,
      duration,
      fromPos: this.stage.camera.position.clone(),
      fromTarget: this.stage.controls.target.clone(),
      toPos: pos.clone(),
      toTarget: target.clone(),
    };
    this.stage.controls.enabled = false;
  }

  /** Frames a single file tower head-on. */
  flyToNode(node, lift) {
    const y = node.ring * lift;
    const target = new THREE.Vector3(node.x, y + node.height * 0.5, node.z);
    const outward = new THREE.Vector3(node.x, 0, node.z).normalize();
    const dist = Math.max(26, node.height * 2.6);
    const pos = target
      .clone()
      .add(outward.multiplyScalar(dist * 0.75))
      .add(new THREE.Vector3(0, dist * 0.55, 0));
    this.flyTo(pos, target, 1.1);
  }

  play() {
    this.cancelFly();
    this.playing = true;
    this.time = 0;
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

  update(dt) {
    if (this._fly) {
      const f = this._fly;
      f.t += dt;
      const t = easeInOut(Math.min(1, f.t / f.duration));
      this.stage.camera.position.lerpVectors(f.fromPos, f.toPos, t);
      this.stage.controls.target.lerpVectors(f.fromTarget, f.toTarget, t);
      if (f.t >= f.duration) {
        this._fly = null;
        this.stage.controls.enabled = true;
      }
      return;
    }

    if (!this.playing) return;

    this.time += dt;
    if (this.time >= TOUR_DURATION) {
      this.stop();
      return;
    }

    let acc = 0;
    let index = 0;
    for (let i = 0; i < SHOTS.length; i += 1) {
      if (this.time < acc + SHOTS[i].duration) {
        index = i;
        break;
      }
      acc += SHOTS[i].duration;
      index = i;
    }
    const shot = SHOTS[index];
    const local = Math.min(1, (this.time - acc) / shot.duration);

    if (index !== this.shotIndex) {
      this.shotIndex = index;
      this.onShot(shot, index);
    }

    const spec = Cinema.lerpSpec(shot.from, shot.to, shot.ease(local));
    const { pos, target } = this.#resolve(spec);
    // A slow handheld drift keeps the tour from feeling like a turntable render.
    const wobble = this.time * 0.4;
    pos.x += Math.sin(wobble) * this.radius * 0.012;
    pos.y += Math.cos(wobble * 0.77) * this.radius * 0.009;

    this.stage.camera.position.copy(pos);
    this.stage.controls.target.copy(target);
    this.onProgress(this.time / TOUR_DURATION);
  }
}

/**
 * Records the live canvas to a WebM file.
 *
 * MediaRecorder captures exactly what is on screen, so the export always
 * matches what the viewer just watched — including their own camera moves.
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
