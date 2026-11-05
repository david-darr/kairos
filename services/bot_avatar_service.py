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
import hashlib
import io
import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Optional

from core import image_providers
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
PROVIDERS = image_providers.PROVIDERS
CONFIG_FILE = image_providers.CONFIG_FILE

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

def _delegate(name, *args, **kwargs):
    try:
        return getattr(image_providers, name)(*args, **kwargs)
    except image_providers.ImageError as error:
        raise AvatarError(str(error)) from error


def _clean_base(kind, base_url):
    return _delegate("_clean_base", kind, base_url)


def provider_state():
    return _delegate("provider_state")


def save_provider(kind, key, base_url=None, model=None, daily_limit=None):
    return _delegate("save_provider", kind, key, base_url, model, daily_limit)


def clear_provider():
    return _delegate("clear_provider")


# -- generation --------------------------------------------------------------------------------

def clean_direction(text) -> str:
    if not isinstance(text, str) or not text.strip():
        raise AvatarError("Describe the picture you want.")
    if len(text) > MAX_DIRECTION_CHARS:
        raise AvatarError(f"Keep the description under {MAX_DIRECTION_CHARS} characters.")
    return text.strip()


async def generate(scope: str, direction: str) -> dict:
    """Ask the saved connection for one picture and stage it as an owned asset."""
    prompt = clean_direction(direction)
    try:
        pictures = await image_providers.generate(f"Avatar picture for an assistant: {prompt}", transport=_transport)
        return store(scope, pictures[0], MAX_GENERATED_BYTES)
    except (image_providers.ImageUnavailable, AvatarError) as error:
        raise AvatarUnavailable(str(error)) from error
    except image_providers.ImageError as error:
        raise AvatarError(str(error)) from error
