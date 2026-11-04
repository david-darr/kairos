"""One encrypted image connection for avatars and designs, with a daily spending cap."""
import base64
from datetime import date
import io
import os
import re
import threading
from typing import Optional
from urllib.parse import urlparse

import httpx
from PIL import Image
from core import secret_storage, settings
from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR

PROVIDERS = {"openai": ("https://api.openai.com/v1", "gpt-image-1"),
             "xai": ("https://api.x.ai/v1", "grok-2-image"), "compatible": ("", "")}
CONFIG_FILE = os.path.join(DATA_DIR, "avatar_provider.json")
USAGE_FILE = os.path.join(DATA_DIR, "image_usage.json")
GENERATE_TIMEOUT = 120
MAX_GENERATED_BYTES = 15 * 1024 * 1024
SIZES = {"square": "1024x1024", "landscape": "1536x1024", "portrait": "1024x1536"}
_transport = None
_usage_lock = threading.Lock()
_reserved = 0


class ImageError(ValueError):
    """Input the person can correct."""


class ImageUnavailable(ValueError):
    """A missing connection or an unusable server response."""


def _limit(value):
    try:
        value = max(0, min(500, int(value)))
    except (ValueError, TypeError, OverflowError) as error:
        raise ImageError("Give a daily image limit from 0 to 500; 0 turns the limit off.") from error
    return value


def set_daily_limit(value):
    settings.update_settings(image_daily_limit=_limit(value))


def _usage_state():
    usage = read_json(USAGE_FILE, {})
    count = usage.get("count", 0) if usage.get("date") == date.today().isoformat() else 0
    return {"daily_limit": max(0, min(500, int(settings.get_setting("image_daily_limit")))),
            "used_today": max(0, int(count))}


def _clean_base(kind: str, base_url: Optional[str]) -> str:
    if not isinstance(kind, str) or kind not in PROVIDERS:
        raise ImageError("Choose OpenAI, xAI or a compatible server.")
    if base_url is not None and not isinstance(base_url, str):
        raise ImageError("Give the image server's HTTPS address.")
    base = (base_url or "").strip() or PROVIDERS[kind][0]
    parsed = urlparse(base)
    local = parsed.hostname in ("localhost", "127.0.0.1", "::1")
    if parsed.scheme not in ("https", "http") or not parsed.hostname or (parsed.scheme == "http" and not local):
        raise ImageError("The image server address must start with https://.")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ImageError("The image server address cannot carry a login or query.")
    return base.rstrip("/")


def provider_state() -> dict:
    """What the settings page may show. The key is never returned."""
    data = read_json(CONFIG_FILE, {})
    if not isinstance(data, dict) or not data.get("key"):
        return {**_usage_state(), "configured": False, "kind": None, "base_url": None, "model": None}
    return {**_usage_state(), "configured": True, "kind": data.get("kind"), "base_url": data.get("base_url"), "model": data.get("model")}


def save_provider(kind: str, key: str, base_url: Optional[str] = None, model: Optional[str] = None, daily_limit=None) -> dict:
    if not isinstance(kind, str) or kind not in PROVIDERS:
        raise ImageError("Choose OpenAI, xAI or a compatible server.")
    if not isinstance(key, str) or not 8 <= len(key.strip()) <= 400:
        raise ImageError("Paste the connection's key.")
    if base_url is not None and not isinstance(base_url, str):
        raise ImageError("Give the image server's HTTPS address.")
    if model is not None and not isinstance(model, str):
        raise ImageError("Give the image model's name.")
    if kind == "compatible" and not (base_url or "").strip():
        raise ImageError("A compatible server needs its address.")
    model = (model or "").strip() or PROVIDERS[kind][1]
    if not model or len(model) > 120 or not re.fullmatch(r"[\w.:/-]+", model):
        raise ImageError("Give the image model's name.")
    if daily_limit is not None:
        daily_limit = _limit(daily_limit)
    write_json_atomic(CONFIG_FILE, {"kind": kind, "base_url": _clean_base(kind, base_url), "model": model,
                                    "key": secret_storage.encrypt(key.strip())})
    if daily_limit is not None:
        set_daily_limit(daily_limit)
    return provider_state()


def clear_provider() -> dict:
    try:
        os.remove(CONFIG_FILE)
    except FileNotFoundError:
        pass
    return provider_state()


def _connection():
    config = read_json(CONFIG_FILE, {})
    if not isinstance(config, dict) or not config.get("key"):
        raise ImageUnavailable("Save an image connection first.")
    try:
        key = secret_storage.decrypt(config["key"])
        if not isinstance(key, str) or not key or not config.get("model") or not config.get("base_url"):
            raise ValueError()
        _clean_base(config.get("kind"), config["base_url"])
    except Exception as error:
        raise ImageUnavailable("The saved image connection cannot be read. Save it again.") from error
    return config, {"Authorization": f"Bearer {key}"}


async def generate(prompt, size="square", count=1, *, transport=None) -> list[bytes]:
    global _reserved
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 16000:
        raise ImageError("Describe the picture in 1 to 16000 characters.")
    if not isinstance(size, str) or size not in SIZES or type(count) is not int or not 1 <= count <= 4:
        raise ImageError("Choose square, landscape or portrait and 1 to 4 images.")
    config, headers = _connection()
    with _usage_lock:
        state = _usage_state()
        limit = state["daily_limit"]
        if limit and state["used_today"] + _reserved + count > limit:
            raise ImageUnavailable(f"Kairos's daily image limit ({limit}) is reached; it resets tomorrow, or raise it in Settings > Connections > Image generation.")
        _reserved += count
    try:
        body = {"model": config["model"], "prompt": prompt.strip(), "n": count, "size": SIZES[size]}
        if config.get("kind") != "openai" or not str(config["model"]).startswith("gpt-image"):
            body["response_format"] = "b64_json"
        async with httpx.AsyncClient(timeout=GENERATE_TIMEOUT, follow_redirects=False, trust_env=False,
                                     transport=transport if transport is not None else _transport) as client:
            try:
                response = await client.post(f"{config['base_url']}/images/generations", headers=headers, json=body)
            except httpx.TimeoutException as error:
                raise ImageUnavailable("The image connection took too long. Try again.") from error
            except httpx.HTTPError as error:
                raise ImageUnavailable("The image connection could not be reached.") from error
        if response.status_code != 200:
            raise ImageUnavailable(f"The image connection refused the request ({response.status_code}).")
        try:
            items = response.json()["data"]
            if not isinstance(items, list) or not 1 <= len(items) <= count:
                raise ValueError()
            # The provider bills what it sent, so it counts toward the cap even if Kairos can't use it.
            with _usage_lock:
                write_json_atomic(USAGE_FILE, {"date": date.today().isoformat(), "count": _usage_state()["used_today"] + len(items)})
            pictures = []
            for item in items:
                encoded = item["b64_json"]
                if not isinstance(encoded, str) or len(encoded) > MAX_GENERATED_BYTES * 4 // 3 + 16:
                    raise ValueError()
                raw = base64.b64decode(encoded, validate=True)
                if not raw or len(raw) > MAX_GENERATED_BYTES:
                    raise ValueError()
                with Image.open(io.BytesIO(raw)) as image:
                    if image.format not in ("PNG", "JPEG", "GIF", "WEBP") or max(image.size) > 8192 or image.width * image.height > 36_000_000:
                        raise ValueError()
                    image.verify()
                with Image.open(io.BytesIO(raw)) as image:
                    image.load()
                pictures.append(raw)
        except Exception as error:
            raise ImageUnavailable("The image connection did not return a picture Kairos can use.") from error
        return pictures
    finally:
        with _usage_lock:
            _reserved -= count


async def test(transport=None) -> dict:
    """Check authentication through the model list without buying an image."""
    try:
        config, headers = _connection()
        async with httpx.AsyncClient(timeout=20, follow_redirects=False, trust_env=False,
                                     transport=transport if transport is not None else _transport) as client:
            response = await client.get(f"{config['base_url']}/models", headers=headers)
        if response.status_code != 200:
            raise ImageUnavailable(f"The image connection refused the request ({response.status_code}).")
        return {"ok": True}
    except (ImageUnavailable, httpx.HTTPError) as error:
        return {"ok": False, "error": str(error) if isinstance(error, ImageUnavailable) else "The image connection could not be reached."}
