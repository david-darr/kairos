"""About you: the person-level profile every bot reads (Bots Phase 2, unit U2; design 3.2 and 4.2).

On disk, under the data folder, one folder per owner:

    bot-profiles/<p_key>/about.md      the person's own text (at most 24,000 characters)
    bot-profiles/<p_key>/state.json    learned facts, removed identities and forgotten terms

The key is a hash of the authenticated identity (the account name, or the single local user), never a value a
caller supplies. Learned facts are dated and say which bot learned them. Removing one is remembered by the
fact's identity so it is not learned again; "forget" is remembered by term. Automatic capture can never reverse
either; only the person re-adding the fact, or a reviewed Undo, can (`lift`).
"""
import hashlib
import os
import re
import threading
import time
import uuid
from typing import Optional

from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR

ABOUT_LIMIT = 24_000
MAX_LEARNED = 200
MAX_REMOVED = 500
MAX_FORGOTTEN = 200
MAX_FACT_CHARS = 1000
MIN_TERM_LETTERS = 3
ROOT = os.path.join(DATA_DIR, "bot-profiles")
_LOCK = threading.RLock()


class ProfileError(ValueError):
    status = 400


class ProfileConflict(ProfileError):
    status = 409


class ProfileTooLarge(ProfileError):
    status = 413


class ProfileMissing(ProfileError):
    status = 404


def owner_key(owner: str) -> str:
    if not isinstance(owner, str) or not owner.strip():
        raise ProfileError("no signed-in owner")
    return "p_" + hashlib.sha256(owner.encode("utf-8")).hexdigest()[:24]


def _dir(owner: str) -> str:
    return os.path.join(ROOT, owner_key(owner))


def _hash(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


def normal(text: str) -> str:
    return " ".join(re.sub(r"[^\w\s]", " ", (text or "").casefold()).split())


def identity(text: str) -> str:
    """What makes two statements the same fact: their words, not their date or punctuation."""
    return hashlib.sha256(normal(text).encode("utf-8")).hexdigest()[:20]


def whole_word(term: str) -> "re.Pattern":
    return re.compile(r"(?<!\w)" + re.escape(term.strip()) + r"(?!\w)", re.IGNORECASE)


def check_term(term: str) -> str:
    cleaned = " ".join((term or "").split())
    if sum(ch.isalpha() for ch in cleaned) < MIN_TERM_LETTERS or len(cleaned) > 60:
        raise ProfileError("name a word of at least three letters to forget (60 characters at most)")
    return cleaned


def _state(owner: str) -> dict:
    data = read_json(os.path.join(_dir(owner), "state.json"), {})
    return {"learned": [r for r in data.get("learned", []) if isinstance(r, dict)],
            "removed": [x for x in data.get("removed", []) if isinstance(x, str)],
            "forgotten": [x for x in data.get("forgotten", []) if isinstance(x, str)]}


def _save(owner: str, state: dict) -> None:
    state["learned"] = state["learned"][-MAX_LEARNED:]
    state["removed"] = state["removed"][-MAX_REMOVED:]
    state["forgotten"] = state["forgotten"][-MAX_FORGOTTEN:]
    write_json_atomic(os.path.join(_dir(owner), "state.json"), state)


def _write_text(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = f"{path}.{uuid.uuid4().hex[:8]}.tmp"
    with open(temporary, "wb") as file:
        file.write(text.encode("utf-8"))
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)


# -- the person's own text -------------------------------------------------------------------------------

def get_about(owner: str) -> dict:
    path = os.path.join(_dir(owner), "about.md")
    try:
        with open(path, encoding="utf-8") as file:
            text = file.read()
    except FileNotFoundError:
        text = ""
    return {"text": text, "hash": _hash(text), "limit": ABOUT_LIMIT, "chars": len(text)}


def put_about(owner: str, text: str, expected_hash: Optional[str]) -> dict:
    if not isinstance(text, str):
        raise ProfileError("About you is text")
    if len(text) > ABOUT_LIMIT:
        raise ProfileTooLarge(f"About you is limited to {ABOUT_LIMIT:,} characters; this is {len(text):,}")
    with _LOCK:
        current = get_about(owner)
        if expected_hash != current["hash"]:
            raise ProfileConflict("About you changed since you opened it")
        _write_text(os.path.join(_dir(owner), "about.md"), text)
        return get_about(owner)


# -- learned facts ----------------------------------------------------------------------------------------

def learned(owner: str) -> list[dict]:
    return [{"id": r["id"], "text": r["text"], "learned_by": r.get("learned_by") or "a bot", "at": r.get("at")}
            for r in reversed(_state(owner)["learned"])]


def is_suppressed(owner: str, text: str) -> bool:
    """Forgotten (a term appears as a whole word) or removed by the person (same fact identity)."""
    with _LOCK:
        state = _state(owner)
    if identity(text) in state["removed"]:
        return True
    return any(whole_word(term).search(text or "") for term in state["forgotten"])


def add_learned(owner: str, text: str, learned_by: str, now: Optional[float] = None) -> Optional[str]:
    """Record a fact a bot learned about the person. None when it is suppressed or already known."""
    fact = " ".join((text or "").split())[:MAX_FACT_CHARS]
    if not fact:
        return None
    with _LOCK:
        state = _state(owner)
        mine = identity(fact)
        if mine in state["removed"] or any(whole_word(t).search(fact) for t in state["forgotten"]):
            return None
        if any(identity(r["text"]) == mine for r in state["learned"]):
            return None
        if any(normal(fact) in normal(line) for line in get_about(owner)["text"].splitlines() if line.strip()):
            return None
        row = {"id": uuid.uuid4().hex[:12], "text": fact, "learned_by": " ".join((learned_by or "a bot").split())[:100],
               "at": time.time() if now is None else now}
        state["learned"].append(row)
        _save(owner, state)
        return row["id"]


def remove_learned(owner: str, fact_id: str) -> dict:
    """The person removes one learned fact. It is remembered by identity and never learned again."""
    with _LOCK:
        state = _state(owner)
        row = next((r for r in state["learned"] if r["id"] == fact_id), None)
        if row is None:
            raise ProfileMissing("that fact is already gone")
        state["learned"] = [r for r in state["learned"] if r["id"] != fact_id]
        mine = identity(row["text"])
        if mine not in state["removed"]:
            state["removed"].append(mine)
        _save(owner, state)
        return {"removed": fact_id}


def forget(owner: str, term: str) -> dict:
    """The person's own "forget X": the term is remembered, and learned facts and lines of About you that
    contain it as a whole word are removed. Returns the counts."""
    cleaned = check_term(term)
    pattern = whole_word(cleaned)
    with _LOCK:
        state = _state(owner)
        if cleaned.casefold() not in [t.casefold() for t in state["forgotten"]]:
            state["forgotten"].append(cleaned)
        kept = [r for r in state["learned"] if not pattern.search(r["text"])]
        facts = len(state["learned"]) - len(kept)
        state["learned"] = kept
        _save(owner, state)
        about = get_about(owner)
        lines = about["text"].splitlines(keepends=True)
        remaining = [line for line in lines if not pattern.search(line)]
        if len(remaining) != len(lines):
            _write_text(os.path.join(_dir(owner), "about.md"), "".join(remaining))
        return {"term": cleaned, "learned_facts": facts, "about_lines": len(lines) - len(remaining)}


def lift(owner: str, term: Optional[str] = None, text: Optional[str] = None) -> dict:
    """Reverse a suppression: the person re-added the fact, or a reviewed Undo restored it. Never called by
    automatic capture."""
    with _LOCK:
        state = _state(owner)
        before = len(state["forgotten"]) + len(state["removed"])
        if term:
            word = " ".join(term.split()).casefold()
            state["forgotten"] = [t for t in state["forgotten"] if t.casefold() != word]
        if text:
            mine = identity(text)
            state["removed"] = [x for x in state["removed"] if x != mine]
            # A forgotten term also covers a re-added sentence that contains it.
            state["forgotten"] = [t for t in state["forgotten"] if not whole_word(t).search(text)]
        _save(owner, state)
        return {"lifted": before - len(state["forgotten"]) - len(state["removed"])}


def forgotten_terms(owner: str) -> list[str]:
    with _LOCK:
        return list(_state(owner)["forgotten"])


# -- what a bot reads --------------------------------------------------------------------------------------

def profile_context(owner: Optional[str], include_learned: bool = True) -> str:
    """The text every bot gets: the person's own About you, then the facts bots learned (when allowed)."""
    if not owner:
        return ""
    parts = []
    about = get_about(owner)["text"].strip()
    if about:
        parts.append(about)
    if include_learned:
        rows = learned(owner)
        if rows:
            parts.append("Learned by your bots:\n" + "\n".join(f"- {r['text']} (learned by {r['learned_by']})" for r in rows[:50]))
    return "\n\n".join(parts)


def remove_owner(owner: str) -> None:
    """Tests and account removal only."""
    import shutil
    shutil.rmtree(_dir(owner), ignore_errors=True)
