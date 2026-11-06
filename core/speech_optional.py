"""Optional speech models that ride on the ONNX runtime: Smart Turn (end of turn by meaning) and Kokoro (neural voice).

Nothing here downloads on its own. A file is fetched only when an administrator presses its Download button in
Settings > Speech, and only if the catalog entry carries a pinned https URL AND a pinned SHA-256 for every file. The
bytes are hashed while they stream; a mismatch deletes the partial file and nothing is installed. An entry whose URL or
hash is still `None` refuses to download ("not pinned in this build") before any network call is made.

Pinning status in this build: the URLs and hashes below are deliberately still TODO. They have to be copied from the
official release pages (and the hashes computed from the files themselves) by a person who has looked at them; they must
not be guessed. Filling an entry in is the whole change needed to switch its download on.

onnxruntime is NOT bundled. Without it, or without the model, every feature here reports why and does nothing:
call endpointing stays on its fixed 700 ms (Open Mic 900 ms) silence wait and the voice stays on the device voice.
"""
import asyncio
import hashlib
import importlib.util
import logging
import os
import re

import httpx

from core.constants import DATA_DIR

logger = logging.getLogger(__name__)

OPTIONAL_DIR = os.path.join(DATA_DIR, "speech_models", "onnx")

_HEX64 = re.compile(r"^[0-9a-f]{64}$")

# TODO(pin): url and sha256 for each file come from the official release (Smart Turn: github.com/pipecat-ai/smart-turn
# model card; Kokoro: the Kokoro-82M ONNX release). Left None on purpose: download is refused until both are filled.
CATALOG = [
    {"name": "smart-turn", "label": "Smart Turn", "kind": "turn", "needs": ["onnxruntime"],
     "description": "Decides whether you have finished your sentence, so Kairos answers sooner without cutting you off. Runs on the processor in about 12 ms.",
     "files": [{"file": "smart-turn.onnx", "size_mb": 8, "url": None, "sha256": None}]},
    {"name": "kokoro", "label": "Kokoro voice", "kind": "voice", "needs": ["onnxruntime", "kokoro_onnx"],
     "description": "A natural local voice that speaks sentence by sentence. The device voice stays as the fallback.",
     "files": [{"file": "kokoro-model.onnx", "size_mb": 310, "url": None, "sha256": None},
               {"file": "kokoro-voices.bin", "size_mb": 27, "url": None, "sha256": None}]},
]

RUNTIME_NAMES = {"onnxruntime": "the ONNX runtime", "kokoro_onnx": "the Kokoro engine package"}

_progress: dict[str, dict] = {}


def entry(name: str) -> dict | None:
    return next((item for item in CATALOG if item["name"] == name), None)


def path_of(name: str, index: int = 0) -> str:
    return os.path.join(OPTIONAL_DIR, entry(name)["files"][index]["file"])


def is_pinned(item: dict) -> bool:
    """Every file has an https URL and a lowercase 64-hex SHA-256."""
    return all(isinstance(f.get("url"), str) and f["url"].startswith("https://") and isinstance(f.get("sha256"), str)
               and bool(_HEX64.match(f["sha256"])) for f in item["files"])


def downloaded(name: str) -> bool:
    item = entry(name)
    return bool(item) and all(os.path.isfile(os.path.join(OPTIONAL_DIR, f["file"])) for f in item["files"])


def module_available(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


def missing_runtime(name: str) -> list[str]:
    return [m for m in entry(name)["needs"] if not module_available(m)]


def runtime_message(missing: list[str]) -> str:
    return "Needs " + " and ".join(RUNTIME_NAMES.get(m, m) for m in missing)


def state(name: str) -> dict:
    """What the Settings row says. `ready` means usable right now; `state` is the honest one-word reason otherwise."""
    item = entry(name)
    have = downloaded(name)
    missing = missing_runtime(name)
    progress = _progress.get(name, {})
    if progress.get("status") == "downloading":
        label, key = "Downloading", "downloading"
    elif not have:
        label, key = ("Not downloaded", "not_downloaded") if is_pinned(item) else ("Not available yet: its download is not pinned in this build", "not_pinned")
    elif missing:
        label, key = runtime_message(missing), "needs_runtime"
    else:
        label, key = "Ready", "ready"
    return {"name": name, "label": item["label"], "kind": item["kind"], "description": item["description"],
            "size_mb": sum(f["size_mb"] for f in item["files"]), "downloaded": have, "pinned": is_pinned(item),
            "missing_runtime": missing, "state": key, "status": label, "ready": key == "ready"}


def status() -> list[dict]:
    return [state(item["name"]) for item in CATALOG]


def get_progress(name: str) -> dict:
    return _progress.get(name, {"status": "not_started"})


def start_download(name: str) -> None:
    """Refuses (ValueError, message shown to the user) unless every file is pinned. Must run inside the event loop."""
    item = entry(name)
    if item is None:
        raise ValueError(f"unknown optional speech model: {name}")
    if not is_pinned(item):
        raise ValueError(f"{item['label']} cannot be downloaded yet: its file address and SHA-256 are not pinned in this build.")
    if _progress.get(name, {}).get("status") == "downloading":
        return
    _progress[name] = {"status": "downloading", "completed": 0, "total": sum(f["size_mb"] for f in item["files"]) * 1024 * 1024, "done": False, "error": None}
    asyncio.create_task(_run_download(name))


async def _run_download(name: str) -> None:
    item = entry(name)
    os.makedirs(OPTIONAL_DIR, exist_ok=True)
    partials: list[str] = []
    try:
        done_before = 0
        async with httpx.AsyncClient(timeout=None, follow_redirects=True) as client:
            for spec in item["files"]:
                target = os.path.join(OPTIONAL_DIR, spec["file"])
                tmp = target + ".part"
                partials.append(tmp)
                digest = hashlib.sha256()
                completed = 0
                async with client.stream("GET", spec["url"]) as resp:
                    resp.raise_for_status()
                    with open(tmp, "wb") as handle:
                        async for chunk in resp.aiter_bytes(1024 * 256):
                            digest.update(chunk)
                            handle.write(chunk)
                            completed += len(chunk)
                            _progress[name]["completed"] = done_before + completed
                if digest.hexdigest() != spec["sha256"]:
                    raise ValueError(f"{spec['file']} did not match its pinned SHA-256; it was discarded.")
                os.replace(tmp, target)
                done_before += completed
        _progress[name].update(status="done", done=True)
        logger.info("speech: downloaded optional model %s", name)
    except Exception as e:
        logger.exception("speech: optional download failed for %s", name)
        _progress[name].update(status="error", done=True, error=str(e)[:300])
        for tmp in partials:
            try:
                os.remove(tmp)
            except OSError:
                pass


def remove(name: str) -> None:
    item = entry(name)
    if item is None:
        raise ValueError(f"unknown optional speech model: {name}")
    if _progress.get(name, {}).get("status") == "downloading":
        raise ValueError("Wait for the download to finish before removing it.")
    for spec in item["files"]:
        try:
            os.remove(os.path.join(OPTIONAL_DIR, spec["file"]))
        except FileNotFoundError:
            pass
    _progress.pop(name, None)
    # Cached sessions and engines must not outlive their files.
    from core import turn_detect, kokoro_voice
    turn_detect.reset()
    kokoro_voice.reset()
