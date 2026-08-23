/**
 * The render stage: renderer, camera rig, bloom pipeline, deep-space backdrop.
 *
 * Everything visual in RepoSense leans on the bloom pass — emissive materials
 * are authored deliberately "too bright" so the bloom threshold picks them up
 * and turns them into light sources rather than lit surfaces.
 *
 * The whole pipeline runs in HDR: scene → multisampled half-float target →
 * bloom → ACES tone mapping in the output pass. The multisampling matters
 * because post-processing bypasses the canvas's own antialiasing — the
 * `antialias: true` on the renderer only covers the default framebuffer, so
 * without MSAA on the composer's target every edge in the scene goes jagged
 * the moment the composer takes over.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

export class Stage {
  constructor(container, labelLayer) {
    this.container = container;
    this.clock = new THREE.Clock();
    this.updaters = new Set();

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true, // needed for PNG capture
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.setClearColor(0x04060d, 1);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.classList.add('rs-canvas');

    this.labelRenderer = new CSS2DRenderer({ element: labelLayer });
    labelLayer.classList.add('rs-labels');

    // Every material in the scene is a custom unlit shader, so this scene
    // deliberately carries no lights and no fog — they would be dead weight.
    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(48, 1, 0.5, 6000);
    this.camera.position.set(0, 120, 220);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.055;
    this.controls.rotateSpeed = 0.55;
    this.controls.panSpeed = 0.7;
    this.controls.zoomSpeed = 0.9;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 2200;
    this.controls.maxPolarAngle = Math.PI * 0.92;

    this.starfield = this.#buildStarfield();
    this.scene.add(this.starfield);

    // A multisampled HDR target for the composer (see the header comment).
    // WebGL2 resolves the samples automatically when a pass samples the
    // texture; on a WebGL1 fallback `samples` is ignored and rendering still
    // works, just without the smoothing.
    const composeTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: this.renderer.capabilities.isWebGL2 ? 4 : 0,
    });
    this.composer = new EffectComposer(this.renderer, composeTarget);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // strength / radius / threshold — the threshold is deliberately high so only
    // emissive crowns and rim strips bloom, not every lit surface.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.36, 0.72, 0.74);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    // Adaptive resolution. The ceiling is the device's own pixel ratio (capped
    // at 2); a sustained slow frame rate steps the render scale down, and a
    // sustained fast one steps it back up. Phones and 5K displays land on the
    // density they can actually sustain instead of janking at full DPR.
    this.maxPixelRatio = Math.min(devicePixelRatio || 1, 2);
    this.renderScale = 1;
    this._slowFrames = 0;
    this._fastFrames = 0;
    this._scaleCooldown = 0;

    this._onResize = () => this.resize();
    addEventListener('resize', this._onResize);
    this.resize();
  }

  #applyPixelRatio() {
    const ratio = Math.max(0.75, this.maxPixelRatio * this.renderScale);
    this.renderer.setPixelRatio(ratio);
    this.composer.setPixelRatio(ratio);
    this.starfield.userData.material.uniforms.uPixelRatio.value = ratio;
    this.resize();
  }

  /**
   * One step of the adaptive-resolution controller, fed each frame's delta.
   * Hysteresis on both sides (45 slow frames down, 240 fast frames up, with a
   * cooldown after every change) keeps it from oscillating on a machine that
   * hovers near a threshold.
   */
  #adaptQuality(dt, time) {
    if (time < this._scaleCooldown) return;
    if (dt > 1 / 24) {
      this._slowFrames += 1;
      this._fastFrames = 0;
    } else if (dt < 1 / 50) {
      this._fastFrames += 1;
      this._slowFrames = 0;
    }
    if (this._slowFrames > 45 && this.renderScale > 0.5) {
      this.renderScale = Math.max(0.5, this.renderScale * 0.8);
      this.#applyPixelRatio();
      this._slowFrames = 0;
      this._scaleCooldown = time + 1.5;
    } else if (this._fastFrames > 240 && this.renderScale < 1) {
      this.renderScale = Math.min(1, this.renderScale / 0.8);
      this.#applyPixelRatio();
      this._fastFrames = 0;
      this._scaleCooldown = time + 1.5;
    }
  }

  #buildStarfield() {
    const COUNT = 3800;
    const positions = new Float32Array(COUNT * 3);
    const colors = new Float32Array(COUNT * 3);
    const sizes = new Float32Array(COUNT);
    const tint = new THREE.Color();

    for (let i = 0; i < COUNT; i += 1) {
      // Uniform points on a shell, pushed far enough out to read as sky.
      const u = Math.random() * 2 - 1;
      const theta = Math.random() * Math.PI * 2;
      const r = 1500 + Math.random() * 1900;
      const s = Math.sqrt(1 - u * u);
      positions[i * 3] = Math.cos(theta) * s * r;
      positions[i * 3 + 1] = u * r * 0.72;
      positions[i * 3 + 2] = Math.sin(theta) * s * r;

      tint.setHSL(0.55 + Math.random() * 0.16, 0.55, 0.5 + Math.random() * 0.42);
      colors[i * 3] = tint.r;
      colors[i * 3 + 1] = tint.g;
      colors[i * 3 + 2] = tint.b;
      sizes[i] = Math.random() < 0.06 ? 5.5 : 1.2 + Math.random() * 2.2;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uPixelRatio: { value: Math.min(devicePixelRatio || 1, 2) } },
      vertexShader: `
        attribute float aSize;
        varying vec3 vColor;
        varying float vTwinkle;
        uniform float uTime;
        uniform float uPixelRatio;
        void main() {
          vColor = color;
          vTwinkle = 0.72 + 0.28 * sin(uTime * 0.8 + position.x * 0.01 + position.z * 0.013);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uPixelRatio * (900.0 / -mv.z);
        }`,
      fragmentShader: `
        varying vec3 vColor;
        varying float vTwinkle;
        void main() {
          float d = length(gl_PointCoord - vec2(0.5));
          if (d > 0.5) discard;
          float a = smoothstep(0.5, 0.0, d);
          gl_FragColor = vec4(vColor * vTwinkle, a * a * vTwinkle);
        }`,
      vertexColors: true,
    });

    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.userData.material = mat;
    return points;
  }

  onUpdate(fn) {
    this.updaters.add(fn);
    return () => this.updaters.delete(fn);
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.labelRenderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.frame = requestAnimationFrame(loop);
      const dt = Math.min(this.clock.getDelta(), 0.05);
      const t = this.clock.elapsedTime;
      this.starfield.userData.material.uniforms.uTime.value = t;
      this.starfield.rotation.y = t * 0.006;
      for (const fn of this.updaters) fn(dt, t);
      this.controls.update();
      this.composer.render();
      this.labelRenderer.render(this.scene, this.camera);
      this.#adaptQuality(dt, t);
    };
    loop();
  }

  /**
   * Renders a single frame at an explicit scene time, outside the animation
   * loop. Used by the offline recorder, which drives time itself.
   */
  renderOnce(time) {
    this.starfield.userData.material.uniforms.uTime.value = time;
    this.starfield.rotation.y = time * 0.006;
    // Deliberately no controls.update(): damping is stateful, so it would drag
    // the camera toward wherever the previous frame left it and the same
    // timestamp would render differently depending on what came before. The
    // recorder positions the camera outright.
    this.composer.render();
    this.labelRenderer.render(this.scene, this.camera);
  }

  stop() {
    this.running = false;
    if (this.frame) cancelAnimationFrame(this.frame);
  }

  setQuality(level) {
    // 'high' | 'balanced' | 'performance'
    const ratios = { high: 2, balanced: 1.5, performance: 1 };
    this.maxPixelRatio = Math.min(devicePixelRatio || 1, ratios[level] ?? 1.5);
    this.renderScale = 1;
    this.bloom.enabled = level !== 'performance';
    this.#applyPixelRatio();
  }

  dispose() {
    this.stop();
    removeEventListener('resize', this._onResize);
    this.controls.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
