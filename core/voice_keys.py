"""Keys for voice engines (ElevenLabs today), one file per account.

Sealed with that account's own key (core/secret_storage.py), like the Phone connection's secrets. Kept apart from the
chosen engine (core/call_voices.py) so switching engines keeps a key. Values are never returned by any route: callers
get `has(name)` and the server side alone calls `get(name)`.
"""
import os
import threading
from typing import Optional

from core import accounts
from core.atomic_io import read_json, write_json_atomic
from core.secret_storage import decrypt_for, encrypt_for

FILE = "voice_engine_keys.json"
NAMES = ("elevenlabs",)
_LOCK = threading.RLock()
PATH: Optional[str] = None      # a test can point it at its own file


def _file() -> str:
    return PATH or os.path.join(accounts.account_dir(), FILE)


def clean(value) -> str:
    """A pasted key with spaces and line breaks removed; refuses anything that cannot be a key."""
    key = "".join(str(value or "").split())
    if not 8 <= len(key) <= 300 or not all(33 <= ord(c) < 127 for c in key):
        raise ValueError("That does not look like a key. Copy the whole key and paste it again.")
    return key


def set_key(name: str, value) -> None:
    if name not in NAMES:
        raise ValueError("Unknown voice engine.")
    key = clean(value)
    with _LOCK:
        data = read_json(_file(), {})
        data[name] = encrypt_for(accounts.effective_account(), key)
        write_json_atomic(_file(), data)
    try:
        os.chmod(_file(), 0o600)
    except OSError:
        pass


def get(name: str) -> str:
    """The key, unsealed, for the server side only; '' when none is saved or it cannot be unsealed."""
    sealed = read_json(_file(), {}).get(name)
    if not sealed:
        return ""
    try:
        return decrypt_for(accounts.effective_account(), sealed)
    except Exception:
        return ""


def has(name: str) -> bool:
    return bool(read_json(_file(), {}).get(name))


def clear(name: str) -> None:
    with _LOCK:
        data = read_json(_file(), {})
        if data.pop(name, None) is not None:
            write_json_atomic(_file(), data)
