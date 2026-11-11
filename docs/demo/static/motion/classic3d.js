// Pack C classic's renderer (David, 2026-11-10): the classic block world (classic.js) drawn with three.js (MIT, vendored in
// static/vendor/three) in the render window's WebGL, on the same player contract as every video: the engine calls it
// inside its synchronous drawFrame(t).
//
// The look the reference asks for: hard 16 x 16 pixel textures drawn in code (blocks.js) shown nearest-neighbour, faces
// only where no neighbour hides them, gathered into one mesh per texture; a warm sun with sharp shadows and a sky fill; a
// sky gradient from the horizon to overhead; flat white box clouds; the Standard look (no tone mapping), no motion blur
// and no depth of field. A story frame (Story Short) is two pictures in one: the avatar room on top, the scene below.
import * as THREE from 'three';
import { BLOCKS, TEX, blockTexture, skinTexture, hairSlab, faceTexture } from './blocks.js';
import { meshWorld, blockCharacter, ROOM, roomModel, P } from './classic.js';

const lin = c => new THREE.Color(c[0] / 255, c[1] / 255, c[2] / 255).convertSRGBToLinear();
const DEG = Math.PI / 180;

// A pixel texture (top row first) as a three.js texture, hard pixels.
function dataTexture(t) {
  const flipped = new Uint8Array(t.w * t.h * 4);
  for (let y = 0; y < t.h; y++) flipped.set(t.data.subarray((t.h - 1 - y) * t.w * 4, (t.h - y) * t.w * 4), y * t.w * 4);
  const tex = new THREE.DataTexture(flipped, t.w, t.h, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace; tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestMipmapNearestFilter;
  tex.generateMipmaps = true; tex.needsUpdate = true;
  return tex;
}

// A box in the Z-up frame with its own UVs per face (v up the sides, u left to right as seen from outside), and one
// material group per face in the order front (-Y), back (+Y), left (-X), right (+X), top (+Z), bottom (-Z).
export function skinBox(sx, sy, sz) {
  const x = sx / 2, y = sy / 2, z = sz / 2;
  const faces = [
    [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z], [0, -1, 0]],
    [[x, y, -z], [-x, y, -z], [-x, y, z], [x, y, z], [0, 1, 0]],
    [[-x, y, -z], [-x, -y, -z], [-x, -y, z], [-x, y, z], [-1, 0, 0]],
    [[x, -y, -z], [x, y, -z], [x, y, z], [x, -y, z], [1, 0, 0]],
    [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z], [0, 0, 1]],
    [[-x, y, -z], [x, y, -z], [x, -y, -z], [-x, -y, -z], [0, 0, -1]],
  ];
  const pos = [], nor = [], uv = [], g = new THREE.BufferGeometry();
  const UV = [[0, 0], [1, 0], [1, 1], [0, 1]];
  faces.forEach(([a, b, c, d, n], i) => {
    const q = [a, b, c, d];
    for (const k of [0, 1, 2, 0, 2, 3]) { pos.push(...q[k]); nor.push(...n); uv.push(...UV[k]); }
    g.addGroup(i * 6, 6, i);
  });
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}
const FACE_ORDER = ['front', 'back', 'left', 'right', 'top', 'bottom'];

function skyMaterial(sky) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: lin(sky.top) }, horizon: { value: lin(sky.horizon) } },
    vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; varying vec3 vDir;
      void main() { float h = clamp(vDir.y, 0.0, 1.0); gl_FragColor = vec4(mix(horizon, top, pow(h, 0.7)), 1.0);
        #include <colorspace_fragment>
      }`,
  });
}

export class ClassicRenderer {
  constructor(width, height, { ss = 2 } = {}) {
    this.w = width; this.h = height; this.ss = ss; this.lost = 0;
    this.gl = document.createElement('canvas'); this.gl.width = width * ss; this.gl.height = height * ss;
    this.gl.addEventListener('webglcontextlost', e => { this.lost++; e.preventDefault(); });
    const r = this.renderer = new THREE.WebGLRenderer({ canvas: this.gl, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    r.setPixelRatio(1); r.setSize(width * ss, height * ss, false);
    r.toneMapping = THREE.NoToneMapping;                        // the Standard look: no filmic curve
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFShadowMap;
    r.autoClear = false;
    const ctx = r.getContext(), info = ctx.getExtension('WEBGL_debug_renderer_info');
    this.info = { renderer: info ? ctx.getParameter(info.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER), webgl2: r.capabilities.isWebGL2, three: THREE.REVISION, ss, look: 'classic' };
    this.out = document.createElement('canvas'); this.out.width = width; this.out.height = height;
    this.octx = this.out.getContext('2d'); this.octx.imageSmoothingEnabled = true; this.octx.imageSmoothingQuality = 'high';
    this.camera = new THREE.PerspectiveCamera(50, width / height, .05, 400);
    this.textures = new Map(); this.materials = new Map(); this.scenes = new Map(); this.characters = new Map(); this.faces = new Map();
    this.unit = skinBox(1, 1, 1);
  }

  tex(name) {
    if (!this.textures.has(name)) this.textures.set(name, dataTexture(blockTexture(name)));
    return this.textures.get(name);
  }
  blockMaterial(name) {
    if (!this.materials.has(name)) {
      const def = Object.values(BLOCKS).find(b => b.faces?.includes(name) || b.sprite === name) || {};
      const glow = name === 'cloud' ? .4 : name === 'lantern' ? .9 : 0;
      const m = new THREE.MeshLambertMaterial({ map: this.tex(name), transparent: name === 'water', opacity: name === 'water' ? .82 : 1,
        alphaTest: def.sprite ? .5 : 0, side: def.sprite ? THREE.DoubleSide : THREE.FrontSide,
        emissive: glow ? new THREE.Color('#ffffff') : new THREE.Color(0), emissiveMap: glow ? this.tex(name) : null, emissiveIntensity: glow });
      this.materials.set(name, m);
    }
    return this.materials.get(name);
  }
  // A block as a cube with its own faces (debris, props): [front, back, left, right, top, bottom] materials.
  cubeMaterials(block) {
    const [top, bottom, side] = BLOCKS[block].faces;
    return [side, side, side, side, top, bottom || top].map(n => this.blockMaterial(n || top));
  }

  // The static world of a place as meshes (one per texture), in the Z-up root.
  _world(world, skip) {
    const group = new THREE.Group();
    for (const [name, m] of Object.entries(meshWorld(world, skip))) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(m.normals, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(m.uvs, 2));
      const mesh = new THREE.Mesh(g, this.blockMaterial(name));
      mesh.castShadow = name !== 'water' && !BLOCKS[name]?.sprite; mesh.receiveShadow = true; mesh.frustumCulled = false;
      group.add(mesh);
    }
    // Flat white box clouds, lit a little by themselves (emission 0.4 in the reference).
    if (world.clouds.length) {
      const cloud = new THREE.InstancedMesh(this.unit, new THREE.MeshLambertMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: .4 }), world.clouds.length);
      const m = new THREE.Matrix4();
      world.clouds.forEach((c, i) => cloud.setMatrixAt(i, m.makeScale(c.w, c.d, 1).setPosition(c.x, c.y, c.z)));
      cloud.instanceMatrix.needsUpdate = true; cloud.frustumCulled = false; group.add(cloud);
    }
    return group;
  }

  // A character's meshes: groups with their rest pivots, each box with its per-face pixel textures.
  _character(model, root, prefix, colours = {}) {
    const groups = {};
    for (const [name, g] of Object.entries(model.groups)) { groups[name] = new THREE.Group(); groups[name].rotation.order = 'ZYX'; }
    for (const [name, g] of Object.entries(model.groups)) {
      const parent = g.parent ? model.groups[g.parent].pivot : [0, 0, 0];
      groups[name].userData.rest = g.pivot.map((v, i) => v - parent[i]);
      groups[name].position.set(...groups[name].userData.rest);
      (g.parent ? groups[g.parent] : root).add(groups[name]);
    }
    const id = model.id;
    let face = null;
    for (const part of model.parts) {
      const geometry = skinBox(...part.size);
      let materials;
      if (part.colour) materials = new THREE.MeshLambertMaterial({ color: part.colour });
      else materials = FACE_ORDER.map(f => {
        const key = part.tex[f];
        if (key === `${id}:face`) { const m = new THREE.MeshLambertMaterial({ map: this.faceTex(model.outfit, 'neutral', false, 0, false) }); face = m; return m; }
        return new THREE.MeshLambertMaterial({ map: this.skinTex(model.outfit, part.name, f) });
      });
      const mesh = new THREE.Mesh(geometry, materials);
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.userData.part = part.name;
      mesh.position.set(part.pos[0], part.pos[1], part.pos[2]);
      groups[part.group].add(mesh);
    }
    return { groups, face, outfit: model.outfit, state: '' };
  }
  skinTex(outfit, part, face) {
    const kind = part === 'hair' ? 'slab' : part.startsWith('arm') ? 'arm' : part.startsWith('leg') ? 'leg' : part;
    const key = `${JSON.stringify(outfit)}:${kind}:${face}`;
    if (!this.textures.has(key)) this.textures.set(key, dataTexture(kind === 'slab' ? hairSlab(outfit) : skinTexture(outfit, kind, face)));
    return this.textures.get(key);
  }
  faceTex(outfit, mood, open, look, blink) {
    const key = `${JSON.stringify(outfit)}:face:${mood}:${open}:${look}:${blink}`;
    if (!this.faces.has(key)) {
      this.faces.set(key, dataTexture(faceTexture(outfit, mood, open, look, blink)));
      if (this.faces.size > 400) { const [old, tex] = this.faces.entries().next().value; this.faces.delete(old); tex.dispose(); }
    }
    return this.faces.get(key);
  }
  _setFace(c, mood, open, look, blink) {
    const id = `${mood}:${open}:${look}:${blink}`;
    if (!c.face || c.state === id) return;
    c.state = id; c.face.map = this.faceTex(c.outfit, mood, open, look, blink); c.face.needsUpdate = true;
  }

  _sun(scene, sky, power = 1) {
    const sun = new THREE.DirectionalLight(lin(sky.sun.map(v => v * 255)), sky.sunPower * .92 * power);
    sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096); sun.shadow.radius = 1.2;
    const sc = sun.shadow.camera; sc.left = -22; sc.right = 22; sc.top = 22; sc.bottom = -22; sc.near = .5; sc.far = 140;
    sun.shadow.bias = -.0005; sun.shadow.normalBias = .02;
    scene.add(sun, sun.target);
    const fill = new THREE.HemisphereLight(lin(sky.top), lin([110, 96, 80]), sky.world * 2.6 * power);
    scene.add(fill);
    return sun;
  }

  // The scene of one story or classic voxel beat, built once.
  build(model) {
    const key = `${model.world.place}:${model.world.seed}:${model.world.time}:${model.gone.size}:${model.beat}`;
    if (this.scenes.has(key)) return this.scenes.get(key);
    const scene = new THREE.Scene(), root = new THREE.Group(); root.rotation.x = -Math.PI / 2; scene.add(root);
    const sky = model.world.sky;
    scene.background = lin(sky.horizon);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(300, 32, 16), skyMaterial(sky)); dome.renderOrder = -1; scene.add(dome);
    scene.fog = new THREE.Fog(lin(sky.fog), model.world.place === 'cave' ? 14 : 70, model.world.place === 'cave' ? 46 : 190);
    const whole = this._world(model.world, model.gone); root.add(whole);
    // The blocks a blast in this beat takes away, as their own group: shown until the blast, then hidden.
    const blastGroups = model.debris.map(list => {
      const g = new THREE.Group();
      for (const b of list) { const m = new THREE.Mesh(this.unit, this.cubeMaterials(b.block)); m.position.set(b.i + .5, b.j + .5, b.k + .5); m.castShadow = true; m.receiveShadow = true; g.add(m); }
      root.add(g); return g;
    });
    if (model.debris.some(l => l.length)) {
      // The static world is built without the blast's blocks; they live in the blast group.
      const skip = new Set(model.gone); for (const list of model.debris) for (const b of list) skip.add(`${b.i},${b.j},${b.k}`);
      root.remove(whole); root.add(this._world(model.world, skip));
    }
    const actors = model.actors.map(a => {
      if (!a.model) return null;
      const holder = new THREE.Group(); holder.rotation.order = 'ZYX'; root.add(holder);
      const c = this._character(a.model, holder, a.key);
      return { ...c, holder };
    });
    for (const p of model.props) {
      if (p.kind === 'crate' || p.kind === 'cake' || p.kind === 'lantern') {
        const m = new THREE.Mesh(this.unit, this.cubeMaterials(p.kind));
        const s = p.kind === 'cake' ? [.9, .9, .5] : [1, 1, 1];
        m.scale.set(...s); m.position.set(p.x, p.y, p.z + s[2] / 2); m.castShadow = true; m.receiveShadow = true; root.add(m);
      } else if (p.kind === 'balloon') {
        const m = new THREE.Mesh(this.unit, new THREE.MeshLambertMaterial({ color: p.colour || '#e8434e' })); m.scale.set(.55, .55, .65); m.position.set(p.x, p.y, p.z + 2.6); root.add(m);
        const s = new THREE.Mesh(this.unit, new THREE.MeshLambertMaterial({ color: '#f2f2f2' })); s.scale.set(.03, .03, 2.2); s.position.set(p.x, p.y, p.z + 1.15); root.add(s);
      } else if (p.kind === 'table') {
        const m = new THREE.Mesh(this.unit, this.cubeMaterials('planks')); m.scale.set(2.4, 1, .2); m.position.set(p.x, p.y, p.z + .9); m.castShadow = true; root.add(m);
        for (const dx of [-1, 1]) { const l = new THREE.Mesh(this.unit, this.cubeMaterials('log')); l.scale.set(.2, .2, .8); l.position.set(p.x + dx, p.y, p.z + .4); root.add(l); }
      }
    }
    // The effects' meshes: fuse crates with their flash, debris and smoke, the blast light, splat and pop cubes.
    const fx = { crates: [], light: new THREE.PointLight(lin([255, 150, 60]), 0, 30, 1.4), smoke: null, splat: null };
    root.add(fx.light);
    for (const f of model.fx) if (f.kind === 'fuse') {
      const crate = new THREE.Mesh(this.unit, this.cubeMaterials('crate')); crate.position.set(f.pos[0], f.pos[1], f.pos[2] + .5); crate.castShadow = true;
      const flash = new THREE.Mesh(this.unit, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false }));
      flash.scale.setScalar(1.02); flash.position.copy(crate.position);
      root.add(crate, flash); fx.crates.push({ crate, flash });
    }
    fx.debris = model.debris.map(list => list.map(b => { const m = new THREE.Mesh(this.unit, this.cubeMaterials(b.block)); m.visible = false; m.rotation.order = 'ZYX'; m.castShadow = true; root.add(m); return m; }));
    if (model.blasts.length) {
      fx.smoke = new THREE.InstancedMesh(this.unit, new THREE.MeshLambertMaterial({ color: '#9a9a9a', transparent: true, opacity: .85, depthWrite: false }), 22 * model.blasts.length);
      fx.smoke.count = 0; fx.smoke.frustumCulled = false; root.add(fx.smoke);
    }
    fx.splat = new THREE.InstancedMesh(this.unit, new THREE.MeshLambertMaterial({ color: '#ffffff' }), 40);
    fx.splat.count = 0; fx.splat.frustumCulled = false; root.add(fx.splat);
    const lights = [];
    for (const l of model.world.lanterns) { const pl = new THREE.PointLight(lin([255, 210, 140]), 6, 14, 1.6); pl.position.set(...l); root.add(pl); lights.push(pl); }
    const sun = this._sun(scene, sky);
    const built = { scene, root, dome, actors, blastGroups, fx, sun };
    this.scenes.set(key, built);
    while (this.scenes.size > 6) {
      const [old, value] = this.scenes.entries().next().value;
      this.scenes.delete(old);
      value.scene.traverse(o => { if (o.isMesh && o.geometry !== this.unit) o.geometry.dispose(); });
    }
    return built;
  }

  _pose(built, model, pose) {
    pose.poses.forEach((q, i) => {
      const c = built.actors[i];
      if (!c) return;
      c.holder.position.set(q.x, q.y, q.z); c.holder.rotation.set(0, 0, q.yaw);
      for (const name of ['body', 'head', 'arm_l', 'arm_r', 'leg_l', 'leg_r']) {
        const g = c.groups[name], r = q.q[name];
        g.position.set(...g.userData.rest); g.rotation.set(r[0], r[1], r[2]);
      }
      this._setFace(c, q.mood, !!q.open, q.look || 0, !!q.blink);
    });
    // Effects.
    let crate = 0;
    for (const e of pose.effects) {
      if (e.kind === 'fuse') {
        const c = built.fx.crates[crate++];
        if (!c) continue;
        c.crate.visible = c.flash.visible = e.visible;
        c.crate.scale.setScalar(e.scale); c.flash.scale.setScalar(e.scale * 1.02); c.flash.material.opacity = e.flash;
      } else if (e.kind === 'blast') {
        const g = built.blastGroups[e.index]; if (g) g.visible = !e.blown;
        const meshes = built.fx.debris[e.index] || [];
        meshes.forEach((m, n) => { const d = e.debris[n]; m.visible = !!d; if (d) { m.position.set(...d.pos); m.rotation.set(...d.rot); m.scale.setScalar(d.scale); } });
        built.fx.light.intensity = Math.max(built.fx.light.intensity, 120 * e.light); built.fx.light.position.set(...e.pos);
        if (built.fx.smoke) {
          const m = new THREE.Matrix4(), c = new THREE.Color();
          let n = e.index * 22;
          for (const s of e.smoke) { built.fx.smoke.setMatrixAt(n, m.makeScale(s.size, s.size, s.size).setPosition(...s.pos)); built.fx.smoke.setColorAt(n, c.setScalar(s.shade)); n++; }
          built.fx.smoke.count = Math.max(built.fx.smoke.count, n); built.fx.smoke.material.opacity = .85 * (e.smoke[0]?.alpha ?? 0);
          built.fx.smoke.instanceMatrix.needsUpdate = true; if (built.fx.smoke.instanceColor) built.fx.smoke.instanceColor.needsUpdate = true;
        }
      } else if (e.kind === 'splat' || e.kind === 'pop') {
        const m = new THREE.Matrix4(), c = new THREE.Color(), s = built.fx.splat;
        let n = s.count;
        for (const cube of e.cubes) { if (n >= 40) break; s.setMatrixAt(n, m.makeScale(cube.size, cube.size, cube.size).setPosition(...cube.pos)); s.setColorAt(n, c.set(cube.colour)); n++; }
        s.count = n; s.instanceMatrix.needsUpdate = true; if (s.instanceColor) s.instanceColor.needsUpdate = true;
      }
    }
  }
  _reset(built) {
    built.fx.light.intensity = 0; built.fx.splat.count = 0; if (built.fx.smoke) built.fx.smoke.count = 0;
  }

  _camera(cam, w, h) {
    const c = this.camera;
    c.aspect = w / h; c.fov = cam.fov; c.near = .05; c.far = 400; c.updateProjectionMatrix();
    const z = v => new THREE.Vector3(v[0], v[2], -v[1]);
    c.position.copy(z(cam.pos)); c.up.copy(z(cam.up || [0, 0, 1])); c.lookAt(z(cam.target)); c.updateMatrixWorld();
  }

  // One scene picture into a rectangle of the output (x, y from the top, w, h in output pixels).
  _draw(built, cam, rect, sunAt) {
    const r = this.renderer, ss = this.ss, H = this.h * ss;
    this._camera(cam, rect.w, rect.h);
    built.dome.position.copy(this.camera.position);
    if (sunAt && built.sun) {
      // The sun stays high, a little to the left and in front (the camera's side), so faces turned to each other still catch it; its shadow box follows what the camera looks at.
      const t = new THREE.Vector3(sunAt[0], sunAt[2], -sunAt[1]);
      built.sun.target.position.copy(t); built.sun.position.copy(t).add(new THREE.Vector3(-6, 30, 20));
      built.sun.target.updateMatrixWorld();
    }
    built.scene.updateMatrixWorld();
    r.setViewport(rect.x * ss, H - (rect.y + rect.h) * ss, rect.w * ss, rect.h * ss);
    r.setScissor(rect.x * ss, H - (rect.y + rect.h) * ss, rect.w * ss, rect.h * ss); r.setScissorTest(true);
    r.render(built.scene, this.camera);
  }

  // A classic frame: the scene of `model` at `pose` into `rect` (default the whole frame). Returns the output canvas.
  render(model, pose, rect = { x: 0, y: 0, w: this.w, h: this.h }, avatar = null) {
    const r = this.renderer;
    r.setScissorTest(false); r.setClearColor(0x000000, 0); r.clear();
    const built = this.build(model);
    this._reset(built); this._pose(built, model, pose);
    this._draw(built, pose.camera, rect, pose.camera.target);
    if (avatar) this.renderAvatar(avatar);
    r.setScissorTest(false);
    this.octx.clearRect(0, 0, this.w, this.h);
    this.octx.drawImage(this.gl, 0, 0, this.w, this.h);
    return this.out;
  }

  // -- the avatar strip -------------------------------------------------------------------------------------------------
  _room(colour) {
    const key = `room:${colour}`;
    if (this.scenes.has(key)) return this.scenes.get(key);
    const scene = new THREE.Scene(), root = new THREE.Group(); root.rotation.x = -Math.PI / 2; scene.add(root);
    const room = roomModel(), wall = lin(ROOM.wall);
    scene.background = wall.clone().multiplyScalar(.6);
    const walls = new THREE.MeshLambertMaterial({ color: wall });
    const back = new THREE.Mesh(this.unit, walls); back.scale.set(14, .2, 7); back.position.set(0, room.wall.y + .1, 2.5); back.receiveShadow = true; root.add(back);
    const floor = new THREE.Mesh(this.unit, new THREE.MeshLambertMaterial({ color: '#1c1826' })); floor.scale.set(14, 8, .2); floor.position.set(0, 0, -.1); root.add(floor);
    for (const b of [...room.boxes, ...room.chair]) { const m = new THREE.Mesh(this.unit, new THREE.MeshLambertMaterial({ color: b.colour })); m.scale.set(...b.size); m.position.set(...b.pos); root.add(m); }
    const led = new THREE.MeshBasicMaterial({ color: colour });
    for (const l of room.leds) { const m = new THREE.Mesh(this.unit, led); m.scale.set(...l.size); m.position.set(...l.pos); root.add(m); }
    // A glow on the wall from the strips, the monitor's blue-white light from in front and below, a rim in the speaker's colour.
    const wash = new THREE.PointLight(new THREE.Color(colour), 9, 9, 1.4); wash.position.set(0, 2.4, 3.4); root.add(wash);
    const monitor = new THREE.DirectionalLight(lin(ROOM.monitor), 2.1); monitor.position.set(.4, -3, -1.2); root.add(monitor, monitor.target); monitor.target.position.set(0, 0, 1.6);
    const rim = new THREE.DirectionalLight(new THREE.Color(colour), 2.6); rim.position.set(-2.5, 3, 3.5); root.add(rim, rim.target); rim.target.position.set(0, 0, 1.6);
    scene.add(new THREE.HemisphereLight(lin([120, 110, 160]), lin([30, 26, 40]), .7));
    const holder = new THREE.Group(); holder.rotation.order = 'ZYX'; root.add(holder);
    const built = { scene, root, holder, character: null, characterKey: '', dome: new THREE.Object3D(), colour };
    this.scenes.set(key, built);
    return built;
  }
  // avatar: {rect, colour, outfit, id, mood, open, blink, camera, pose (classic.poseAt result)}
  renderAvatar(a) {
    const built = this._room(a.colour);
    const key = `${a.id}:${JSON.stringify(a.outfit)}`;
    if (built.characterKey !== key) {
      while (built.holder.children.length) built.holder.remove(built.holder.children[0]);
      const model = blockCharacter(a.id, a.outfit, { headset: a.colour });
      built.character = this._character(model, built.holder, 'avatar');
      built.characterKey = key;
    }
    const c = built.character;
    for (const name of ['body', 'head', 'arm_l', 'arm_r', 'leg_l', 'leg_r']) { const g = c.groups[name], r = a.pose[name]; g.position.set(...g.userData.rest); g.rotation.set(r[0], r[1], r[2]); }
    this._setFace(c, a.mood, a.open, 0, a.blink);
    this._draw(built, a.camera, a.rect, null);
  }

  dispose() {
    for (const value of this.scenes.values()) value.scene.traverse(o => { if (o.isMesh && o.geometry !== this.unit) o.geometry.dispose(); });
    this.scenes.clear();
    for (const t of this.textures.values()) t.dispose();
    for (const t of this.faces.values()) t.dispose();
    this.unit.dispose();
    this.renderer.dispose(); this.renderer.forceContextLoss();
  }

  // A character sheet cell: one classic figure, no world, an orthographic camera, transparent background; `flat` draws each
  // part in its spec colour, unlit (the colour key the sheet checks measure).
  renderCell(model, groups, face, { width, height, center, viewHeight, yaw = 0, flat = false, colours }) {
    const scene = new THREE.Scene(), root = new THREE.Group(); root.rotation.x = -Math.PI / 2; scene.add(root);
    const holder = new THREE.Group(); root.add(holder);
    const c = this._character(model, holder, 'sheet');
    for (const name of Object.keys(groups)) { const g = c.groups[name]; if (!g) continue; g.rotation.set(...groups[name]); }
    this._setFace(c, face.mood, face.open, 0, false);
    if (flat) {
      // Each part in its key colour: torso and arms the body (shirt), the head (skin), the legs the limb colour (pants).
      const key = { torso: colours.body, head: colours.head, arm_l: colours.body, arm_r: colours.body, leg_l: colours.limb, leg_r: colours.limb, hair: colours.outline };
      holder.traverse(o => { if (o.isMesh) o.material = new THREE.MeshBasicMaterial({ color: key[o.userData.part] || colours.accent }); });
    } else {
      scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 1.5));
      const sun = new THREE.DirectionalLight(0xfff4e6, 2.6); sun.position.set(-3, 4, 6); scene.add(sun);
    }
    const cam = new THREE.OrthographicCamera(-viewHeight * width / height / 2, viewHeight * width / height / 2, viewHeight / 2, -viewHeight / 2, .05, 50);
    const d = 8, pos = [center[0] + d * Math.sin(yaw), center[1] - d * Math.cos(yaw), center[2]];
    cam.position.set(pos[0], pos[2], -pos[1]); cam.up.set(0, 1, 0); cam.lookAt(center[0], center[2], -center[1]); cam.updateMatrixWorld();
    const r = this.renderer;
    r.setScissorTest(false); r.setViewport(0, 0, width, height); r.setSize(width, height, false); r.setClearColor(0x000000, 0); r.clear();
    const shadows = r.shadowMap.enabled; r.shadowMap.enabled = false;
    r.render(scene, cam);
    r.shadowMap.enabled = shadows;
    const out = document.createElement('canvas'); out.width = width; out.height = height;
    out.getContext('2d').drawImage(this.gl, 0, 0, width, height, 0, 0, width, height);
    r.setSize(this.w * this.ss, this.h * this.ss, false);
    scene.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
    return out;
  }
}
export { TEX, P, DEG };
