"""The style pack registry (Video Styles build spec, section 3): which looks a video can be made in, and what each needs.

A style pack is a look plus a renderer plus a character set plus a voice default. Packs are data: this module holds
the built-in ones; the Content Studio cost check (services/content_studio/formats.py), the Evaluator and the video
tools read them from here.

- `motion-type` (Pack 0): kinetic type, numbers, lists and photos, narrated. Exists since the engine.
- `flat-2d` (Pack A, build unit 3): flat shapes and soft gradients, a limited palette per channel, layered parallax
  scenes (sky, far, mid, near), simple icon props, and an original geometric character family (round, square and
  triangle-bodied figures with dot eyes) drawn by our own 2D rig in static/motion/rig.js and static/motion/scene.js.
  Its characters are versioned specs (core/character_store.py); a video may only use a version the person approved.
- `glossy-3d` (Pack B, build unit 5): a glossy 3D studio with our own mascot (the starting family rebuilt in 3D from its
  character spec), simple stand-in people, glossy props and floating labels and numbers drawn by the 2D engine. Two
  renderers (David, 2026-11-10: "just add both as options"): three.js, built in and the default (static/motion/stage3d.js
  in the render window), and Blender, only when the person has it installed (core/blender_tools.py finds it; Kairos
  never bundles or downloads it) and picked it for the pack or the channel (core/video_blender.py runs it).
- `block-classic` (Pack C classic, David 2026-11-10: "much closer to the block-game reference he shared", knowing the
  resemblance risk): the classic block world with hard 16 x 16 pixel textures drawn in code (grass, dirt, stone, logs,
  leaves, planks, water, ore specks, flowers), box clouds and a warm sun, and our own classic block characters (form block:
  the classic box proportions, per-face pixel skins drawn from their outfit, faces with the full mood set) whose every key
  is constant. Its own format is the Story Short (a 1080 x 1920 split screen with the talking avatar over the scene, pure
  dialogue with each character's own voice, word-by-word captions, sepia flashbacks; static/motion/story.js); its voxel
  beats can also take `look: classic` in any aspect. three.js draws it (static/motion/classic3d.js). The distance rules hold:
  no other game's textures, skins, sounds or names, and the Evaluator's brand rule covers it like voxel-3d.
- `voxel-3d` (Pack C, build unit 6): a generic blocky world on our own palette (meadow, cave, village, sky island, ocean;
  day, dusk and night), soft bevelled blocks drawn instanced, and blocky original characters built from boxes from their
  character spec (form voxel) with pixel faces drawn in code. three.js only (static/motion/voxel.js, voxel3d.js): Pack C
  has no Blender path. Kept apart from any well-known block game: no such game's textures, skins, fonts, logos, mobs, UI,
  sounds or block names, and the Evaluator refuses that game's name in a Pack C post's title, tags or thumbnail
  (services/content_studio/policy.py brand_findings). This look draws children: channels and posts state honestly whether
  a video is made for kids (YouTube's made-for-kids setting, services/content_studio/prepare.py and youtube_publish.py).

User-made packs (core/style_pack_store.py): `user_packs()` lists the current account's own packs with the same fields
as a built-in entry, drawn by the built-in pack they are based on (their `base`). A user pack is available only while
it has a version the person approved and its renderer draws its base (the 2D engine for motion-type and flat-2d;
three.js or Blender for glossy-3d; three.js for voxel-3d). Packs are data only; nothing runs from a pack.

Render speed (the cost check, services/content_studio/formats.py, and Studio's estimates) comes from measured numbers,
per renderer, in RENDER_SPEED: frames a second on the machine Pack B was built on (an RTX 4090), with the date and what
was measured. Other machines are slower or faster; a machine's own long renders record their own speed (unit 4).
"""
from __future__ import annotations

RENDERERS = ("2d-engine", "blender", "threejs")
# What each renderer was measured at, whole render path included (capture, encode, the overlay pass and compositing for
# Blender). `fps` is frames rendered a second; video minutes take 1800 / fps seconds of rendering. Measured 2026-11-10.
RENDER_SPEED = {
    "2d-engine": {"fps": 48.0, "measured": "2026-11-10, a 3.5-minute Flat 2D long-form sample (unit 4), RTX 4090"},
    # Capture through the render worker, look pass on (2x supersampling, ambient occlusion, contact shadows): 38.8 and 43.1 fps.
    "threejs": {"fps": 40.0, "measured": "2026-11-10, the 23 s Pack B sample in three.js with the look pass, RTX 4090"},
    # The whole part: overlay pass, Eevee at 32 samples (3.1 to 3.3 frames a second), FFmpeg composite: 3.4 frames a second.
    "blender": {"fps": 3.4, "measured": "2026-11-10, the 23 s Pack B sample in Blender 5.2.2 Eevee (32 samples) with the overlay pass and composite, RTX 4090"},
    # Pack C's blocky world on three.js: thousands of instanced bevelled blocks, soft shadows, ambient occlusion.
    # Capture through the render worker (2x supersampling, 4x MSAA, soft shadows, ambient occlusion, about 9,000 instanced
    # blocks a shot): 38.2 fps; the whole 25.2 s sample took 29.4 s including Kokoro narration. One run.
    "threejs-voxel": {"fps": 38.0, "measured": "2026-11-10, the 25 s Pack C sample (five worlds) in three.js, RTX 4090"},
    # Pack C classic: two pictures a frame in a Story Short (the avatar room and the block scene), pixel textures, sharp sun shadows.
    # Measured capture through the render worker: 41.4 and 41.0 frames a second (2x supersampling, the avatar room and the
    # block scene each frame, sharp sun shadows); the whole 35.5 s Story Short took 187 to 196 s, most of it 17 Kokoro lines and
    # their whisper.cpp alignment. Two runs, on this RTX 4090 only.
    "threejs-classic": {"fps": 41.0, "measured": "2026-11-11, the 35.5 s Story Short sample (two pictures a frame) in three.js, RTX 4090"},
}
# Which measured speed a pack's renderer uses: Pack C draws a whole world, so it has its own number.
SPEED_KEYS = {("voxel-3d", "threejs"): "threejs-voxel", ("block-classic", "threejs"): "threejs-classic"}


def speed_key(base: str, renderer: str) -> str:
    return SPEED_KEYS.get((base, renderer), renderer)


def render_seconds_per_minute(renderer: str) -> float:
    """Seconds of rendering for one minute of video with this renderer, from its measured speed."""
    return round(1800 / RENDER_SPEED[renderer]["fps"], 1)

# `units_per_minute` is render effort relative to the 2D engine, from the measured speeds (RENDER_SPEED, SPEED_KEYS). `max_seconds` is what the pack makes in one part (chapters: unit 4).
BUILT_IN = {
    "motion-type": {"name": "Motion type", "available": True, "renderer": "2d-engine", "units_per_minute": 1.0,
                    "max_seconds": 480, "characters": False,
                    "note": "Kinetic type, numbers, lists and photos with narration. Up to 8 minutes until long-form lands."},
    "flat-2d": {"name": "Flat 2D explainer", "available": True, "renderer": "2d-engine", "units_per_minute": 3.0,
                "max_seconds": 480, "characters": True,
                "note": "Original geometric characters in layered flat scenes, speaking the narration. Characters are "
                        "approved from their sheet before a video can use them. Up to 8 minutes."},
    "glossy-3d": {"name": "Glossy 3D mascot", "available": True, "renderer": "threejs", "renderers": ["threejs", "blender"],
                  "units_per_minute": 1.6, "max_seconds": 480, "characters": True,
                  "note": "Our own glossy 3D mascot in a studio, with floating labels and numbers. Rendered with three.js, built in; "
                          "or with Blender when it is installed and picked for the pack or channel (slower, softer light). "
                          "Characters are approved from their 3D sheet before a video can use them. Up to 8 minutes, or 20 in chapters."},
    "voxel-3d": {"name": "Blocky voxel 3D", "available": True, "renderer": "threejs", "renderers": ["threejs"],
                 "units_per_minute": 1.6, "max_seconds": 480, "characters": True,
                 "note": "A generic blocky world on our own palette (meadow, cave, village, sky island, ocean; day, dusk, night) with "
                         "our own blocky characters and their pixel faces. Rendered with three.js only (built in; no Blender path). "
                         "This look draws children: say on the channel and each post whether it is made for kids. Characters are "
                         "approved from their sheet before a video can use them. Up to 8 minutes, or 20 in chapters."},
    "block-classic": {"name": "Classic block", "available": True, "renderer": "threejs", "renderers": ["threejs"],
                      "units_per_minute": 1.6, "max_seconds": 480, "characters": True, "formats": ["story-short"],
                      "note": "The classic block world (pixel textures drawn in code, box clouds, a warm sun) with our own classic block "
                              "characters, every key constant. Its format is the Story Short: 1080 x 1920, the speaker's avatar over the "
                              "scene, pure dialogue with each character's own voice, word captions, sepia flashbacks. Rendered with three.js "
                              "(built in). This look draws children: say on the channel and each post whether it is made for kids. "
                              "Characters are approved from their sheet before a video can use them."},
}

# Pack A's scene palettes: one per channel keeps the series consistent. Each is a short list of flat colours; the
# scene draws soft gradients only between neighbours of the same list, so the palette stays limited.
PALETTES = {
    "dawn":  {"sky": ["#ffd9b8", "#fff1df"], "far": "#f2b8a2", "mid": "#d98f8a", "near": "#7d5a7a", "ground": "#5b4466",
              "prop": "#ffffff", "ink": "#3a2a40", "glow": "#fff6e8"},
    "mint":  {"sky": ["#bfe8e0", "#eefaf6"], "far": "#9fd6c6", "mid": "#6fb8a6", "near": "#3f8a7e", "ground": "#2f6a63",
              "prop": "#fff7e6", "ink": "#1f3b3a", "glow": "#ffffff"},
    "dusk":  {"sky": ["#5b4b8a", "#f2a490"], "far": "#8a6aa8", "mid": "#5e4a85", "near": "#3a2f5e", "ground": "#2a2347",
              "prop": "#ffe3a8", "ink": "#1c1733", "glow": "#ffe9c7"},
    "night": {"sky": ["#14213d", "#2d3f6b"], "far": "#2a3a63", "mid": "#1f2d50", "near": "#152039", "ground": "#0f172b",
              "prop": "#ffd166", "ink": "#0a0f1e", "glow": "#fff3c4"},
    "paper": {"sky": ["#f4efe6", "#fbf8f2"], "far": "#e2d6c3", "mid": "#c9b79c", "near": "#a48b6e", "ground": "#7d6750",
              "prop": "#ffffff", "ink": "#3b3127", "glow": "#ffffff"},
}
SETTINGS = ("meadow", "city", "space", "room", "ocean", "lab")
# Pack B's studio (static/motion/stage.js): the set's tones, its glossy props, and the stand-in people.
STAGE_SETS = ("lavender", "peach", "mint", "sky", "night")
STAGE_PROPS = ("ball", "block", "pillar", "ring", "coin")
STAGE_FACINGS = ("camera", "left", "right")
MAX_PEOPLE, MAX_LABELS = 8, 8
# Pack C's blocky world (static/motion/voxel.js): its worlds, times of day, props and stand-in people.
VOXEL_WORLDS = ("meadow", "cave", "village", "sky-island", "ocean")
VOXEL_TIMES = ("day", "dusk", "night")
VOXEL_PROPS = ("gem", "lantern", "crate", "flag", "ball", "star")
VOXEL_MAX_PEOPLE = 6
VOXEL_LOOKS = ("pastel", "classic")
# Pack C classic and its Story Short (static/motion/classic.js, story.js): places, poses, moods, shots, effects, props and
# the sounds Kairos synthesizes for them (core/video_audio.py).
STORY_PLACES = ("meadow", "cliff", "village", "party", "cave", "beach", "sky-island")
STORY_TIMES = ("day", "dusk")
STORY_POSES = ("idle", "walk", "run", "hips", "despair", "flail", "hang", "wave", "shove", "nod", "point", "cheer", "cry", "laugh",
               "shrug", "think", "sit", "slip")
STORY_MOODS = ("neutral", "happy", "smug", "angry", "scared", "sad", "crying", "shocked", "laughing", "splat")
STORY_SHOTS = ("close", "medium", "wide", "low", "top", "orbit")
STORY_FX = ("fuse", "blast", "splat", "fall", "pop")
STORY_PROPS = ("crate", "cake", "lantern", "balloon", "table")
STORY_SFX = ("boom", "splat", "sting", "riser", "pop", "whoosh", "impact", "steps", "gasp")
STORY_MAX_CAST, STORY_MAX_SHOTS = 4, 3
SHOTS = ("wide", "medium", "close")
PROPS = ("sun", "moon", "star", "cloud", "lightbulb", "heart", "book", "planet", "drop", "leaf", "gear", "arrow",
         "question", "coin", "clock", "rocket", "tree", "house", "magnifier", "atom")


def user_packs() -> list[dict]:
    """The current account's own packs, each shaped like a built-in entry. Data only; nothing runs from a pack."""
    from core import style_pack_store
    out = []
    try:
        metas = style_pack_store.list_all()
    except Exception:       # no account folder yet (a fresh install): no user packs
        return out
    for meta in metas:
        version = style_pack_store.approved_version(meta)
        shown = version or style_pack_store.latest(meta)["version"]
        try:
            data = style_pack_store.spec(meta["id"], shown)
        except LookupError:
            continue
        base = BUILT_IN[data["base"]]
        runs = base["available"] and data["renderer"] in (base.get("renderers") or [base["renderer"]])
        if not runs:
            state = "Its renderer does not draw this base (Pack C renders with three.js only)." if data["base"] == "voxel-3d" else "Its renderer is not built yet."
        elif version is None:
            state = "Not approved yet: approve its sample in Studio > Content > Styles."
        else:
            state = f"Approved version {version}."
        out.append({"id": meta["id"], "name": meta["name"], "available": bool(runs and version), "renderer": data["renderer"],
                    "base": data["base"], "units_per_minute": units_per_minute(speed_key(data["base"], data["renderer"])), "max_seconds": base["max_seconds"],
                    "characters": base["characters"], "approved_version": version,
                    "note": (data["summary"] + " " if data["summary"] else "") + state})
    return out


def units_per_minute(renderer: str) -> float:
    """Render effort relative to the 2D engine, from the measured speeds (1.0 is Pack 0 and Pack A)."""
    return round(RENDER_SPEED["2d-engine"]["fps"] / RENDER_SPEED[renderer]["fps"], 2)


for _id, _pack in BUILT_IN.items():
    if _pack["available"]:
        _pack["speed_key"] = speed_key(_id, _pack["renderer"])
        _pack["units_per_minute"] = units_per_minute(_pack["speed_key"])
        _pack["render_seconds_per_minute"] = render_seconds_per_minute(_pack["speed_key"])


def all_packs() -> dict:
    out = {k: dict(v) for k, v in BUILT_IN.items()}
    for pack in user_packs():
        out.setdefault(pack["id"], {**pack, "user": True})
    return out


def get(pack_id: str) -> dict | None:
    return all_packs().get(pack_id)


def available(pack_id: str) -> bool:
    pack = get(pack_id)
    return bool(pack and pack["available"])
