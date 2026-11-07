"""Which realtime voice connection and voice a bot's calls use (build spec 6b). Per account, sealed by being that
account's file; holds ids and a voice name only, never a key. A bot's own choice wins over the account default."""
import os
import re

from core.atomic_io import read_json, write_json_atomic

SETTINGS_FILE = None     # a test can point it at its own file; otherwise the current account's

_VOICE = re.compile(r"[\w .:-]{1,60}")
_ID = re.compile(r"[\w.:-]{1,80}")


def settings_file() -> str:
    from core import accounts
    return SETTINGS_FILE or os.path.join(accounts.account_dir(), "realtime_settings.json")


def _clean(value) -> dict:
    value = value if isinstance(value, dict) else {}
    endpoint = value.get("endpoint_id")
    voice = value.get("voice")
    return {"endpoint_id": endpoint if isinstance(endpoint, str) and _ID.fullmatch(endpoint) else None,
            "voice": voice if isinstance(voice, str) and _VOICE.fullmatch(voice) else None}


def get() -> dict:
    data = read_json(settings_file(), {})
    return {**_clean(data), "bots": {b: _clean(v) for b, v in (data.get("bots") or {}).items() if isinstance(b, str)}}


def update(endpoint_id=None, voice=None, bot_id: str = "") -> dict:
    """Set the account default, or (with bot_id) that bot's own choice. None for both removes a bot's choice."""
    current = get()
    if bot_id:
        if not _ID.fullmatch(bot_id):
            raise ValueError("Unknown bot.")
        if endpoint_id is None and voice is None:
            current["bots"].pop(bot_id, None)
        else:
            current["bots"][bot_id] = _clean({"endpoint_id": endpoint_id, "voice": voice})
    else:
        for name, value in (("endpoint_id", endpoint_id), ("voice", voice)):
            if value is not None and not _clean({name: value})[name]:
                raise ValueError(f"That {name.replace('_', ' ')} is not valid.")
        current.update(_clean({"endpoint_id": endpoint_id, "voice": voice}))
    write_json_atomic(settings_file(), current)
    return current


def for_bot(bot_id: str) -> dict:
    """{'endpoint_id', 'voice'} for a bot's calls: its own choice, then the account default."""
    current = get()
    own = current["bots"].get(bot_id) or {}
    return {"endpoint_id": own.get("endpoint_id") or current["endpoint_id"], "voice": own.get("voice") or current["voice"]}
