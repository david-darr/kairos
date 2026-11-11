"""HD voice: Qwen3-TTS 0.6B on an NVIDIA graphics card, an optional quality level of Kairos Voice (David, 2026-11-10:
"keep kokoro as the default, however for users that have an nvidia graphics card, in settings allow them to have the
option to switch to that"). Kokoro stays the default and the automatic fallback.

What a person gets:
- Offered only on Windows with an NVIDIA card that has a recent driver (570 or newer, PyTorch's CUDA 12.8 build),
  compute capability 8.0 or newer (RTX 30 series and up: the model runs in bfloat16) and about 4 GB of free graphics
  memory. Anyone else sees nothing, or one plain line saying why (an NVIDIA card that falls short).
- Installed only when the person asks, after one consent step that states the size and that it runs locally. Every
  file comes from its official source (PyTorch wheels from download.pytorch.org, the rest from PyPI, the weights from
  Qwen's Hugging Face repositories, the reference clip from kyutai/tts-voices), pinned in core/hd_voice_manifest.json
  by URL, size and SHA-256. Bytes are hashed as they arrive; a mismatch deletes the file and stops. A stopped or
  failed download resumes where it left off (HTTP Range). Everything lands in the app's data folder
  (speech_models/hd_voice): its own Python environment (`env/site`, wheels unpacked there, never into the app's
  runtime), the models, and the voice clip. Remove deletes the whole folder.
- Runs as a sidecar process (sidecars/hd_voice/server.py) with the app's own interpreter in isolated mode, so only
  that environment and the reviewed vendored model code are on its path. Started on first use or when a call starts
  (warm), stopped after IDLE_SECONDS without use. One GPU queue: sentences render one at a time in the order they are
  asked for, so the next sentence (which the speakers request while one plays) is already queued. Audio streams back
  in pieces of about a third of a second, with the silence the model pads each sentence with trimmed (EdgeTrim).
- If the sidecar is missing, still loading, crashes, errors or is slow to start a sentence, `stream()` raises
  HDUnavailable before any audio and core/call_voices.py speaks that sentence with Kokoro instead.

Pronunciations: Qwen3-TTS reads text, it has no phoneme input. Respellings ("shi-VAWN") are applied as plain text
("Shivawn"); entries that only have typed phonemes apply to the Standard voice only.
"""
import asyncio
import atexit
import collections
import hashlib
import json
import logging
import os
import re
import shutil
import struct
import subprocess
import sys
import threading
import time
import zipfile

from core.constants import BASE_DIR, DATA_DIR

logger = logging.getLogger(__name__)

NAME = "qwen3-tts-hd"
SAMPLE_RATE = 24000
VOICES = [
    {"id": "iris", "name": "Iris", "description": "Warm female voice, cloned from a donated clip (CC0)."},
    {"id": "ryan", "name": "Ryan", "description": "Male voice built into Qwen3-TTS."},
    {"id": "aiden", "name": "Aiden", "description": "Male voice built into Qwen3-TTS."},
]
VOICE_IDS = tuple(v["id"] for v in VOICES)
DEFAULT_VOICE = "iris"
PREVIEW_TEXT = "Hi, I'm Kairos. This is how I sound in HD on your graphics card."

MIN_DRIVER = (570, 0)                 # PyTorch 2.9.1 + CUDA 12.8 (NVIDIA's minimum for CUDA 12.8 on Windows is 570.x)
MIN_CAPABILITY = (8, 0)               # bfloat16 kernels: Ampere (RTX 30) and newer
MIN_FREE_MB = 4000                    # model + CUDA graphs measured 2.9 to 3.5 GB in the bake-off
IDLE_SECONDS = 300                    # stop the sidecar (and free the graphics memory) after 5 minutes unused
START_TIMEOUT = 20.0                  # a queued sentence must start within this (the queue ahead of it renders fast)
FIRST_AUDIO_TIMEOUT = 2.5             # and sound within this once started (measured about 0.2 s), else Kokoro speaks
LOAD_TIMEOUT = 120.0
WATCH_INTERVAL = 1.0                  # how often the idle watcher looks

# Tests point these at their own folders, manifest, sidecar command and GPU answer.
HD_DIR = None
MANIFEST = None
SIDECAR_COMMAND = None                # a list: replaces [python, server.py, ...] (a fake sidecar in tests)
GPU_PROBE = None                      # callable -> list of GPU dicts, or None for "no NVIDIA tool"
ALLOW_LOOPBACK_HTTP = False           # tests serve the files from a local mock server

MANIFEST_PATH = os.path.join(BASE_DIR, "core", "hd_voice_manifest.json")
SERVER_PATH = os.path.join(BASE_DIR, "sidecars", "hd_voice", "server.py")


class HDUnavailable(Exception):
    """Message is meant for the person, as-is."""


def root() -> str:
    return HD_DIR or os.path.join(DATA_DIR, "speech_models", "hd_voice")


def manifest() -> dict:
    if MANIFEST is not None:
        return MANIFEST
    with open(MANIFEST_PATH, encoding="utf-8") as handle:
        return json.load(handle)


# -- the graphics card -------------------------------------------------------------------------------------------------

_gpu_cache: dict = {}


def _nvidia_smi() -> list | None:
    """Rows from nvidia-smi (installed with every NVIDIA driver), or None when there is no NVIDIA tool or card."""
    exe = shutil.which("nvidia-smi") or os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "nvidia-smi.exe")
    if not os.path.isfile(exe):
        return None
    try:
        out = subprocess.run([exe, "--query-gpu=name,memory.total,memory.free,driver_version,compute_cap",
                              "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=8,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    rows = []
    for line in out.stdout.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 5:
            continue
        try:
            rows.append({"name": parts[0], "total_mb": int(float(parts[1])), "free_mb": int(float(parts[2])),
                         "driver": parts[3], "capability": parts[4]})
        except ValueError:
            continue
    return rows or None


def _version(text: str) -> tuple:
    try:
        return tuple(int(x) for x in str(text).split(".")[:2])
    except ValueError:
        return (0,)


def gpu(max_age: float = 600.0) -> dict:
    """The first NVIDIA card (the one CUDA calls device 0) and whether HD voice can run on it, in plain words.
    {"nvidia": bool, "capable": bool, "reason": str, "card": {...} | None}. Asking nvidia-smi takes a moment, so the
    answer is kept for `max_age` seconds (Settings asks for a fresher one)."""
    now = time.monotonic()
    if _gpu_cache and now - _gpu_cache["at"] < max_age:
        return _gpu_cache["value"]
    if sys.platform != "win32" and GPU_PROBE is None:
        value = {"nvidia": False, "capable": False, "reason": "", "card": None}
    else:
        rows = GPU_PROBE() if GPU_PROBE is not None else _nvidia_smi()
        if not rows:
            value = {"nvidia": False, "capable": False, "reason": "", "card": None}
        else:
            card = rows[0]
            reason = ""
            if _version(card.get("driver")) < MIN_DRIVER:
                reason = f"Update the NVIDIA driver to version {MIN_DRIVER[0]} or newer to use HD voice (this PC has {card.get('driver')})."
            elif _version(card.get("capability")) < MIN_CAPABILITY:
                reason = f"HD voice needs an NVIDIA RTX 30 series card or newer; the {card.get('name')} is too old for it."
            elif int(card.get("free_mb") or 0) < MIN_FREE_MB and not installed():
                reason = (f"HD voice needs about 4 GB of free graphics memory; the {card.get('name')} has "
                          f"{round(int(card.get('free_mb') or 0) / 1024, 1)} GB free right now. Close a game or other graphics app and try again.")
            value = {"nvidia": True, "capable": not reason, "reason": reason, "card": card}
    _gpu_cache.update(at=now, value=value)
    return value


# -- install state -----------------------------------------------------------------------------------------------------

def _paths():
    base = root()
    return {"site": os.path.join(base, "env", "site"), "models": os.path.join(base, "models"),
            "voices": os.path.join(base, "voices"), "downloads": os.path.join(base, "downloads"),
            "marker": os.path.join(base, "installed.json")}


def installed() -> bool:
    """Every piece is on disk and the install finished for this manifest version."""
    paths = _paths()
    try:
        with open(paths["marker"], encoding="utf-8") as handle:
            marker = json.load(handle)
    except (OSError, ValueError):
        return False
    if marker.get("version") != manifest().get("version"):
        return False
    return all(os.path.isfile(os.path.join(root(), f["path"])) for f in manifest()["files"]) and os.path.isdir(paths["site"])


def sizes() -> dict:
    m = manifest()
    wheels = sum(int(w["size"]) for w in m["wheels"])
    files, seen = 0, set()
    for f in m["files"]:
        if f["sha256"] not in seen:
            seen.add(f["sha256"])
            files += int(f["size"])
    return {"runtime_bytes": wheels, "models_bytes": files, "download_bytes": wheels + files,
            "disk_bytes": int(m.get("unpacked_bytes") or 0) + files}


def _partial_bytes() -> int:
    """Bytes an unfinished install has already downloaded (kept, so Install resumes from there)."""
    if installed():
        return 0
    total, env = 0, os.path.join(root(), "env")
    for folder, _dirs, names in os.walk(root()):
        if os.path.join(folder, "").startswith(os.path.join(env, "")):
            continue
        for name in names:
            try:
                total += os.path.getsize(os.path.join(folder, name))
            except OSError:
                pass
    return total


def ready() -> tuple[bool, str | None]:
    """Usable right now: installed and a capable card. (Whether the sidecar runs is decided when it is asked.)"""
    if not installed():
        return False, "HD voice is not installed"
    card = gpu()
    if not card["nvidia"]:
        return False, "No NVIDIA graphics card was found"
    if _version((card["card"] or {}).get("driver")) < MIN_DRIVER or _version((card["card"] or {}).get("capability")) < MIN_CAPABILITY:
        return False, card["reason"] or "This graphics card cannot run HD voice"
    if _sidecar.failed_reason:
        return False, _sidecar.failed_reason
    return True, None


def status() -> dict:
    """What Settings > Speech shows: whether to offer HD voice at all, its install state, size and progress."""
    card = gpu(max_age=30)
    have = installed()
    progress = {k: v for k, v in _progress.items() if k != "stop"}
    size = sizes()
    ok, reason = ready()
    state = ("installing" if progress.get("status") == "running" else "ready" if ok
             else "installed" if have else "partial" if _partial_bytes() else "not_installed")
    return {"offered": bool(card["nvidia"] and (card["capable"] or have)), "nvidia": card["nvidia"],
            "reason": card["reason"], "card": (card["card"] or {}).get("name"), "installed": have, "ready": ok,
            "not_ready_reason": "" if ok else (reason or ""), "state": state, "progress": progress,
            "partial_bytes": _partial_bytes(), **size, "voices": VOICES, "default_voice": DEFAULT_VOICE,
            "running": _sidecar.running(), "sources": manifest().get("sources", [])}


# -- the installer -----------------------------------------------------------------------------------------------------

_progress: dict = {}
_install_task = None


def _allowed(url: str) -> bool:
    if url.startswith("https://"):
        return True
    return ALLOW_LOOPBACK_HTTP and url.startswith(("http://127.0.0.1:", "http://localhost:"))


def _sha256_file(path: str) -> tuple[str, int]:
    digest, size = hashlib.sha256(), 0
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 22), b""):
            digest.update(block)
            size += len(block)
    return digest.hexdigest(), size


def _verified(path: str, item: dict) -> bool:
    """A finished download from an earlier attempt, still intact."""
    return os.path.isfile(path) and os.path.getsize(path) == int(item["size"]) and _sha256_file(path)[0] == item["sha256"]


async def _fetch(client, item: dict, target: str) -> None:
    """Download `item` to `target`, resuming a `.part` file with an HTTP Range request. Verified before it is kept."""
    if not _allowed(item["url"]):
        raise ValueError(f"{item.get('name') or item.get('path')} has no secure address in this build.")
    expected = int(item["size"])
    os.makedirs(os.path.dirname(target), exist_ok=True)
    part = target + ".part"
    digest, have = hashlib.sha256(), 0
    if os.path.exists(part):
        if os.path.getsize(part) > expected:
            os.remove(part)
        else:
            with open(part, "rb") as handle:
                for block in iter(lambda: handle.read(1 << 22), b""):
                    digest.update(block)
                    have += len(block)
    _progress["done_bytes"] = _progress.get("done_bytes", 0) + have
    if have < expected:
        headers = {"Range": f"bytes={have}-"} if have else {}
        async with client.stream("GET", item["url"], headers=headers) as response:
            if response.status_code == 200 and have:
                # The server ignored the Range: start this file again.
                _progress["done_bytes"] -= have
                digest, have = hashlib.sha256(), 0
                mode = "wb"
            elif response.status_code in (200, 206):
                mode = "ab" if have else "wb"
            else:
                raise ValueError(f"The download of {item.get('name') or os.path.basename(item['path'])} failed (HTTP {response.status_code}).")
            with open(part, mode) as handle:
                async for chunk in response.aiter_bytes():
                    have += len(chunk)
                    if have > expected:
                        raise ValueError(f"{item.get('name') or os.path.basename(item['path'])} is larger than its pinned size; it was discarded.")
                    digest.update(chunk)
                    handle.write(chunk)
                    _progress["done_bytes"] = _progress.get("done_bytes", 0) + len(chunk)
                    if _progress.get("stop"):
                        raise asyncio.CancelledError()
    if have < expected:
        # The connection ended early: keep what arrived, so the next try resumes from here.
        raise ValueError(f"The download of {item.get('name') or os.path.basename(item['path'])} was interrupted. Resume to continue.")
    if digest.hexdigest() != item["sha256"]:
        try:
            os.remove(part)
        except OSError:
            pass
        raise ValueError(f"{item.get('name') or os.path.basename(item['path'])} did not match its pinned SHA-256; it was discarded. Try again.")
    os.replace(part, target)


def _unpack(wheels: list, site: str) -> None:
    """Unpack verified wheels into a fresh `site` folder (a wheel is a zip; its .data/purelib and platlib parts go in
    the same folder; scripts and headers are not needed). Built aside and swapped in, so a failure leaves nothing half done."""
    staging = site + ".staging"
    shutil.rmtree(staging, ignore_errors=True)
    os.makedirs(staging)
    for wheel in wheels:
        with zipfile.ZipFile(wheel) as archive:
            for member in archive.infolist():
                name = member.filename
                if name.endswith("/"):
                    continue
                parts = name.split("/")
                if ".." in parts or name.startswith("/") or ":" in parts[0]:
                    raise ValueError(f"{os.path.basename(wheel)} has an unsafe path; nothing was installed.")
                if parts[0].endswith(".data"):
                    if len(parts) < 3 or parts[1] not in ("purelib", "platlib"):
                        continue
                    parts = parts[2:]
                destination = os.path.join(staging, *parts)
                os.makedirs(os.path.dirname(destination), exist_ok=True)
                with archive.open(member) as source, open(destination, "wb") as out:
                    shutil.copyfileobj(source, out, 1 << 20)
    shutil.rmtree(site, ignore_errors=True)
    os.replace(staging, site)


async def _install() -> None:
    import httpx
    m, paths = manifest(), _paths()
    try:
        need = sizes()["download_bytes"] + int(m.get("unpacked_bytes") or 0) - _partial_bytes()
        os.makedirs(root(), exist_ok=True)
        free = shutil.disk_usage(root()).free
        if free < need + (1 << 30):
            raise ValueError(f"HD voice needs about {round((need + (1 << 30)) / 1e9, 1)} GB of free disk space; "
                             f"this drive has {round(free / 1e9, 1)} GB.")
        _progress.update(stage="Downloading")
        wheels, fetched = [], {}
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, read=120.0), follow_redirects=True, trust_env=False) as client:
            for item in m["wheels"]:
                target = os.path.join(paths["downloads"], item["name"])
                if await asyncio.to_thread(_verified, target, item):
                    _progress["done_bytes"] = _progress.get("done_bytes", 0) + int(item["size"])
                else:
                    await _fetch(client, item, target)
                wheels.append(target)
            for item in m["files"]:
                target = os.path.join(root(), item["path"])
                if await asyncio.to_thread(_verified, target, item):
                    _progress["done_bytes"] = _progress.get("done_bytes", 0) + int(item["size"])
                elif item["sha256"] in fetched:          # the same file under another model (the speech tokenizer)
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    try:
                        os.link(fetched[item["sha256"]], target)
                    except OSError:
                        shutil.copyfile(fetched[item["sha256"]], target)
                else:
                    await _fetch(client, item, target)
                fetched[item["sha256"]] = target
        _progress.update(stage="Setting up")
        await asyncio.to_thread(_unpack, wheels, paths["site"])
        shutil.rmtree(paths["downloads"], ignore_errors=True)
        with open(paths["marker"], "w", encoding="utf-8") as handle:
            json.dump({"version": m.get("version"), "at": time.time()}, handle)
        _gpu_cache.clear()
        _sidecar.failed_reason = ""
        _progress.update(status="done", stage="Installed", error=None)
        logger.info("hd voice: installed")
    except asyncio.CancelledError:
        _progress.update(status="stopped", stage="Paused", error=None)
    except Exception as error:
        logger.exception("hd voice: install failed")
        _progress.update(status="error", stage="Failed", error=str(error)[:300])
    finally:
        _progress.pop("stop", None)


def start_install() -> dict:
    """Start (or resume) the install. Must run inside the event loop. Refused on a PC that cannot run it."""
    global _install_task
    card = gpu(max_age=0)
    if not card["nvidia"] or not card["capable"]:
        raise ValueError(card["reason"] or "HD voice needs an NVIDIA graphics card.")
    if _progress.get("status") == "running":
        return dict(_progress)
    _progress.clear()
    _progress.update(status="running", stage="Starting", done_bytes=0, total_bytes=sizes()["download_bytes"], error=None)
    _install_task = asyncio.ensure_future(_install())
    return dict(_progress)


def stop_install() -> None:
    """Pause: what has arrived stays, and Install resumes from there."""
    if _progress.get("status") == "running":
        _progress["stop"] = True


async def remove() -> None:
    """Delete everything HD voice put on disk (environment, models, voices, partial downloads)."""
    if _progress.get("status") == "running":
        raise ValueError("Pause the install before removing HD voice.")
    await asyncio.to_thread(_sidecar.stop)
    await asyncio.to_thread(shutil.rmtree, root(), True)
    _progress.clear()
    _sidecar.failed_reason = ""


# -- the sidecar -------------------------------------------------------------------------------------------------------

class _Sidecar:
    """One child process, driven from any thread or event loop. A reader thread hands each frame to whoever asked."""

    def __init__(self):
        self.proc = None
        self.lock = threading.RLock()
        self.next_id = 1
        self.waiters: dict = {}          # id or "control" -> (loop, asyncio.Queue) | queue-like with put
        self.loaded: str | None = None   # voice whose model is loaded
        self.loading = False
        self.last_used = time.monotonic()
        self.active = 0
        self.stderr = collections.deque(maxlen=60)
        self.crashes = collections.deque(maxlen=5)
        self.failed_reason = ""
        self.watcher = None

    def running(self) -> bool:
        return bool(self.proc and self.proc.poll() is None)

    def _command(self):
        paths = _paths()
        if SIDECAR_COMMAND:
            return list(SIDECAR_COMMAND) + ["--env", paths["site"], "--models", paths["models"], "--voices", paths["voices"]]
        return [sys.executable, "-I", "-S", "-X", "utf8", SERVER_PATH, "--env", paths["site"],
                "--models", paths["models"], "--voices", paths["voices"]]

    def start(self) -> None:
        with self.lock:
            if self.running():
                return
            recent = [t for t in self.crashes if time.monotonic() - t < 600]
            if len(recent) >= 3:
                self.failed_reason = "HD voice stopped three times in ten minutes, so Kokoro speaks until Kairos restarts."
                raise HDUnavailable(self.failed_reason)
            self.proc = subprocess.Popen(self._command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                         stderr=subprocess.PIPE, cwd=root(),
                                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            self.loaded = None
            proc = self.proc
            threading.Thread(target=self._read, args=(proc,), daemon=True, name="hd-voice-reader").start()
            threading.Thread(target=self._read_err, args=(proc,), daemon=True, name="hd-voice-stderr").start()
            if not self.watcher or not self.watcher.is_alive():
                self.watcher = threading.Thread(target=self._watch, daemon=True, name="hd-voice-idle")
                self.watcher.start()
            logger.info("hd voice: sidecar started (pid %s)", proc.pid)

    def _read_err(self, proc):
        for raw in iter(proc.stderr.readline, b""):
            line = raw.decode("utf-8", "replace").rstrip()
            if line:
                self.stderr.append(line)
        proc.stderr.close()

    def _read(self, proc):
        stream = proc.stdout
        try:
            while True:
                head = stream.read(4)
                if len(head) < 4:
                    break
                header = json.loads(stream.read(struct.unpack(">I", head)[0]))
                payload = stream.read(header["bytes"]) if header.get("bytes") else b""
                key = header.get("id") if header.get("id") is not None else "control"
                self._deliver(key, (header, payload))
        except Exception:
            logger.exception("hd voice: reader failed")
        finally:
            code = proc.wait()
            stream.close()
            try:
                proc.stdin.close()
            except OSError:
                pass
            with self.lock:
                if self.proc is proc:
                    self.proc = None
                    self.loaded = None
                    if code not in (0, None):
                        self.crashes.append(time.monotonic())
                        logger.warning("hd voice: sidecar exited with %s: %s", code, " | ".join(list(self.stderr)[-5:]))
                waiting = list(self.waiters)
            for key in waiting:
                self._deliver(key, ({"type": "error", "message": "HD voice stopped."}, b""))

    def _deliver(self, key, item):
        target = self.waiters.get(key)
        if target is None:
            return
        loop, q = target
        try:
            loop.call_soon_threadsafe(q.put_nowait, item)
        except RuntimeError:
            pass                                    # that caller's loop is gone

    def _send(self, message: dict) -> None:
        with self.lock:
            if not self.running():
                raise HDUnavailable("HD voice is not running.")
            try:
                self.proc.stdin.write((json.dumps(message) + "\n").encode("utf-8"))
                self.proc.stdin.flush()
            except OSError as error:
                raise HDUnavailable("HD voice stopped.") from error

    def _watch(self):
        while True:
            time.sleep(WATCH_INTERVAL)
            with self.lock:
                if not self.running():
                    return
                idle = time.monotonic() - self.last_used
                if self.active == 0 and not self.loading and idle > IDLE_SECONDS:
                    logger.info("hd voice: stopping after %d s idle", int(idle))
                    self._quit_locked()
                    return

    def _quit_locked(self):
        proc, self.proc, self.loaded = self.proc, None, None
        if not proc:
            return
        try:
            proc.stdin.write(b'{"op":"quit"}\n')
            proc.stdin.flush()
            proc.stdin.close()
        except OSError:
            pass
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()

    def stop(self) -> None:
        with self.lock:
            self._quit_locked()

    async def _control(self, message: dict, wanted: str, timeout: float) -> dict:
        loop, q = asyncio.get_running_loop(), asyncio.Queue()
        with self.lock:
            if "control" in self.waiters:
                raise HDUnavailable("HD voice is busy loading.")
            self.waiters["control"] = (loop, q)
        try:
            self._send(message)
            while True:
                header, _ = await asyncio.wait_for(q.get(), timeout)
                if header.get("type") == wanted:
                    return header
                if header.get("type") == "error":
                    raise HDUnavailable(header.get("message") or "HD voice could not load.")
        finally:
            with self.lock:
                self.waiters.pop("control", None)

    async def load(self, voice: str) -> float:
        """Start the sidecar if needed and get `voice`'s model into graphics memory. Returns the seconds it took."""
        if self.loaded == voice and self.running():
            return 0.0
        await asyncio.to_thread(self.start)
        self.loading = True
        try:
            header = await self._control({"op": "load", "voice": voice}, "loaded", LOAD_TIMEOUT)
        except asyncio.TimeoutError as error:
            raise HDUnavailable("HD voice took too long to load.") from error
        finally:
            self.loading = False
            self.last_used = time.monotonic()
        self.loaded = voice
        return float(header.get("seconds") or 0)

    def warm_kind(self, voice: str) -> bool:
        """Is a model that can speak `voice` already loaded? Iris uses the Base model; Ryan and Aiden share the other."""
        if not self.running() or not self.loaded:
            return False
        return (self.loaded == "iris") == (voice == "iris")

    async def say(self, text: str, voice: str):
        """Yield raw 24 kHz PCM16 pieces for one sentence. Raises HDUnavailable before the first piece on any failure
        or slowness. Closing the generator early cancels the sentence in the sidecar."""
        loop, q = asyncio.get_running_loop(), asyncio.Queue()
        with self.lock:
            ident = self.next_id
            self.next_id += 1
            self.waiters[ident] = (loop, q)
            self.active += 1
            self.last_used = time.monotonic()
        finished = False
        try:
            self._send({"op": "say", "id": ident, "text": text, "voice": voice})
            started = sounded = False
            while True:
                wait = FIRST_AUDIO_TIMEOUT if started and not sounded else (START_TIMEOUT if not started else 30.0)
                try:
                    header, payload = await asyncio.wait_for(q.get(), wait)
                except asyncio.TimeoutError as error:
                    raise HDUnavailable("HD voice was too slow, so Kokoro spoke instead.") from error
                kind = header.get("type")
                if kind == "start":
                    started = True
                elif kind == "audio":
                    sounded = True
                    yield payload
                elif kind == "end":
                    finished = True
                    return
                elif kind == "error":
                    finished = True
                    raise HDUnavailable(header.get("message") or "HD voice could not speak.")
        finally:
            with self.lock:
                self.waiters.pop(ident, None)
                self.active -= 1
                self.last_used = time.monotonic()
            if not finished:
                try:
                    self._send({"op": "cancel", "id": ident})
                except HDUnavailable:
                    pass


_sidecar = _Sidecar()
atexit.register(_sidecar.stop)


def stop() -> None:
    _sidecar.stop()


# -- edge trim and the stream the speakers use -------------------------------------------------------------------------

class EdgeTrim:
    """Streaming edge trim for PCM16 at 24 kHz. Qwen3-TTS pads each sentence with near-silence (the bake-off measured
    0.2 to 0.44 s before and about 0.46 s after); in a sentence-by-sentence pipeline that is close to a second of dead
    air between sentences. Leading quiet is dropped down to LEAD margin before the first sound; quiet audio is held
    back and released only when sound follows (so pauses inside the sentence stay), and at the end only TAIL of it is
    kept. A 10 ms frame is sound when its loudness is above THRESHOLD_DB (full scale)."""

    FRAME = 240
    THRESHOLD_DB = -50.0
    LEAD = 0.03
    TAIL = 0.08

    def __init__(self):
        import numpy as np
        self.np = np
        self.threshold = 32768.0 * 10 ** (self.THRESHOLD_DB / 20)
        self.pending = b""            # less than a frame, not judged yet
        self.held = bytearray()       # quiet frames since the last sound (or the start)
        self.heard = False
        self.cut_lead = self.cut_tail = 0

    def _loud(self, frame: bytes) -> bool:
        samples = self.np.frombuffer(frame, dtype="<i2").astype(self.np.float32)
        return float(self.np.sqrt((samples * samples).mean())) >= self.threshold

    def feed(self, data: bytes) -> bytes:
        data = self.pending + data
        size = self.FRAME * 2
        whole = len(data) - len(data) % size
        self.pending = data[whole:]
        out = bytearray()
        for at in range(0, whole, size):
            frame = data[at:at + size]
            if self._loud(frame):
                if not self.heard:
                    keep = int(self.LEAD * SAMPLE_RATE) * 2
                    self.cut_lead = (len(self.held) - min(keep, len(self.held))) // 2
                    out += self.held[-keep:] if keep else b""
                    self.heard = True
                else:
                    out += self.held
                self.held.clear()
                out += frame
            else:
                self.held += frame
        return bytes(out)

    def finish(self) -> bytes:
        tail = bytes(self.held) + self.pending
        if not self.heard:
            return tail                               # all quiet: leave it alone
        keep = int(self.TAIL * SAMPLE_RATE) * 2
        self.cut_tail = (len(tail) - min(keep, len(tail))) // 2
        return tail[:keep]


def speakable(text: str) -> str:
    """The person's respellings applied as text (Qwen3-TTS has no phoneme input): "Siobhan" -> "Shivawn"."""
    try:
        from core import pronunciations
        entries = [i for i in pronunciations.items() if i.get("say") and not i.get("typed")]
    except Exception:
        return text
    for entry in entries:
        said = re.sub(r"[^A-Za-z']", "", str(entry["say"])).lower()
        if not said:
            continue
        said = said[:1].upper() + said[1:]
        text = re.sub(rf"(?<![\w']){re.escape(entry['word'])}(?!\w)", said, text, flags=re.I)
    return text


def voice_for(requested: str | None, fallback: str | None = None) -> str:
    if requested in VOICE_IDS:
        return requested
    if fallback in VOICE_IDS:
        return fallback
    return DEFAULT_VOICE


async def warm(voice: str | None = None) -> bool:
    """Load the model now (a call or Open Mic is starting). Never raises; False when it cannot."""
    if not ready()[0]:
        return False
    try:
        await _sidecar.load(voice if voice in VOICE_IDS else voice_for(None, _account_voice()))
        return True
    except Exception as error:
        logger.info("hd voice: warm-up failed: %s", error)
        return False


def _account_voice() -> str:
    try:
        from core import call_voices
        return call_voices.stored().get("hd_voice") or DEFAULT_VOICE
    except Exception:
        return DEFAULT_VOICE


_warming: set = set()


async def stream(text: str, voice: str | None = None):
    """One sentence as {'sample_rate'} then {'audio'} items, like every other engine in core/call_voices.py.
    Raises HDUnavailable before any audio when HD cannot speak it now: the caller falls back to Kokoro. When the model
    is not loaded yet, that is the answer for this sentence (loading takes seconds) and loading starts in the
    background, so the next sentences are in HD."""
    ok, reason = ready()
    if not ok:
        raise HDUnavailable(reason or "HD voice is not ready")
    wanted = voice_for(voice, _account_voice())
    if not _sidecar.warm_kind(wanted):
        if not _sidecar.loading:
            task = asyncio.ensure_future(warm(wanted))
            _warming.add(task)
            task.add_done_callback(_warming.discard)
        raise HDUnavailable("HD voice is still loading, so Kokoro speaks for now.")
    trim = EdgeTrim()
    said = False
    pieces = _sidecar.say(speakable(text), wanted)
    try:
        async for data in pieces:
            out = trim.feed(data)
            if out:
                if not said:
                    yield {"sample_rate": SAMPLE_RATE}
                    said = True
                yield {"audio": out}
        out = trim.finish()
        if out:
            if not said:
                yield {"sample_rate": SAMPLE_RATE}
                said = True
            yield {"audio": out}
    finally:
        await pieces.aclose()


async def preview(voice: str) -> bytes:
    """A short WAV of `voice` for the Settings picker (loads the model if needed, so the first one takes seconds)."""
    import io
    import wave
    ok, reason = ready()
    if not ok:
        raise HDUnavailable(reason or "HD voice is not ready")
    wanted = voice_for(voice)
    await _sidecar.load(wanted)
    pcm = bytearray()
    trim = EdgeTrim()
    async for data in _sidecar.say(PREVIEW_TEXT, wanted):
        pcm += trim.feed(data)
    pcm += trim.finish()
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(bytes(pcm))
    return buffer.getvalue()
