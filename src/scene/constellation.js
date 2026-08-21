/**
 * The Constellation: contributors as an orbital system around the repository
 * core, with light-arcs drawn to the directories they actually touched.
 *
 * Attribution links only appear when the payload carries per-file author data
 * (the local CLI always does; the hosted app does after a deep scan). Without
 * it this is an honest orbital chart of commit counts and nothing more.
 */

import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { LIFT } from '../layout.js';
import { colorOf, hexToRgb } from '../palette.js';

const PER_RING = 6;

export class Constellation {
  constructor(model, layout) {
    this.model = model;
    this.layout = layout;
    this.group = new THREE.Group();
    this.group.visible = false;
    this.uniforms = { uTime: { value: 0 }, uReveal: { value: 0 } };
    this.nodes = [];

    // Orbits are sized from the structure so contributors circle the repository
    // at a readable distance whether it is a script or a monorepo.
    const unit = layout.fitRadius || layout.maxRadius || 100;
    this.orbitBase = unit * 0.62;
    this.orbitStep = unit * 0.24;
    this.bodyScale = unit * 0.028;
    this.orbitHeight = (layout.center?.y || 0) + unit * 0.35;

    const contributors = (model.payload.contributors || []).slice(0, 24);
    this.hasLinks = false;

    if (contributors.length) {
      this.#buildOrbits(contributors);
      this.#buildLinks(contributors);
    }
    this.empty = contributors.length === 0;
  }

  #buildOrbits(contributors) {
    const maxCommits = Math.max(1, ...contributors.map((c) => c.commits || 0));
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');

    contributors.forEach((c, i) => {
      const ringIndex = Math.floor(i / PER_RING);
      const inRing = i % PER_RING;
      const perThisRing = Math.min(PER_RING, contributors.length - ringIndex * PER_RING);
      const radius = this.orbitBase + ringIndex * this.orbitStep;
      // Offset each ring so bodies do not line up into spokes.
      const phase = (inRing / perThisRing) * Math.PI * 2 + ringIndex * 0.7;
      const share = (c.commits || 0) / maxCommits;
      const size = this.bodyScale * (0.9 + Math.sqrt(share) * 2.6);

      const color = new THREE.Color().setHSL(0.52 + (i % 7) * 0.045, 0.72, 0.62);
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(size, 24, 18),
        new THREE.MeshBasicMaterial({ color, toneMapped: false }),
      );

      // Avatars are decorative; a failed load leaves the coloured sphere.
      if (c.avatar) {
        loader.load(
          `${c.avatar}${c.avatar.includes('?') ? '&' : '?'}s=96`,
          (tex) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            mesh.material.map = tex;
            mesh.material.color.setScalar(1.35);
            mesh.material.needsUpdate = true;
          },
          undefined,
          () => {},
        );
      }

      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(size * 1.7, 20, 14),
        new THREE.ShaderMaterial({
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.BackSide,
          uniforms: { uColor: { value: color }, uTime: this.uniforms.uTime, uSeed: { value: i * 1.7 } },
          vertexShader: `
            varying vec3 vN; varying vec3 vV;
            void main() {
              vN = normalize(normalMatrix * normal);
              vec4 mv = modelViewMatrix * vec4(position, 1.0);
              vV = normalize(-mv.xyz);
              gl_Position = projectionMatrix * mv;
            }`,
          fragmentShader: `
            uniform vec3 uColor; uniform float uTime; uniform float uSeed;
            varying vec3 vN; varying vec3 vV;
            void main() {
              float fres = pow(1.0 - abs(dot(vN, vV)), 2.6);
              float pulse = 0.7 + 0.3 * sin(uTime * 1.6 + uSeed);
              gl_FragColor = vec4(uColor * fres * pulse * 2.2, fres * 0.75);
            }`,
        }),
      );

      const holder = new THREE.Group();
      holder.add(mesh, halo);

      const el = document.createElement('div');
      el.className = 'rs-person';
      el.innerHTML = `<span class="rs-person-name"></span><span class="rs-person-count"></span>`;
      el.querySelector('.rs-person-name').textContent = c.login;
      el.querySelector('.rs-person-count').textContent =
        `${c.commits.toLocaleString()} commit${c.commits === 1 ? '' : 's'}`;
      el.style.setProperty('--person-color', `#${color.getHexString()}`);
      if (c.url) {
        el.classList.add('is-link');
        el.addEventListener('click', () => window.open(c.url, '_blank', 'noopener'));
      }
      const label = new CSS2DObject(el);
      label.position.y = size + 5;
      holder.add(label);

      this.group.add(holder);
      this.nodes.push({
        holder,
        radius,
        phase,
        // Bigger contributors orbit slower — visually they read as heavier.
        speed: 0.075 / (0.55 + share),
        tilt: (ringIndex % 2 === 0 ? 1 : -1) * (0.1 + ringIndex * 0.06),
        bob: this.bodyScale * (1.6 + ringIndex * 0.8),
        login: c.login,
        color,
      });
    });
  }

  /**
   * Light-arcs from each contributor to the top-level directories they touched.
   * Built from per-file author counts, so it reflects real attribution.
   */
  #buildLinks(contributors) {
    const files = this.model.payload.files || [];
    const byAuthor = new Map();
    for (const f of files) {
      if (!f.authors) continue;
      const top = f.path.includes('/') ? f.path.slice(0, f.path.indexOf('/')) : '·root';
      for (const [author, n] of Object.entries(f.authors)) {
        let m = byAuthor.get(author);
        if (!m) byAuthor.set(author, (m = new Map()));
        m.set(top, (m.get(top) || 0) + n);
      }
    }
    if (!byAuthor.size) return;

    // Anchor points: the mid-angle of each top-level directory's terrace.
    const anchors = new Map();
    for (const d of this.model.root.children) {
      if (d.type !== 'dir') continue;
      const ring = d.ring + 1;
      const r = ring * this.layout.ringGap + this.layout.band * 0.5;
      anchors.set(d.name, new THREE.Vector3(Math.cos(d.aMid) * r, ring * LIFT, Math.sin(d.aMid) * r));
    }
    anchors.set('·root', new THREE.Vector3(0, 6, 0));

    const positions = [];
    const colors = [];
    this.linkSpecs = [];

    contributors.forEach((c, i) => {
      const touched = byAuthor.get(c.login);
      if (!touched) return;
      const node = this.nodes[i];
      if (!node) return;
      const top = [...touched.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
      for (const [dirName, count] of top) {
        const anchor = anchors.get(dirName);
        if (!anchor) continue;
        const dir = this.model.root.children.find((n) => n.name === dirName);
        const c2 = hexToRgb(colorOf(dir ? dir.lang : 'Other'));
        // Placeholder vertices; the orbit update rewrites the near end each frame.
        const SEGMENTS = 18;
        const start = positions.length / 3;
        for (let s = 0; s <= SEGMENTS; s += 1) positions.push(0, 0, 0);
        for (let s = 0; s <= SEGMENTS; s += 1) {
          const t = s / SEGMENTS;
          const fade = Math.sin(t * Math.PI);
          colors.push(
            (node.color.r * (1 - t) + c2.r * t) * fade,
            (node.color.g * (1 - t) + c2.g * t) * fade,
            (node.color.b * (1 - t) + c2.b * t) * fade,
          );
        }
        this.linkSpecs.push({ node, anchor, start, segments: SEGMENTS, weight: count });
      }
    });

    if (!this.linkSpecs.length) return;
    this.hasLinks = true;

    const geo = new THREE.BufferGeometry();
    this.linkPositions = new Float32Array(positions);
    geo.setAttribute('position', new THREE.BufferAttribute(this.linkPositions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
    // One strip per link, so draw each as its own line via a segment index.
    const idx = [];
    for (const spec of this.linkSpecs) {
      for (let s = 0; s < spec.segments; s += 1) idx.push(spec.start + s, spec.start + s + 1);
    }
    geo.setIndex(idx);

    this.links = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.links.frustumCulled = false;
    this.group.add(this.links);
  }

  setVisible(v) {
    this.group.visible = v;
  }

  update(dt, time) {
    if (!this.group.visible) return;
    this.uniforms.uTime.value = time;

    for (const n of this.nodes) {
      const a = n.phase + time * n.speed;
      n.holder.position.set(
        Math.cos(a) * n.radius,
        this.orbitHeight + Math.sin(a * 2 + n.phase) * n.bob + n.tilt * n.radius * 0.35,
        Math.sin(a) * n.radius,
      );
    }

    if (!this.links) return;
    // Redraw each arc as a quadratic bow between the moving contributor and
    // its fixed directory anchor.
    const p = this.linkPositions;
    const mid = new THREE.Vector3();
    for (const spec of this.linkSpecs) {
      const from = spec.node.holder.position;
      const to = spec.anchor;
      mid.copy(from).add(to).multiplyScalar(0.5);
      mid.y += from.distanceTo(to) * 0.28;
      for (let s = 0; s <= spec.segments; s += 1) {
        const t = s / spec.segments;
        const it = 1 - t;
        const i3 = (spec.start + s) * 3;
        p[i3] = it * it * from.x + 2 * it * t * mid.x + t * t * to.x;
        p[i3 + 1] = it * it * from.y + 2 * it * t * mid.y + t * t * to.y;
        p[i3 + 2] = it * it * from.z + 2 * it * t * mid.z + t * t * to.z;
      }
    }
    this.links.geometry.attributes.position.needsUpdate = true;
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (o.material.map) o.material.map.dispose();
        o.material.dispose();
      }
      if (o.element) o.element.remove();
    });
  }
}
