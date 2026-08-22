/**
 * The Arcology: a repository rendered as a stepped, radial megastructure.
 *
 * Layout recap (see layout.js): every node owns an angular sector, and depth
 * maps to a concentric ring. Here that becomes architecture —
 *
 *   terrace   a directory's floor, drawn across its children's ring band, so
 *             everything a folder contains literally stands on it
 *   tower     a file, rising from its parent's terrace; height is log(bytes),
 *             colour is language, glow is churn
 *   bridge    the ramp from a sub-directory's slice on its parent terrace out
 *             to its own terrace one tier up and one ring out
 *
 * Terrace altitude lives in a shader uniform (uLift) rather than in vertex
 * data, so the whole structure can rise from a flat disc into a ziggurat
 * without touching a single buffer.
 */

import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { LIFT } from '../layout.js';
import { hexToRgb, colorOf } from '../palette.js';

const MAX_LABELS = 64;

/** Cool grey-blue the directory floors are tinted toward. */
const STRUCTURE_TINT = { r: 0.42, g: 0.52, b: 0.68 };

function mixToward(c, target, t) {
  return {
    r: c.r * (1 - t) + target.r * t,
    g: c.g * (1 - t) + target.g * t,
    b: c.b * (1 - t) + target.b * t,
  };
}

/* Per-instance state, matched in the tower shader. */
const STATE_NORMAL = 1.0;
const STATE_DIM = 0.11;
const STATE_HIGHLIGHT = 2.0;

export class Arcology {
  constructor(model, layout) {
    this.model = model;
    this.layout = layout;
    this.group = new THREE.Group();
    this.lift = LIFT;
    this.uniforms = {
      uLift: { value: LIFT },
      uTime: { value: 0 },
      uHeatBoost: { value: 1 },
      uFade: { value: 0 }, // 0 = fully built, 1 = not yet revealed
    };

    this.fileByInstance = layout.files;
    this.instanceByPath = new Map(layout.files.map((f, i) => [f.path, i]));

    this.#buildTowers();
    this.#buildTerraces();
    this.#buildBridges();
    this.#buildCore();
    this.#buildLabels();
    this.#buildSelection();
  }

  /* ------------------------------------------------------------------ towers */

  #buildTowers() {
    const files = this.layout.files;
    const count = files.length;

    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0); // pivot at the base so scaling grows upward

    const aColor = new Float32Array(count * 3);
    const aRing = new Float32Array(count);
    const aHeat = new Float32Array(count);
    const aState = new Float32Array(count);
    const aAppear = new Float32Array(count);
    const aFlash = new Float32Array(count);
    const aSeed = new Float32Array(count);

    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);

    const mesh = new THREE.InstancedMesh(geo, this.#towerMaterial(), count);
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    // Tower altitude is baked into the instance matrix rather than added in the
    // shader, because the raycaster reads matrices and would otherwise pick
    // towers at the wrong height whenever the structure is lifted.
    this.towerParts = { quat: [], scale: [] };

    for (let i = 0; i < count; i += 1) {
      const f = files[i];
      pos.set(f.x, 0, f.z); // altitude comes from uLift * aRing in the shader
      // Face the tower outward so its flat sides follow the ring, not the axes.
      quat.setFromAxisAngle(up, -f.aMid);
      // Radial depth is capped by the band; tangential width by the arc length.
      scale.set(f.footprint, f.height, Math.min(f.footprint * 1.35, 3.0));
      matrix.compose(pos, quat, scale);
      mesh.setMatrixAt(i, matrix);
      this.towerParts.quat.push(quat.clone());
      this.towerParts.scale.push(scale.clone());

      const c = hexToRgb(colorOf(f.lang));
      aColor[i * 3] = c.r;
      aColor[i * 3 + 1] = c.g;
      aColor[i * 3 + 2] = c.b;
      aRing[i] = f.ring;
      aHeat[i] = f.heat || 0;
      aState[i] = STATE_NORMAL;
      aAppear[i] = 1;
      aFlash[i] = 0;
      aSeed[i] = (i * 0.6180339887) % 1;
    }

    geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(aColor, 3));
    geo.setAttribute('aRing', new THREE.InstancedBufferAttribute(aRing, 1));
    geo.setAttribute('aHeat', new THREE.InstancedBufferAttribute(aHeat, 1));
    geo.setAttribute('aState', new THREE.InstancedBufferAttribute(aState, 1));
    geo.setAttribute('aAppear', new THREE.InstancedBufferAttribute(aAppear, 1));
    geo.setAttribute('aFlash', new THREE.InstancedBufferAttribute(aFlash, 1));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(aSeed, 1));

    this.towers = mesh;
    this.attrs = {
      aHeat: geo.attributes.aHeat,
      aState: geo.attributes.aState,
      aAppear: geo.attributes.aAppear,
      aFlash: geo.attributes.aFlash,
    };
    this.group.add(mesh);
  }

  #towerMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      vertexShader: `
        attribute vec3 aColor;
        attribute float aRing;
        attribute float aHeat;
        attribute float aState;
        attribute float aAppear;
        attribute float aFlash;
        attribute float aSeed;

        uniform float uLift;
        uniform float uTime;
        uniform float uFade;

        varying vec3 vColor;
        varying float vY;
        varying float vHeat;
        varying float vState;
        varying vec3 vNormalW;
        varying vec3 vViewDir;
        varying float vAlpha;
        varying float vFlash;

        void main() {
          vFlash = aFlash;
          vColor = aColor;
          vHeat = aHeat;
          vState = aState;
          vY = position.y; // 0 at base, 1 at tip (box was translated)

          // The reveal sweeps outward: outer rings finish building last.
          float reveal = clamp((1.0 - uFade) * 3.0 - aRing * 0.42 - aSeed * 0.25, 0.0, 1.0);
          reveal = reveal * reveal * (3.0 - 2.0 * reveal);
          float grow = aAppear * reveal;
          vAlpha = step(0.001, grow);

          vec3 p = position;
          p.y *= grow;

          vec4 world = instanceMatrix * vec4(p, 1.0);

          vNormalW = normalize(mat3(instanceMatrix) * normal);
          vec4 mv = modelViewMatrix * world;
          vViewDir = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        precision highp float;
        uniform float uTime;
        uniform float uHeatBoost;

        varying vec3 vColor;
        varying float vY;
        varying float vHeat;
        varying float vState;
        varying vec3 vNormalW;
        varying vec3 vViewDir;
        varying float vAlpha;
        varying float vFlash;

        void main() {
          if (vAlpha < 0.5) discard;

          // Stylised lighting: a fixed key direction plus a fresnel rim. Real
          // lights would flatten the silhouettes the bloom pass depends on.
          vec3 keyDir = normalize(vec3(0.45, 0.8, 0.35));
          float lambert = max(dot(normalize(vNormalW), keyDir), 0.0);
          float fres = pow(1.0 - max(dot(normalize(vNormalW), normalize(vViewDir)), 0.0), 2.4);

          // Windows-in-a-tower feel: dark plinth fading to a lit crown.
          float crown = smoothstep(0.15, 1.0, vY);
          vec3 base = mix(vColor * 0.14, vColor, 0.52 + 0.48 * crown);
          vec3 col = base * (0.26 + 0.62 * lambert);
          col += vColor * fres * 0.26;
          col += vColor * crown * crown * 0.16;

          // Churn reads as a heat shimmer climbing the tower.
          float pulse = 0.6 + 0.4 * sin(uTime * 2.2 + vY * 6.0);
          col += vColor * vHeat * uHeatBoost * pulse * (0.5 + crown) * 1.1;
          col += vec3(1.0, 0.55, 0.25) * vHeat * uHeatBoost * crown * 0.40;

          // A file appearing in the timeline flares white and settles. It reads
          // as the moment of creation rather than as decoration: what lights up
          // is exactly what that stretch of history added.
          col += vec3(1.0, 0.95, 0.85) * vFlash * (1.4 + crown * 2.2);

          float alpha = 1.0;
          if (vState < 0.5) {          // dimmed by a search
            col *= vState * 2.2;
            alpha = 0.30;
          } else if (vState > 1.5) {   // search hit
            col = mix(col, vec3(1.0), 0.30) * 2.4;
          }

          gl_FragColor = vec4(col, alpha);
        }`,
    });
  }

  /* ---------------------------------------------------------------- terraces */

  /**
   * One merged mesh for every directory floor, plus an additive rim ribbon
   * along the outer edge that the bloom pass turns into a light strip.
   */
  #buildTerraces() {
    const dirs = [this.model.root, ...this.layout.dirs];
    const floors = { pos: [], col: [], ring: [], idx: [] };
    const rims = { pos: [], col: [], ring: [], idx: [] };
    let fBase = 0;
    let rBase = 0;

    for (const d of dirs) {
      const ring = d.ring + 1; // a folder's floor carries its children
      const r0 = ring * this.layout.ringGap;
      const r1 = r0 + this.layout.band;
      const span = d.a1 - d.a0;
      if (span <= 0.0004) continue;
      const segs = Math.max(2, Math.min(96, Math.ceil((span * r1) / 1.6)));
      const rc = hexToRgb(colorOf(d.lang));

      // Floors are tinted toward a cool structural grey rather than painted
      // in the full language colour: a repo that is 97% one language would
      // otherwise render as one flat sheet, and the towers — which carry the
      // real per-file colour — would have nothing to stand out against.
      const c = mixToward(hexToRgb(colorOf(d.lang)), STRUCTURE_TINT, 0.45);
      // Deeper folders sit further out and read dimmer, which keeps the eye on
      // the trunk of the tree rather than the leaves.
      const dim = Math.max(0.28, 1 - d.depth * 0.11);

      for (let s = 0; s <= segs; s += 1) {
        const a = d.a0 + (span * s) / segs;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        floors.pos.push(ca * r0, 0, sa * r0, ca * r1, 0, sa * r1);
        floors.col.push(c.r * 0.045 * dim, c.g * 0.045 * dim, c.b * 0.045 * dim);
        floors.col.push(c.r * 0.26 * dim, c.g * 0.26 * dim, c.b * 0.26 * dim);
        floors.ring.push(ring, ring);

        // Rims keep the undiluted language colour so each tier still reads.
        const rimIn = r1 - 0.55;
        rims.pos.push(ca * rimIn, 0, sa * rimIn, ca * r1, 0, sa * r1);
        rims.col.push(rc.r * 0.18 * dim, rc.g * 0.18 * dim, rc.b * 0.18 * dim);
        rims.col.push(rc.r * 1.15 * dim, rc.g * 1.15 * dim, rc.b * 1.15 * dim);
        rims.ring.push(ring, ring);
      }
      for (let s = 0; s < segs; s += 1) {
        const i = fBase + s * 2;
        floors.idx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
        const j = rBase + s * 2;
        rims.idx.push(j, j + 1, j + 2, j + 1, j + 3, j + 2);
      }
      fBase += (segs + 1) * 2;
      rBase += (segs + 1) * 2;
    }

    this.terraces = new THREE.Mesh(
      makeGeometry(floors),
      this.#surfaceMaterial({ opacity: 0.96, additive: false, depthWrite: true }),
    );
    this.terraces.frustumCulled = false;
    this.terraces.renderOrder = -1;

    this.rims = new THREE.Mesh(
      makeGeometry(rims),
      this.#surfaceMaterial({ opacity: 1, additive: true, depthWrite: false }),
    );
    this.rims.frustumCulled = false;

    this.group.add(this.terraces, this.rims);
  }

  #surfaceMaterial({ opacity, additive, depthWrite }) {
    return new THREE.ShaderMaterial({
      uniforms: { ...this.uniforms, uOpacity: { value: opacity } },
      transparent: true,
      depthWrite,
      side: THREE.DoubleSide,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: `
        attribute float aRing;
        attribute vec3 aColor;
        uniform float uLift;
        uniform float uFade;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = aColor;
          float reveal = clamp((1.0 - uFade) * 3.0 - aRing * 0.42, 0.0, 1.0);
          vAlpha = reveal * reveal * (3.0 - 2.0 * reveal);
          vec3 p = position;
          p.y += aRing * uLift;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `
        uniform float uOpacity;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          if (vAlpha < 0.01) discard;
          gl_FragColor = vec4(vColor, uOpacity * vAlpha);
        }`,
    });
  }

  /* ----------------------------------------------------------------- bridges */

  /** Ramps linking a sub-directory's slice to the terrace it opens onto. */
  #buildBridges() {
    const pos = [];
    const col = [];
    const ring = [];

    for (const d of this.layout.dirs) {
      const innerRing = d.ring;
      const outerRing = d.ring + 1;
      const rInner = innerRing * this.layout.ringGap + this.layout.band;
      const rOuter = outerRing * this.layout.ringGap;
      const c = hexToRgb(colorOf(d.lang));
      const dim = Math.max(0.3, 1 - d.depth * 0.12);
      // Two rails at the sector edges read as a bridge; one line reads as noise.
      for (const a of [d.a0 + (d.a1 - d.a0) * 0.16, d.a1 - (d.a1 - d.a0) * 0.16]) {
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        pos.push(ca * rInner, 0, sa * rInner, ca * rOuter, 0, sa * rOuter);
        col.push(c.r * 0.16 * dim, c.g * 0.16 * dim, c.b * 0.16 * dim);
        col.push(c.r * 0.6 * dim, c.g * 0.6 * dim, c.b * 0.6 * dim);
        ring.push(innerRing, outerRing);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(col), 3));
    geo.setAttribute('aRing', new THREE.BufferAttribute(new Float32Array(ring), 1));

    this.bridges = new THREE.LineSegments(
      geo,
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: `
          attribute vec3 aColor;
          attribute float aRing;
          uniform float uLift;
          uniform float uFade;
          varying vec3 vColor;
          varying float vAlpha;
          void main() {
            vColor = aColor;
            float reveal = clamp((1.0 - uFade) * 3.0 - aRing * 0.42, 0.0, 1.0);
            vAlpha = reveal;
            vec3 p = position;
            p.y += aRing * uLift;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
          }`,
        fragmentShader: `
          varying vec3 vColor;
          varying float vAlpha;
          void main() {
            if (vAlpha < 0.01) discard;
            gl_FragColor = vec4(vColor, 0.65 * vAlpha);
          }`,
      }),
    );
    this.bridges.frustumCulled = false;
    this.group.add(this.bridges);
  }

  /* -------------------------------------------------------------------- core */

  /** The repository root, rendered as the star everything else orbits. */
  #buildCore() {
    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(4.2, 4),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        vertexShader: `
          varying vec3 vN;
          varying vec3 vV;
          uniform float uTime;
          void main() {
            vN = normalize(normalMatrix * normal);
            vec3 p = position * (1.0 + 0.045 * sin(uTime * 1.4 + position.y * 1.5));
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            vV = normalize(-mv.xyz);
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: `
          varying vec3 vN;
          varying vec3 vV;
          uniform float uTime;
          void main() {
            float fres = pow(1.0 - max(dot(vN, vV), 0.0), 1.6);
            vec3 col = mix(vec3(0.25, 0.85, 1.0), vec3(0.85, 0.45, 1.0), fres);
            float pulse = 0.75 + 0.25 * sin(uTime * 1.8);
            gl_FragColor = vec4(col * (0.55 + fres * 2.2) * pulse, 1.0);
          }`,
      }),
    );
    core.position.y = 2;
    this.core = core;
    this.group.add(core);
  }

  /* ------------------------------------------------------------------ labels */

  #buildLabels() {
    this.labels = [];
    const candidates = this.layout.dirs
      .filter((d) => d.labelWorthy)
      .sort((a, b) => a.depth - b.depth || b.weight - a.weight)
      .slice(0, MAX_LABELS);

    for (const d of candidates) {
      const el = document.createElement('div');
      el.className = 'rs-label';
      el.dataset.depth = String(d.depth);
      el.innerHTML = `<span class="rs-label-name"></span><span class="rs-label-meta"></span>`;
      el.querySelector('.rs-label-name').textContent = d.name;
      el.querySelector('.rs-label-meta').textContent = `${d.leafCount}`;
      el.style.setProperty('--label-color', colorOf(d.lang));

      const obj = new CSS2DObject(el);
      const ring = d.ring + 1;
      const r = ring * this.layout.ringGap + this.layout.band * 0.5;
      obj.position.set(Math.cos(d.aMid) * r, 0, Math.sin(d.aMid) * r);
      obj.userData.ring = ring;
      obj.userData.node = d;
      this.group.add(obj);
      this.labels.push(obj);
    }
  }

  /* --------------------------------------------------------------- selection */

  #buildSelection() {
    // A vertical light column marking the hovered or selected file.
    const geo = new THREE.CylinderGeometry(0.55, 0.55, 1, 12, 1, true);
    geo.translate(0, 0.5, 0);
    this.beam = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: { uTime: this.uniforms.uTime, uColor: { value: new THREE.Color(0xffffff) } },
        vertexShader: `
          varying float vY;
          void main() {
            vY = position.y;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          uniform float uTime;
          uniform vec3 uColor;
          varying float vY;
          void main() {
            float fade = pow(1.0 - vY, 1.5);
            float scan = 0.55 + 0.45 * sin(uTime * 4.0 - vY * 14.0);
            gl_FragColor = vec4(uColor * (0.8 + scan), fade * 0.55);
          }`,
      }),
    );
    this.beam.visible = false;
    this.group.add(this.beam);
  }

  /* ------------------------------------------------------------------- state */

  setLift(lift) {
    if (this.lift === lift && this._liftBaked) return;
    this.lift = lift;
    this.uniforms.uLift.value = lift; // terraces, rims and bridges
    this.#bakeTowerLift();
    this._liftBaked = true;
  }

  #bakeTowerLift() {
    const files = this.layout.files;
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    for (let i = 0; i < files.length; i += 1) {
      const f = files[i];
      pos.set(f.x, f.ring * this.lift, f.z);
      m.compose(pos, this.towerParts.quat[i], this.towerParts.scale[i]);
      this.towers.setMatrixAt(i, m);
    }
    this.towers.instanceMatrix.needsUpdate = true;
    this.towers.computeBoundingSphere();
  }

  setFade(fade) {
    this.uniforms.uFade.value = fade;
  }

  /** Marks a file with the hover/selection beam. Pass null to clear. */
  focus(file) {
    if (!file) {
      this.beam.visible = false;
      return;
    }
    const y = file.ring * this.lift;
    this.beam.position.set(file.x, y, file.z);
    this.beam.scale.set(1, Math.max(file.height * 1.9, 26), 1);
    this.beam.material.uniforms.uColor.value.set(colorOf(file.lang));
    this.beam.visible = true;
  }

  /** Applies a search predicate; pass null to restore everything. */
  applyFilter(predicate) {
    const state = this.attrs.aState.array;
    let hits = 0;
    for (let i = 0; i < state.length; i += 1) {
      if (!predicate) {
        state[i] = STATE_NORMAL;
      } else if (predicate(this.fileByInstance[i])) {
        state[i] = STATE_HIGHLIGHT;
        hits += 1;
      } else {
        state[i] = STATE_DIM;
      }
    }
    this.attrs.aState.needsUpdate = true;
    return hits;
  }

  /**
   * Time playback. `t` is a unix timestamp in seconds.
   *
   * Files with a known creation time grow in as history reaches them; without
   * one, every file stays present and only the heat responds. That distinction
   * is surfaced in the HUD so the timeline is never silently lying.
   */
  applyTime(t, { hasHistory, window: win = 60 * 60 * 24 * 45 }) {
    const appear = this.attrs.aAppear.array;
    const heat = this.attrs.aHeat.array;
    const flash = this.attrs.aFlash.array;
    let visible = 0;
    let bytes = 0;
    let appeared = 0;

    for (let i = 0; i < appear.length; i += 1) {
      const f = this.fileByInstance[i];
      let present = 1;
      if (hasHistory && f.addedAt) {
        // Ease the last few days of growth so towers rise rather than pop.
        const age = t - f.addedAt;
        present = age <= 0 ? 0 : Math.min(1, age / (60 * 60 * 24 * 3));
      } else if (hasHistory) {
        present = 1;
      }
      // Flare on the transition into existence, then decay. Scrubbing backwards
      // must not flare — going back in time is not a creation event.
      if (present > 0.02 && appear[i] <= 0.02) {
        flash[i] = 1;
        appeared += 1;
      } else if (flash[i] > 0) {
        flash[i] = Math.max(0, flash[i] - 0.06);
      }

      appear[i] = present;
      if (present > 0.02) {
        visible += 1;
        bytes += f.size * present;
      }
      const touched = f.lastTouched || 0;
      if (touched && touched <= t) {
        const recency = Math.max(0, 1 - (t - touched) / win);
        heat[i] = Math.max(f.heat * 0.25, recency * Math.max(0.35, f.heat));
      } else {
        heat[i] = touched ? 0 : f.heat * 0.25;
      }
    }
    this.attrs.aAppear.needsUpdate = true;
    this.attrs.aHeat.needsUpdate = true;
    this.attrs.aFlash.needsUpdate = true;
    return { visible, bytes, appeared };
  }

  /** Restores the static (non-playback) appearance. */
  resetTime() {
    const appear = this.attrs.aAppear.array;
    const heat = this.attrs.aHeat.array;
    const flash = this.attrs.aFlash.array;
    for (let i = 0; i < appear.length; i += 1) {
      appear[i] = 1;
      flash[i] = 0;
      heat[i] = this.fileByInstance[i].heat || 0;
    }
    this.attrs.aAppear.needsUpdate = true;
    this.attrs.aHeat.needsUpdate = true;
    this.attrs.aFlash.needsUpdate = true;
  }

  update(dt, time, camera) {
    this.uniforms.uTime.value = time;
    this.core.rotation.y = time * 0.16;
    this.core.rotation.x = Math.sin(time * 0.21) * 0.24;

    // Labels are real scene objects, so they need the animated lift applied.
    // Visibility is judged per label against the camera, scaled by how big this
    // particular structure is — a fixed distance would show everything on a
    // small repo and nothing on a large one.
    // Label thresholds are distances, and a narrow viewport parks the camera
    // further back (see Cinema#aspectPullback) — so the same rule has to be
    // scaled by the same factor, or a phone shows no labels at all.
    const halfV = (camera.fov * Math.PI) / 360;
    const halfH = Math.atan(Math.tan(halfV) * camera.aspect);
    const halfRef = Math.atan(Math.tan(halfV) * (16 / 9));
    const pullback = Math.min(2.2, Math.max(0.86, Math.pow(Math.sin(halfRef) / Math.sin(halfH), 0.65)));
    const unit = (this.layout.fitRadius || 100) * pullback;
    // Narrow viewports also get fewer tiers: the same 14 pills that read as
    // annotation on a desktop bury a phone screen.
    const narrow = innerWidth < 720;
    const budget = 4;
    for (const obj of this.labels) {
      obj.position.y = obj.userData.ring * this.lift + 3.2;
      const d = obj.userData.node.depth;
      if (narrow && d > 1) {
        // On a phone only the top-level districts are worth naming.
        obj.visible = false;
        continue;
      }
      obj.getWorldPosition(_labelPos);
      const dist = _labelPos.distanceTo(camera.position);
      // Shallow folders stay legible from further out; deep ones only appear
      // once you fly in, which keeps the wide shots clean.
      const threshold = unit * (2.2 + (budget - Math.min(d, budget)) * 0.75);
      obj.visible = dist < threshold;
    }
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
      if (o.element) o.element.remove();
    });
  }
}

const _labelPos = new THREE.Vector3();

function makeGeometry({ pos, col, ring, idx }) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(col), 3));
  geo.setAttribute('aRing', new THREE.BufferAttribute(new Float32Array(ring), 1));
  geo.setIndex(idx);
  return geo;
}
