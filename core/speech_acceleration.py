"""Optional, explicitly registered whisper.cpp CUDA runtime owned by Kairos.

No discovery, downloads, shell commands or connection to Voice-line's server.
Only an administrator can register a trusted installation. Its executable and
DLL hashes are checked before starting a private loopback child process.
Callers serialize operations with speech_routes' engine lock.
"""
import atexit
import hashlib
import io
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import threading
import time
import wave

import httpx

from core.constants import DATA_DIR

CONFIG = Path(DATA_DIR) / 'speech_runtime.json'
_process = None
_model = None
_port = None
_gpu = threading.Event()
_verified = None
_failed = None
_job = None


def _own_process(child):
    """Kill this child even if Electron force-terminates its Python parent."""
    global _job
    if os.name != 'nt':
        return
    import ctypes as c
    from ctypes import wintypes as w
    class Basic(c.Structure):
        _fields_ = [('process_time', c.c_int64), ('job_time', c.c_int64), ('flags', w.DWORD),
                    ('min_working', c.c_size_t), ('max_working', c.c_size_t), ('active_limit', w.DWORD),
                    ('affinity', c.c_size_t), ('priority', w.DWORD), ('scheduling', w.DWORD)]
    class IO(c.Structure):
        _fields_ = [(key, c.c_uint64) for key in ('read_ops','write_ops','other_ops','read_bytes','write_bytes','other_bytes')]
    class Limits(c.Structure):
        _fields_ = [('basic', Basic), ('io', IO), ('process_memory', c.c_size_t), ('job_memory', c.c_size_t),
                    ('peak_process', c.c_size_t), ('peak_job', c.c_size_t)]
    api = c.WinDLL('kernel32', use_last_error=True)
    api.CreateJobObjectW.argtypes = [c.c_void_p, w.LPCWSTR]; api.CreateJobObjectW.restype = w.HANDLE
    api.SetInformationJobObject.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD]; api.SetInformationJobObject.restype = w.BOOL
    api.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]; api.AssignProcessToJobObject.restype = w.BOOL
    api.CloseHandle.argtypes = [w.HANDLE]; api.CloseHandle.restype = w.BOOL
    handle = api.CreateJobObjectW(None, None)
    limits = Limits(); limits.basic.flags = 0x2000  # KILL_ON_JOB_CLOSE
    if not handle:
        raise OSError('Could not own the GPU recognition process')
    if not api.SetInformationJobObject(handle, 9, c.byref(limits), c.sizeof(limits)) or not api.AssignProcessToJobObject(handle, child._handle):
        api.CloseHandle(handle)
        raise OSError('Could not own the GPU recognition process')
    _job = (api, handle)


def _read():
    try:
        value = json.loads(CONFIG.read_text(encoding='utf-8'))
        if value.get('version') == 1 and isinstance(value.get('folder'), str) and isinstance(value.get('files'), dict):
            return value
    except (OSError, ValueError, AttributeError):
        pass
    return None


def status():
    return {'supported': os.name == 'nt', 'configured': bool(_read()),
            'running': bool(_process and _process.poll() is None and _gpu.is_set())}


def _files(folder):
    if not folder.is_absolute() or not folder.is_dir():
        raise ValueError('Choose an installed whisper.cpp CUDA folder on this computer.')
    files = [p for p in folder.iterdir() if p.name.lower() == 'whisper-server.exe' or p.suffix.lower() == '.dll']
    if not any(p.name == 'whisper-server.exe' for p in files) or not any(p.name == 'ggml-cuda.dll' for p in files):
        raise ValueError('The folder needs whisper-server.exe, ggml-cuda.dll and its accompanying DLLs.')
    if len(files) > 100 or any(p.is_symlink() or not p.is_file() for p in files) or sum(p.stat().st_size for p in files) > 2_000_000_000:
        raise ValueError('That runtime folder is unsupported. Choose an extracted whisper.cpp CUDA release.')
    return files


def _hash(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def register(folder):
    global _verified, _failed
    if os.name != 'nt':
        raise ValueError('This optional CUDA runtime is available on Windows. Built-in recognition remains available.')
    root = Path(folder).expanduser()
    files = _files(root)
    manifest = {p.name: _hash(p) for p in files}
    value = {'version': 1, 'folder': str(root.resolve()), 'files': manifest}
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    temporary = CONFIG.with_suffix('.tmp')
    temporary.write_text(json.dumps(value), encoding='utf-8')
    os.replace(temporary, CONFIG)
    stop(); _verified = None; _failed = None
    return status()


def unregister():
    global _verified, _failed
    stop(); CONFIG.unlink(missing_ok=True); _verified = None; _failed = None
    return status()


def stop():
    global _process, _model, _port, _job
    child = _process
    _process = None; _model = None; _port = None; _gpu.clear()
    if child:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill(); child.wait(timeout=3)
        if child.stdout:
            child.stdout.close()
    if _job:
        api, handle = _job; api.CloseHandle(handle); _job = None


def _observe(child, ready):
    # whisper.cpp prints recognized words. Discard output; retain only whether
    # its startup actually selected CUDA, never audio or transcript content.
    try:
        for line in child.stdout:
            if re.search(r'using CUDA\d* backend', line, re.I):
                ready.set()
    except (OSError, ValueError):
        pass


def prepare(model_path):
    global _process, _model, _port, _verified, _failed, _gpu
    config = _read()
    if not config:
        raise ValueError('No GPU runtime is configured. Using built-in CPU recognition.')
    if _failed:
        raise ValueError(_failed)
    if _process and _process.poll() is None and _model == str(model_path) and _gpu.is_set():
        return
    stop()
    try:
        root = Path(config['folder'])
        files = _files(root)
        stamps = tuple(sorted((p.name, p.stat().st_size, p.stat().st_mtime_ns) for p in files))
        signature = (str(root), stamps, tuple(sorted(config['files'].items())))
        if _verified != signature:
            if {p.name: _hash(p) for p in files} != config['files']:
                raise ValueError('The GPU runtime files changed. Select the trusted runtime folder again.')
            _verified = signature
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
        child = _process = subprocess.Popen(
            [str(root / 'whisper-server.exe'), '-m', str(model_path), '--host', '127.0.0.1', '--port', str(port),
             '-l', 'en', '-t', '4', '-bo', '2', '-bs', '-1'],
            cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding='utf-8', errors='replace', creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        ready = _gpu = threading.Event()
        _own_process(child)
        threading.Thread(target=_observe, args=(child, ready), daemon=True).start()
        deadline = time.monotonic() + 30
        with httpx.Client(timeout=.5, trust_env=False) as client:
            while time.monotonic() < deadline and child.poll() is None:
                if ready.is_set():
                    try:
                        if client.get(f'http://127.0.0.1:{port}/health').is_success:
                            # Initialize CUDA kernels before Listening, using
                            # silence rather than a user's first sentence.
                            warm = io.BytesIO()
                            with wave.open(warm, 'wb') as wav:
                                wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000); wav.writeframes(bytes(16000))
                            with httpx.Client(timeout=15, trust_env=False) as warming:
                                warming.post(f'http://127.0.0.1:{port}/inference', files={'file': ('warmup.wav', warm.getvalue(), 'audio/wav')}, data={'response_format': 'json'}).raise_for_status()
                            _model = str(model_path); _port = port
                            return
                    except httpx.HTTPError:
                        pass
                time.sleep(.1)
        raise ValueError('GPU recognition could not start on this device. Using built-in CPU recognition.')
    except Exception as error:
        stop()
        _failed = str(error) if isinstance(error, ValueError) else 'GPU recognition is unavailable. Using built-in CPU recognition.'
        raise ValueError(_failed) from error


def transcribe(audio, model_path):
    global _failed
    prepare(model_path)
    try:
        with httpx.Client(timeout=90, trust_env=False) as client:
            result = client.post(f'http://127.0.0.1:{_port}/inference',
                                 files={'file': ('audio.wav', audio, 'audio/wav')},
                                 data={'response_format': 'json'})
            result.raise_for_status()
            text = result.json().get('text')
            if not isinstance(text, str):
                raise ValueError('Invalid recognition response')
            return text
    except Exception as error:
        stop(); _failed = 'GPU recognition stopped. Using built-in CPU recognition.'
        raise ValueError(_failed) from error


atexit.register(stop)
