"""Git object checkpoints around model turns, independent of a user's Git repo.

Each watched root has a bare object store in JARVIS data. A turn records a
before commit before the model starts and an after commit even if it fails.
No Git executable is needed in the packaged app.
"""
import asyncio
import difflib
import hashlib
import json
import logging
import os
from pathlib import Path
import stat as stat_mod
import subprocess
import tempfile
import threading
import time
import uuid
import zlib
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

from core.constants import BASE_DIR, DATA_DIR
from core.vault import resolve_vault_dir

logger = logging.getLogger(__name__)
STORE = None  # override (tests); else the current account's file_checkpoints folder


def store() -> Path:
    from core import accounts
    return Path(STORE or accounts.path("file_checkpoints"))


MAX_FILE = 50 * 1024 * 1024
MAX_TOTAL = 300 * 1024 * 1024
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist"}
GIT_TIMEOUT = 20
# Hash cache: a file whose (size, mtime_ns, inode) is unchanged since it was last
# stored reuses its blob id instead of being read again. Like Git's racy-timestamp
# rule, files modified within RACY_NS of the snapshot are always re-read, and every
# FULL_REHASH_SECONDS the whole root is re-read so a missed in-place edit that kept
# size and mtime can survive at most that long.
RACY_NS = 2_000_000_000
FULL_REHASH_SECONDS = 600
_seen: dict[str, dict[str, tuple[int, int, int, str]]] = {}
_full_at: dict[str, float] = {}
_seen_lock = threading.Lock()


class Conflict(Exception):
    pass


def _atomic_write(path: Path, data: bytes, *, same_if_present: bool = False) -> None:
    """Write through a temp file. Turns running at once (a burst of bot routines) write the same objects and
    the same new repository's HEAD: on Windows the second os.replace onto a file the first is placing fails
    with access denied (WinError 5, 100-bot scale test, 2026-11-10). `same_if_present`: the content is fixed
    by the name (an object, or HEAD and config), so a target that is already there is the same write."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as tmp:
        tmp.write(data)
        name = tmp.name
    for attempt in range(10):
        try:
            os.replace(name, path)
            return
        except PermissionError:
            if same_if_present and path.exists():
                break
            if attempt == 9:
                _discard(name)
                raise
            time.sleep(0.05)
    _discard(name)


def _discard(name: str) -> None:
    try:
        os.remove(name)
    except OSError:
        pass


def _repo(root: Path) -> Path:
    key = hashlib.sha256(os.path.normcase(str(root)).encode()).hexdigest()
    repo = store() / "repos" / key
    if not (repo / "HEAD").exists():
        _atomic_write(repo / "HEAD", b"ref: refs/heads/checkpoints\n")
        _atomic_write(repo / "config", b"[core]\n\trepositoryformatversion = 0\n\tbare = true\n")
    return repo


def _object(repo: Path, kind: str, body: bytes) -> str:
    raw = f"{kind} {len(body)}\0".encode() + body
    oid = hashlib.sha1(raw).hexdigest()
    target = repo / "objects" / oid[:2] / oid[2:]
    if not target.exists():
        _atomic_write(target, zlib.compress(raw), same_if_present=True)
    return oid


def _read_object(repo: Path, oid: str) -> tuple[str, bytes]:
    if len(oid) != 40 or any(c not in "0123456789abcdef" for c in oid):
        raise ValueError("invalid object id")
    raw = zlib.decompress((repo / "objects" / oid[:2] / oid[2:]).read_bytes())
    header, body = raw.split(b"\0", 1)
    kind, size = header.split(b" ", 1)
    if len(body) != int(size) or hashlib.sha1(raw).hexdigest() != oid:
        raise ValueError("corrupt checkpoint object")
    return kind.decode(), body


def _kill_tree(process) -> None:
    if os.name == "nt":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(process.pid)],
                       capture_output=True, timeout=5, check=False)
    else:
        process.kill()


def _git_paths(root: Path) -> list[str] | None:
    if not (root / ".git").exists():
        return None
    # Git must not inherit the app's stdin: a pending read on it held Git for Windows'
    # real git.exe before main() for a minute. On timeout the whole tree goes, since
    # killing only the git.exe launcher left the real one holding the output pipes.
    try:
        process = subprocess.Popen(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                                   cwd=root, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError:
        return None
    try:
        stdout, _ = process.communicate(timeout=GIT_TIMEOUT)
    except subprocess.TimeoutExpired:
        _kill_tree(process)
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        return None
    if process.returncode:
        return None
    return [os.fsdecode(p) for p in stdout.split(b"\0") if p]


def _files(root: Path):
    listed = _git_paths(root)
    if listed is not None:
        for name in listed:
            if SKIP_DIRS.isdisjoint(name.replace("\\", "/").split("/")):
                yield name
        return
    for folder, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS
                   and not (Path(folder) / d).is_symlink()
                   and not (root == Path(BASE_DIR).resolve() and
                            ((Path(folder) == root and d == "data") or
                             (Path(folder) == root / "electron" and d == "runtime")))
                   and not (Path(folder) / d).resolve().is_relative_to(store().resolve())]
        for file in files:
            if file == ".git":
                continue
            yield (Path(folder) / file).relative_to(root).as_posix()


def _lstat_all(root_str: str, names: list[str]) -> list:
    def one(name: str):
        try:
            return os.lstat(os.path.join(root_str, name))
        except OSError as exc:
            return exc
    if len(names) < 300:
        return [one(name) for name in names]
    with ThreadPoolExecutor(max_workers=8) as pool:
        return list(pool.map(one, names, chunksize=64))


def _blob_stored(stored: dict[str, set[str]], objects: str, oid: str) -> bool:
    """Whether the blob file exists, from one directory listing per id prefix per snapshot."""
    names = stored.get(oid[:2])
    if names is None:
        try:
            names = set(os.listdir(os.path.join(objects, oid[:2])))
        except OSError:
            names = set()
        stored[oid[:2]] = names
    return oid[2:] in names


def _snapshot(root: Path) -> tuple[str, dict[str, str], list[str]]:
    repo = _repo(root)
    key = os.path.normcase(str(root))
    start_ns = time.time_ns()
    now = time.monotonic()
    with _seen_lock:
        full = now - _full_at.get(key, float("-inf")) >= FULL_REHASH_SECONDS
        if full:
            _full_at[key] = now
        cache = {} if full else _seen.get(key, {})
    fresh: dict[str, tuple[int, int, int, str]] = {}
    manifest: dict[str, str] = {}
    skipped: list[str] = []
    safe_parents: dict[str, bool] = {}
    stored: dict[str, set[str]] = {}
    objects = os.fspath(repo / "objects")
    root_str = os.fspath(root)
    total = 0
    names = list(_files(root))
    # lstat is the floor cost per file and releases the GIL, so a big tree is stat'ed in parallel.
    infos = _lstat_all(root_str, names)
    for name, info in zip(names, infos):
        path = os.path.join(root_str, name)
        try:
            if isinstance(info, OSError):
                raise info
            if not stat_mod.S_ISREG(info.st_mode):
                continue
            parent = os.path.dirname(name)
            if parent not in safe_parents:
                safe_parents[parent] = (root / parent).resolve().is_relative_to(root)
            if not safe_parents[parent]:
                continue
            size = info.st_size
            if size > MAX_FILE or total + size > MAX_TOTAL:
                skipped.append(name)
                continue
            posix = name.replace("\\", "/")
            stamp = (size, info.st_mtime_ns, info.st_ino)
            hit = cache.get(posix)
            if hit and hit[:3] == stamp and _blob_stored(stored, objects, hit[3]):
                total += size
                manifest[posix] = hit[3]
                fresh[posix] = hit
                continue
            with open(path, "rb") as handle:
                body = handle.read()
            total += len(body)
            oid = _object(repo, "blob", body)
            manifest[posix] = oid
            if len(body) == size and info.st_mtime_ns < start_ns - RACY_NS:
                fresh[posix] = (*stamp, oid)
        except FileNotFoundError:
            continue
        except (OSError, ValueError) as exc:
            skipped.append(name)
            logger.warning("checkpoint skipped %s: %s", path, exc)
    with _seen_lock:
        _seen[key] = fresh
    return _tree(repo, manifest), manifest, skipped


def _tree(repo: Path, items: dict[str, str]) -> str:
    entries: dict[str, dict[str, str] | str] = {}
    for name, oid in items.items():
        parts = name.split("/")
        branch = entries
        for part in parts[:-1]:
            branch = branch.setdefault(part, {})  # type: ignore[assignment]
        branch[parts[-1]] = oid
    def encode(branch: dict) -> str:
        out = bytearray()
        for name, value in sorted(branch.items(), key=lambda pair: pair[0].encode() + (b"/" if isinstance(pair[1], dict) else b"")):
            is_dir = isinstance(value, dict)
            child = encode(value) if is_dir else value
            out.extend(("40000" if is_dir else "100644").encode() + b" " + name.encode() + b"\0" + bytes.fromhex(child))
        return _object(repo, "tree", bytes(out))
    return encode(entries)


def _commit(repo: Path, tree_oid: str, event_id: str, phase: str) -> str:
    stamp = int(time.time())
    body = (f"tree {tree_oid}\nauthor JARVIS <jarvis@localhost> {stamp} +0000\n"
            f"committer JARVIS <jarvis@localhost> {stamp} +0000\n\n"
            f"{event_id} {phase}\n").encode()
    oid = _object(repo, "commit", body)
    _atomic_write(repo / "refs" / "checkpoints" / event_id / phase, f"{oid}\n".encode())
    return oid


def _event_path(event_id: str) -> Path:
    if len(event_id) != 32 or any(c not in "0123456789abcdef" for c in event_id):
        raise KeyError(event_id)
    return store() / "events" / f"{event_id}.json"


def _save(event: dict) -> None:
    _atomic_write(_event_path(event["id"]), json.dumps(event, ensure_ascii=False).encode())


def _app_folder(root: Path, vault: Path) -> bool:
    """The app's own source or data, or a folder holding either. The chosen vault is never one, even when it
    sits in the data folder (the default vault does)."""
    if root == vault:
        return False
    source, data = Path(BASE_DIR).resolve(), Path(DATA_DIR).resolve()
    if any(root == app or app.is_relative_to(root) for app in (source, data)):
        return True
    return root.is_relative_to(source) or root.is_relative_to(data)


def _bot_roots(workspace: str | None) -> list[Path]:
    """A bot's turn changes only its working folder: the conversation's workspace, else the vault (the folder its
    file tools are fenced to, core/brain.py fence_roots). Never the app's own source or data: a bot turn in a
    source checkout snapshotted the whole tree, 418 MB and 27,000 files after 150 turns (100-bot scale test,
    2026-11-10). A bot's own folder and generated files live in the data folder and are not checkpointed."""
    vault = Path(resolve_vault_dir()).resolve()
    folder = Path(workspace).resolve() if workspace else vault
    return [folder] if folder.is_dir() and not _app_folder(folder, vault) else []


def _roots(workspace: str | None = None, bot: bool = False) -> list[Path]:
    if bot:
        return _bot_roots(workspace)
    roots = [Path(resolve_vault_dir()).resolve()]
    source_root = Path(BASE_DIR).resolve()
    if (source_root / ".git").exists() and source_root not in roots:
        roots.append(source_root)
    if workspace:
        folder = Path(workspace).resolve()
        if folder not in roots:
            roots.append(folder)
    return [root for root in roots if root.is_dir()]


def _snapshot_all(roots: list[Path]) -> list[tuple[str, dict[str, str], list[str]]]:
    if len(roots) < 2:
        return [_snapshot(root) for root in roots]
    with ThreadPoolExecutor(max_workers=len(roots)) as pool:
        return list(pool.map(_snapshot, roots))


def _start(source: str, workspace: str | None, bot: bool = False) -> dict | None:
    roots = _roots(workspace, bot)
    if bot and not roots:
        return None  # nothing this bot turn can change is watched (no working folder outside the app's own)
    event = {"id": uuid.uuid4().hex, "created": time.time(), "source": source,
             "status": "running", "roots": []}
    for root, (tree, manifest, skipped) in zip(roots, _snapshot_all(roots)):
        repo = _repo(root)
        event["roots"].append({"path": str(root), "before": _commit(repo, tree, event["id"], "before"),
                               "before_files": manifest, "before_skipped": skipped})
    _save(event)
    return event


def _finish(event: dict) -> None:
    changed = False
    snapshots = _snapshot_all([Path(info["path"]) for info in event["roots"]])
    for root_info, (tree, manifest, skipped) in zip(event["roots"], snapshots):
        root = Path(root_info["path"])
        root_info["after"] = _commit(_repo(root), tree, event["id"], "after")
        before = root_info.pop("before_files")
        root_info["created_unprotected"] = [name for name in skipped
                                             if name not in before and name not in root_info["before_skipped"]]
        unavailable = set(root_info["before_skipped"]) | set(skipped)
        root_info["changes"] = [{"path": name, "before": before.get(name), "after": manifest.get(name)}
                                for name in sorted(before.keys() | manifest.keys())
                                if name not in unavailable and before.get(name) != manifest.get(name)]
        root_info["after_skipped"] = skipped
        changed |= bool(root_info["changes"] or root_info["created_unprotected"])
    event["status"] = "changed" if changed else "unchanged"
    event["finished"] = time.time()
    _save(event)
    if changed and event["source"].startswith("chat:"):
        try:
            from core import chat_files
            chat_files.record_checkpoint(event)
        except Exception:
            logger.exception("could not index files from checkpoint %s", event["id"])


@asynccontextmanager
async def around_turn(source: str, workspace: str | None = None, *, bot: bool = False):
    """Snapshot the turn's roots without making a checkpoint failure break a chat. `bot`: a bot's turn (chat,
    routine, card or goal), which watches only its working folder (_bot_roots)."""
    event = None
    try:
        event = await asyncio.to_thread(_start, source, workspace, bot)
    except Exception:
        logger.exception("could not start file checkpoint for %s", source)
    try:
        yield
    finally:
        if event is not None:
            try:
                finish = asyncio.create_task(asyncio.to_thread(_finish, event))
                try:
                    await asyncio.shield(finish)
                except asyncio.CancelledError:
                    await finish
                    raise
            except Exception:
                logger.exception("could not finish file checkpoint %s", event["id"])


def record_file_write(source: str, root: str, name: str, before: bytes | None, after: bytes, write) -> dict:
    """One person's own edit to one file (a Library save, 2026-10-22), kept
    as a checkpoint like a model turn so it shows in Settings > File
    checkpoints and the note's History, and restores the same way. The
    before image is stored and the event saved BEFORE `write` runs, so a
    crash mid-write still leaves the previous text recoverable."""
    root_path = Path(root).resolve()
    repo = _repo(root_path)
    name = name.replace("\\", "/")
    before_oid = _object(repo, "blob", before) if before is not None else None
    event = {"id": uuid.uuid4().hex, "created": time.time(), "source": source, "status": "running",
             "roots": [{"path": str(root_path), "before_skipped": []}]}
    root_info = event["roots"][0]
    root_info["before"] = _commit(repo, _tree(repo, {name: before_oid} if before_oid else {}), event["id"], "before")
    _save(event)
    try:
        write()
    except Exception:
        root_info.update(changes=[], after_skipped=[], created_unprotected=[])
        event.update(status="unchanged", finished=time.time(), error="The write failed; nothing changed.")
        _save(event)
        raise
    after_oid = _object(repo, "blob", after)
    root_info["after"] = _commit(repo, _tree(repo, {name: after_oid}), event["id"], "after")
    root_info.update(changes=[{"path": name, "before": before_oid, "after": after_oid}] if before_oid != after_oid else [],
                     after_skipped=[], created_unprotected=[])
    event["status"] = "changed" if root_info["changes"] else "unchanged"
    event["finished"] = time.time()
    _save(event)
    return event


def list_events(limit: int = 100, source: str | None = None) -> list[dict]:
    events = []
    for path in (store() / "events").glob("*.json"):
        try:
            event = json.loads(path.read_text(encoding="utf-8"))
            events.append({"id": event["id"], "created": event["created"], "finished": event.get("finished"),
                           "source": event["source"],
                           "status": event["status"], "roots": [{"path": r["path"], "changes": r.get("changes", []),
                           "skipped": sorted(set(r.get("before_skipped", [])) | set(r.get("after_skipped", [])))}
                           for r in event["roots"]]})
        except (OSError, ValueError, KeyError):
            logger.warning("invalid checkpoint record %s", path)
    recent = sorted((e for e in events if source is None or e['source'] == source),
                    key=lambda e: e['created'], reverse=True)[:limit]
    for event in recent:
        own_roots = {r["path"] for r in event["roots"]}
        event["overlap"] = any(other["id"] != event["id"]
                               and own_roots.intersection(r["path"] for r in other["roots"])
                               and event["created"] < (other["finished"] or float("inf"))
                               and other["created"] < (event["finished"] or float("inf"))
                               for other in events)
    return recent


def _load_event(event_id: str) -> dict:
    try:
        return json.loads(_event_path(event_id).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise KeyError(event_id) from exc


def _current_blob_oid(root: Path, name: str) -> str | None:
    path = root / name
    if not path.resolve().is_relative_to(root) or any(p.is_symlink() for p in [path, *path.parents] if p != root):
        raise Conflict(f"Unsafe path: {name}")
    if not path.exists():
        return None
    if not path.is_file():
        raise Conflict(f"Path is no longer a file: {name}")
    body = path.read_bytes()
    return hashlib.sha1(b"blob " + str(len(body)).encode() + b"\0" + body).hexdigest()


def get_event(event_id: str) -> dict:
    event = _load_event(event_id)
    for root_info in event["roots"]:
        root = Path(root_info["path"]).resolve()
        repo = _repo(root)
        for change in root_info.get("changes", []):
            try:
                current = _current_blob_oid(root, change["path"])
                change["restore_state"] = ("restored" if change.get("restored_at") else
                                           "available" if current == change["after"] else
                                           "at_before" if current == change["before"] else "changed_since")
            except (OSError, Conflict):
                change["restore_state"] = "changed_since"
            old = _read_object(repo, change["before"])[1] if change["before"] else b""
            new = _read_object(repo, change["after"])[1] if change["after"] else b""
            try:
                if max(len(old), len(new)) > 1024 * 1024:
                    change["diff"] = "File is too large to show a text diff."
                    continue
                a, b = old.decode("utf-8"), new.decode("utf-8")
                lines = list(difflib.unified_diff(a.splitlines(True), b.splitlines(True),
                             fromfile="before/" + change["path"], tofile="after/" + change["path"]))
                # Unit D totals describe this turn, even when its displayed
                # checkpoint diff hits the existing 2,000-line/100 KB cap.
                change["added"] = sum(line.startswith('+') for line in lines[2:])
                change["removed"] = sum(line.startswith('-') for line in lines[2:])
                change["diff"] = "".join(lines[:2000])[:100000]
            except UnicodeDecodeError:
                change["diff"] = "Binary file changed."
    return event


def restore(event_id: str, selections: list[dict]) -> list[dict]:
    """Restore selected paths only when each still equals its after image."""
    event = _load_event(event_id)
    if event["status"] != "changed":
        raise Conflict("This checkpoint has no completed changes.")
    chosen = []
    seen = set()
    for selection in selections:
        root_name, name = selection.get("root"), selection.get("path")
        if (root_name, name) in seen:
            raise Conflict("A file was selected twice.")
        seen.add((root_name, name))
        root_info = next((r for r in event["roots"] if r["path"] == root_name), None)
        change = next((c for c in (root_info or {}).get("changes", []) if c["path"] == name), None)
        if not root_info or not change:
            raise Conflict("Selected file is not in this checkpoint.")
        if change.get("restored_at"):
            raise Conflict(f"Already restored: {name}")
        root = Path(root_name).resolve()
        path = root / name
        repo = _repo(root)
        current = _current_blob_oid(root, name)
        if current != change["after"]:
            if current == change["before"]:
                raise Conflict(f"Already at previous state: {name}")
            raise Conflict(f"Changed since checkpoint: {name}")
        old = _read_object(repo, change["before"])[1] if change["before"] else None
        chosen.append((path, old, selection, change))
    for path, old, _, _ in chosen:
        if old is None:
            path.unlink()
        else:
            _atomic_write(path, old)
    for _, _, _, change in chosen:
        change["restored_at"] = time.time()
    try:
        _save(event)
    except OSError:
        logger.exception("files restored but checkpoint %s status could not be saved", event_id)
    return [selection for _, _, selection, _ in chosen]
