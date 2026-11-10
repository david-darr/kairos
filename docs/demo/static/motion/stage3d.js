// Pack B's built-in renderer: the stage model (stage.js) drawn with three.js (MIT, vendored in static/vendor/three, see
// VENDORED.txt) in the render window's WebGL. Same player contract as every video: the engine calls draw() inside its
// synchronous drawFrame(t), so frames, captions, transitions, chapters and resume work as for any other beat.
//
// The look pass (after the unit 5 spike, whose three.js clip read flatter than Blender's Eevee):
// - soft studio light: rectangular area lights (RectAreaLight, from three's examples) give broad soft highlights on the
//   glossy coat, with one soft shadow-casting spot at the key;
// - ambient occlusion: three's GTAO pass darkens creases (arms against the body, feet on the floor, props on the set);
// - contact shadows: the cast and props are drawn from below into a small depth texture, blurred twice, and the floor
//   darkens under them (the technique of three's own contact-shadow example, written into the floor's shader here);
// - a soft pool of light on the backdrop and a fine dither on the output so the curved wall shows no banding.
import * as THREE from 'three';
import { RoomEnvironment } from '/static/vendor/three/examples/jsm/environments/RoomEnvironment.js';
import { RectAreaLightUniformsLib } from '/static/vendor/three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { EffectComposer } from '/static/vendor/three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '/static/vendor/three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from '/static/vendor/three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from '/static/vendor/three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from '/static/vendor/three/examples/jsm/postprocessing/ShaderPass.js';
import { HorizontalBlurShader } from '/static/vendor/three/examples/jsm/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from '/static/vendor/three/examples/jsm/shaders/VerticalBlurShader.js';
import { fovs } from './stage.js';

RectAreaLightUniformsLib.init();

const zup = v => new THREE.Vector3(v[0], v[2], -v[1]);   // a shot point in three's Y-up world
const srgbToLinear = c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
// The contact shadow's box on the floor, in shot coordinates (x across, y into the set), and how high it looks.
const SHADOW = { x: [-5, 5], y: [-3.4, 2.6], height: .7, size: 1024, darkness: .62 };

// A final pass: one step of noise in the last bit, so smooth gradients on the curved wall do not band.
const DitherShader = {
  name: 'KairosDither', uniforms: { tDiffuse: { value: null } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
    float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() { vec4 c = texture2D(tDiffuse, vUv); c.rgb += (rand(gl_FragCoord.xy) - 0.5) / 255.0; gl_FragColor = c; }`,
};

export class StageRenderer {
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
    renderer.toneMappingExposure = 1;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    const ctx = renderer.getContext(), info = ctx.getExtension('WEBGL_debug_renderer_info');
    this.info = { renderer: info ? ctx.getParameter(info.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER), webgl2: renderer.capabilities.isWebGL2, three: THREE.REVISION, ss };
    this.out = document.createElement('canvas');
    this.out.width = width; this.out.height = height;
    this.octx = this.out.getContext('2d');
    this.octx.imageSmoothingEnabled = true; this.octx.imageSmoothingQuality = 'high';
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.environment = pmrem.fromScene(new RoomEnvironment(), .04).texture;
    pmrem.dispose();
    this.camera = new THREE.PerspectiveCamera(40, width / height, .05, 120);
    this.sphere = new THREE.SphereGeometry(1, 64, 32);
    this.geometries = new Map(); this.materials = new Map(); this.scenes = new Map();
    if (look) this._composer();
    this._contactShadow();
  }

  _composer() {
    const { w, h, ss } = this;
    const target = new THREE.WebGLRenderTarget(w * ss, h * ss, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.setPixelRatio(1);
    this.composer.setSize(w * ss, h * ss);
    this.renderPass = new RenderPass(null, this.camera);
    this.gtao = new GTAOPass(null, this.camera, w * ss, h * ss);
    this.gtao.updateGtaoMaterial({ radius: .32, distanceExponent: 1.4, thickness: 1, scale: 1, samples: 16, distanceFallOff: 1 });
    this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
    this.gtao.blendIntensity = .9;
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.gtao);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(new ShaderPass(DitherShader));
  }

  // Contact shadows: an orthographic camera under the floor looks up at everything within SHADOW.height of it.
  _contactShadow() {
    const { size } = SHADOW, wx = SHADOW.x[1] - SHADOW.x[0], wy = SHADOW.y[1] - SHADOW.y[0];
    this.shadowTarget = new THREE.WebGLRenderTarget(size, Math.round(size * wy / wx));
    this.shadowTarget.texture.generateMipmaps = false;
    this.blurTarget = new THREE.WebGLRenderTarget(this.shadowTarget.width, this.shadowTarget.height);
    const cam = this.shadowCamera = new THREE.OrthographicCamera(-wx / 2, wx / 2, wy / 2, -wy / 2, 0, SHADOW.height);
    cam.position.copy(zup([(SHADOW.x[0] + SHADOW.x[1]) / 2, (SHADOW.y[0] + SHADOW.y[1]) / 2, .001]));
    cam.up.set(0, 0, -1);
    cam.lookAt(cam.position.clone().add(new THREE.Vector3(0, 1, 0)));
    cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    this.shadowMatrix = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    // Depth as darkness: nearer the floor is darker (the contact-shadow example's depth material).
    this.depthMaterial = new THREE.MeshDepthMaterial();
    this.depthMaterial.onBeforeCompile = shader => {
      shader.fragmentShader = shader.fragmentShader.replace('gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
        'gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) );');
    };
    this.depthMaterial.depthTest = false; this.depthMaterial.depthWrite = false; this.depthMaterial.side = THREE.DoubleSide;
    this.blurH = new THREE.ShaderMaterial(HorizontalBlurShader); this.blurH.depthTest = false;
    this.blurV = new THREE.ShaderMaterial(VerticalBlurShader); this.blurV.depthTest = false;
    this.blurQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.blurCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  _renderContactShadow(scene) {
    const r = this.renderer, hidden = [];
    scene.traverse(o => { if (o.isMesh && o.userData.receiveOnly && o.visible) { o.visible = false; hidden.push(o); } });
    const background = scene.background, fog = scene.fog;
    scene.background = null; scene.overrideMaterial = this.depthMaterial;
    const clear = r.getClearAlpha();
    r.setClearAlpha(0);
    const tone = r.toneMapping; r.toneMapping = THREE.NoToneMapping;
    r.setRenderTarget(this.shadowTarget); r.clear(); r.render(scene, this.shadowCamera);
    scene.overrideMaterial = null; scene.background = background; scene.fog = fog;
    for (const o of hidden) o.visible = true;
    for (const amount of [2.2, 1.2]) {
      this.blurQuad.material = this.blurH; this.blurH.uniforms.tDiffuse.value = this.shadowTarget.texture; this.blurH.uniforms.h.value = amount / this.shadowTarget.width;
      r.setRenderTarget(this.blurTarget); r.render(this.blurQuad, this.blurCamera);
      this.blurQuad.material = this.blurV; this.blurV.uniforms.tDiffuse.value = this.blurTarget.texture; this.blurV.uniforms.v.value = amount / this.shadowTarget.height;
      r.setRenderTarget(this.shadowTarget); r.render(this.blurQuad, this.blurCamera);
    }
    r.setRenderTarget(null); r.setClearAlpha(clear); r.toneMapping = tone;
  }

  _geometry(key, data, colored) {
    const id = key + (colored ? ':c' : '');
    if (this.geometries.has(id)) return this.geometries.get(id);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(data.verts, 3));
    if (colored && data.colors) g.setAttribute('color', new THREE.Float32BufferAttribute(data.colors.map(srgbToLinear), 3));
    g.setIndex(data.faces);
    g.computeVertexNormals();
    this.geometries.set(id, g);
    return g;
  }

  _material(def, flat) {
    const id = JSON.stringify(def) + (flat ? ':flat' : '');
    if (this.materials.has(id)) return this.materials.get(id);
    let m;
    if (flat) m = new THREE.MeshBasicMaterial({ color: new THREE.Color(def.color), vertexColors: !!def.vertex_colors, side: THREE.DoubleSide });
    else {
      m = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(def.color), roughness: def.roughness, metalness: def.metallic || 0,
        clearcoat: def.coat || 0, clearcoatRoughness: def.coat_roughness ?? .05, vertexColors: !!def.vertex_colors,
        side: def.two_sided ? THREE.DoubleSide : THREE.FrontSide, envMapIntensity: .9 });
      if (def.emission) { m.emissive = new THREE.Color(def.color); m.emissiveIntensity = def.emission; }
    }
    this.materials.set(id, m);
    return m;
  }

  // The floor darkens under the cast from the contact-shadow texture, looked up by world position.
  _floorMaterial(def, tone) {
    const m = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(def.color), roughness: def.roughness, side: THREE.DoubleSide, envMapIntensity: .35 });
    const uniforms = { contactMap: { value: this.blurTarget && this.shadowTarget.texture }, contactMatrix: { value: this.shadowMatrix }, contactDark: { value: SHADOW.darkness } };
    m.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vKdWorld;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvKdWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vKdWorld;\nuniform sampler2D contactMap;\nuniform mat4 contactMatrix;\nuniform float contactDark;')
        .replace('#include <opaque_fragment>', `{
          vec4 p = contactMatrix * vec4(vKdWorld, 1.0); vec2 uv = p.xy * 0.5 + 0.5;
          float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0) * (1.0 - smoothstep(0.02, 0.12, vKdWorld.y));
          float a = texture2D(contactMap, uv).a * inside;
          outgoingLight *= 1.0 - contactDark * clamp(a * 1.6, 0.0, 1.0);
        }
        #include <opaque_fragment>`);
    };
    m.customProgramCacheKey = () => 'kd-floor';
    return m;
  }

  // The three.js scene of one stage model, built once and reused for every frame of the beat.
  build(model, { flat = false } = {}) {
    const key = model.beat + (flat ? ':flat' : '');
    if (this.scenes.has(key)) { const s = this.scenes.get(key); this.scenes.delete(key); this.scenes.set(key, s); return s; }
    const scene = new THREE.Scene(), tone = model.world;
    const root = new THREE.Group(); root.rotation.x = -Math.PI / 2; scene.add(root);
    const groups = {};
    for (const name of Object.keys(model.groups)) { groups[name] = new THREE.Group(); groups[name].rotation.order = 'ZYX'; }
    for (const [name, g] of Object.entries(model.groups)) {
      const parent = g.parent ? model.groups[g.parent].pivot : [0, 0, 0];
      groups[name].userData.rest = g.pivot.map((v, i) => v - parent[i]);
      groups[name].position.set(...groups[name].userData.rest);
      (g.parent ? groups[g.parent] : root).add(groups[name]);
    }
    for (const p of model.prims) {
      const def = model.materials[p.material];
      const material = p.name === 'cyclorama' && !flat ? this._floorMaterial(def) : this._material(def, flat);
      const geometry = p.type === 'sphere' ? this.sphere : this._geometry(p.mesh, model.meshes[p.mesh], !!def.vertex_colors);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = !p.receive_only; mesh.receiveShadow = true; mesh.userData.receiveOnly = !!p.receive_only;
      const pivot = p.group ? model.groups[p.group].pivot : [0, 0, 0];
      mesh.position.set(p.pos[0] - pivot[0], p.pos[1] - pivot[1], p.pos[2] - pivot[2]);
      mesh.rotation.order = 'ZYX'; mesh.rotation.set(...(p.rot || [0, 0, 0]));
      if (p.scale) mesh.scale.set(...p.scale);
      (p.group ? groups[p.group] : root).add(mesh);
    }
    if (!flat) {
      scene.background = new THREE.Color(tone.color);
      scene.environment = this.environment; scene.environmentIntensity = .22;
      scene.add(new THREE.HemisphereLight(new THREE.Color(tone.color), new THREE.Color(tone.bounce), .5));
      for (const li of model.lights) {
        const color = new THREE.Color(li.color), pos = zup(li.pos), target = zup(li.target);
        // Area lights: Blender's watts over the light's area, scaled to three's luminance by eye against the Eevee frame.
        const area = new THREE.RectAreaLight(color, li.power / (li.size * li.size) * .26, li.size, li.size);
        area.position.copy(pos); area.lookAt(target); scene.add(area);
        if (li.shadow) {
          const spot = new THREE.SpotLight(color, li.power * .13, 0, Math.PI / 4.5, 1, 2);
          spot.position.copy(pos); spot.target.position.copy(target); scene.add(spot, spot.target);
          spot.castShadow = true; spot.shadow.mapSize.set(2048, 2048);
          spot.shadow.camera.near = .5; spot.shadow.camera.far = 22; spot.shadow.radius = 9; spot.shadow.blurSamples = 16;
          spot.shadow.bias = -.0005; spot.shadow.normalBias = .02;
        }
      }
    }
    const built = { scene, groups };
    this.scenes.set(key, built);
    while (this.scenes.size > 4) {     // a few recent beats stay built; older ones free their GPU memory
      const [old, value] = this.scenes.entries().next().value;
      this.scenes.delete(old);
      value.scene.traverse(o => { if (o.isMesh) o.geometry !== this.sphere && !this._shared(o.geometry) && o.geometry.dispose(); });
    }
    return built;
  }
  _shared(geometry) { for (const g of this.geometries.values()) if (g === geometry) return true; return false; }

  _pose(built, pose) {
    for (const [name, t] of Object.entries(pose.groups)) {
      const g = built.groups[name];
      if (!g) continue;
      const r = g.userData.rest;
      g.position.set(r[0] + t[0], r[1] + t[1], r[2] + t[2]); g.rotation.set(t[3], t[4], t[5]);
      g.scale.set(t[6] || 1e-5, t[7] || 1e-5, t[8] || 1e-5);
      g.visible = !(t[6] === 0 && t[7] === 0 && t[8] === 0);
    }
  }

  _camera(camera, w = this.w, h = this.h) {
    const c = this.camera, f = fovs(camera.lens, w, h);
    c.aspect = w / h; c.fov = f.v * 180 / Math.PI; c.updateProjectionMatrix();
    c.position.copy(zup(camera.pos)); c.up.set(0, 1, 0); c.lookAt(zup(camera.target)); c.updateMatrixWorld();
  }

  // One frame of a stage beat, at the output size. Returns the output canvas (the engine draws it as the background).
  render(model, pose) {
    const built = this.build(model);
    this._pose(built, pose);
    this._camera(pose.camera);
    built.scene.updateMatrixWorld();
    this._renderContactShadow(built.scene);
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

  // A character sheet cell: one figure, a fixed orthographic camera, a transparent background (no set), lit like the
  // studio, or flat (each part in its spec colour, unlit) for the colour key the sheet checks measure.
  renderCell(model, pose, { width, height, center, viewHeight, yaw = 0, flat = false }) {
    const built = this.build(model, { flat });
    this._pose(built, pose);
    const cam = new THREE.OrthographicCamera(-viewHeight * width / height / 2, viewHeight * width / height / 2, viewHeight / 2, -viewHeight / 2, .05, 50);
    const d = 8, pos = [center[0] + d * Math.sin(yaw), center[1] - d * Math.cos(yaw), center[2]];
    cam.position.copy(zup(pos)); cam.up.set(0, 1, 0); cam.lookAt(zup(center)); cam.updateMatrixWorld();
    const r = this.renderer, tone = r.toneMapping, shadows = r.shadowMap.enabled;
    if (flat) r.toneMapping = THREE.NoToneMapping;
    r.shadowMap.enabled = false;      // a sheet cell has no floor to shadow; self-shadowing smudged the side view
    const background = built.scene.background; built.scene.background = null;
    r.setRenderTarget(null); r.setClearColor(0x000000, 0); r.setSize(width, height, false); r.clear();
    built.scene.updateMatrixWorld();
    r.render(built.scene, cam);
    built.scene.background = background; r.toneMapping = tone; r.shadowMap.enabled = shadows;
    const out = document.createElement('canvas'); out.width = width; out.height = height;
    out.getContext('2d').drawImage(this.gl, 0, 0, width, height, 0, 0, width, height);
    r.setSize(this.w * this.ss, this.h * this.ss, false);
    return out;
  }
}
