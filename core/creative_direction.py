"""Art direction for every model (Creative Output Quality spec, Phase 1).

Before a design is built, creative_direction reads the brief and offers three
directions: a bundled look, its palette and type, a layout archetype for the
output type, and an imagery plan. It is plain scoring over each look's subject
tags, mood words and the types it suits, with no model call, so a 7B local
model gets the same choices as Claude and the same brief always gets the same
answer.

Variety is deliberate: looks the person used in their last few designs rank
lower, so two different briefs rarely land on the same look and the same
person doesn't get one look forever. The Kairos look is offered only when the
brief is about Kairos or the person set it as their default.
"""
from __future__ import annotations

import hashlib
import re
from typing import Optional

from core import design_looks, design_systems

KINDS = ("poster", "screen", "website", "slides", "social", "print", "email", "banner", "video")
KIND_ALIASES = {"app": "screen", "mobile": "screen", "ui": "screen", "onboarding": "screen", "dashboard": "screen",
                "landing": "website", "web": "website", "site": "website", "page": "website", "homepage": "website",
                "deck": "slides", "presentation": "slides", "slide": "slides", "pitch": "slides",
                "flyer": "poster", "instagram": "social", "post": "social", "story": "social", "tiktok": "social",
                "document": "print", "pdf": "print", "guide": "print", "resume": "print", "one-pager": "print",
                "letter": "print", "report": "print", "newsletter": "email", "header": "banner", "cover": "banner"}
# The layout skeletons in the design-canvas skill, by output type, best first.
ARCHETYPES = {
    "poster": ["poster-stack", "big-number", "editorial-column", "grid-12"],
    "screen": ["bento", "hero-split", "comparison", "editorial-column"],
    "website": ["hero-split", "bento", "comparison", "editorial-column", "grid-12"],
    "slides": ["slide-title", "big-number", "big-statement", "comparison", "two-column", "chart", "timeline", "quote",
               "image-led", "closing"],
    "social": ["poster-stack", "big-number", "quote"],
    "print": ["editorial-column", "grid-12", "comparison", "timeline"],
    "email": ["editorial-column", "hero-split"],
    "banner": ["hero-split", "big-number"],
    "video": ["slide-title", "big-statement", "big-number", "image-led", "closing"],
}
RECENT = 5          # How many of the person's latest designs count as "recently used".
RECENT_PENALTY = 2.5
_WORD = re.compile(r"[a-z0-9][a-z0-9'-]*")
# Words that say what to make, not what it is about: they never pick a look.
BRIEF_WORDS = frozenset({"app", "design", "launch", "launching", "product", "page", "poster", "deck", "slide", "slides",
                         "guide", "post", "screen", "home", "video", "pdf", "pitch", "make", "new", "website", "site",
                         "landing", "instagram", "social", "email", "banner", "print", "flyer", "promo", "announcing"})
# When a brief names several output words, the most specific wins ("a 3 page guide as a PDF" is print).
KIND_PRIORITY = ("video", "pdf", "document", "resume", "one-pager", "report", "letter", "deck", "presentation", "slides",
                 "slide", "pitch", "instagram", "tiktok", "story", "social", "newsletter", "email", "banner", "header",
                 "cover", "poster", "flyer", "onboarding", "dashboard", "app", "mobile", "ui", "screen", "landing",
                 "homepage", "website", "web", "site", "guide", "post", "page", "print")


def kind_of(value: Optional[str]) -> str:
    value = (value or "").strip().lower()
    if value in KINDS:
        return value
    words = set(_WORD.findall(value))
    for word in KIND_PRIORITY:
        if word in words:
            return word if word in KINDS else KIND_ALIASES[word]
    return "poster"


def _stem(word: str) -> str:
    for suffix in ("ing", "es", "s"):
        if len(word) > 4 and word.endswith(suffix):
            return word[: -len(suffix)]
    return word


def _terms(text: str) -> set[str]:
    words = [w for w in _WORD.findall((text or "").lower()) if w not in BRIEF_WORDS]
    terms = {_stem(w) for w in words}
    terms |= {f"{a} {b}" for a, b in zip(words, words[1:])}
    return terms


def _hits(terms: set[str], values: list[str]) -> list[str]:
    out = []
    for value in values:
        key = value.lower()
        if (" " in key and key in terms) or _stem(key) in terms:
            out.append(value)
    return out


def _recent(owner: Optional[str]) -> list[str]:
    from core import design_store
    mine = [d for d in design_store.list_designs() if owner is None or d.get("owner") == owner]
    return [d.get("design_system") for d in mine[:RECENT] if d.get("design_system")]


def _suits(look: dict, kind: str) -> bool:
    """Video inherits the looks suited to slides and social, without changing bundled data."""
    good_for = set(look["good_for"])
    return kind in good_for or (kind == "video" and bool({"slides", "social"} & good_for))


def directions(brief: str, kind: Optional[str] = None, *, owner: Optional[str] = None, count: int = 3) -> list[dict]:
    """The best `count` directions for a brief, as plain dicts."""
    kind = kind_of(kind or brief)
    terms = _terms(brief)
    recent = _recent(owner)
    scored = []
    for look in design_looks.load().values():
        tags = _hits(terms, look["tags"])
        moods = _hits(terms, look["mood"])
        score = 3.0 * len(tags) + 1.0 * len(moods) + (1.0 if _suits(look, kind) else -3.0)
        score -= RECENT_PENALTY * recent.count(look["id"])
        tie = int(hashlib.sha1(f"{brief}|{look['id']}".encode()).hexdigest()[:6], 16) / 0xFFFFFF  # stable, per brief
        scored.append((score + tie * 0.5, look, tags + moods))
    # The person's own styles (Phase 1b): a style the brief names comes first; one whose tags match ranks
    # above the bundled looks; "my style" favours theirs. Others' styles only once an admin shares them.
    words = set(_WORD.findall((brief or "").lower()))
    for system in design_systems.styles_for(owner) if owner else []:
        look = {**design_systems._style_look(system["id"]), "id": system["id"]}
        name_words = {w for w in _WORD.findall(look["name"].lower()) if w not in ("style", "look", "my", "the")}
        tags = _hits(terms, look["tags"])
        score = 2.0 + 3.0 * len(tags) + (1.0 if _suits(look, kind) else -3.0)
        if name_words and name_words <= words:
            score += 100.0
            tags = [f"the brief names {look['name']}"] + tags
        elif {"my", "our"} & words and {"style", "brand", "look"} & words and system.get("owner") == owner:
            score += 4.0
        scored.append((score if tags or score > 50 else score - 4.0, look, tags))
    scored.sort(key=lambda item: item[0], reverse=True)
    picks = [(look, why) for _, look, why in scored[:count]]
    kairos_asked = "kairos" in _WORD.findall((brief or "").lower()) or design_systems.default_id() == design_systems.BUILTIN_ID
    out = []
    if kairos_asked:
        out.append(_kairos(kind))
    for look, why in picks[: count - len(out)]:
        archetypes = [a for a in ARCHETYPES[kind] if a in look["archetypes"]] or ARCHETYPES[kind][:2]
        out.append({"look": look["id"], "name": look["name"], "mood": look["mood"],
                    "why": (why[0] if why and why[0].startswith("the brief names") else
                            f"matches {', '.join(why[:4])}" if why else f"suits a {kind}"),
                    "palette": design_looks.summary(look)["palette"],
                    "fonts": design_looks.summary(look)["fonts"],
                    "layout": archetypes[:2], "imagery": look["imagery"],
                    "image_treatment": look["image_treatment"], "pattern": look["pattern"],
                    "guide": look["guide"].split(". ")[0].rstrip(".") + "."})
    return out


def _kairos(kind: str) -> dict:
    system = design_systems.builtin()
    flat = design_systems.variables(system["tokens"])
    return {"look": design_systems.BUILTIN_ID, "name": "Kairos", "mood": ["warm", "calm", "precise"],
            "why": "the brief is about Kairos" , "palette": {k: flat.get(f"--ds-{k}") for k in ("bg", "surface", "text", "accent")},
            "fonts": {"display": "Cormorant Garamond", "body": "Jost"}, "layout": ARCHETYPES[kind][:2],
            "imagery": "Kairos's own screens, halftone and dither treatments",
            "image_treatment": "halftone", "pattern": "dots", "guide": "Parchment, bistre ink, a gold point."}


def describe(brief: str, kind: Optional[str] = None, *, owner: Optional[str] = None) -> str:
    """The tool's reply: three directions a model can pick from in one line."""
    kind = kind_of(kind or brief)
    tool = "video_create" if kind == "video" else "design_create"
    lines = [f"Three directions for this {kind}. Pick one and pass its look to {tool} (look=\"...\"). "
             "Say which you chose and why in one line of your reply."]
    for n, d in enumerate(directions(brief, kind, owner=owner), 1):
        palette = ", ".join(f"{k} {v}" for k, v in d["palette"].items())
        fonts = " / ".join(f"{v} ({k})" for k, v in d["fonts"].items())
        lines.append(f"{n}. look=\"{d['look']}\" {d['name']} ({', '.join(d['mood'])}): {d['why']}. {d['guide']}\n"
                     f"   Palette: {palette}. Type: {fonts}. Layout: {', '.join(d['layout'])}. Imagery: {d['imagery']}. "
                     f"Pictures: image_generate (when connected), image_search for an openly licensed photo, "
                     f"image_treat {d['image_treatment']} on the person's own photo, or image_pattern {d['pattern']}.")
    if kind == "print":
        lines.append("A document or PDF of more than one page is format document (its pages flow, with page numbers): "
                     "read_skill pdf-document. Exactly one printed page is format print.")
    if kind == "video":
        lines.append("Use video_create with a beat sheet: one idea per beat, 3 to 8 words on screen, 1 to 2 bars; "
                     "hook first, end card last. Then video_preview, fix with video_edit and video_render. "
                     "For a narrated video, give each beat a say line (what the voice says over it); run video_narrate "
                     "for the timed shot plan before previewing.")
    if kind == "slides":
        lines.append("Mix the ten slide archetypes in the design-canvas skill, one idea per slide; charts are tables in "
                     "<figure data-chart>.")
    if kind in ("poster", "social", "banner", "slides", "screen", "print"):
        lines.append("After design_create, get the pictures before you finish: image_generate when connected, otherwise "
                     "image_search then use, or image_treat on the person's photo; image_pattern when no photo fits. "
                     "Place them with design_edit.")
    lines.append("Every look's tokens are the same var(--ds-...) names; headlines use var(--ds-font-display), "
                 "text on an accent fill uses var(--ds-on-accent). Layout skeletons are in the design-canvas skill.")
    return "\n".join(lines)
