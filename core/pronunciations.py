"""Pronunciations: words Kairos Voice (Kokoro) should say a certain way, per account (Settings > Speech > More options).

misaki reads rare names wrong (Siobhan, Saoirse, Nguyen) and "Kairos" as "KY-ross". Each entry is a word and how to say
it, written as a respelling ("shi-VAWN": syllables split by hyphens or spaces, the stressed one in capitals) or, for
people who know them, Kokoro's own phonemes. A respelling is turned into phonemes once, when it is saved, through
misaki (each syllable read on its own, the spelling rules for any it does not know). core/kokoro_g2p.py asks
`lookup()` for every word before misaki reads it, so a listed word is always said the listed way.

Stored in the account's pronunciations.json as [{word, say, phonemes}]; nothing is seeded.
"""
import hashlib
import json
import os
import re
import threading
from typing import Optional

from core import accounts
from core.atomic_io import read_json, write_json_atomic

FILE = "pronunciations.json"
PATH: Optional[str] = None            # a test can point it at its own file
MAX_ITEMS = 200
_WORD = re.compile(r"[A-Za-z][A-Za-z'\-]{0,39}")
_TOKEN = re.compile(r"[A-Za-z][A-Za-z'\-]*")
_SAY = re.compile(r"[A-Za-z]+(?:[- ][A-Za-z]+){0,9}")
_STRESS = "ˈˌ"
_lock = threading.Lock()
_cache: dict = {}                     # path -> (mtime, {word lowercased: phonemes})


class PronunciationError(ValueError):
    """Shown to the person as-is."""


def _file() -> str:
    return PATH or os.path.join(accounts.account_dir(), FILE)


def items() -> list:
    raw = read_json(_file(), [])
    return [i for i in raw if isinstance(i, dict) and i.get("word") and i.get("phonemes")] if isinstance(raw, list) else []


def _valid_phonemes(value: str) -> str:
    from core import kokoro_engine
    value = " ".join(value.split())
    if not value or len(value) > 120 or any(c not in kokoro_engine.VOCAB for c in value):
        raise PronunciationError("Those phonemes have a symbol Kairos Voice cannot say. Use a respelling instead.")
    return value


def respell(say: str) -> str:
    """Phonemes for a respelling like "shi-VAWN": each syllable through misaki (or the spelling rules), stress on the
    syllable in capitals (the first one when none is)."""
    from core import kokoro_g2p
    syllables = [s for s in re.split(r"[- ]+", say.strip()) if s]
    if not syllables or not _SAY.fullmatch(say.strip()):
        raise PronunciationError("Write how to say it in letters, with syllables split by hyphens, like shi-VAWN.")
    capitals = [n for n, s in enumerate(syllables) if s.isupper()]
    stressed = capitals[0] if capitals and len(capitals) < len(syllables) else 0
    out = []
    for syllable in syllables:
        try:
            ps = kokoro_g2p.phonemize(syllable.lower(), lexicon=False) if not kokoro_g2p.missing() else ""
        except Exception:
            ps = ""
        ps = "".join(c for c in (ps or kokoro_g2p.guess(syllable.lower())) if c not in _STRESS and not c.isspace())
        out.append(ps)
    head = out[stressed]
    at = next((n for n, c in enumerate(head) if c in kokoro_g2p._STRESSABLE), 0)
    out[stressed] = head[:at] + "ˈ" + head[at:]
    return "".join(out)


def save(entries: list) -> list:
    """Replace the account's list. Each entry {word, say, phonemes?}: typed phonemes win over the respelling."""
    if not isinstance(entries, list) or len(entries) > MAX_ITEMS:
        raise PronunciationError(f"Keep the list to {MAX_ITEMS} words.")
    cleaned, seen = [], set()
    for entry in entries:
        word = str((entry or {}).get("word") or "").strip()
        say = str((entry or {}).get("say") or "").strip()
        typed = str((entry or {}).get("phonemes") or "").strip()
        if not word and not say and not typed:
            continue
        if not _WORD.fullmatch(word):
            raise PronunciationError(f"\"{word[:40]}\" is not one word. Use letters only, one word per line.")
        if word.lower() in seen:
            raise PronunciationError(f"\"{word}\" is in the list twice.")
        if not say and not typed:
            raise PronunciationError(f"Write how to say \"{word}\".")
        seen.add(word.lower())
        phonemes = _valid_phonemes(typed) if typed else _valid_phonemes(respell(say))
        cleaned.append({"word": word, "say": say[:80], "phonemes": phonemes, **({"typed": True} if typed else {})})
    with _lock:
        write_json_atomic(_file(), cleaned)
        _cache.pop(_file(), None)
    return cleaned


def _table() -> dict:
    path = _file()
    try:
        stamp = os.path.getmtime(path)
    except OSError:
        return {}
    with _lock:
        found = _cache.get(path)
        if found and found[0] == stamp:
            return found[1]
    table = {i["word"].lower(): i["phonemes"] for i in items()}
    with _lock:
        _cache[path] = (stamp, table)
    return table


def signature(text: str) -> str:
    """A short fingerprint of the listed pronunciations that can change how `text` is said ("" when none can).
    core/video_store.speech_key adds it to a narration line's cache key, so editing the list re-speaks only the lines
    with an affected word. Matched generously (the words as written, as core/kokoro_g2p.expand spells them out, and
    the parts of hyphenated or apostrophe words): a spare match costs one re-speak, a missed one keeps a stale line."""
    try:
        table = _table()
    except Exception:
        return ""                       # no account in scope: the lookup during speech finds nothing either
    if not table or not text:
        return ""
    from core import kokoro_g2p
    words = set()
    for source in (text, kokoro_g2p.expand(text)):
        for token in _TOKEN.findall(source):
            token = token.lower()
            words.add(token)
            words.update(part for part in re.split(r"['\-]+", token) if part)
    hits = sorted((w, table[w]) for w in words if w in table)
    if not hits:
        return ""
    return hashlib.sha256(json.dumps(hits, ensure_ascii=False).encode("utf-8")).hexdigest()[:16]


def lookup(word: str, british: bool = False) -> Optional[str]:
    """The listed phonemes for `word` (any case), else None. Called by core/kokoro_g2p.py for every word."""
    if not word:
        return None
    return _table().get(word.strip().lower())
