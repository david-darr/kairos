"""Held secrets: text that must never reach a bot, a transcript or a log (Phase 2, unit U5).

Saved passwords, passwords that were just filled into a page and one-time codes made a moment ago
are "held". `scrub()` removes them from any text that is about to go to a model, a transcript or an
error message, in the common encodings a page or a tool could echo them back in: as written, JSON
escaped, URL encoded, HTML escaped, base64 (any alignment) and hex.

Sources are plain callables so the login store can offer every saved password without this module
importing it. Nothing here writes a secret anywhere; held values live in memory only.
"""
import base64
import binascii
import html
import json
import re
import threading
import time
from typing import Callable, Iterable
from urllib.parse import quote, quote_plus

# The one folder (under the data folder) that holds saved logins and their own key. Backups, exports and
# restores never include it, whatever else they are asked to carry.
SECRET_FOLDER = "bot-secrets"
MIN_LENGTH = 4
CODE_TTL_SECONDS = 180
MAX_HELD = 500
PASSWORD_MARK = "[saved password]"
CODE_MARK = "[one-time code]"


def _variants(secret: str) -> set[str]:
    """Every spelling of `secret` that scrub() looks for."""
    raw = secret.encode("utf-8")
    found = {secret, json.dumps(secret, ensure_ascii=False)[1:-1], json.dumps(secret)[1:-1],
             quote(secret, safe=""), quote_plus(secret), quote(secret), html.escape(secret), html.escape(secret, quote=False),
             raw.hex(), raw.hex().upper(), secret.replace("\\", "\\\\")}
    for pad in range(3):
        # Base64 of the secret at each of the three alignments it can take inside a longer encoded string.
        encoded = base64.b64encode(b"\0" * pad + raw).decode("ascii")
        urlsafe = base64.urlsafe_b64encode(b"\0" * pad + raw).decode("ascii")
        lead = {0: 0, 1: 2, 2: 3}[pad]  # leading characters that also depend on the bytes before the secret
        tail = 1 if (pad + len(raw)) % 3 else 0  # a partly filled last character depends on the bytes after it
        for text in (encoded, urlsafe):
            trimmed = text.rstrip("=")[lead:]
            stable = trimmed[:len(trimmed) - tail] if tail else trimmed
            if len(stable) >= MIN_LENGTH:
                found.add(stable)
    return {v for v in found if len(v) >= MIN_LENGTH or v == secret}


class HeldSecrets:
    def __init__(self, clock: Callable[[], float] = time.time):
        self._clock = clock
        self._lock = threading.RLock()
        self._held: dict[str, tuple[str, float | None]] = {}  # secret -> (mark, expires)
        self._sources: list[Callable[[], Iterable[str]]] = []
        self._pattern: tuple[frozenset, re.Pattern | None, dict[str, str]] = (frozenset(), None, {})

    def hold(self, secret: str, *, kind: str = "password", ttl: float | None = None) -> None:
        """Hold one value. Codes expire (ttl); passwords stay until forget()."""
        if not isinstance(secret, str) or not secret or (len(secret) < MIN_LENGTH and kind != "code"):
            return
        with self._lock:
            if len(self._held) >= MAX_HELD:
                self._drop_expired()
                if len(self._held) >= MAX_HELD:
                    self._held.pop(next(iter(self._held)))
            self._held[secret] = (CODE_MARK if kind == "code" else PASSWORD_MARK, self._clock() + ttl if ttl else None)

    def hold_code(self, code: str) -> None:
        self.hold(code, kind="code", ttl=CODE_TTL_SECONDS)

    def forget(self, secret: str) -> None:
        with self._lock:
            self._held.pop(secret, None)

    def clear(self) -> None:
        with self._lock:
            self._held.clear()
            self._pattern = (frozenset(), None, {})

    def add_source(self, source: Callable[[], Iterable[str]]) -> None:
        with self._lock:
            if source not in self._sources:
                self._sources.append(source)

    def _drop_expired(self) -> None:
        now = self._clock()
        for secret in [s for s, (_, until) in self._held.items() if until is not None and until <= now]:
            del self._held[secret]

    def _secrets(self) -> dict[str, str]:
        with self._lock:
            self._drop_expired()
            found = {s: mark for s, (mark, _) in self._held.items()}
            sources = list(self._sources)
        for source in sources:
            try:
                for secret in source():
                    if isinstance(secret, str) and len(secret) >= MIN_LENGTH:
                        found.setdefault(secret, PASSWORD_MARK)
            except Exception:  # a broken source must never open a leak or break a turn
                continue
        return found

    def _compiled(self) -> tuple[re.Pattern | None, dict[str, str]]:
        secrets = self._secrets()
        key = frozenset(secrets.items())
        with self._lock:
            if self._pattern[0] == key:
                return self._pattern[1], self._pattern[2]
        marks: dict[str, str] = {}
        for secret, mark in secrets.items():
            for variant in _variants(secret):
                marks.setdefault(variant, mark)
        if not marks:
            compiled = None
        else:
            ordered = sorted(marks, key=len, reverse=True)
            compiled = re.compile("|".join(re.escape(v) for v in ordered))
        with self._lock:
            self._pattern = (key, compiled, marks)
        return compiled, marks

    def scrub(self, text):
        """`text` with every held secret replaced by a short mark. Non-strings pass through."""
        if not isinstance(text, str) or not text:
            return text
        pattern, marks = self._compiled()
        return pattern.sub(lambda m: marks.get(m.group(0), PASSWORD_MARK), text) if pattern else text

    def scrub_value(self, value):
        """scrub() through nested lists and dicts (tool results, transcripts)."""
        if isinstance(value, str):
            return self.scrub(value)
        if isinstance(value, list):
            return [self.scrub_value(v) for v in value]
        if isinstance(value, tuple):
            return tuple(self.scrub_value(v) for v in value)
        if isinstance(value, dict):
            return {self.scrub(k) if isinstance(k, str) else k: self.scrub_value(v) for k, v in value.items()}
        return value

    def contains(self, text: str) -> bool:
        return isinstance(text, str) and self.scrub(text) != text


held = HeldSecrets()


def scrub(text):
    return held.scrub(text)


def looks_encoded(text: str) -> bool:
    """True for a string that is only base64 or hex, which a caller may want to refuse to echo."""
    try:
        return len(text) >= 16 and bool(base64.b64decode(text, validate=True))
    except (binascii.Error, ValueError):
        return False
