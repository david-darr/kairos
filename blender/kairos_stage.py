# Kairos Blender stage script: renders Pack B's 3D studio shots in Blender, headless, for Kairos's optional Blender renderer.
#
# MIT License
#
# Copyright (c) 2026 David Darr
#
# Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
# documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
# rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
# persons to whom the Software is furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
# Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
# WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
# COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
# OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
#
# Licence note: this file uses Blender's Python API (bpy), and blender.org asks that published scripts using it be under
# a GPL-compatible licence. The MIT licence above is GPL-compatible, so this script may be combined with Blender (GPL) as
# Blender's licence allows. Kairos never bundles, installs or downloads Blender; it runs the person's own copy as a
# separate program. What a person renders with Blender is their own (blender.org: "What you create with Blender is your
# sole property"). See blender/LICENSE.txt.
#
# Usage (Kairos's core/video_blender.py runs it; it reads only the two JSON files it is given and writes only PNGs and
# a timing file into the output folder):
#   blender -b --factory-startup -P kairos_stage.py -- --stage <stage.json> --poses <poses.json> --out <folder>
#           --width 1920 --height 1080 --first <frame> [--samples 32]
# stage.json holds the stage models (static/motion/stage.js stageModel, by beat id); poses.json holds one pose per frame
# from --first on (null where no stage shot is on screen). Every transform and camera comes from those files, so the
# picture matches the three.js renderer's animation exactly. Frames already in the output folder are skipped, so a stopped
# render resumes. Prints "KD_FRAME <n>" after each frame it writes.
import json
import math
import sys
import time
from pathlib import Path

import bmesh
import bpy
from mathutils import Euler, Vector

T0 = time.perf_counter()
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
opts = {argv[i]: argv[i + 1] for i in range(0, len(argv) - 1, 2)}
models = json.loads(Path(opts["--stage"]).read_text(encoding="utf-8"))
poses = json.loads(Path(opts["--poses"]).read_text(encoding="utf-8"))
out = Path(opts["--out"])
out.mkdir(parents=True, exist_ok=True)
first = int(opts.get("--first", 0))
width, height = int(opts.get("--width", 1920)), int(opts.get("--height", 1080))
samples = int(opts.get("--samples", 32))


def srgb_to_linear(c):
    return c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4


def colour(hex_, alpha=None):
    rgb = [srgb_to_linear(int(hex_[i:i + 2], 16) / 255) for i in (1, 3, 5)]
    return rgb + ([alpha] if alpha is not None else [])


bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.use_lock_interface = True   # the frame handler changes data while rendering


def material(name, m):
    mat = bpy.data.materials.new(name)
    try:
        mat.use_nodes = True
    except Exception:
        pass
    nodes = mat.node_tree.nodes
    bsdf = nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = colour(m["color"], 1.)
    bsdf.inputs["Roughness"].default_value = m.get("roughness", .5)
    bsdf.inputs["Metallic"].default_value = m.get("metallic", 0.)
    bsdf.inputs["Coat Weight"].default_value = m.get("coat", 0.)
    bsdf.inputs["Coat Roughness"].default_value = m.get("coat_roughness", .05)
    if m.get("emission"):
        bsdf.inputs["Emission Color"].default_value = colour(m["color"], 1.)
        bsdf.inputs["Emission Strength"].default_value = m["emission"]
    if m.get("vertex_colors"):
        attr = nodes.new("ShaderNodeVertexColor")
        attr.layer_name = "Col"
        mat.node_tree.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
    return mat


def uv_sphere(segments=64, rings=32):
    verts = [(0, 0, 1)]
    for r in range(1, rings):
        phi = math.pi * r / rings
        for s in range(segments):
            th = 2 * math.pi * s / segments
            verts.append((math.sin(phi) * math.cos(th), math.sin(phi) * math.sin(th), math.cos(phi)))
    verts.append((0, 0, -1))
    faces = [(0, 1 + (s + 1) % segments, 1 + s) for s in range(segments)]
    for r in range(rings - 2):
        a, b = 1 + r * segments, 1 + (r + 1) * segments
        faces += [(a + s, a + (s + 1) % segments, b + (s + 1) % segments, b + s) for s in range(segments)]
    last, base = len(verts) - 1, 1 + (rings - 2) * segments
    faces += [(base + s, base + (s + 1) % segments, last) for s in range(segments)]
    return verts, faces


SPHERE = uv_sphere()
_meshes = {}


def mesh_data(key, data, closed):
    if key in _meshes:
        return _meshes[key]
    verts = [tuple(data["verts"][i:i + 3]) for i in range(0, len(data["verts"]), 3)]
    faces = [tuple(data["faces"][i:i + 3]) for i in range(0, len(data["faces"]), 3)]
    me = bpy.data.meshes.new(key)
    me.from_pydata(verts, [], faces)
    if closed:
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(me)
        bm.free()
    if data.get("colors"):
        attr = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
        cols = data["colors"]
        for i in range(len(verts)):
            attr.data[i].color = (srgb_to_linear(cols[3 * i]), srgb_to_linear(cols[3 * i + 1]), srgb_to_linear(cols[3 * i + 2]), 1.)
    me.update()
    me.shade_smooth()
    _meshes[key] = me
    return me


def track(ob, target):
    ob.rotation_euler = (Vector(target) - ob.location).to_track_quat("-Z", "Y").to_euler()


built = {}
for beat_id, model in models.items():
    coll = bpy.data.collections.new("beat_" + beat_id)
    scene.collection.children.link(coll)
    mats = {name: material(f"{beat_id}:{name}", m) for name, m in model["materials"].items()}
    groups = {}
    for name in model["groups"]:
        e = bpy.data.objects.new(f"{beat_id}:{name}", None)
        coll.objects.link(e)
        groups[name] = e
    for name, g in model["groups"].items():
        e = groups[name]
        pivot = Vector(g["pivot"])
        if g["parent"]:
            e.parent = groups[g["parent"]]
            e.location = pivot - Vector(model["groups"][g["parent"]]["pivot"])
        else:
            e.location = pivot
        e["rest"] = list(e.location)
    for p in model["prims"]:
        if p["type"] == "sphere":
            me = _meshes.get("uv_sphere")
            if me is None:
                me = bpy.data.meshes.new("uv_sphere")
                me.from_pydata(SPHERE[0], [], SPHERE[1])
                bm = bmesh.new()
                bm.from_mesh(me)
                bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
                bm.to_mesh(me)
                bm.free()
                me.update()
                me.shade_smooth()
                me.materials.append(None)
                _meshes["uv_sphere"] = me
        else:
            key = p["mesh"]
            me = mesh_data(key, model["meshes"][key], not (key == "cyclorama" or key.endswith(":leaf")))
            if not me.materials:
                me.materials.append(None)
        ob = bpy.data.objects.new(f"{beat_id}:{p['name']}", me)
        coll.objects.link(ob)
        # The material is linked to the object, so one shared mesh can take different colours in different beats.
        ob.material_slots[0].link = "OBJECT"
        ob.material_slots[0].material = mats[p["material"]]
        pivot = Vector(model["groups"][p["group"]]["pivot"]) if p.get("group") else Vector((0, 0, 0))
        ob.location = Vector(p["pos"]) - pivot
        ob.rotation_euler = Euler(p.get("rot") or (0, 0, 0), "XYZ")
        if p.get("scale"):
            ob.scale = p["scale"]
        if p.get("group"):
            ob.parent = groups[p["group"]]
    for li in model["lights"]:
        ld = bpy.data.lights.new(f"{beat_id}:{li['name']}", "AREA")
        ld.shape = "DISK"
        ld.size = li["size"]
        ld.energy = li["power"]
        ld.color = colour(li["color"])
        lo = bpy.data.objects.new(f"{beat_id}:{li['name']}", ld)
        coll.objects.link(lo)
        lo.location = li["pos"]
        track(lo, li["target"])
    built[beat_id] = {"collection": coll, "groups": groups, "world": model["world"]}

world = bpy.data.worlds.new("studio")
scene.world = world
try:
    world.use_nodes = True
except Exception:
    pass
background = world.node_tree.nodes.get("Background") or world.node_tree.nodes.new("ShaderNodeBackground")
if not any(link.to_node.type == "OUTPUT_WORLD" for link in world.node_tree.links):
    output = world.node_tree.nodes.get("World Output") or world.node_tree.nodes.new("ShaderNodeOutputWorld")
    world.node_tree.links.new(background.outputs["Background"], output.inputs["Surface"])

cam_data = bpy.data.cameras.new("camera")
cam_data.sensor_fit = "HORIZONTAL"
cam_data.sensor_width = 36.0
cam_data.clip_start, cam_data.clip_end = .05, 120
cam = bpy.data.objects.new("camera", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
shown = {"beat": None}


def apply(frame):
    pose = poses[frame - first] if 0 <= frame - first < len(poses) else None
    if not pose:
        return
    if shown["beat"] != pose["beat"]:
        for beat_id, b in built.items():
            b["collection"].hide_render = beat_id != pose["beat"]
        w = built[pose["beat"]]["world"]
        background.inputs["Color"].default_value = colour(w["color"], 1.)
        background.inputs["Strength"].default_value = w["strength"]
        shown["beat"] = pose["beat"]
    groups = built[pose["beat"]]["groups"]
    for name, t in pose["groups"].items():
        e = groups.get(name)
        if e is None:
            continue
        rest = e["rest"]
        e.location = (rest[0] + t[0], rest[1] + t[1], rest[2] + t[2])
        e.rotation_euler = (t[3], t[4], t[5])
        e.scale = (t[6] or 1e-5, t[7] or 1e-5, t[8] or 1e-5)
        e.hide_render = t[6] == 0 and t[7] == 0 and t[8] == 0
        for child in e.children:
            if child.type == "MESH":
                child.hide_render = e.hide_render
    c = pose["camera"]
    cam.location = c["pos"]
    track(cam, c["target"])
    cam_data.lens = c["lens"]


def on_frame(sc, *_):
    apply(sc.frame_current)


try:
    scene.view_settings.view_transform = "Khronos PBR Neutral"
except TypeError:
    scene.view_settings.view_transform = "AgX"
r = scene.render
r.resolution_x, r.resolution_y, r.resolution_percentage = width, height, 100
r.fps = 30
r.image_settings.file_format = "PNG"
r.image_settings.color_mode = "RGB"
r.image_settings.compression = 15
r.use_file_extension = True
r.use_overwrite = False          # frames already written (a stopped render) are skipped: the render resumes
r.use_placeholder = False
r.engine = "BLENDER_EEVEE"
ee = scene.eevee
ee.taa_render_samples = samples
for name, value in (("use_raytracing", True), ("use_shadows", True), ("use_fast_gi", True)):
    if hasattr(ee, name):
        setattr(ee, name, value)
r.filepath = str(out / "f_######")

stamps = []


def written(*_):
    stamps.append(time.perf_counter())
    print(f"KD_FRAME {scene.frame_current}", flush=True)


bpy.app.handlers.frame_change_pre.append(on_frame)
bpy.app.handlers.render_write.append(written)
setup = time.perf_counter() - T0
# One animation render per run of consecutive frames that show a stage shot (frames without one are drawn by the overlay).
runs, start = [], None
for i, pose in enumerate(poses + [None]):
    if pose and start is None:
        start = i
    elif not pose and start is not None:
        runs.append((first + start, first + i - 1))
        start = None
T1 = time.perf_counter()
for a, b in runs:
    if all((out / f"f_{n:06d}.png").is_file() for n in range(a, b + 1)):
        continue
    scene.frame_start, scene.frame_end = a, b
    apply(a)
    bpy.ops.render.render(animation=True)
T2 = time.perf_counter()
per = [b - a for a, b in zip(stamps, stamps[1:])]
(out / f"timing-{first}.json").write_text(json.dumps({
    "engine": r.engine, "samples": samples, "frames": len(stamps), "setup_s": round(setup, 3), "render_s": round(T2 - T1, 3),
    "per_frame_s": [round(x, 4) for x in per], "blender": bpy.app.version_string, "runs": runs}), encoding="utf-8")
print(f"KD_DONE frames={len(stamps)} setup={setup:.2f}s render={T2 - T1:.2f}s", flush=True)
