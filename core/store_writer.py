"""Coalesced, off-loop saves for the busiest JSON stores (tasks.json and task_runs.json).

Why (100-bot scale test, 2026-11-10): one routine run rewrote tasks.json and task_runs.json about ten times,
each a full pretty-printed rewrite on the event loop (task_runs.json reaches 2.4 MB with a month of history),
and 100 routines due in one minute froze the app for up to 45 s.

How: a save made on the event loop marks the store dirty and returns. Within COALESCE_SECONDS the loop encodes
the latest state once (the C encoder, compact: tens of milliseconds for the biggest store, and consistent,
since it runs between two loop steps) and hands the bytes to one background thread, which writes them
atomically (a temp file, then os.replace). However many saves arrived in that window, the store is encoded and
written once. A save made off the loop (a worker thread, a test, a script) encodes and writes at once, as before.

Every write carries a sequence number taken when its bytes were encoded; an older write never lands over a
newer one. flush() writes whatever is waiting, now, on the calling thread; a store being reloaded from disk
and the backup flush first, and the process flushes at shutdown and at exit.
"""
from __future__ import annotations

import asyncio
import atexit
import itertools
import json
import logging
import os
import tempfile
import threading
from typing import Any, Callable, Optional

from core.atomic_io import _replace

logger = logging.getLogger(__name__)

COALESCE_SECONDS = 0.25
ENABLED = True  # tests may switch it off to keep every save synchronous

_lock = threading.Lock()
_wake = threading.Condition(_lock)
_seq = itertools.count(1)
_dirty: dict[str, tuple[Callable[[], Any], asyncio.AbstractEventLoop]] = {}  # waiting to be encoded on the loop
_pending: dict[str, tuple[int, bytes]] = {}  # encoded, waiting for the writer thread
_writing: set[str] = set()
_written: dict[str, int] = {}
_path_locks: dict[str, threading.Lock] = {}
_thread: Optional[threading.Thread] = None


def encode(data: Any) -> bytes:
    """Compact JSON through the C encoder (indent= forces the pure-Python one: 31 ms against 9 ms for 3,200 runs)."""
    return json.dumps(data, separators=(",", ":")).encode("utf-8")


def save(path: str, producer: Callable[[], Any]) -> None:
    """Persist producer() to path: soon and off the loop when called on the event loop, else now."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is None or not ENABLED:
        _write(path, next(_seq), encode(producer()), create=True)
        return
    with _lock:
        held = _dirty.get(path)
        _dirty[path] = (producer, loop)
    # One timer per window. A timer left on a loop that has since closed (asyncio.run in a test) never fires,
    # so a save on another loop always arms its own.
    if held is None or held[1] is not loop or loop.is_closed():
        loop.call_later(COALESCE_SECONDS, _encode_dirty, path)


def _encode_dirty(path: str) -> None:
    """On the loop: encode the latest state once and hand it to the writer thread."""
    with _lock:
        held = _dirty.pop(path, None)
    if held is None:
        return
    try:
        seq, body = next(_seq), encode(held[0]())
    except Exception:
        logger.exception("could not encode %s", path)
        return
    _hand_off(path, seq, body)


def _hand_off(path: str, seq: int, body: bytes) -> None:
    global _thread
    with _wake:
        old = _pending.get(path)
        if old is None or old[0] < seq:
            _pending[path] = (seq, body)
        if _thread is None or not _thread.is_alive():
            _thread = threading.Thread(target=_run, name="store-writer", daemon=True)
            _thread.start()
        _wake.notify_all()


def _run() -> None:
    while True:
        with _wake:
            while not _pending:
                _wake.wait()
            path, (seq, body) = _pending.popitem()
            _writing.add(path)
        try:
            _write(path, seq, body)
        except Exception:
            logger.exception("could not save %s", path)
        finally:
            with _wake:
                _writing.discard(path)
                _wake.notify_all()


def _path_lock(path: str) -> threading.Lock:
    with _lock:
        return _path_locks.setdefault(os.path.normcase(os.path.abspath(path)), threading.Lock())


def _write(path: str, seq: int, body: bytes, create: bool = False) -> None:
    """create: make the folder if it is missing (a save made now). A late background write never re-creates a
    folder that was removed in the meantime (a finished test's, a deleted account's)."""
    key = os.path.normcase(os.path.abspath(path))
    with _path_lock(path):
        if _written.get(key, 0) > seq:
            return  # a newer state already landed
        directory = os.path.dirname(path) or "."
        if create:
            os.makedirs(directory, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp_", suffix=".json")
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(body)
            _replace(tmp, path)
        except Exception:
            if os.path.exists(tmp):
                os.remove(tmp)
            raise
        _written[key] = seq


def flush(path: Optional[str] = None, timeout: float = 30.0) -> None:
    """Write what is waiting (one store, or all), on this thread, and wait for any write in progress. Call it on
    the loop's thread or with the loop stopped: the state is read from the store's own objects."""
    key = os.path.normcase(os.path.abspath(path)) if path else None

    def wanted(name: str) -> bool:
        return key is None or os.path.normcase(os.path.abspath(name)) == key

    with _lock:
        dirty = [(name, held) for name, held in _dirty.items() if wanted(name)]
        for name, _ in dirty:
            _dirty.pop(name, None)
        pending = [(name, item) for name, item in _pending.items() if wanted(name)]
        for name, _ in pending:
            _pending.pop(name, None)
    for name, (seq, body) in pending:
        _write(name, seq, body)
    for name, (producer, _) in dirty:
        _write(name, next(_seq), encode(producer()), create=True)
    with _wake:
        _wake.wait_for(lambda: not any(wanted(name) for name in _writing), timeout)


async def landed(*paths: str, timeout: float = 30.0) -> None:
    """Wait, without holding the loop, until what was saved to these stores is on disk: whatever waits is encoded
    now and written by the background writer. A run awaits this before its model work starts, so its claim and
    its run record are durable first, as when every save was written at once."""
    for path in paths:
        with _lock:
            held = _dirty.pop(path, None)
        if held is not None:
            _hand_off(path, next(_seq), encode(held[0]()))
    keys = {os.path.normcase(os.path.abspath(path)) for path in paths}

    def busy() -> bool:
        return any(os.path.normcase(os.path.abspath(name)) in keys for name in (*_pending, *_writing))

    def wait() -> None:
        with _wake:
            _wake.wait_for(lambda: not busy(), timeout)
    with _lock:
        if not busy():
            return
    await asyncio.to_thread(wait)


def waiting() -> bool:
    with _lock:
        return bool(_dirty or _pending or _writing)


def _at_exit() -> None:
    try:
        flush()
    except Exception:
        logger.exception("could not flush stores at exit")


atexit.register(_at_exit)
