/**
 * The Arcology: a repository rendered as a stepped, radial megastructure.
 *
 * Layout recap (see layout.js): every node owns an angular sector, and depth
 * maps to a concentric ring. Here that becomes architecture:
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
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { LIFT } from '../layout.js';
import { hexToRgb, colorOf } from '../palette.js';

const MAX_LABELS = 64;

/**
 * Fixed draw order for the transparent queue.
 *
 * Three.js sorts transparent objects by distance to the camera, so two meshes
 * that overlap on screen can swap places from one frame to the next. When the
 * additive rim strips landed behind the towers instead of in front of them,
 * a whole terrace edge blinked out for a frame and came back, which is the
 * flicker that made the structure look like it was phasing through its own
 * datum plane. Pinning the order removes the swap and, as a bonus, makes the
 * recorded frames independent of the camera path that reached them.
 */
const ORDER = {
  ground: -4,
  terraces: -3,
  shadows: -2,
  towers: 0,
  rims: 1,
  bridges: 1,
  motes: 2,
  beam: 3,
  core: 3,
};

/**
 * Depth-buffer bias for surfaces that share a plane with the terrace they sit
 * on: the rim strips and the contact shadows. Polygon offset is expressed in
 * units of the smallest resolvable depth difference at the fragment, so one
 * constant holds from a close fly-by to the widest establishing shot. A world
 * space epsilon cannot: 0.07 of a unit separates two surfaces cleanly at 40
 * units from the camera and is worth a fraction of a depth step at 900.
 */
const DECAL_OFFSET = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 };

/**
 * How much later each tier starts building during the reveal: one step per
 * ring outward, plus a small per-tower jitter so a district does not rise as
 * one slab. The two are summed into `uStagger` and folded back into the rate
 * (see the reveal expression in every shader below), because a fixed rate
 * runs out of animation before the outermost ring is done. At the old rate of
 * 3.0 a seventh ring finished the sweep 6% built and stayed there: uFade
 * reads 0, the structure is declared complete, and the deepest folders sit on
 * the datum plane as ghosts of themselves with their towers still flat.
 */
const RING_STAGGER = 0.42;
const SEED_STAGGER = 0.25;

/** Cool grey-blue the directory floors are tinted toward. */
const STRUCTURE_TINT = { r: 0.36, g: 0.46, b: 0.66 };

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
      // Total spread of the reveal stagger, from the innermost ring to the
      // last tower of the outermost one. Every shader divides the sweep over
      // 1 + this, so uFade = 0 leaves nothing half-built at any depth.
      uStagger: {
        value: (((layout.maxRing ?? 4) + 1) * RING_STAGGER) + SEED_STAGGER,
      },
      // Atmospheric perspective, scaled to this structure: the far side of a
      // big repository recedes into the backdrop instead of stacking on the
      // near side at full contrast.
      uFogColor: { value: new THREE.Color(0x04060d) },
      uFogDensity: { value: 1 / Math.pow(Math.max(120, layout.fitRadius) * 6.5, 2) },
    };

    this.fileByInstance = layout.files;
    this.instanceByPath = new Map(layout.files.map((f, i) => [f.path, i]));

    this.#buildGround();
    this.#buildTowers();
    this.#buildTerraces();
    this.#buildBridges();
    this.#buildCore();
    this.#buildMotes();
    this.#buildLabels();
    this.#buildSelection();
  }

  /* ------------------------------------------------------------------ ground */

  /**
   * The plane the arcology stands on: a pool of light under the core, fading
   * out through faint concentric guides at each ring radius. Without it the
   * structure floats in a void; with it the whole composition is anchored,
   * and the guides quietly restate the layout's grammar: rings are depth.
   */
  #buildGround() {
    const maxR = ((this.layout.maxRing ?? 4) + 2) * this.layout.ringGap + this.layout.band;
    const R = maxR * 2.1;
    const geo = new THREE.CircleGeometry(R, 96);
    geo.rotateX(-Math.PI / 2);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        ...this.uniforms,
        uRingGap: { value: this.layout.ringGap },
        uMaxR: { value: maxR },
      },
      transparent: true,
      depthWrite: false,
      vertexShader: `
        varying vec2 vXZ;
        varying float vDist;
        void main() {
          vXZ = position.xz;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vDist = length(mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform float uFade;
        uniform float uRingGap;
        uniform float uMaxR;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        varying vec2 vXZ;
        varying float vDist;
        void main() {
          float r = length(vXZ);
          // Light pooled under the core, dying away with radius.
          float pool = exp(-pow(r / (uMaxR * 0.6), 2.0));
          vec3 col = mix(vec3(0.006, 0.01, 0.026), vec3(0.045, 0.085, 0.165), pool);

          // Concentric guides at the ring radii, strongest near the middle.
          //
          // The guide is drawn at a constant *apparent* width rather than a
          // constant world width. The disc is seen almost edge-on for most of
          // the tour, so a fixed 0.8-unit line is several pixels wide near the
          // camera and a fraction of a pixel further out, where point sampling
          // turns it into a crawling dashed arc. Widening the line with the
          // screen-space rate of change of the radius keeps every guide about
          // a pixel and a half thick wherever it lands.
          float rw = max(fwidth(r), 1e-4);
          float lineW = max(0.8, rw * 1.5);
          float band = abs(fract(r / uRingGap + 0.5) - 0.5) * uRingGap;
          float line = smoothstep(lineW, lineW * 0.2, band) * smoothstep(uMaxR * 1.7, uMaxR * 0.25, r);
          // Past the point where neighbouring guides would land in the same
          // pixel, the set dissolves instead of aliasing into moire rings.
          line *= 1.0 - smoothstep(uRingGap * 0.10, uRingGap * 0.34, rw);
          col += vec3(0.24, 0.38, 0.62) * line * 0.055;
          float fog = 1.0 - exp(-vDist * vDist * uFogDensity);
          col = mix(col, uFogColor, fog * 0.7);
          // The disc dissolves at its rim and follows the build-in reveal.
          float alpha = smoothstep(uMaxR * 2.05, uMaxR * 1.1, r) * (1.0 - uFade);
          gl_FragColor = vec4(col, alpha * 0.9);
        }`,
    });

    this.ground = new THREE.Mesh(geo, mat);
    this.ground.position.y = -this.layout.band * 0.26;
    this.ground.renderOrder = ORDER.ground;
    this.ground.frustumCulled = false;
    this.group.add(this.ground);
  }

  /* ------------------------------------------------------------------ towers */

  #buildTowers() {
    const files = this.layout.files;
    const count = files.length;

    // A chamfered box rather than a perfect one: nothing physical has a
    // zero-radius edge, and the bevel is what lets the fresnel catch along
    // silhouettes the way light catches a machined corner.
    const geo = new RoundedBoxGeometry(1, 1, 1, 1, 0.07);
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
    mesh.renderOrder = ORDER.towers;
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

    // Contact shadows. A soft dark pool under each tower is what makes a
    // building sit on its terrace instead of hovering a millimetre above it.
    // The quads share the towers' appear and ring arrays, so the reveal and
    // the chronology drive both from one update; the attribute objects are
    // separate, so both need their dirty flags raised (see #flagShared).
    const shadowGeo = new THREE.PlaneGeometry(1, 1);
    shadowGeo.rotateX(-Math.PI / 2);
    shadowGeo.setAttribute('aRing', new THREE.InstancedBufferAttribute(aRing, 1));
    shadowGeo.setAttribute('aAppear', new THREE.InstancedBufferAttribute(aAppear, 1));
    shadowGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(aSeed, 1));
    this.sharedAppear = [this.attrs.aAppear, shadowGeo.attributes.aAppear];

    const shadowMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      ...DECAL_OFFSET,
      vertexShader: `
        attribute float aRing;
        attribute float aAppear;
        attribute float aSeed;
        uniform float uFade;
        uniform float uStagger;
        varying vec2 vUvL;
        varying float vA;
        void main() {
          vUvL = uv;
          float reveal = clamp((1.0 - uFade) * (1.0 + uStagger) - aRing * ${RING_STAGGER.toFixed(3)} - aSeed * ${SEED_STAGGER.toFixed(3)}, 0.0, 1.0);
          vA = aAppear * reveal;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying vec2 vUvL;
        varying float vA;
        void main() {
          float d = length(vUvL - 0.5) * 2.0;
          float a = smoothstep(1.0, 0.15, d) * 0.42 * vA;
          gl_FragColor = vec4(0.0, 0.0, 0.0, a);
        }`,
    });
    this.shadows = new THREE.InstancedMesh(shadowGeo, shadowMat, count);
    this.shadows.frustumCulled = false;
    this.shadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shadows.renderOrder = ORDER.shadows;
    this.group.add(this.shadows);
  }

  /** Raise the dirty flag on every attribute object sharing one array. */
  #flagShared() {
    for (const attr of this.sharedAppear) attr.needsUpdate = true;
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
        uniform float uStagger;

        varying vec3 vColor;
        varying float vY;
        varying float vHeat;
        varying float vState;
        varying vec3 vNormalW;
        varying vec3 vViewDir;
        varying float vAlpha;
        varying float vFlash;
        varying vec3 vLocal;
        varying vec3 vNLocal;
        varying vec3 vScale;
        varying float vSeed;
        varying float vDist;
        varying float vGrow;

        void main() {
          vFlash = aFlash;
          vColor = aColor;
          vHeat = aHeat;
          vState = aState;
          vSeed = aSeed;
          vLocal = position;
          vNLocal = normal;
          vScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
          vY = position.y; // 0 at base, 1 at tip (box was translated)

          // The reveal sweeps outward: outer rings finish building last.
          float reveal = clamp((1.0 - uFade) * (1.0 + uStagger) - aRing * ${RING_STAGGER.toFixed(3)} - aSeed * ${SEED_STAGGER.toFixed(3)}, 0.0, 1.0);
          reveal = reveal * reveal * (3.0 - 2.0 * reveal);
          float grow = aAppear * reveal;
          vAlpha = step(0.001, grow);
          // The fragment shader lays the window grid out in world height, so
          // it needs to know how much of the tower is actually standing. Row
          // spacing then holds while a building rises instead of the whole
          // facade stretching with it.
          vGrow = grow;

          vec3 p = position;
          p.y *= grow;

          vec4 world = instanceMatrix * vec4(p, 1.0);

          vNormalW = normalize(mat3(instanceMatrix) * normal);
          vec4 mv = modelViewMatrix * world;
          vViewDir = normalize(-mv.xyz);
          vDist = length(mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        precision highp float;
        uniform float uTime;
        uniform float uHeatBoost;
        uniform vec3 uFogColor;
        uniform float uFogDensity;

        varying vec3 vColor;
        varying float vY;
        varying float vHeat;
        varying float vState;
        varying vec3 vNormalW;
        varying vec3 vViewDir;
        varying float vAlpha;
        varying float vFlash;
        varying vec3 vLocal;
        varying vec3 vNLocal;
        varying vec3 vScale;
        varying float vSeed;
        varying float vDist;
        varying float vGrow;

        /**
         * One pane edge, filtered over the pixel it lands in. The w argument
         * is the screen-space width of a cell, so the rectangle keeps an edge
         * roughly one pixel wide however far away the tower is. Point
         * sampling a step() here is what made the facades crawl.
         */
        float paneBand(float x, float lo, float hi, float w) {
          float e = max(w, 0.0015);
          return clamp(smoothstep(lo - e, lo + e, x) - smoothstep(hi - e, hi + e, x), 0.0, 1.0);
        }

        void main() {
          if (vAlpha < 0.5) discard;

          // Stylised lighting: a fixed key direction plus a fresnel rim. Real
          // lights would flatten the silhouettes the bloom pass depends on.
          vec3 keyDir = normalize(vec3(0.45, 0.8, 0.35));
          float lambert = max(dot(normalize(vNormalW), keyDir), 0.0);
          // The base is clamped at zero because dot() of two normalized
          // vectors can exceed 1.0 by a float ulp on real GPUs, and
          // pow(negative, 2.4) is NaN, and the bloom blur smears one NaN
          // pixel across the entire frame as white.
          float fres = pow(max(1.0 - dot(normalize(vNormalW), normalize(vViewDir)), 0.0), 2.4);

          // The body is desaturated toward its own luminance. High-end
          // grading keeps chroma scarce and spends the pure language colour
          // only where it reads as light: the crown, the rim, the windows.
          float lum = dot(vColor, vec3(0.299, 0.587, 0.114));
          vec3 body = mix(vColor, vec3(lum), 0.34);

          // Dark plinth fading to a lit crown. The additive light scales with
          // the tower's stature: a two-unit stub with a full crown used to
          // bloom into a featureless white lump, and a repository is mostly
          // stubs.
          float crown = smoothstep(0.15, 1.0, vY);
          float stature = smoothstep(1.5, 9.0, vScale.y);
          vec3 base = mix(body * 0.14, body, 0.42 + 0.44 * crown);
          vec3 col = base * (0.24 + 0.58 * lambert);
          col += vColor * fres * mix(0.07, 0.18, stature);
          col += vColor * crown * crown * mix(0.04, 0.12, stature);

          // Procedural windows on the side faces. Each face carries a grid of
          // slightly inset panes; a per-cell hash decides which are lit. This
          // is what makes a close fly-by read as an inhabited structure rather
          // than a glowing slab. It is a pure function of geometry and
          // seed, so every frame and every renderer agrees.
          //
          // The whole pattern is filtered against its own screen-space
          // footprint. A grid this fine is far below one pixel per cell on
          // any wide shot, and point sampling it there produced the speckle
          // that boiled across the facades whenever the camera moved.
          // Chamfer normals interpolate, so sideness fades across the bevel
          // instead of switching at it.
          float sideness = smoothstep(0.62, 0.42, abs(vNLocal.y));
          float u = abs(vNLocal.x) > 0.5 ? (vLocal.z + 0.5) : (vLocal.x + 0.5);
          float faceW = abs(vNLocal.x) > 0.5 ? vScale.z : vScale.x;
          float h = vY * vGrow * vScale.y;
          float cols = max(1.0, floor(faceW / 1.05));
          float rowH = 1.55;
          // Rows are staggered per building; a whole district whose windows
          // align to one grid is the repetition the eye flags as synthetic.
          float uu = u * cols;
          float hh = h / rowH + vSeed * 0.83;
          // Derivatives are taken on the unwrapped coordinates: fract() spikes
          // fwidth at every cell boundary. The clamp covers the geometry edges
          // where the 2x2 quad straddles two faces.
          float wu = min(fwidth(uu), 0.5);
          float wv = min(fwidth(hh), 0.5);
          vec2 cell = vec2(fract(uu), fract(hh));
          float pane = paneBand(cell.x, 0.2, 0.8, wu) * paneBand(cell.y, 0.3, 0.74, wv);
          vec2 id = vec2(floor(uu), floor(hh));
          float litHash = fract(sin(dot(vec3(id, vSeed * 61.7), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
          float lit = step(0.42, litHash);
          // Once a cell is worth about half a pixel the grid stops being
          // resolvable, so both the pane mask and the lit/unlit hash cross
          // fade to their own averages: 0.6 x 0.44 of a cell is glass, and
          // 58% of cells are lit. The tower keeps the warmth of an inhabited
          // facade at distance and loses only detail it could not draw.
          float sharp = 1.0 - smoothstep(0.16, 0.5, max(wu, wv));
          pane = mix(0.264, pane, sharp);
          lit = mix(0.58, lit, sharp);
          // Only towers tall enough to have storeys get windows, and the top
          // band stays clean so the crown keeps its line. Both limits are
          // ramps: a hard cut left a visible seam around the parapet and a
          // step between two buildings a hair either side of the threshold.
          float storeys = smoothstep(3.5, 5.5, vScale.y);
          float bodyBand = smoothstep(0.03, 0.07, vY) * (1.0 - smoothstep(0.84, 0.9, vY));
          float windows = pane * sideness * storeys * bodyBand;
          vec3 glass = mix(body * 0.10, mix(vColor, vec3(1.0, 0.93, 0.78), 0.55) * 1.3, lit);
          col = mix(col, glass, windows * 0.85);

          // Contact shading where the tower meets its terrace.
          col *= mix(0.5, 1.0, smoothstep(0.0, 0.16, vY));

          // Churn reads as a heat shimmer climbing the tower.
          float pulse = 0.6 + 0.4 * sin(uTime * 2.2 + vY * 6.0);
          col += vColor * vHeat * uHeatBoost * pulse * (0.5 + crown) * 0.9;
          col += vec3(1.0, 0.55, 0.25) * vHeat * uHeatBoost * crown * 0.34;

          // A file appearing in the timeline flares white and settles. It reads
          // as the moment of creation rather than as decoration: what lights up
          // is exactly what that stretch of history added.
          col += vec3(1.0, 0.95, 0.85) * vFlash * (1.4 + crown * 2.2);

          float alpha = 1.0;
          if (vState < 0.5) {          // dimmed by a search
            col *= vState * 2.2;
            alpha = 0.30;
          } else if (vState > 1.5) {   // search hit
            // Bright enough to find from across the structure, restrained
            // enough that flying up to it still shows a building rather than
            // a white nuke. The slow breath separates "found" from "lit".
            float breath = 0.92 + 0.14 * sin(uTime * 2.6);
            col = mix(col, vec3(1.0), 0.18) * 1.55 * breath;
          }

          // Atmospheric perspective.
          float fog = 1.0 - exp(-vDist * vDist * uFogDensity);
          col = mix(col, uFogColor, fog * 0.7);

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
      // otherwise render as one flat sheet, and the towers, which carry the
      // real per-file colour, would have nothing to stand out against.
      const c = mixToward(hexToRgb(colorOf(d.lang)), STRUCTURE_TINT, 0.6);
      // Deeper folders sit further out and read dimmer, which keeps the eye on
      // the trunk of the tree rather than the leaves.
      const dim = Math.max(0.28, 1 - d.depth * 0.11);

      for (let s = 0; s <= segs; s += 1) {
        const a = d.a0 + (span * s) / segs;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        floors.pos.push(ca * r0, 0, sa * r0, ca * r1, 0, sa * r1);
        floors.col.push(c.r * 0.04 * dim, c.g * 0.04 * dim, c.b * 0.04 * dim);
        floors.col.push(c.r * 0.2 * dim, c.g * 0.2 * dim, c.b * 0.2 * dim);
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

      // The platform's visible thickness: the outer edge extruded downward.
      // Without it a terrace seen from a low angle is a sheet of paper.
      const SKIRT = this.layout.band * 0.22;
      for (let s = 0; s <= segs; s += 1) {
        const a = d.a0 + (span * s) / segs;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        floors.pos.push(ca * r1, 0, sa * r1, ca * r1, -SKIRT, sa * r1);
        floors.col.push(c.r * 0.16 * dim, c.g * 0.16 * dim, c.b * 0.16 * dim);
        floors.col.push(c.r * 0.02, c.g * 0.02, c.b * 0.02);
        floors.ring.push(ring, ring);
      }
      for (let s = 0; s < segs; s += 1) {
        const i = fBase + s * 2;
        floors.idx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
      }
      fBase += (segs + 1) * 2;
    }

    this.terraces = new THREE.Mesh(
      makeGeometry(floors),
      this.#surfaceMaterial({ opacity: 0.96, additive: false, depthWrite: true }),
    );
    this.terraces.frustumCulled = false;
    this.terraces.renderOrder = ORDER.terraces;

    this.rims = new THREE.Mesh(
      makeGeometry(rims),
      this.#surfaceMaterial({ opacity: 1, additive: true, depthWrite: false, decal: true }),
    );
    this.rims.frustumCulled = false;
    this.rims.renderOrder = ORDER.rims;

    this.group.add(this.terraces, this.rims);
  }

  #surfaceMaterial({ opacity, additive, depthWrite, decal = false }) {
    return new THREE.ShaderMaterial({
      defines: { ADDITIVE: additive ? 'true' : 'false' },
      uniforms: { ...this.uniforms, uOpacity: { value: opacity } },
      transparent: true,
      depthWrite,
      ...(decal ? DECAL_OFFSET : null),
      side: THREE.DoubleSide,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: `
        attribute float aRing;
        attribute vec3 aColor;
        uniform float uLift;
        uniform float uFade;
        uniform float uStagger;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vDist;
        void main() {
          vColor = aColor;
          float reveal = clamp((1.0 - uFade) * (1.0 + uStagger) - aRing * ${RING_STAGGER.toFixed(3)}, 0.0, 1.0);
          vAlpha = reveal * reveal * (3.0 - 2.0 * reveal);
          vec3 p = position;
          p.y += aRing * uLift;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vDist = length(mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform float uOpacity;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vDist;
        void main() {
          if (vAlpha < 0.01) discard;
          float fog = 1.0 - exp(-vDist * vDist * uFogDensity);
          // Additive surfaces dim with distance; opaque ones mix to the sky.
          vec3 col = ADDITIVE ? vColor * (1.0 - fog * 0.85) : mix(vColor, uFogColor, fog * 0.7);
          gl_FragColor = vec4(col, uOpacity * vAlpha);
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
        // A ramp ends on the deck it serves, so both of its endpoints sit in a
        // terrace plane. Polygon offset covers triangles only, so the rails
        // clear the deck in world space instead: a couple of decimetres, small
        // enough to still read as touching and large enough that the line
        // never dips through the floor it lands on.
        uniforms: { ...this.uniforms, uDeckClear: { value: this.layout.band * 0.02 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: `
          attribute vec3 aColor;
          attribute float aRing;
          uniform float uLift;
          uniform float uFade;
          uniform float uStagger;
          uniform float uDeckClear;
          varying vec3 vColor;
          varying float vAlpha;
          varying float vDist;
          void main() {
            vColor = aColor;
            float reveal = clamp((1.0 - uFade) * (1.0 + uStagger) - aRing * ${RING_STAGGER.toFixed(3)}, 0.0, 1.0);
            vAlpha = reveal * reveal * (3.0 - 2.0 * reveal);
            vec3 p = position;
            p.y += aRing * uLift + uDeckClear;
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            vDist = length(mv.xyz);
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: `
          uniform float uFogDensity;
          varying vec3 vColor;
          varying float vAlpha;
          varying float vDist;
          void main() {
            if (vAlpha < 0.01) discard;
            float fog = 1.0 - exp(-vDist * vDist * uFogDensity);
            gl_FragColor = vec4(vColor * (1.0 - fog * 0.85), 0.65 * vAlpha);
          }`,
      }),
    );
    this.bridges.frustumCulled = false;
    this.bridges.renderOrder = ORDER.bridges;
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
            // max() before pow, for the same NaN reason as the tower fresnel.
            float fres = pow(max(1.0 - dot(vN, vV), 0.0), 1.6);
            vec3 col = mix(vec3(0.25, 0.85, 1.0), vec3(0.85, 0.45, 1.0), fres);
            float pulse = 0.75 + 0.25 * sin(uTime * 1.8);
            gl_FragColor = vec4(col * (0.55 + fres * 2.2) * pulse, 1.0);
          }`,
      }),
    );
    core.position.y = 2;
    core.renderOrder = ORDER.core;
    this.core = core;
    this.group.add(core);
  }

  /* ------------------------------------------------------------------- motes */

  /**
   * Slow dust drifting through the structure. A few hundred faint points give
   * the air a volume for the towers to stand in, and their parallax is what
   * sells the camera moves. Positions are seeded and the drift is a pure
   * function of scene time, so the offline recorder stays deterministic.
   */
  #buildMotes() {
    const maxR = ((this.layout.maxRing ?? 4) + 2) * this.layout.ringGap + this.layout.band;
    const COUNT = Math.min(340, Math.max(140, Math.round(maxR * 2.2)));

    let s = 0x9e3779b9;
    const rand = () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const positions = new Float32Array(COUNT * 3);
    const seeds = new Float32Array(COUNT);
    const sizes = new Float32Array(COUNT);
    const height = Math.max(this.layout.band * 3, this.layout.fitHeight * 1.5);
    for (let i = 0; i < COUNT; i += 1) {
      // sqrt keeps the disc evenly filled instead of clumped at the middle.
      const r = Math.sqrt(rand()) * maxR * 1.25;
      const a = rand() * Math.PI * 2;
      positions[i * 3] = Math.cos(a) * r;
      positions[i * 3 + 1] = rand() * height - this.layout.band * 0.2;
      positions[i * 3 + 2] = Math.sin(a) * r;
      seeds[i] = rand() * 100;
      sizes[i] = 0.9 + rand() * 1.8;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      vertexShader: `
        attribute float aSeed;
        attribute float aSize;
        uniform float uTime;
        uniform float uFade;
        varying float vA;
        void main() {
          vec3 p = position;
          p.x += sin(uTime * 0.09 + aSeed * 1.7) * 3.5;
          p.y += sin(uTime * 0.06 + aSeed * 2.3) * 2.5;
          p.z += cos(uTime * 0.08 + aSeed * 1.1) * 3.5;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = aSize * 260.0 / max(40.0, -mv.z);
          // Each mote breathes on its own phase; all of them obey the reveal.
          vA = (0.5 + 0.5 * sin(uTime * 0.5 + aSeed * 3.7)) * (1.0 - uFade);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float disc = smoothstep(1.0, 0.2, d);
          gl_FragColor = vec4(vec3(0.62, 0.74, 0.92), disc * vA * 0.14);
        }`,
    });

    this.motes = new THREE.Points(geo, mat);
    this.motes.frustumCulled = false;
    this.motes.renderOrder = ORDER.motes;
    this.group.add(this.motes);
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
            // max() before pow, for the same reason as the tower fresnel:
            // vY is interpolated across the column and can land a float ulp
            // above 1.0, pow() of a negative base is NaN, and this material
            // is additive, so one NaN fragment poisons the buffer the bloom
            // then blurs across the whole frame as white.
            float fade = pow(max(1.0 - vY, 0.0), 1.5);
            float scan = 0.55 + 0.45 * sin(uTime * 4.0 - vY * 14.0);
            gl_FragColor = vec4(uColor * (0.8 + scan), fade * 0.55);
          }`,
      }),
    );
    this.beam.renderOrder = ORDER.beam;
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
    const shadowScale = new THREE.Vector3();
    for (let i = 0; i < files.length; i += 1) {
      const f = files[i];
      pos.set(f.x, f.ring * this.lift, f.z);
      m.compose(pos, this.towerParts.quat[i], this.towerParts.scale[i]);
      this.towers.setMatrixAt(i, m);

      const ts = this.towerParts.scale[i];
      // The quad shares the terrace's plane exactly; DECAL_OFFSET on its
      // material is what keeps it in front, at every distance.
      shadowScale.set(ts.x * 2.3, 1, ts.z * 2.3);
      m.compose(pos, this.towerParts.quat[i], shadowScale);
      this.shadows.setMatrixAt(i, m);
    }
    this.towers.instanceMatrix.needsUpdate = true;
    this.shadows.instanceMatrix.needsUpdate = true;
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
  applyTime(t, { hasHistory, window: win = 60 * 60 * 24 * 45, flashWindow = 0 }) {
    const appear = this.attrs.aAppear.array;
    const heat = this.attrs.aHeat.array;
    const flash = this.attrs.aFlash.array;
    let visible = 0;
    let bytes = 0;

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
      // The creation flare is a pure function of the timestamp: a file glows
      // white for `flashWindow` seconds of history after it appears, then
      // settles into its language colour. Stateless on purpose: an earlier
      // version decayed a stored value per frame, which made the flare last
      // twice as long at 30fps as at 60 and drift between live playback and
      // offline recording. Computed from `t` alone, every path that draws a
      // frame agrees exactly, and pausing the playhead leaves the files just
      // created still glowing, a marker of what this stretch of history added.
      let flare = 0;
      if (hasHistory && f.addedAt && flashWindow > 0) {
        const age = t - f.addedAt;
        if (age >= 0 && age < flashWindow) {
          flare = 1 - age / flashWindow;
          flare *= flare;
        }
      }
      flash[i] = flare;

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
    this.#flagShared();
    this.attrs.aHeat.needsUpdate = true;
    this.attrs.aFlash.needsUpdate = true;
    return { visible, bytes };
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
    this.#flagShared();
    this.attrs.aHeat.needsUpdate = true;
    this.attrs.aFlash.needsUpdate = true;
  }

  update(dt, time, camera) {
    this.uniforms.uTime.value = time;
    this.core.rotation.y = time * 0.16;
    this.core.rotation.x = Math.sin(time * 0.21) * 0.24;

    // Labels are real scene objects, so they need the animated lift applied.
    // Visibility is judged per label against the camera, scaled by how big this
    // particular structure is; a fixed distance would show everything on a
    // small repo and nothing on a large one.
    // Label thresholds are distances, and a narrow viewport parks the camera
    // further back (see Cinema#aspectPullback), so the same rule has to be
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
      // once you fly in, which keeps the wide shots clean. The last quarter
      // of the range fades, so labels dissolve instead of popping.
      const threshold = unit * (2.2 + (budget - Math.min(d, budget)) * 0.75);
      const fade = Math.max(0, Math.min(1, (threshold - dist) / (threshold * 0.25)));
      obj.visible = fade > 0.01;
      if (obj.visible) obj.element.style.opacity = fade.toFixed(3);
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
