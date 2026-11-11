// Pack C's renderer: the voxel world (voxel.js) drawn with three.js (MIT, vendored in static/vendor/three, see
// VENDORED.txt) in the render window's WebGL. Same player contract as every video: the engine calls render() inside its
// synchronous drawFrame(t), so frames, captions, transitions, chapters and resume work as for any other beat.
// Pack C renders with three.js only (no Blender path): the faces are pixel textures drawn here in code every frame.
//
// The look: soft toy blocks rather than hard pixel cubes.
// - every block is a bevelled cube with smooth normals on its rounded edges, drawn instanced (one draw per kind), its
//   colour from our palette with a small per-block variation and a gentle "pillow" shade drawn in code on each face;
// - soft light: a key light for the time of day with soft shadows, a sky and ground fill, the sky's own gradient, fog
//   that melts the far end, and ground-truth ambient occlusion (three's GTAO pass) in every crease between blocks;
// - round sun and moon discs, round stars and puffy round clouds.
import * as THREE from 'three';
import { EffectComposer } from '/static/vendor/three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '/static/vendor/three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from '/static/vendor/three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from '/static/vendor/three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from '/static/vendor/three/examples/jsm/postprocessing/ShaderPass.js';
import { fovs } from './stage.js';
import { BLOCKS, FACE_GRID, faceCells, swell } from './voxel.js';

const zup = v => new THREE.Vector3(v[0], v[2], -v[1]);   // a world point in three's Y-up space

const DitherShader = {
  name: 'KairosDither', uniforms: { tDiffuse: { value: null } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
    float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() { vec4 c = texture2D(tDiffuse, vUv); c.rgb += (rand(gl_FragCoord.xy) - 0.5) / 255.0; gl_FragColor = c; }`,
};

// A box with rounded edges: a segmented box whose every vertex is pulled onto a rounded shell, with the shell's own
// normals, so the bevels shade smoothly. Sizes in metres; `radius` absolute; `taper` narrows the top (x and y).
export function roundedBox(sx, sy, sz, radius, taper = 1, segments = 4) {
  const g = new THREE.BoxGeometry(sx, sy, sz, segments, segments, segments);
  const pos = g.attributes.position, nor = g.attributes.normal, r = Math.max(1e-4, Math.min(radius, sx / 2, sy / 2, sz / 2) * .999);
  const ix = sx / 2 - r, iy = sy / 2 - r, iz = sz / 2 - r, v = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    c.set(THREE.MathUtils.clamp(v.x, -ix, ix), THREE.MathUtils.clamp(v.y, -iy, iy), THREE.MathUtils.clamp(v.z, -iz, iz));
    n.subVectors(v, c);
    if (n.lengthSq() < 1e-12) n.fromBufferAttribute(nor, i); else n.normalize();
    v.copy(c).addScaledVector(n, r);
    // three's box is Y-up; the world is Z-up (shot coordinates), so taper by height in z after the caller's rotation:
    // here height is the box's own z.
    if (taper !== 1) { const k = 1 + (taper - 1) * (v.z / sz + .5); v.x *= k; v.y *= k; }
    pos.setXYZ(i, v.x, v.y, v.z); nor.setXYZ(i, n.x, n.y, n.z);
  }
  if (taper !== 1) g.computeVertexNormals();
  return g;
}

// The pillow shade every block face carries: lighter in the middle, a little darker at the rim, a faint grain. Drawn in
// code (no image files); multiplied by the block's colour.
function pillowTexture() {
  const size = 32, canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
  const g = canvas.getContext('2d'), image = g.createImageData(size, size);
  let s = 12345;
  const rand = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + .5) / size * 2 - 1, v = (y + .5) / size * 2 - 1, edge = Math.max(Math.abs(u), Math.abs(v)) ** 6;
    const value = Math.round(255 * Math.min(1, .97 - .1 * edge + (rand() - .5) * .025));
    const i = (y * size + x) * 4; image.data[i] = image.data[i + 1] = image.data[i + 2] = value; image.data[i + 3] = 255;
  }
  g.putImageData(image, 0, 0);
  const t = new THREE.CanvasTexture(canvas); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

// The sky dome: a vertical gradient (below the horizon, horizon, top) with a soft glow around the sun or moon.
function skyMaterial(sky, disc) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color(sky.top) }, horizon: { value: new THREE.Color(sky.horizon) }, below: { value: new THREE.Color(sky.below) },
      glow: { value: new THREE.Color(sky.disc_color || '#ffffff') }, sun: { value: disc.clone().normalize() }, glowAmount: { value: disc.length() ? .35 : 0 } },
    vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 below; uniform vec3 glow; uniform vec3 sun; uniform float glowAmount; varying vec3 vDir;
      void main() {
        float h = vDir.y;
        vec3 c = h > 0.0 ? mix(horizon, top, pow(clamp(h, 0.0, 1.0), 0.55)) : mix(horizon, below, pow(clamp(-h, 0.0, 1.0), 0.6));
        float d = max(dot(normalize(vDir), sun), 0.0);
        c += glow * glowAmount * pow(d, 24.0);
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  });
}

export class VoxelRenderer {
  constructor(width, height, { ss = 2, look = true } = {}) {
    this.w = width; this.h = height; this.ss = ss; this.look = look;
    this.gl = document.createElement('canvas');
    this.gl.width = width * ss; this.gl.height = height * ss;
    this.lost = 0;
    this.gl.addEventListener('webglcontextlost', event => { this.lost++; event.preventDefault(); });
    const renderer = this.renderer = new THREE.WebGLRenderer({ canvas: this.gl, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(1);
    renderer.setSize(width * ss, height * ss, false);
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    const ctx = renderer.getContext(), info = ctx.getExtension('WEBGL_debug_renderer_info');
    this.info = { renderer: info ? ctx.getParameter(info.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER), webgl2: renderer.capabilities.isWebGL2, three: THREE.REVISION, ss };
    this.out = document.createElement('canvas'); this.out.width = width; this.out.height = height;
    this.octx = this.out.getContext('2d'); this.octx.imageSmoothingEnabled = true; this.octx.imageSmoothingQuality = 'high';
    this.camera = new THREE.PerspectiveCamera(40, width / height, .05, 160);
    this.pillow = pillowTexture();
    this.unit = new Map(); this.geometries = new Map(); this.scenes = new Map();
    this.sphere = new THREE.SphereGeometry(1, 24, 16);
    if (look) this._composer();
  }

  _composer() {
    const { w, h, ss } = this;
    const target = new THREE.WebGLRenderTarget(w * ss, h * ss, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.setPixelRatio(1); this.composer.setSize(w * ss, h * ss);
    this.renderPass = new RenderPass(null, this.camera);
    this.gtao = new GTAOPass(null, this.camera, w * ss, h * ss);
    this.gtao.updateGtaoMaterial({ radius: .45, distanceExponent: 1.5, thickness: 1, scale: 1, samples: 16, distanceFallOff: 1 });
    this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
    this.gtao.blendIntensity = .95;
    this.composer.addPass(this.renderPass); this.composer.addPass(this.gtao);
    this.composer.addPass(new OutputPass()); this.composer.addPass(new ShaderPass(DitherShader));
  }

  // One unit rounded cube per bevel share, shared by every instanced block of that bevel.
  _unitBox(bevel) {
    const key = bevel.toFixed(2);
    if (!this.unit.has(key)) this.unit.set(key, roundedBox(1, 1, 1, bevel / 2, 1, bevel >= .4 ? 6 : 3));
    return this.unit.get(key);
  }
  _partGeometry(size, bevel, taper) {
    const key = `${size.join(',')}:${bevel}:${taper}`;
    if (!this.geometries.has(key)) this.geometries.set(key, roundedBox(size[0], size[1], size[2], Math.min(...size) * bevel / 2, taper, 5));
    return this.geometries.get(key);
  }

  // The static world: blocks grouped by kind and bevel into instanced meshes, each block its own colour.
  _blocks(model, root) {
    const groups = new Map(), animated = [];
    for (const b of model.boxes) {
      const def = BLOCKS[b.block], bevel = b.bevel ?? (def.kind === 'gloss' ? .12 : .18);
      const key = `${def.kind}:${bevel}`;
      if (!groups.has(key)) groups.set(key, { kind: def.kind, bevel, list: [] });
      groups.get(key).list.push(b);
    }
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, 'ZYX'), s = new THREE.Vector3(), p = new THREE.Vector3(), c = new THREE.Color();
    for (const { kind, bevel, list } of groups.values()) {
      const material = kind === 'glow' ? new THREE.MeshBasicMaterial({ color: '#ffffff' })
        : new THREE.MeshStandardMaterial({ color: '#ffffff', map: this.pillow, roughness: kind === 'gloss' ? .18 : .82, metalness: 0,
          envMapIntensity: kind === 'gloss' ? .9 : .25 });
      const mesh = new THREE.InstancedMesh(this._unitBox(bevel), material, list.length);
      mesh.castShadow = kind !== 'gloss'; mesh.receiveShadow = true;
      list.forEach((b, i) => {
        e.set(0, b.tilt || 0, 0); q.setFromEuler(e);
        s.set(b.sx ?? b.s, b.sy ?? b.s, b.sz ?? b.s); p.set(b.x, b.y, b.z);
        mesh.setMatrixAt(i, m.compose(p, q, s));
        // Each block a touch lighter or darker than its neighbours (from its place, so every frame and render agree).
        const jitter = ((Math.imul(Math.round(b.x * 8) * 73856093 ^ Math.round(b.y * 8) * 19349663 ^ Math.round(b.z * 8) * 83492791, 1) >>> 0) % 1000) / 1000 - .5;
        c.set(BLOCKS[b.block].color); if (kind !== 'glow') c.offsetHSL(0, 0, jitter * .045);
        mesh.setColorAt(i, c);
        if (b.spin || b.wave || kind === 'gloss') animated.push({ mesh, i, b });
      });
      mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.frustumCulled = false;
      root.add(mesh);
    }
    return animated;
  }

  _animate(animated, t) {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, 'ZYX'), s = new THREE.Vector3(), p = new THREE.Vector3();
    const touched = new Set();
    for (const { mesh, i, b } of animated) {
      let z = b.z, spin = 0, ry = b.tilt || 0;
      if (BLOCKS[b.block].kind === 'gloss') z += swell(b.x, b.y, t);
      if (b.spin) { spin = t * 1.2; z += .04 * Math.sin(t * 2.2); }
      if (b.wave) ry += .12 * Math.sin(t * 3 + b.x);
      e.set(0, ry, spin); q.setFromEuler(e); s.set(b.sx ?? b.s, b.sy ?? b.s, b.sz ?? b.s); p.set(b.x, b.y, z);
      mesh.setMatrixAt(i, m.compose(p, q, s)); touched.add(mesh);
    }
    for (const mesh of touched) mesh.instanceMatrix.needsUpdate = true;
  }

  // A character's or person's face: a canvas with the pixel face drawn per frame (only when it changes).
  _face(face) {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = FACE_GRID * 4;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace; texture.magFilter = THREE.NearestFilter; texture.minFilter = THREE.NearestFilter; texture.generateMipmaps = false;
    const material = new THREE.MeshStandardMaterial({ map: texture, transparent: true, alphaTest: .5, roughness: .7, depthWrite: true });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(face.size[0], face.size[1]), material);
    mesh.rotation.order = 'ZYX'; mesh.rotation.x = Math.PI / 2;    // facing -Y in the Z-up world
    return { mesh, canvas, texture, palette: face.palette, state: '' };
  }
  static drawFace(canvas, palette, state) {
    const g = canvas.getContext('2d'), cell = canvas.width / FACE_GRID;
    g.clearRect(0, 0, canvas.width, canvas.height);
    const colours = { eye: palette.eye, catch: '#ffffff', brow: palette.outline, cheek: palette.cheek, mouth: palette.mouth, teeth: '#fff8ee' };
    for (const [x, y, key] of faceCells(state.expression, state.mouth, state.blink, state.look)) {
      g.fillStyle = colours[key]; g.fillRect(x * cell, y * cell, cell, cell);
    }
  }

  // The three.js scene of one beat, built once and reused for every frame of it.
  build(model, { flat = false, figureOnly = false } = {}) {
    const key = model.beat + (flat ? ':flat' : '') + (figureOnly ? ':figure' : '');
    if (this.scenes.has(key)) { const s = this.scenes.get(key); this.scenes.delete(key); this.scenes.set(key, s); return s; }
    const scene = new THREE.Scene(), sky = model.sky;
    const root = new THREE.Group(); root.rotation.x = -Math.PI / 2; scene.add(root);
    const groups = {};
    for (const name of Object.keys(model.groups)) { groups[name] = new THREE.Group(); groups[name].rotation.order = 'ZYX'; }
    for (const [name, g] of Object.entries(model.groups)) {
      const parent = g.parent ? model.groups[g.parent].pivot : [0, 0, 0];
      groups[name].userData.rest = g.pivot.map((v, i) => v - parent[i]);
      groups[name].position.set(...groups[name].userData.rest);
      (g.parent ? groups[g.parent] : root).add(groups[name]);
    }
    // At night and in the cave the figures glow a little in their own colours, so they read (and keep their sheet's hue)
    // without lighting the whole world up.
    const glow = figureOnly ? 0 : model.enclosed ? .4 : model.time === 'night' ? .38 : model.time === 'dusk' ? .1 : 0;
    for (const part of model.parts) {
      const material = flat ? new THREE.MeshBasicMaterial({ color: part.color })
        : new THREE.MeshStandardMaterial({ color: part.color, roughness: .62, metalness: 0, envMapIntensity: .3,
          emissive: new THREE.Color(part.color), emissiveIntensity: glow });
      const mesh = new THREE.Mesh(this._partGeometry(part.size, part.bevel, part.taper), material);
      mesh.castShadow = true; mesh.receiveShadow = true;
      const pivot = model.groups[part.group].pivot;
      mesh.position.set(part.pos[0] - pivot[0], part.pos[1] - pivot[1], part.pos[2] - pivot[2]);
      mesh.rotation.order = 'ZYX'; if (part.rot) mesh.rotation.set(...part.rot);
      groups[part.group].add(mesh);
    }
    const faces = {};
    for (const face of model.faces) {
      const f = this._face(face), pivot = model.groups[face.group].pivot;
      if (glow) { f.mesh.material.emissive = new THREE.Color('#ffffff'); f.mesh.material.emissiveMap = f.texture; f.mesh.material.emissiveIntensity = glow; }
      f.mesh.position.set(face.pos[0] - pivot[0], face.pos[1] - pivot[1], face.pos[2] - pivot[2]);
      if (flat) f.mesh.visible = false;          // the colour key shows the spec's flat colours only
      groups[face.group].add(f.mesh); faces[face.key] = f;
    }
    let animated = [];
    const built = { scene, groups, faces, animated, root };
    if (!figureOnly) {
      animated = built.animated = this._blocks(model, root);
      const day = model.time !== 'night';
      // Round puffy clouds, lit softly.
      if (model.puffs.length) {
        const cloud = new THREE.InstancedMesh(this.sphere, new THREE.MeshStandardMaterial({ color: day ? '#ffffff' : '#8e9ad0', roughness: 1,
          emissive: new THREE.Color(sky.horizon), emissiveIntensity: day ? .18 : .1 }), model.puffs.length);
        const m = new THREE.Matrix4();
        model.puffs.forEach((p, i) => cloud.setMatrixAt(i, m.makeScale(p.r, p.r * .78, p.r * .72).setPosition(p.x, p.y, p.z)));
        cloud.instanceMatrix.needsUpdate = true; cloud.frustumCulled = false; root.add(cloud);
      }
      // Sky, sun or moon disc (round), stars at night.
      const discDir = model.enclosed ? new THREE.Vector3() : zup(sky.disc === 'moon' ? [-.45, 1, .55] : model.time === 'dusk' ? [.55, 1, .1] : [-.35, 1, .62]).normalize();
      const dome = new THREE.Mesh(new THREE.SphereGeometry(140, 48, 24), skyMaterial(sky, discDir));
      dome.renderOrder = -1; scene.add(dome); built.dome = dome;
      if (!model.enclosed) {
        const disc = new THREE.Mesh(new THREE.SphereGeometry(model.time === 'night' ? 3.2 : 4.4, 32, 16), new THREE.MeshBasicMaterial({ color: sky.disc_color, fog: false }));
        disc.position.copy(discDir.clone().multiplyScalar(120)); scene.add(disc); built.disc = disc; built.discDir = discDir;
        if (model.time === 'night') {
          const stars = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshBasicMaterial({ color: '#f4f6ff', fog: false }), 220);
          const m = new THREE.Matrix4();
          let s = 7;
          const rand = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
          for (let i = 0; i < 220; i++) {
            const a = rand() * Math.PI * 1.4 - Math.PI * .2, h = .08 + rand() * .9, r = .16 + rand() * .3;
            const d = new THREE.Vector3(Math.cos(a) * Math.cos(h), Math.sin(h), -Math.sin(a) * Math.cos(h)).multiplyScalar(130);
            stars.setMatrixAt(i, m.makeScale(r, r, r).setPosition(d));
          }
          stars.instanceMatrix.needsUpdate = true; stars.frustumCulled = false; scene.add(stars); built.stars = stars;
        }
      }
      scene.fog = new THREE.Fog(new THREE.Color(sky.fog), model.enclosed ? 7 : 24, model.enclosed ? 26 : 62);
      scene.background = new THREE.Color(sky.horizon);
    }
    if (!flat) {
      const sky2 = model.sky;
      const hemi = new THREE.HemisphereLight(new THREE.Color(sky2.fill || '#ffffff'), new THREE.Color(sky2.ground || '#888888'), (sky2.fillPower ?? 1) * (model.enclosed ? .55 : 1));
      scene.add(hemi);
      // The key: from the camera's side and above, so faces are lit; colour and height by the time of day.
      const height = model.time === 'dusk' ? 3.2 : model.time === 'night' ? 6 : 8.5;
      const key = new THREE.DirectionalLight(new THREE.Color(sky2.key || '#ffffff'), (sky2.keyPower ?? 2.5) * (model.enclosed ? .55 : 1));
      key.position.copy(zup([-5.5, -7, height])); key.target.position.copy(zup([0, 1, 0]));
      key.castShadow = !figureOnly;
      key.shadow.mapSize.set(4096, 4096); key.shadow.radius = 6; key.shadow.blurSamples = 16;
      const sc = key.shadow.camera; sc.left = -16; sc.right = 16; sc.top = 16; sc.bottom = -16; sc.near = .5; sc.far = 60;
      key.shadow.bias = -.0004; key.shadow.normalBias = .03;
      scene.add(key, key.target); built.key = key;
      // A soft rim from behind so figures stand out from the world.
      const rim = new THREE.DirectionalLight(new THREE.Color(sky2.horizon || '#ffffff'), .55);
      rim.position.copy(zup([4, 9, 5])); rim.target.position.copy(zup([0, 0, 1])); scene.add(rim, rim.target);
      for (const glow of figureOnly ? [] : model.glows) {
        const light = new THREE.PointLight(new THREE.Color(glow.color), glow.power * (model.time === 'night' || model.enclosed ? 2.2 : .6), 9, 1.6);
        light.position.copy(zup(glow.pos)); scene.add(light);
      }
    }
    this.scenes.set(key, built);
    while (this.scenes.size > 4) {
      const [old, value] = this.scenes.entries().next().value;
      this.scenes.delete(old);
      value.scene.traverse(o => {
        if (o.isInstancedMesh) { o.dispose(); o.material.dispose(); }
        else if (o.isMesh && o.material?.map?.isCanvasTexture && o.material.map !== this.pillow) { o.material.map.dispose(); o.material.dispose(); }
      });
    }
    return built;
  }

  _pose(built, pose) {
    for (const [name, t] of Object.entries(pose.groups)) {
      const g = built.groups[name];
      if (!g) continue;
      const r = g.userData.rest;
      g.position.set(r[0] + t[0], r[1] + t[1], r[2] + t[2]); g.rotation.set(t[3], t[4], t[5]);
      g.scale.set(t[6] || 1e-5, t[7] || 1e-5, t[8] || 1e-5);
    }
    for (const [key, f] of Object.entries(built.faces)) {
      const state = pose.faces?.[key];
      if (!state) continue;
      const id = `${state.expression}:${state.mouth}:${state.blink}:${state.look}`;
      if (id === f.state) continue;
      f.state = id; VoxelRenderer.drawFace(f.canvas, f.palette, state); f.texture.needsUpdate = true;
    }
  }

  _camera(camera, w = this.w, h = this.h) {
    const c = this.camera, f = fovs(camera.lens, w, h);
    c.aspect = w / h; c.fov = f.v * 180 / Math.PI; c.updateProjectionMatrix();
    c.position.copy(zup(camera.pos)); c.up.set(0, 1, 0); c.lookAt(zup(camera.target)); c.updateMatrixWorld();
  }

  // One frame of a voxel beat, at the output size. Returns the output canvas (the engine draws it as the background).
  render(model, pose) {
    const built = this.build(model);
    this._pose(built, pose);
    this._animate(built.animated, pose.t || 0);
    this._camera(pose.camera);
    if (built.dome) built.dome.position.copy(this.camera.position);
    if (built.disc) built.disc.position.copy(this.camera.position).addScaledVector(built.discDir, 120);
    if (built.stars) built.stars.position.copy(this.camera.position);
    if (built.key) {
      const target = zup(pose.camera.target);
      built.key.target.position.set(target.x, 0, target.z);
      built.key.position.copy(built.key.target.position).add(zup([-5.5, -7, model.time === 'dusk' ? 3.2 : model.time === 'night' ? 6 : 8.5]));
    }
    built.scene.updateMatrixWorld();
    if (this.composer) {
      this.renderPass.scene = built.scene; this.gtao.scene = built.scene;
      this.composer.render();
    } else {
      this.renderer.setRenderTarget(null); this.renderer.render(built.scene, this.camera);
    }
    this.octx.clearRect(0, 0, this.w, this.h);
    this.octx.drawImage(this.gl, 0, 0, this.w, this.h);
    return this.out;
  }

  dispose() {
    for (const value of this.scenes.values()) value.scene.traverse(o => { if (o.isInstancedMesh) o.dispose(); });
    this.scenes.clear();
    for (const g of this.geometries.values()) g.dispose();
    for (const g of this.unit.values()) g.dispose();
    this.sphere.dispose(); this.pillow.dispose();
    this.composer?.dispose?.();
    this.renderer.dispose(); this.renderer.forceContextLoss();
  }

  // A character sheet cell: one figure, an orthographic camera, a transparent background (no world), lit softly, or flat
  // (each part in its spec colour, unlit, no face) for the colour key the sheet checks measure.
  renderCell(model, pose, { width, height, center, viewHeight, yaw = 0, flat = false }) {
    const built = this.build(model, { flat, figureOnly: true });
    this._pose(built, pose);
    const cam = new THREE.OrthographicCamera(-viewHeight * width / height / 2, viewHeight * width / height / 2, viewHeight / 2, -viewHeight / 2, .05, 50);
    const d = 8, pos = [center[0] + d * Math.sin(yaw), center[1] - d * Math.cos(yaw), center[2]];
    cam.position.copy(zup(pos)); cam.up.set(0, 1, 0); cam.lookAt(zup(center)); cam.updateMatrixWorld();
    const r = this.renderer, tone = r.toneMapping, shadows = r.shadowMap.enabled;
    if (flat) r.toneMapping = THREE.NoToneMapping;
    r.shadowMap.enabled = false;
    if (built.key && !flat) { built.key.position.copy(zup([pos[0] - 3, pos[1] - 2, center[2] + 6])); built.key.target.position.copy(zup(center)); }
    r.setRenderTarget(null); r.setClearColor(0x000000, 0); r.setSize(width, height, false); r.clear();
    built.scene.updateMatrixWorld();
    r.render(built.scene, cam);
    r.toneMapping = tone; r.shadowMap.enabled = shadows;
    const out = document.createElement('canvas'); out.width = width; out.height = height;
    out.getContext('2d').drawImage(this.gl, 0, 0, width, height, 0, 0, width, height);
    r.setSize(this.w * this.ss, this.h * this.ss, false);
    return out;
  }
}
