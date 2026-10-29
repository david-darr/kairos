"""Bot avatar images: owned uploads, generated drafts and the saved provider.

An avatar image is an optional picture layered beside a bot's Kip (services/
agent_service.py keeps the Kip spec unchanged). The record only ever holds
{asset_id, shape, zoom, focus_x, focus_y}; the bytes live here, in the bot's own
folder, so an asset can only be read through the bot that owns it.

Rules (Phase 1 design 5.2): PNG, JPEG, GIF or WebP, decoded and checked, at most
10 MB; SVG and any external URL are refused. Generation uses one saved image
connection (OpenAI, xAI or a compatible server), a 400 character direction, a
120 second timeout, base64 only (a URL in the answer is never fetched) and a 15 MB
decoded limit. A generated picture is staged as an owned asset and applied only
against the avatar snapshot taken when it was asked for, so a late result cannot
overwrite a newer edit. A bot that does not exist yet stages its picture in an
owner-bound draft scope, adopted into the bot after it is created.
"""
import base64
import hashlib
import io
import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

from core import secret_storage
from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR

MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_GENERATED_BYTES = 15 * 1024 * 1024
MAX_DIRECTION_CHARS = 400
GENERATE_TIMEOUT = 120
MAX_PIXELS = 36_000_000
MAX_SIDE = 8192
MAX_DRAFTS = 12
DRAFT_TTL_SECONDS = 24 * 3600
ASSET_ID = re.compile(r"[0-9a-f]{32}")
FORMATS = {"PNG": ("image/png", "png"), "JPEG": ("image/jpeg", "jpg"), "GIF": ("image/gif", "gif"),
           "WEBP": ("image/webp", "webp")}
PROVIDERS = {"openai": ("https://api.openai.com/v1", "gpt-image-1"),
             "xai": ("https://api.x.ai/v1", "grok-2-image"),
             "compatible": ("", "")}
CONFIG_FILE = os.path.join(DATA_DIR, "avatar_provider.json")

# Tests replace this with an httpx.MockTransport; production leaves it None.
_transport = None


class AvatarError(ValueError):
    """Bad input (400)."""


class AvatarConflict(AvatarError):
    """A state refusal (409): the avatar changed while this was in flight."""


class AvatarUnavailable(AvatarError):
    """No image connection is saved, or it failed (502/409 by the route)."""


# -- storage -----------------------------------------------------------------------------------

def _scope_dir(scope: str) -> Path:
    kind, _, name = scope.partition(":")
    if kind == "bot":
        if not re.fullmatch(r"[\w.-]{1,128}", name) or name in (".", ".."):
            raise AvatarError("unknown bot")
        return Path(DATA_DIR) / "agents" / name / "avatar"
    if kind == "draft":
        return Path(DATA_DIR) / "agents" / "_avatar_drafts" / name
    raise AvatarError("unknown avatar scope")


def bot_scope(agent_id: str) -> str:
    return f"bot:{agent_id}"


def draft_scope(user: str) -> str:
    """Owner-bound: the folder name is a hash of the signed-in account."""
    return "draft:" + hashlib.sha256(str(user or "").encode("utf-8")).hexdigest()[:24]


def inspect_image(data: bytes, limit: int = MAX_UPLOAD_BYTES) -> dict:
    """Decode the bytes and say what they are. Raises AvatarError otherwise.

    The format comes from decoding, never from a name or header the sender
    chose; SVG and anything else is not an image here."""
    if not isinstance(data, (bytes, bytearray)) or not data:
        raise AvatarError("Choose a picture to upload.")
    if len(data) > limit:
        raise AvatarError(f"That picture is larger than {limit // (1024 * 1024)} MB.")
    from PIL import Image
    try:
        with Image.open(io.BytesIO(data)) as image:
            fmt = image.format
            width, height = image.size
            if fmt not in FORMATS:
                raise AvatarError("Use a PNG, JPEG, GIF or WebP picture.")
            if width < 1 or height < 1 or width > MAX_SIDE or height > MAX_SIDE or width * height > MAX_PIXELS:
                raise AvatarError("That picture is too large to use.")
            image.verify()
        with Image.open(io.BytesIO(data)) as image:
            image.load()  # a truncated body fails here, not in the browser
    except AvatarError:
        raise
    except Exception as error:
        raise AvatarError("That file is not a picture Kairos can read.") from error
    mime, ext = FORMATS[fmt]
    return {"mime": mime, "ext": ext, "width": width, "height": height, "bytes": len(data)}


def _sweep_drafts(folder: Path) -> None:
    now = time.time()
    files = sorted((p for p in folder.glob("*.*") if p.is_file()), key=lambda p: p.stat().st_mtime)
    for path in files:
        if now - path.stat().st_mtime > DRAFT_TTL_SECONDS:
            path.unlink(missing_ok=True)
    files = [p for p in files if p.exists()]
    for path in files[:max(0, len(files) - MAX_DRAFTS + 1)]:
        path.unlink(missing_ok=True)


def store(scope: str, data: bytes, limit: int = MAX_UPLOAD_BYTES) -> dict:
    info = inspect_image(data, limit)
    folder = _scope_dir(scope)
    folder.mkdir(parents=True, exist_ok=True)
    if scope.startswith("draft:"):
        _sweep_drafts(folder)
    asset_id = uuid.uuid4().hex
    path = folder / f"{asset_id}.{info['ext']}"
    temporary = path.with_suffix(".tmp")
    temporary.write_bytes(bytes(data))
    os.replace(temporary, path)
    return {"asset_id": asset_id, "mime": info["mime"], "width": info["width"], "height": info["height"],
            "bytes": info["bytes"]}


def _find(scope: str, asset_id: str) -> Optional[Path]:
    if not isinstance(asset_id, str) or not ASSET_ID.fullmatch(asset_id):
        return None
    folder = _scope_dir(scope)
    for _mime, ext in FORMATS.values():
        path = folder / f"{asset_id}.{ext}"
        if path.is_file():
            return path
    return None


def exists(scope: str, asset_id: str) -> bool:
    return _find(scope, asset_id) is not None


def read(scope: str, asset_id: str) -> tuple[bytes, str]:
    path = _find(scope, asset_id)
    if path is None:
        raise KeyError(asset_id)
    ext = path.suffix.lstrip(".")
    mime = next(m for m, e in FORMATS.values() if e == ext)
    return path.read_bytes(), mime


def remove(scope: str, asset_id: str) -> None:
    path = _find(scope, asset_id)
    if path is not None:
        path.unlink(missing_ok=True)


def adopt_draft(user: str, asset_id: str, agent_id: str) -> None:
    """Move an owner's draft picture into the new bot's own folder."""
    path = _find(draft_scope(user), asset_id)
    if path is None:
        raise AvatarError("That draft picture is no longer available.")
    folder = _scope_dir(bot_scope(agent_id))
    folder.mkdir(parents=True, exist_ok=True)
    os.replace(path, folder / path.name)


def delete_bot(agent_id: str) -> None:
    import shutil
    shutil.rmtree(_scope_dir(bot_scope(agent_id)), ignore_errors=True)


# -- the avatar snapshot -----------------------------------------------------------------------

def snapshot_of(agent: dict) -> str:
    """What a late result is checked against: the Kip look, the image and the expression."""
    state = [agent.get("avatar"), agent.get("avatar_image"), agent.get("mascot_expression")]
    return hashlib.sha256(json.dumps(state, sort_keys=True).encode("utf-8")).hexdigest()[:16]


def framing(payload: dict) -> dict:
    """The saved avatar_image object for an asset and its framing."""
    return {"asset_id": payload.get("asset_id"), "shape": payload.get("shape", "circle"),
            "zoom": payload.get("zoom", 1), "focus_x": payload.get("focus_x", 0.5),
            "focus_y": payload.get("focus_y", 0.5)}


# -- the saved image connection ----------------------------------------------------------------

def _clean_base(kind: str, base_url: Optional[str]) -> str:
    base = (base_url or "").strip() or PROVIDERS[kind][0]
    parsed = urlparse(base)
    local = parsed.hostname in ("localhost", "127.0.0.1", "::1")
    if parsed.scheme not in ("https", "http") or not parsed.hostname or (parsed.scheme == "http" and not local):
        raise AvatarError("The image server address must start with https://.")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise AvatarError("The image server address cannot carry a login or query.")
    return base.rstrip("/")


def provider_state() -> dict:
    """What the settings page may show. The key is never returned."""
    data = read_json(CONFIG_FILE, {})
    if not data.get("key"):
        return {"configured": False, "kind": None, "base_url": None, "model": None}
    return {"configured": True, "kind": data.get("kind"), "base_url": data.get("base_url"), "model": data.get("model")}


def save_provider(kind: str, key: str, base_url: Optional[str] = None, model: Optional[str] = None) -> dict:
    if kind not in PROVIDERS:
        raise AvatarError("Choose OpenAI, xAI or a compatible server.")
    if not isinstance(key, str) or not 8 <= len(key.strip()) <= 400:
        raise AvatarError("Paste the connection's key.")
    if kind == "compatible" and not (base_url or "").strip():
        raise AvatarError("A compatible server needs its address.")
    model = (model or "").strip() or PROVIDERS[kind][1]
    if not model or len(model) > 120 or not re.fullmatch(r"[\w.:/-]+", model):
        raise AvatarError("Give the image model's name.")
    write_json_atomic(CONFIG_FILE, {"kind": kind, "base_url": _clean_base(kind, base_url), "model": model,
                                    "key": secret_storage.encrypt(key.strip())})
    return provider_state()


def clear_provider() -> dict:
    try:
        os.remove(CONFIG_FILE)
    except FileNotFoundError:
        pass
    return provider_state()


# -- generation --------------------------------------------------------------------------------

def clean_direction(text) -> str:
    if not isinstance(text, str) or not text.strip():
        raise AvatarError("Describe the picture you want.")
    if len(text) > MAX_DIRECTION_CHARS:
        raise AvatarError(f"Keep the description under {MAX_DIRECTION_CHARS} characters.")
    return text.strip()


async def generate(scope: str, direction: str) -> dict:
    """Ask the saved connection for one picture and stage it as an owned asset."""
    import httpx
    prompt = clean_direction(direction)
    config = read_json(CONFIG_FILE, {})
    if not config.get("key"):
        raise AvatarUnavailable("Save an image connection first.")
    try:
        key = secret_storage.decrypt(config["key"])
    except Exception as error:
        raise AvatarUnavailable("The saved image connection cannot be read. Save it again.") from error
    body = {"model": config["model"], "prompt": f"Avatar picture for an assistant: {prompt}", "n": 1,
            "size": "1024x1024"}
    if config.get("kind") != "openai" or not str(config["model"]).startswith("gpt-image"):
        body["response_format"] = "b64_json"
    try:
        async with httpx.AsyncClient(timeout=GENERATE_TIMEOUT, follow_redirects=False, trust_env=False,
                                     transport=_transport) as client:
            response = await client.post(f"{config['base_url']}/images/generations",
                                         headers={"Authorization": f"Bearer {key}"}, json=body)
    except httpx.TimeoutException as error:
        raise AvatarUnavailable("The image connection took too long. Try again.") from error
    except httpx.HTTPError as error:
        raise AvatarUnavailable("The image connection could not be reached.") from error
    if response.status_code != 200:
        raise AvatarUnavailable(f"The image connection refused the request ({response.status_code}).")
    try:
        item = response.json()["data"][0]
        encoded = item["b64_json"]
        if not isinstance(encoded, str) or len(encoded) > MAX_GENERATED_BYTES * 4 // 3 + 16:
            raise ValueError
        data = base64.b64decode(encoded, validate=True)
    except Exception as error:
        raise AvatarUnavailable("The image connection did not return a picture Kairos can use.") from error
    try:
        return store(scope, data, MAX_GENERATED_BYTES)
    except AvatarError as error:
        raise AvatarUnavailable(str(error)) from error
