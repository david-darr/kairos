"""Optional speech models that ride on the ONNX runtime: Smart Turn (end of turn by meaning) and Kokoro (neural voice).

Nothing here downloads on its own. A file is fetched only when an administrator presses its Download button in
Settings > Speech, and only if the catalog entry carries a pinned https URL AND a pinned SHA-256 for every file. The
bytes are hashed while they stream; a mismatch deletes the partial file and nothing is installed. An entry whose URL or
hash is still `None` refuses to download ("not pinned in this build") before any network call is made.

Pinning status in this build: the URLs and hashes below are deliberately still TODO. They have to be copied from the
official release pages (and the hashes computed from the files themselves) by a person who has looked at them; they must
not be guessed. Filling an entry in is the whole change needed to switch its download on.

Everything else ships with the app (requirements.txt): the ONNX runtime (the DirectML build on Windows, the standard
build elsewhere) and Kokoro's phonemizer, misaki with spaCy's English model (core/kokoro_g2p.py, licence-clean: no
espeak-ng, no GPL; David's call 2026-11-10). So a normal install needs only the model download. In a runtime missing
any of it (a dev checkout without the packages), every feature here reports why and does nothing: call endpointing
stays on its fixed 700 ms (Open Mic 900 ms) silence wait and the voice stays on the device voice.
"""
import asyncio
import hashlib
import importlib.util
import logging
import os
import re

import httpx

from core import kokoro_g2p
from core.constants import DATA_DIR

logger = logging.getLogger(__name__)

OPTIONAL_DIR = os.path.join(DATA_DIR, "speech_models", "onnx")

_HEX64 = re.compile(r"^[0-9a-f]{64}$")

# Pins come only from the publisher's own listing, never a mirror. Smart Turn v3.2 CPU: Hugging Face's file API for
# pipecat-ai/smart-turn-v3 (LFS sha256, 8,679,182 bytes), read 2026-11-06. Kokoro: GitHub publishes no digest for the
# thewh1teagle/kokoro-onnx model-files-v1.0 assets, so they were fetched from that release with David's OK on
# 2026-11-07, matched the sizes listed there (kokoro-v1.0.onnx 325,532,387 bytes, voices-v1.0.bin 28,214,398 bytes),
# and their sha256 pinned here. Unpinned entries never download.
CATALOG = [
    {"name": "smart-turn", "label": "Smart Turn", "kind": "turn", "needs": ["onnxruntime"],
     "description": "Decides whether you have finished your sentence, so Kairos answers sooner without cutting you off. Runs on the processor in about 12 ms.",
     "files": [{"file": "smart-turn.onnx", "size_mb": 8,
                "url": "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx",
                "sha256": "2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f"}]},
    {"name": "kokoro", "label": "Kokoro voice", "kind": "voice", "needs": ["onnxruntime", *kokoro_g2p.MODULES],
     "description": "A natural local voice that speaks sentence by sentence. The device voice stays as the fallback.",
     "files": [{"file": "kokoro-model.onnx", "size_mb": 310,
                "url": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx",
                "sha256": "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5"},
               {"file": "kokoro-voices.bin", "size_mb": 27,
                "url": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin",
                "sha256": "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d"}]},
]

RUNTIME_NAMES = {"onnxruntime": "the ONNX runtime", "misaki": "the misaki phonemizer", "spacy": "spaCy",
                 "en_core_web_sm": "spaCy's English model", "num2words": "num2words"}

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


def runtime_names(missing: list[str]) -> str:
    names = [RUNTIME_NAMES.get(m, m) for m in missing]
    if len(names) < 2:
        return "".join(names)
    return ", ".join(names[:-1]) + " and " + names[-1]


def runtime_message(missing: list[str]) -> str:
    return "Needs " + runtime_names(missing)


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
            "missing_runtime": missing, "missing_runtime_text": runtime_names(missing), "state": key, "status": label, "ready": key == "ready", "runs_on": _runs_on(name, key)}


def _runs_on(name: str, key: str) -> str | None:
    """Which part of the computer runs Kokoro, in plain words, once it is usable. Smart Turn always runs on the
    processor (DirectML cannot run its model), and its description already says so."""
    if key != "ready" or name != "kokoro":
        return None
    from core import kokoro_voice
    return kokoro_voice.device()["text"]


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
