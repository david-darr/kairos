"""From a written brief to style pack data (Video Styles, user-made style packs).

The person (or a bot) writes a brief in their own words, like a director's notes. A model turns it into pack fields:
the bots do it themselves through content_studio_propose_style_pack, and Studio's "New from a brief" asks one of the
account's own model connections here (draft()). Either way the result goes through core/style_pack_store.validate, so
nothing the model writes is trusted, and the brief stays attached to the pack as its director brief and origin.

A reference-video analysis (palette, pacing, scene breakdown and motion notes from a video the person points at) is a
later step. It will produce the same fields and call from_fields() with its notes as the brief; style_pack_store
already names the origin "reference" for it.
"""
from __future__ import annotations

import json
import re

from core import style_pack_store

FIELDS = ("name", "summary", "renderer", "base", "look", "characters", "scenes", "pacing", "captions", "music", "voice")
SYSTEM = (
    "You turn a person's written brief for a video style into a Kairos style pack, as one JSON object and nothing else. "
    "Fields: name (up to 60 characters, our own words; never a real channel's or brand's name), summary (one or two sentences), "
    "renderer \"2d-engine\", base (\"flat-2d\" for original geometric characters in layered scenes, \"motion-type\" for kinetic "
    "type and numbers), look {design_look: one of academic, botanical, brutalist, counsel, editorial, fintech-mint, gallery, "
    "headline, luxury, newsprint, nocturne, nordic, pastel, playful, pop-color, retro-pixel, signal, sport, swiss-grid, tech-dark, "
    "terminal, terracotta, warm-minimal; palette: {sky: [top, bottom], far, mid, near, ground, prop, ink, glow} as #rrggbb hex, "
    "with mid-tone layers that are not close to near-black so dark character outlines read; families: any of round, square, "
    "triangle; outline: 4 to 14; lighting: flat, soft or glow}, scenes {settings: any of meadow, city, space, room, ocean, lab; "
    "shots: any of wide, medium, close; props: any of sun, moon, star, cloud, lightbulb, heart, book, planet, drop, leaf, gear, "
    "arrow, question, coin, clock, rocket, tree, house, magnifier, atom; cameras: any of still, push, pull, pan, shake; "
    "transitions: any of cut, whip, zoom, flip, dither, mosaic, wipe}, pacing {words_per_second 1.5 to 4, shot_seconds "
    "[shortest, longest] 1 to 30, hook_seconds 1 to 15}, captions {on: true or false, case: sentence or upper}, music {mood: "
    "energetic, calm, warm, dark or playful; volume 0 to 1}, voice {voice: a Kokoro voice id such as af_heart, am_michael, "
    "bf_emma or bm_george}. Characters are Kairos's own geometric family only; never describe or copy another channel's "
    "characters, mascots, logos, artwork or scenes. Leave out what the brief does not say.")


def _default_name(brief: str) -> str:
    words = re.findall(r"[A-Za-z0-9][A-Za-z0-9'-]*", brief)[:5]
    name = " ".join(words)[:60].strip()
    return name if name and style_pack_store.NAME.fullmatch(name) else "New style pack"


def from_fields(brief: str, fields: dict) -> dict:
    """Pack data from a brief and the fields a model derived from it. The brief becomes the director brief."""
    if not isinstance(brief, str) or not brief.strip():
        raise ValueError("brief: write the brief first.")
    if not isinstance(fields, dict):
        raise ValueError("The model did not return pack fields.")
    data = {k: fields[k] for k in FIELDS if k in fields}
    data.setdefault("name", _default_name(brief))
    if "base" not in data and "renderer" not in data:
        data["base"] = "flat-2d" if data.get("characters") else "motion-type"
    data["director_brief"] = brief.strip()
    return style_pack_store.validate(data)


def parse_reply(text: str) -> dict:
    """The first JSON object in a model's reply."""
    if not isinstance(text, str):
        raise ValueError("The model gave no answer.")
    start = text.find("{")
    if start < 0:
        raise ValueError("The model did not return pack data. Try again, or duplicate a pack and edit it.")
    try:
        value, _ = json.JSONDecoder().raw_decode(text[start:])
    except ValueError:
        raise ValueError("The model's pack data was not readable. Try again, or duplicate a pack and edit it.") from None
    if not isinstance(value, dict):
        raise ValueError("The model did not return pack data.")
    return value


def _endpoint(endpoint_id=None):
    from core import model_endpoints
    if endpoint_id:
        endpoint = model_endpoints.get_endpoint(endpoint_id)
        if endpoint is None:
            raise LookupError("No such model connection.")
        return endpoint
    for endpoint in model_endpoints.list_endpoints():
        if endpoint.get("kind") not in ("codex_cli", "antigravity_cli"):
            return model_endpoints.get_endpoint(endpoint["id"]) or endpoint
    raise LookupError("Turning a brief into a pack needs a model connection. Add one in Settings > Models, or duplicate a pack and edit it.")


async def ask_model(brief: str, endpoint_id=None) -> str:
    """One plain completion from the account's own model connection, recorded as a side run."""
    from core import runs
    from services.chat_service import _build_brain
    endpoint = _endpoint(endpoint_id)
    brain = _build_brain(endpoint, session_id=None, is_admin=False)
    try:
        await brain.connect()
        return await runs.side_call(brain, SYSTEM + "\n\nThe brief:\n" + brief, "style_pack_brief", endpoint=endpoint)
    finally:
        try:
            await brain.disconnect()
        except Exception:
            pass


async def draft(brief: str, endpoint_id=None, ask=None) -> dict:
    """Pack data from a written brief, through a model. `ask` replaces the model call in tests."""
    if not isinstance(brief, str) or not brief.strip():
        raise ValueError("brief: write the brief first.")
    if len(brief) > style_pack_store.BRIEF_LIMIT:
        raise ValueError(f"brief: keep it under {style_pack_store.BRIEF_LIMIT} characters.")
    reply = await (ask or ask_model)(brief, endpoint_id)
    fields = parse_reply(reply)
    fields.pop("characters", None)    # a model cannot name this account's characters; the person adds them
    try:
        return from_fields(brief, fields)
    except ValueError as error:
        raise ValueError(f"The model's pack data did not pass the checks ({error}). Try again, or duplicate a pack and edit it.") from None
