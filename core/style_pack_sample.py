"""A style pack's sample: what the person looks at before approving a pack (Video Styles, user-made style packs).

make() first makes sure every character in the pack has an approved sheet: a draft or rejected character gets its
reference sheet rendered and sent to the person (core/character_sheet.submit, unit 3's flow), and the sample waits
for those approvals. Then it builds a short narrated video in the pack (its palette, lighting, design look, characters,
settings, shots, props, cameras, transitions, music, voice and caption style), renders it through the app's own render
path (core/video_render, the desktop render worker, Kokoro, FFmpeg, the checks), keeps the MP4, its contact sheet and
thumbnail with the pack version, and sends the version for the person's approval. Only the person approves
(routes/style_pack_routes.py).

The sample's script is fixed and harmless, so packs are compared on their look, not their words: why we have seasons
(Earth's axis is tilted about 23 degrees; the half leaning toward the Sun gets more direct light and longer days; it is
not the distance to the Sun). Standard physics, not checked against a source in this module.

A glossy 3D pack (Pack B) gets its own short "what if" sample instead: what if you could see how much everyone slept? The
people and their numbers are made up, on purpose; the script states no real figure. It renders with the pack's renderer
(three.js, or Blender when installed and picked), so a Blender pack's sample shows the Blender look.

A blocky world pack (Pack C) gets a short explainer across its worlds and times of day: why the sea is salty (rain wears
salt out of rock, rivers carry it to the sea, the sun lifts fresh water and leaves the salt; seawater is about 3.5% salt).
Standard science from memory, not checked against a source in this module. three.js only.
"""
from __future__ import annotations

import asyncio
import copy
import shutil

from core import character_sheet, character_store, style_pack_store, video_render, video_store

ASPECT = "16:9"
TITLE = "Why summer is warm"
LINES = {
    "hook": "Why is summer warm?",
    "closer": "It is not because Earth gets closer to the Sun.",
    "tilt": "Earth spins on a tilted axis, leaning about twenty-three degrees.",
    "toward": "When your half leans toward the Sun, its light hits you more directly.",
    "days": "Days get longer too, so the ground has more time to warm up.",
    # A scene's line, on its own beat: on the end card it was captioned over "Seasons come from a tilt" (2026-11-10).
    # The end card is silent; core/video_checks.card_narration_notes names a line on a card that is not its own words.
    "winter": "Six months later, your half leans away. That is winter.",
}
_running: dict[tuple, asyncio.Task] = {}


def _pick(wanted, allowed, fallback=None):
    for item in wanted:
        if item in allowed:
            return item
    return fallback if fallback is not None else allowed[0]


def _props(wanted, allowed, places):
    return [{"icon": icon, **place} for icon, place in zip([w for w in wanted if w in allowed], places)]


TITLE_3D = "What if you could see sleep?"
LINES_3D = {
    "hook": "What if you could see how much sleep everyone got last night?",
    "crowd": "A little number would float over every head.",
    "mine": "And mine says five hours and forty minutes.",
    "explains": "That explains a lot.",
    "everyone": "Now picture everyone else's number, right there, where nobody can hide it.",
    "want": "So, would you want to know your number? Or would you rather not look?",
}


def beats_3d(data) -> list[dict]:
    """Pack B's sample: stage beats in the pack's set tones, shots, props and cameras, cut on the narration. The numbers
    over heads belong to made-up people."""
    scenes = data["scenes"]
    cam = lambda *wanted: _pick(wanted, scenes["cameras"])         # noqa: E731
    cut = lambda *wanted: _pick(wanted, scenes["transitions"])     # noqa: E731
    tone = lambda *wanted: _pick(wanted, scenes["settings"])       # noqa: E731
    shot = lambda *wanted: _pick(wanted, scenes["shots"])          # noqa: E731
    props = scenes["props"]
    prop = lambda shape, **more: [{"shape": shape, **more}] if shape in props else []   # noqa: E731
    me = data["characters"][0]["character"]
    who = lambda **more: {"character": me, "x": 0, **more}        # noqa: E731
    labels = [{"over": f"p{i}", "text": text, "at": .25 + .32 * i} for i, text in enumerate(["7 h 10 m", "8 h 05 m", "6 h 20 m", "9 h", "7 h 45 m"])]
    return [
        {"id": "hook", "kind": "stage", "camera": cam("push", "still"), "transition": cut("cut"), "say": LINES_3D["hook"],
         "stage": {"set": tone("lavender"), "shot": shot("wide"), "cast": [who(action="wave", expression="happy", speaking=True)],
                   "people": {"count": 5, "seed": 3}, "props": prop("ball", x=-.82, depth=.55, size=.32, color=0) + prop("pillar", x=.86, depth=.75, size=.3, color=1)}},
        {"id": "crowd", "kind": "stage", "camera": cam("pan", "still"), "transition": cut("cut"), "say": LINES_3D["crowd"],
         "stage": {"set": tone("lavender"), "shot": shot("wide"), "cast": [who(action="point", expression="happy", speaking=True)],
                   "people": {"count": 5, "seed": 3}, "labels": labels}},
        {"id": "mine", "kind": "stage", "camera": cam("push", "still"), "transition": cut("cut"), "say": LINES_3D["mine"],
         "stage": {"set": tone("lavender"), "shot": shot("medium"), "pedestal": True,
                   "cast": [who(action="idle", expression="neutral", speaking=True, react={"at": .55, "expression": "surprised"})],
                   "labels": [{"over": "c0", "text": "5 h 40 m", "sub": "slept last night", "at": .5}],
                   "props": prop("coin", x=.75, depth=.2, size=.22, color=2)}},
        {"id": "explains", "kind": "stage", "camera": cam("still"), "transition": cut("cut"), "say": LINES_3D["explains"],
         "stage": {"set": tone("lavender"), "shot": shot("close", "medium"), "cast": [who(action="shrug", expression="worried", speaking=True)],
                   "labels": [{"over": "c0", "text": "5 h 40 m", "at": 0}]}},
        {"id": "everyone", "kind": "stage", "camera": cam("pull", "still"), "transition": cut("cut"), "say": LINES_3D["everyone"],
         "stage": {"set": tone("lavender"), "shot": shot("wide"), "cast": [who(action="shrug", expression="surprised", speaking=True)],
                   "people": {"count": 4, "seed": 7},
                   "labels": [{"over": f"p{i}", "text": text, "at": .3 + .3 * i} for i, text in enumerate(["6 h 50 m", "8 h 30 m", "4 h 15 m", "7 h 20 m"])]}},
        {"id": "want", "kind": "stage", "camera": cam("pull", "still"), "transition": cut("cut"), "say": LINES_3D["want"],
         "stage": {"set": tone("lavender"), "shot": shot("medium"), "cast": [who(action="think", expression="thinking", speaking=True)],
                   "props": prop("ring", x=-.8, depth=.6, size=.3, color=4) + prop("block", x=.8, depth=.5, size=.24, color=3)}},
        {"id": "end", "kind": "end", "text": "What if?", "sub": "An original Kairos sample", "bars": 1.5},
    ]


TITLE_VOXEL = "Why is the sea salty?"
LINES_VOXEL = {
    "hook": "Why is the sea salty, when rivers are fresh?",
    "rain": "Rain falls on the hills.",
    "rocks": "It wears down rocks and washes out tiny bits of salt.",
    "rivers": "Rivers carry that salt past towns, all the way to the sea.",
    "sun": "The sun lifts fresh water into clouds. The salt stays behind.",
    "years": "After millions of years, seawater is about three and a half percent salt.",
}


def beats_voxel(data) -> list[dict]:
    """Pack C's sample: voxel beats across the pack's worlds and times of day, cut on the narration. Why the sea is salty:
    rain wears salt out of rock, rivers carry it to the sea, evaporation leaves it behind; seawater is about 3.5% salt.
    Standard science from memory, not checked against a source in this module."""
    scenes = data["scenes"]
    cam = lambda *wanted: _pick(wanted, scenes["cameras"])         # noqa: E731
    cut = lambda *wanted: _pick(wanted, scenes["transitions"])     # noqa: E731
    world = lambda *wanted: _pick(wanted, scenes["settings"])      # noqa: E731
    shot = lambda *wanted: _pick(wanted, scenes["shots"])          # noqa: E731
    when = lambda *wanted: _pick(wanted, scenes.get("times") or ["day"])   # noqa: E731
    props = scenes["props"]
    prop = lambda kind, **more: [{"kind": kind, **more}] if kind in props else []   # noqa: E731
    me = data["characters"][0]["character"]
    who = lambda **more: {"character": me, "x": 0, **more}        # noqa: E731
    return [
        {"id": "hook", "kind": "voxel", "camera": cam("push", "still"), "transition": cut("whip", "cut"), "say": LINES_VOXEL["hook"],
         "voxel": {"world": world("ocean"), "time": when("day"), "shot": shot("wide"), "seed": 3,
                   "cast": [who(action="wave", expression="happy", speaking=True)], "props": prop("flag", x=.62, depth=.55)}},
        {"id": "rain", "kind": "voxel", "camera": cam("pan", "still"), "transition": cut("cut"), "say": LINES_VOXEL["rain"],
         "voxel": {"world": world("meadow"), "time": when("day"), "shot": shot("wide"), "seed": 5,
                   "cast": [who(action="point", expression="happy", speaking=True)]}},
        {"id": "rocks", "kind": "voxel", "camera": cam("push", "still"), "transition": cut("zoom", "cut"), "say": LINES_VOXEL["rocks"],
         "voxel": {"world": world("cave"), "time": when("day"), "shot": shot("medium"), "seed": 2,
                   "cast": [who(action="think", expression="thinking", speaking=True)],
                   "props": prop("gem", x=-.72, depth=.35) + prop("lantern", x=.72, depth=.45)}},
        {"id": "rivers", "kind": "voxel", "camera": cam("pull", "still"), "transition": cut("cut"), "say": LINES_VOXEL["rivers"],
         "voxel": {"world": world("village"), "time": when("dusk", "day"), "shot": shot("wide"), "seed": 4,
                   "cast": [who(action="idle", expression="happy", speaking=True)], "people": {"count": 3, "seed": 4}}},
        {"id": "sun", "kind": "voxel", "camera": cam("still"), "transition": cut("whip", "cut"), "say": LINES_VOXEL["sun"],
         "voxel": {"world": world("sky-island"), "time": when("day"), "shot": shot("medium"), "seed": 6,
                   "cast": [who(action="idle", expression="neutral", speaking=True, react={"at": .9, "expression": "surprised"})]}},
        {"id": "years", "kind": "voxel", "camera": cam("push", "still"), "transition": cut("cut"), "say": LINES_VOXEL["years"],
         "voxel": {"world": world("ocean"), "time": when("night", "dusk"), "shot": shot("close", "medium"), "seed": 3,
                   "cast": [who(action="nod", expression="happy", speaking=True)],
                   "labels": [{"over": "c0", "text": "3.5%", "sub": "salt in seawater", "at": 1.2}]}},
        {"id": "end", "kind": "end", "text": "Salt stays, water rises", "sub": "An original Kairos sample", "bars": 1.5},
    ]


def beats(data) -> list[dict]:
    """The sample's beats in the pack's own rules."""
    scenes = data["scenes"]
    if data["base"] == "glossy-3d" and data["characters"]:
        return beats_3d(data)
    if data["base"] == "voxel-3d" and data["characters"]:
        return beats_voxel(data)
    cam = lambda *wanted: _pick(wanted, scenes["cameras"])         # noqa: E731
    cut = lambda *wanted: _pick(wanted, scenes["transitions"])     # noqa: E731
    if data["base"] == "motion-type" or not data["characters"]:
        return [
            {"id": "hook", "kind": "title", "text": "Why is summer warm?", "camera": cam("push", "still"), "transition": cut("whip", "cut"), "say": LINES["hook"]},
            {"id": "closer", "kind": "statement", "text": "Not because we get closer", "camera": cam("still"), "transition": cut("cut"), "say": LINES["closer"]},
            {"id": "tilt", "kind": "big-number", "number": "23°", "text": "the tilt of Earth's axis", "camera": cam("pull", "still"), "transition": cut("zoom", "cut"), "say": LINES["tilt"]},
            {"id": "toward", "kind": "statement", "text": "Leaning in means direct light", "camera": cam("push", "still"), "transition": cut("wipe", "cut"), "say": LINES["toward"]},
            {"id": "days", "kind": "list", "text": "Summer brings", "items": ["More direct light", "Longer days"], "camera": cam("pan", "still"), "transition": cut("cut"), "say": LINES["days"]},
            {"id": "winter", "kind": "big-number", "number": "6 months", "text": "later, your half leans away", "camera": cam("pull", "still"), "transition": cut("zoom", "cut"), "say": LINES["winter"]},
            {"id": "end", "kind": "end", "text": "Seasons come from a tilt", "sub": "An original Kairos sample", "bars": 1.5},
        ]
    cast = [e["character"] for e in data["characters"]]
    a, b = cast[0], cast[1 % len(cast)]
    setting = lambda *wanted: _pick(wanted, scenes["settings"])    # noqa: E731
    shot = lambda *wanted: _pick(wanted, scenes["shots"])          # noqa: E731
    props = scenes["props"]
    two = [{"character": a, "x": .34, "action": "wave", "expression": "happy", "speaking": True}]
    if b != a:
        two.append({"character": b, "x": .68, "action": "idle", "expression": "neutral", "view": "three_quarter", "facing": "left"})
    out = [
        {"id": "hook", "kind": "scene", "camera": cam("push", "still"), "transition": cut("whip", "cut"), "say": LINES["hook"],
         "scene": {"setting": setting("meadow", "city", "ocean", "space"), "shot": shot("wide", "medium"), "cast": two,
                   "props": _props(["sun", "star", "cloud"], props, [{"x": .82, "y": .18, "size": .12}])}},
        {"id": "closer", "kind": "scene", "camera": cam("still"), "transition": cut("cut"), "say": LINES["closer"],
         "scene": {"setting": setting("space", "meadow"), "shot": shot("medium", "wide"),
                   "cast": [{"character": b, "x": .36, "action": "shrug", "expression": "worried", "speaking": True}],
                   "props": _props(["sun", "planet"], props, [{"x": .62, "y": .3, "size": .14}, {"x": .84, "y": .34, "size": .08, "float": True}])}},
        {"id": "tilt", "kind": "scene", "camera": cam("pull", "still"), "transition": cut("zoom", "cut"), "say": LINES["tilt"],
         "scene": {"setting": setting("space", "lab"), "shot": shot("medium", "wide"),
                   "cast": [{"character": a, "x": .34, "action": "point", "expression": "thinking", "speaking": True}],
                   "props": _props(["planet", "atom", "question"], props, [{"x": .7, "y": .3, "size": .18, "float": True}])}},
        {"id": "toward", "kind": "scene", "camera": cam("push", "still"), "transition": cut("wipe", "cut"), "say": LINES["toward"],
         "scene": {"setting": setting("meadow", "space", "city"), "shot": shot("close", "medium"),
                   "cast": [{"character": b, "x": .5, "action": "nod", "expression": "surprised", "speaking": True, "turn": "three_quarter"}],
                   "props": _props(["sun", "star"], props, [{"x": .16, "y": .18, "size": .1, "float": True}])}},
        {"id": "days", "kind": "scene", "camera": cam("pan", "still"), "transition": cut("cut"), "say": LINES["days"],
         "scene": {"setting": setting("meadow", "ocean", "city"), "shot": shot("wide", "medium"),
                   "cast": [{"character": a, "x": .3, "action": "jump", "expression": "happy", "speaking": True},
                            *([{"character": b, "x": .7, "action": "idle", "expression": "happy"}] if b != a else [])],
                   "props": _props(["clock", "sun", "leaf"], props, [{"x": .5, "y": .2, "size": .12}, {"x": .84, "y": .16, "size": .1}])}},
        {"id": "winter", "kind": "scene", "camera": cam("pull", "still"), "transition": cut("zoom", "cut"), "say": LINES["winter"],
         "scene": {"setting": setting("ocean", "city", "meadow"), "shot": shot("medium", "wide"),
                   "cast": [{"character": b, "x": .4, "action": "shrug", "expression": "worried", "speaking": True}],
                   "props": _props(["moon", "star", "cloud"], props, [{"x": .78, "y": .18, "size": .11}])}},
        {"id": "end", "kind": "end", "text": "Seasons come from a tilt", "sub": "An original Kairos sample", "bars": 1.5},
    ]
    return out


def project_options(data, pack_id, version) -> dict:
    options = style_pack_store.video_defaults(data)
    if data["base"] == "flat-2d" and data["characters"]:
        options["palette"] = data["look"]["palette"] if isinstance(data["look"]["palette"], str) else "dawn"
    elif data["base"] not in ("glossy-3d", "voxel-3d") or not data["characters"]:
        options.pop("cast", None)
    options.update(aspects=[ASPECT], style_pack={"id": pack_id, "version": version})
    return options


def waiting_characters(data) -> list[dict]:
    out = []
    for entry in data["characters"]:
        meta = character_store.get(entry["character"])
        status = character_store.version_of(meta, entry["version"])["status"]
        if status != "approved":
            out.append({**entry, "name": meta["name"], "status": status})
    return out


def notify(meta, version) -> bool:
    """An approval item in the person's Inbox, as the Content Studio Producer (when the account has the team)."""
    try:
        from services.content_studio import delivery, studio
        return delivery._send(studio, f"Style pack to approve: {meta['name']}, version {version}",
                              f"{meta['name']} (version {version}) has a sample video. Watch it and approve or reject the pack in "
                              "Studio > Content > Styles. Channels can only use an approved pack.", False, None)
    except Exception:
        return False


async def make(pack_id, version, owner: str, by: str = "") -> dict:
    """Send the pack's character sheets for approval if needed, else render the sample and send the pack for approval.
    Returns the pack with `step`: "sheets" (waiting for the person's character approvals) or "sample" (sent)."""
    meta = style_pack_store.get(pack_id)
    v = style_pack_store.version_of(meta, version)
    if v["status"] == "approved":
        raise style_pack_store.ApprovalError(f"Version {version} of {meta['name']} is already approved.")
    data = style_pack_store.spec(pack_id, version)
    problems = style_pack_store.check_characters(data)
    if problems:
        raise ValueError("characters: " + " ".join(problems))
    waiting = waiting_characters(data)
    for entry in waiting:
        if entry["status"] in ("draft", "rejected"):
            await character_sheet.submit(entry["character"], entry["version"])
    if waiting:
        names = [e["name"] for e in waiting]
        meta = style_pack_store.set_sample_status(pack_id, version, "waiting for character sheets", waiting=names)
        return {**meta, "step": "sheets"}
    style_pack_store.set_sample_status(pack_id, version, "rendering")
    try:
        title = {"glossy-3d": TITLE_3D, "voxel-3d": TITLE_VOXEL}.get(data["base"], TITLE) if data["characters"] else TITLE
        project = video_store.create(title, owner=owner, beats=copy.deepcopy(beats(data)), **project_options(data, pack_id, version))
        job = await video_render.render(project["id"], ASPECT, sample_of=(pack_id, version))
        if job["status"] != "ready":
            raise RuntimeError(job["status"])
        renders = video_store._folder(project["id"]) / "renders"
        shutil.copy2(job["path"], style_pack_store.sample_path(pack_id, version, "mp4"))
        shutil.copy2(renders / f"sheet-{ASPECT.replace(':', '-')}.png", style_pack_store.sample_path(pack_id, version, "sheet"))
        shutil.copy2(renders / f"thumb-{ASPECT.replace(':', '-')}.png", style_pack_store.sample_path(pack_id, version, "thumb"))
    except Exception as error:
        style_pack_store.set_sample_status(pack_id, version, "failed: " + str(error)[:500])
        raise
    meta = style_pack_store.submit(pack_id, version, {"video_id": project["id"], "seconds": job.get("seconds"),
                                                      "notes": job.get("notes") or [], "loudness": job.get("loudness"),
                                                      "by": str(by or "")[:80]})
    meta["notified"] = notify(meta, version)
    return {**meta, "step": "sample"}


def start(pack_id, version, owner: str, by: str = "") -> asyncio.Task:
    """make() in the background (a sample takes minutes); its progress is on the version's `sample.status`."""
    key = (pack_id, version)
    if key in _running and not _running[key].done():
        raise style_pack_store.ApprovalError("The sample is already rendering.")
    task = asyncio.create_task(make(pack_id, version, owner, by))
    task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)   # failures are on the version
    _running[key] = task
    return task
