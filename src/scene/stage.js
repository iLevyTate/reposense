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

/**
 * Seeded PRNG for anything that reaches a rendered frame. Math.random would
 * give every machine, and every reload, a different sky, and the recording
 * hook's contract is that one timestamp is one image everywhere.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

    this.sky = this.#buildSky();
    this.scene.add(this.sky);
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
    // desaturation, a corner vignette, and fine film grain quantised to 24fps
    // of scene time. The grain is seeded from the timestamp, so the offline
    // recorder gets the identical frame for the identical time; its strength
    // is a uniform so reduced-motion viewers get a still image. This is the
    // pass that takes the image from "renderer output" to "graded picture".
    this.grade = new ShaderPass({
      name: 'GradeShader',
      uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uGrain: { value: 0.016 } },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float uTime;
        uniform float uGrain;
        varying vec2 vUv;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        void main() {
          vec4 c = texture2D(tDiffuse, vUv);
          float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
          c.rgb += vec3(0.008, 0.013, 0.019) * (1.0 - smoothstep(0.0, 0.45, lum));
          c.rgb *= mix(vec3(1.0), vec3(1.02, 1.0, 0.965), smoothstep(0.55, 1.0, lum));
          c.rgb = mix(vec3(dot(c.rgb, vec3(0.299, 0.587, 0.114))), c.rgb, 0.965);
          // Vignette: untouched inside the middle, sliding to a gentle corner
          // falloff. It focuses the eye without reading as a dark frame.
          float d = length(vUv - 0.5) * 1.35;
          c.rgb *= 1.0 - 0.16 * smoothstep(0.5, 1.05, d);
          // One noise field was doing two jobs that want opposite things, and
          // the sky lost the argument. Grain has to move to read as grain;
          // dither has to hold still or it is flicker. They are separate now.
          //
          // Film grain: animated, and confined to the midtones and highlights.
          // At flat amplitude it was 0.016 of full scale everywhere, which is
          // nothing on a lit tower at 200 of 255 and a 14% swing on sky at 21,
          // so the darkest part of the frame carried the loudest grain. The
          // 24fps quantisation then held each field for two or three frames
          // before jumping, and that read as the sky flickering, worst in a
          // portrait viewport where the top of the frame is only sky.
          float gLum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
          float frame = floor(uTime * 24.0);
          float g = hash(gl_FragCoord.xy * 0.7311 + fract(frame * 0.1031) * vec2(173.0, 591.0));
          c.rgb += (g - 0.5) * uGrain * smoothstep(0.05, 0.6, gLum);
          // Dither: fixed in screen space, so it never flickers however long
          // the frame is held. It is here because the sky needs it. Horizon to
          // zenith spans about 25 of the 255 levels, so without a dither that
          // ramp quantises into bands tens of pixels deep. Roughly one level,
          // which is the usual amount, and below the threshold of sight on
          // every surface that does not need it.
          c.rgb += (hash(gl_FragCoord.xy * 1.7137 + 19.0) - 0.5) * (1.2 / 255.0);
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

    // Resizing the drawing buffer throws its contents away, so every resize is
    // deferred to the top of a frame rather than run where it was asked for.
    // See the note in start().
    this._needsResize = false;
    this._onResize = () => {
      if (this.running) this._needsResize = true;
      else this.resize();
    };
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
      this._needsResize = true;
      this._slowFrames = 0;
      this._scaleCooldown = time + 1.5;
    } else if (this._fastFrames > 240 && this.renderScale < 1) {
      this.renderScale = Math.min(1, this.renderScale / 0.8);
      this._needsResize = true;
      this._fastFrames = 0;
      this._scaleCooldown = time + 1.5;
    }
  }

  /**
   * The sky is a graded dome, not a flat clear colour. Two faint pools of
   * colour, a cool cyan low on one side and a violet high on the other, give
   * the void a horizon and a direction; the stars then sit in an atmosphere
   * instead of on black glass.
   */
  #buildSky() {
    const geo = new THREE.SphereGeometry(2800, 32, 24);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying vec3 vDir;
        void main() {
          // Base: deep navy at the horizon rising to near-black overhead.
          float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
          vec3 col = mix(vec3(0.022, 0.032, 0.062), vec3(0.008, 0.011, 0.022), pow(h, 0.7));
          // Two colour pools, fixed in world space.
          float cyan = pow(max(dot(vDir, normalize(vec3(-0.6, -0.12, 0.75))), 0.0), 3.0);
          float violet = pow(max(dot(vDir, normalize(vec3(0.7, 0.45, -0.5))), 0.0), 3.5);
          col += vec3(0.012, 0.03, 0.05) * cyan;
          col += vec3(0.028, 0.016, 0.045) * violet;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const dome = new THREE.Mesh(geo, mat);
    dome.renderOrder = -10;
    dome.frustumCulled = false;
    return dome;
  }

  #buildStarfield() {
    const COUNT = 3800;
    const rand = mulberry32(0x5741b1ed);
    // Twinkle is drawn from its own stream so that adding it left every star
    // exactly where it already was.
    const twinkleRand = mulberry32(0x1f83d9ab);
    const positions = new Float32Array(COUNT * 3);
    const colors = new Float32Array(COUNT * 3);
    const sizes = new Float32Array(COUNT);
    // Per star: the phase it starts at and the rate it runs at.
    const twinkle = new Float32Array(COUNT * 2);
    const tint = new THREE.Color();

    for (let i = 0; i < COUNT; i += 1) {
      // Uniform points on a shell, pushed far enough out to read as sky.
      const u = rand() * 2 - 1;
      const theta = rand() * Math.PI * 2;
      const r = 1500 + rand() * 1900;
      const s = Math.sqrt(1 - u * u);
      positions[i * 3] = Math.cos(theta) * s * r;
      positions[i * 3 + 1] = u * r * 0.72;
      positions[i * 3 + 2] = Math.sin(theta) * s * r;

      tint.setHSL(0.55 + rand() * 0.16, 0.55, 0.5 + rand() * 0.42);
      colors[i * 3] = tint.r;
      colors[i * 3 + 1] = tint.g;
      colors[i * 3 + 2] = tint.b;
      sizes[i] = rand() < 0.06 ? 5.5 : 1.2 + rand() * 2.2;

      twinkle[i * 2] = twinkleRand() * Math.PI * 2;
      twinkle[i * 2 + 1] = 0.45 + twinkleRand() * 0.95;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('aTwinkle', new THREE.BufferAttribute(twinkle, 2));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uPixelRatio: { value: Math.min(devicePixelRatio || 1, 2) } },
      vertexShader: `
        attribute float aSize;
        attribute vec2 aTwinkle;
        varying vec3 vColor;
        varying float vTwinkle;
        uniform float uTime;
        uniform float uPixelRatio;
        void main() {
          vColor = color;
          // Phase and rate are per star. They used to come from the star's own
          // position, which made the phase a smooth function of where a star
          // sat: the field laid about 17 alternating bright and dim bands
          // across the sky and swept them past the camera once every 7.85
          // seconds. Neighbouring stars are a median 166 units apart against a
          // 383-unit wavelength, so they rose and fell together and the sky
          // pulsed as one surface instead of scintillating. Independent phases
          // drop the correlation between neighbours from 0.25 to zero, and
          // independent rates leave no single frequency for the eye to lock
          // onto.
          vTwinkle = 0.72 + 0.28 * sin(uTime * aTwinkle.y + aTwinkle.x);
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
    // Behind everything the scene puts in front of it, and pinned there: the
    // stars write no depth, so a distance sort that ever placed them after a
    // structure would let them draw straight over it.
    points.renderOrder = -9;
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
    // Sizing the composer sizes every pass it owns, at the drawing-buffer
    // resolution (`width * pixelRatio`). The bloom must not be re-sized after
    // it: passing CSS pixels rebuilt its whole mip chain at half resolution on
    // a 2x display and left `invSize` describing a texel that no longer
    // matched the one being sampled, so thin bright features (rim strips,
    // window grids, tower crowns) aliased in the blur and crawled as the
    // camera moved. It is invisible at devicePixelRatio 1, which is why CI
    // never saw it.
    this.composer.setSize(w, h);
    // FXAA needs the drawing-buffer size, which includes the pixel ratio.
    // Unlike the bloom, ShaderPass does not implement setSize, so the
    // composer cannot do this one.
    const dpr = this.renderer.getPixelRatio();
    this.fxaa.material.uniforms.resolution.value.set(1 / (w * dpr), 1 / (h * dpr));
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.frame = requestAnimationFrame(loop);
      // Every resize lands here, at the top of a frame, never where it was
      // asked for. Reallocating the drawing buffer discards its contents, and
      // the adaptive controller used to do that after composer.render(), as
      // the last statement of the callback, so the browser had a buffer to
      // composite that nothing had drawn into. What such a buffer shows is
      // undefined and up to the driver. The controller trips after 45
      // sustained slow frames, which is what a first load looks like while
      // shaders compile and the structure builds; a warm reload never gets
      // slow enough to trip it.
      if (this._needsResize) {
        this._needsResize = false;
        this.#applyPixelRatio();
      }
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
    if (this.running) this._needsResize = true;
    else this.#applyPixelRatio();
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
