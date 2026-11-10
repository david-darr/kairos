"""Built-in local model engine — no separate app to install (David's ask
2026-09-01: "shouldn't we add something for users that don't want to
download Ollama... what Odysseus and other ai harnesses such as Hermes
does"). Uses `llama-cpp-python`'s bundled OpenAI-compatible server
(`llama_cpp.server`, spawned as a subprocess, same pattern as
electron/main.js's own backend auto-spawn) over a directly-downloaded GGUF
file — no Ollama, no separate installer, just a pip dependency that ships
real prebuilt wheels (verified live: a genuine Windows win_amd64 wheel from
the project's own CPU wheel index, `pip install --extra-index-url
https://abetlen.github.io/llama-cpp-python/whl/cpu llama-cpp-python[server]`
— no C++ compiler required, unlike plain PyPI's source-only listing for
this package). Proven end-to-end live before writing this module: real GGUF
download, real server spawn, real chat completion, then through this app's
own core/providers/openai_compatible.py client unchanged.

This is Cookbook's second serving backend, alongside core/ollama_client.py
— genuinely two options now: install Ollama, or use this built-in engine
with zero extra installs beyond jarvis-app's own Python dependencies.
"""
import asyncio
import os
import re
import subprocess
import sys
from typing import AsyncIterator, Optional

import httpx

from core.constants import DATA_DIR

GGUF_DIR = os.path.join(DATA_DIR, "gguf_models")
DEFAULT_PORT = 8600
DEFAULT_HOST = "127.0.0.1"

# A curated list, not a live catalog search — same honesty posture as
# core/ollama_client.py's Cookbook catalog. Every URL here was verified live
# (a real HTTP range request, not guessed) before being added.
CATALOG = [
    {"name": "qwen2.5-0.5b-instruct", "label": "Qwen 2.5 0.5B Instruct", "params": "0.5B",
     "url": "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf",
     "description": "Tiny and fast — runs on almost any machine, no GPU needed. Good default."},
    {"name": "qwen2.5-1.5b-instruct", "label": "Qwen 2.5 1.5B Instruct", "params": "1.5B",
     "url": "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf",
     "description": "More capable than the 0.5B, still comfortable on CPU."},
    {"name": "qwen2.5-3b-instruct", "label": "Qwen 2.5 3B Instruct", "params": "3B",
     "url": "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf",
     "description": "Stronger general performance, wants more RAM."},
    {"name": "llama-3.2-1b-instruct", "label": "Llama 3.2 1B Instruct", "params": "1B",
     "url": "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf",
     "description": "Meta's small model, GGUF build."},
    {"name": "phi-3.5-mini-instruct", "label": "Phi-3.5 Mini Instruct", "params": "3.8B",
     "url": "https://huggingface.co/bartowski/Phi-3.5-mini-instruct-GGUF/resolve/main/Phi-3.5-mini-instruct-Q4_K_M.gguf",
     "description": "Microsoft's small model, strong for its size — needs more RAM."},
]

_process: Optional[subprocess.Popen] = None
_running_model: Optional[str] = None
_download_progress: dict[str, dict] = {}
_download_tasks: dict[str, asyncio.Task] = {}

# A model name is a file name inside GGUF_DIR: letters, digits, dot, dash, underscore.
# Anything else (a Windows backslash, a slash) could leave the folder.
_NAME_RE = re.compile(r"^[a-z0-9._-]+$")


def _model_path(name: str) -> str:
    if not isinstance(name, str) or not _NAME_RE.fullmatch(name):
        raise ValueError(f"invalid model name: {name!r}")
    return os.path.join(GGUF_DIR, f"{name}.gguf")


def list_downloaded() -> list[dict]:
    if not os.path.isdir(GGUF_DIR):
        return []
    out = []
    for fname in sorted(os.listdir(GGUF_DIR)):
        if not fname.endswith(".gguf"):
            continue
        name = fname[:-5]
        path = os.path.join(GGUF_DIR, fname)
        out.append({"name": name, "size": os.path.getsize(path)})
    return out


def get_download_progress(name: str) -> dict:
    return _download_progress.get(name, {"status": "not_started"})


def start_download(name: str) -> None:
    if _download_progress.get(name, {}).get("status") == "downloading":
        return
    entry = next((c for c in CATALOG if c["name"] == name), None)
    if entry is None:
        raise ValueError(f"unknown catalog model: {name}")
    _download_progress[name] = {"status": "downloading", "completed": 0, "total": 0, "done": False, "error": None}
    _download_tasks[name] = asyncio.create_task(_run_download(name, entry["url"]))


async def cancel_download(name: str) -> bool:
    """Stop a running download and remove its .part. False when none is running."""
    task = _download_tasks.get(name)
    if task is None or task.done():
        return False
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    return True


async def _run_download(name: str, url: str) -> None:
    os.makedirs(GGUF_DIR, exist_ok=True)
    tmp_path = _model_path(name) + ".part"
    try:
        async with httpx.AsyncClient(timeout=None, follow_redirects=True) as client:
            async with client.stream("GET", url) as resp:
                resp.raise_for_status()
                total = int(resp.headers.get("content-length", 0))
                _download_progress[name]["total"] = total
                completed = 0
                with open(tmp_path, "wb") as f:
                    async for chunk in resp.aiter_bytes(1024 * 1024):
                        f.write(chunk)
                        completed += len(chunk)
                        _download_progress[name]["completed"] = completed
        os.replace(tmp_path, _model_path(name))
        _download_progress[name] = {**_download_progress[name], "status": "success", "done": True}
    except asyncio.CancelledError:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        _download_progress[name] = {**_download_progress.get(name, {}), "status": "cancelled", "done": True, "error": None}
        raise
    except Exception as e:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        _download_progress[name] = {**_download_progress.get(name, {}), "status": "error", "done": True, "error": str(e)[:300]}


def delete_downloaded(name: str) -> None:
    if _running_model == name:
        stop()
    path = _model_path(name)
    if os.path.exists(path):
        os.remove(path)
    _download_progress.pop(name, None)


def status() -> dict:
    running = _process is not None and _process.poll() is None
    return {
        "running": running,
        "model": _running_model if running else None,
        "port": DEFAULT_PORT if running else None,
        "base_url": f"http://{DEFAULT_HOST}:{DEFAULT_PORT}/v1" if running else None,
    }


async def start(name: str) -> None:
    """Spawns `python -m llama_cpp.server` for the given downloaded model —
    same subprocess-and-poll-health pattern as electron/main.js's backend
    auto-spawn. Only one model at a time (stops whatever was running first),
    matching the one-process-per-server shape of llama.cpp's own server."""
    global _process, _running_model
    path = _model_path(name)
    if not os.path.exists(path):
        raise FileNotFoundError(f"model not downloaded: {name}")
    from core import vc_runtime
    if vc_runtime.missing():
        # llama.cpp needs it too; without it the server dies at import with only a DLL error.
        raise RuntimeError(vc_runtime.MESSAGE + ", then restart Kairos, to run local models.")
    stop()
    _process = subprocess.Popen(
        [sys.executable, "-m", "llama_cpp.server", "--model", path, "--host", DEFAULT_HOST, "--port", str(DEFAULT_PORT)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    _running_model = name
    try:
        healthy = await _wait_healthy()
    except RuntimeError:
        stop()
        raise
    if not healthy:
        stop()
        raise RuntimeError("llama.cpp server didn't come up in time")


async def _wait_healthy(timeout_seconds: float = 60) -> bool:
    deadline = asyncio.get_event_loop().time() + timeout_seconds
    async with httpx.AsyncClient(timeout=3) as client:
        while asyncio.get_event_loop().time() < deadline:
            if _process is not None and _process.poll() is not None:
                # The child is gone (usually llama-cpp-python is not installed): say so now.
                raise RuntimeError("the built-in engine stopped as it started; is llama-cpp-python installed?")
            try:
                resp = await client.get(f"http://{DEFAULT_HOST}:{DEFAULT_PORT}/v1/models")
                if resp.status_code == 200:
                    return True
            except httpx.HTTPError:
                pass
            await asyncio.sleep(1)
    return False


def stop() -> None:
    global _process, _running_model
    if _process is not None and _process.poll() is None:
        _process.terminate()
        try:
            _process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            _process.kill()
    _process = None
    _running_model = None
