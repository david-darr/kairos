"""The style pack registry (Video Styles build spec, section 3): which looks a video can be made in, and what each needs.

A style pack is a look plus a renderer plus a character set plus a voice default. Packs are data: this module holds
the built-in ones; the Content Studio cost check (services/content_studio/formats.py), the Evaluator and the video
tools read them from here.

- `motion-type` (Pack 0): kinetic type, numbers, lists and photos, narrated. Exists since the engine.
- `flat-2d` (Pack A, build unit 3): flat shapes and soft gradients, a limited palette per channel, layered parallax
  scenes (sky, far, mid, near), simple icon props, and an original geometric character family (round, square and
  triangle-bodied figures with dot eyes) drawn by our own 2D rig in static/motion/rig.js and static/motion/scene.js.
  Its characters are versioned specs (core/character_store.py); a video may only use a version the person approved.
- `glossy-3d`, `voxel-3d`: listed, not built (units 5 and 6).

The seam for user-made packs (a later unit): `user_packs()` returns the current account's own pack files. Each is
data only (no scripts run from a pack) with the same fields as a built-in entry plus its owner; it targets one of the
renderers below and may name character specs by id and version. Nothing reads pack files yet, so it returns [].
"""
from __future__ import annotations

RENDERERS = ("2d-engine", "blender", "threejs")

# `units_per_minute` is a planning estimate of render effort relative to Pack 0, not measured. `max_seconds` is what
# the pack can make today (long-form chapters are unit 4).
BUILT_IN = {
    "motion-type": {"name": "Motion type", "available": True, "renderer": "2d-engine", "units_per_minute": 1.0,
                    "max_seconds": 480, "characters": False,
                    "note": "Kinetic type, numbers, lists and photos with narration. Up to 8 minutes until long-form lands."},
    "flat-2d": {"name": "Flat 2D explainer", "available": True, "renderer": "2d-engine", "units_per_minute": 3.0,
                "max_seconds": 480, "characters": True,
                "note": "Original geometric characters in layered flat scenes, speaking the narration. Characters are "
                        "approved from their sheet before a video can use them. Up to 8 minutes."},
    "glossy-3d": {"name": "Glossy 3D mascot", "available": False, "renderer": "blender", "units_per_minute": 10.0,
                  "max_seconds": 480, "characters": True,
                  "note": "Our own 3D mascot. Not built yet (build unit 5, needs the 3D decision)."},
    "voxel-3d": {"name": "Blocky voxel 3D", "available": False, "renderer": "threejs", "units_per_minute": 8.0,
                 "max_seconds": 480, "characters": True,
                 "note": "A generic cube world with our own blocks and characters. Not built yet (build unit 6)."},
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
SHOTS = ("wide", "medium", "close")
PROPS = ("sun", "moon", "star", "cloud", "lightbulb", "heart", "book", "planet", "drop", "leaf", "gear", "arrow",
         "question", "coin", "clock", "rocket", "tree", "house", "magnifier", "atom")


def user_packs() -> list[dict]:
    """The current account's own packs (a later unit). Data only; nothing runs from a pack."""
    return []


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
