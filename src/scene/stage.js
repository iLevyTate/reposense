/**
 * The render stage: renderer, camera rig, bloom pipeline, deep-space backdrop.
 *
 * Everything visual in RepoSense leans on the bloom pass. Emissive materials
 * are authored deliberately "too bright" so the bloom threshold picks them up
 * and turns them into light sources rather than lit surfaces.
 *
 * The whole pipeline runs in HDR: scene → half-float target → bloom → ACES
 * tone mapping → FXAA. The FXAA pass exists because post-processing bypasses
 * the canvas's own antialiasing: `antialias: true` on the renderer only
 * covers the default framebuffer, so without it every edge goes jagged the
 * moment the composer takes over. It is deliberately FXAA rather than a
 * multisampled render target: resolving MSAA on a half-float target is where
 * real-world drivers break. An ANGLE/D3D machine shipped a build of that and
 * rendered every repository as a solid white wash while the software
 * rasteriser in CI drew it perfectly. FXAA is one fragment shader sampling
 * one texture; there is nothing driver-specific left to go wrong. It runs
 * after tone mapping, on gamma-encoded output, which is where FXAA's own
 * luminance heuristics expect to work.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
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
    // deliberately carries no lights and no fog; they would be dead weight.
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

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // strength / radius / threshold. The threshold is deliberately high so only
    // emissive crowns and rim strips bloom, not every lit surface. Restraint
    // here is what separates "lit" from "music visualiser".
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.3, 0.68, 0.78);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    // The grade, applied after tone mapping on display-referred colour: a
    // teal lift in the shadows, faint warmth in the highlights, a whisper of
    // desaturation, and fine film grain quantised to 24fps of scene time.
    // The grain is seeded from the timestamp, so the offline recorder gets the identical
    // frame for the identical time. This is the pass that takes the image
    // from "renderer output" to "graded picture".
    this.grade = new ShaderPass({
      name: 'GradeShader',
      uniforms: { tDiffuse: { value: null }, uTime: { value: 0 } },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float uTime;
        varying vec2 vUv;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        void main() {
          vec4 c = texture2D(tDiffuse, vUv);
          float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
          c.rgb += vec3(0.008, 0.013, 0.019) * (1.0 - smoothstep(0.0, 0.45, lum));
          c.rgb *= mix(vec3(1.0), vec3(1.02, 1.0, 0.965), smoothstep(0.55, 1.0, lum));
          c.rgb = mix(vec3(dot(c.rgb, vec3(0.299, 0.587, 0.114))), c.rgb, 0.965);
          float frame = floor(uTime * 24.0);
          float g = hash(gl_FragCoord.xy * 0.7311 + fract(frame * 0.1031) * vec2(173.0, 591.0));
          c.rgb += (g - 0.5) * 0.016;
          gl_FragColor = c;
        }`,
    });
    this.composer.addPass(this.grade);
    // Antialiasing last, after tone mapping and grade (see the header comment
    // for why this is FXAA and not MSAA).
    this.fxaa = new ShaderPass(FXAAShader);
    this.composer.addPass(this.fxaa);

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
    // FXAA needs the drawing-buffer size, which includes the pixel ratio.
    const dpr = this.renderer.getPixelRatio();
    this.fxaa.material.uniforms.resolution.value.set(1 / (w * dpr), 1 / (h * dpr));
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
      this.grade.uniforms.uTime.value = t;
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
    this.grade.uniforms.uTime.value = time;
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
