"""The notebook's files on disk (Bots Phase 2, unit U1; phase-2-design.md section 3.1).

One workspace per bot: `<DATA_DIR>/bot-workspaces/<bot_id>/`. Only the path shapes
below exist; everything else is refused before any file is touched. Callers never
write notebook files directly: they go through services/bot_memory.py, which uses
this module for the checked reads and the atomic writes.

    MEMORY.md                               the index (loaded each turn, clipped)
    memory/<topic>.md                       topic detail, 64 KiB
    memory/log/YYYY-MM-DD.md                daily outcomes (read-only in the UI)
    memory/archive.md                       expired and displaced entries
    skills/<name>/SKILL.md                  bot-private skill material (unit U3)
    skills/<name>/references/<topic>.md     reviewed supporting text (unit U3)

Safety rules, all enforced here: no absolute paths, traversal, backslashes, colons
(alternate data streams), case aliases, symlinks or Windows junctions inside the
workspace. Writes go to a unique temporary file in the same folder, are flushed and
fsynced, then replace the target.
"""
import hashlib
import os
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from core import constants

INDEX_NAME = "MEMORY.md"
ARCHIVE_PATH = "memory/archive.md"
INDEX_LOAD_LINES = 200
INDEX_LOAD_BYTES = 24_576
TOPIC_LIMIT_BYTES = 64 * 1024
WRITE_LIMIT_BYTES = 512 * 1024
ABSENT = "absent"

BOT_ID = re.compile(r"[0-9a-f]{10}")
TOPIC = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
SKILL_NAME = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
LOG_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")
# A topic may not take the name of a fixed file in the same folder.
RESERVED_TOPICS = ("archive", "log")
_WINDOWS_RESERVED = {"con", "prn", "aux", "nul", *(f"com{n}" for n in range(1, 10)), *(f"lpt{n}" for n in range(1, 10))}

KIND_INDEX, KIND_TOPIC, KIND_LOG, KIND_ARCHIVE, KIND_SKILL, KIND_REFERENCE = (
    "index", "topic", "log", "archive", "skill", "reference")


class NotebookError(ValueError):
    """A request the notebook refuses; the message is safe to show. `status` is the HTTP code a route uses."""
    status = 400

    @property
    def status_code(self) -> int:
        return self.status


class PathRefused(NotebookError):
    status = 400


class NotFound(NotebookError):
    status = 404


class StaleState(NotebookError):
    """The file changed since the caller read it (409)."""
    status = 409

    def __init__(self, message: str, current: Optional[dict] = None):
        super().__init__(message)
        self.current = current or {}


class CapacityError(NotebookError):
    """A write over a size limit (413). Nothing was written."""
    status = 413


class CapacityConflict(StaleState):
    """No safe room can be made for an entry; the document is unchanged (409)."""
    code = "capacity"


@dataclass(frozen=True)
class Target:
    path: str            # the clean relative path, '/'-separated
    kind: str
    limit: int           # write limit in bytes


def data_root() -> Path:
    return Path(constants.DATA_DIR)


def workspaces_root() -> Path:
    from core import accounts
    return Path(accounts.path("bot-workspaces"))


def state_root() -> Path:
    """Protected state (journal, snapshots, manifests): outside every model-writable root."""
    from core import accounts
    return Path(accounts.path("bot-memory-state"))


def check_bot_id(bot_id) -> str:
    if not isinstance(bot_id, str) or not BOT_ID.fullmatch(bot_id):
        raise NotebookError("bad bot id")
    return bot_id


def workspace(bot_id: str) -> Path:
    return workspaces_root() / check_bot_id(bot_id)


def state_dir(bot_id: str) -> Path:
    return state_root() / check_bot_id(bot_id)


def sha256(data: Optional[bytes]) -> str:
    return ABSENT if data is None else hashlib.sha256(data).hexdigest()


def classify(path) -> Target:
    """The shape a relative notebook path has, or PathRefused. Case-sensitive on purpose: `memory.md`
    is not `MEMORY.md`, so a case-insensitive disk can never hold two names for one document."""
    if not isinstance(path, str) or not path or len(path) > 200:
        raise PathRefused("that is not a notebook file")
    if path != path.strip() or "\\" in path or ":" in path or path.startswith("/") or "\x00" in path:
        raise PathRefused("that is not a notebook file")
    parts = path.split("/")
    if any(part in ("", ".", "..") or part.endswith((".", " ")) for part in parts):
        raise PathRefused("that is not a notebook file")
    if path == INDEX_NAME:
        return Target(path, KIND_INDEX, WRITE_LIMIT_BYTES)
    if path == ARCHIVE_PATH:
        return Target(path, KIND_ARCHIVE, WRITE_LIMIT_BYTES)
    if len(parts) == 2 and parts[0] == "memory" and parts[1].endswith(".md"):
        stem = parts[1][:-3]
        if TOPIC.fullmatch(stem) and stem.lower() not in RESERVED_TOPICS and stem.lower() not in _WINDOWS_RESERVED:
            return Target(path, KIND_TOPIC, TOPIC_LIMIT_BYTES)
    if len(parts) == 3 and parts[:2] == ["memory", "log"] and parts[2].endswith(".md") and LOG_DAY.fullmatch(parts[2][:-3]):
        return Target(path, KIND_LOG, WRITE_LIMIT_BYTES)
    if len(parts) == 3 and parts[0] == "skills" and parts[2] == "SKILL.md" and SKILL_NAME.fullmatch(parts[1]):
        return Target(path, KIND_SKILL, 256 * 1024)
    if (len(parts) == 4 and parts[0] == "skills" and SKILL_NAME.fullmatch(parts[1]) and parts[2] == "references"
            and parts[3].endswith(".md") and TOPIC.fullmatch(parts[3][:-3])):
        return Target(path, KIND_REFERENCE, 64 * 1024)
    raise PathRefused("that is not a notebook file")


def topic_path(topic: str) -> str:
    if not isinstance(topic, str) or not TOPIC.fullmatch(topic) or topic.lower() in RESERVED_TOPICS:
        raise PathRefused("a topic name uses letters, numbers, _ or - (and is not 'archive' or 'log')")
    return classify(f"memory/{topic}.md").path


def is_reparse(path: Path) -> bool:
    """A symlink, or on Windows a junction or other reparse point."""
    try:
        if path.is_symlink():
            return True
        attributes = getattr(os.lstat(path), "st_file_attributes", 0)
        return bool(attributes & 0x400)   # FILE_ATTRIBUTE_REPARSE_POINT
    except FileNotFoundError:
        return False
    except OSError:
        return True


def _walk_checked(bot_id: str, target: Target) -> Path:
    """The absolute path for a target, after checking every existing component below the data root:
    none may be a link or junction, and the result must stay inside the workspace."""
    root = workspace(bot_id)
    full = root.joinpath(*target.path.split("/"))
    for ancestor in (workspaces_root(), root, *[root.joinpath(*target.path.split("/")[:n]) for n in range(1, len(target.path.split("/")) + 1)]):
        if is_reparse(ancestor):
            raise PathRefused("that location is a link, which the notebook does not follow")
    try:
        resolved = full.resolve(strict=False)
        if root.resolve(strict=False) not in (resolved, *resolved.parents):
            raise PathRefused("that is not a notebook file")
    except (OSError, RuntimeError):
        raise PathRefused("that is not a notebook file")
    return full


def locate(bot_id: str, path: str) -> tuple[Target, Path]:
    target = classify(path)
    full = _walk_checked(bot_id, target)
    return target, full


def _exact_names(directory: Path) -> list[str]:
    try:
        return os.listdir(directory)
    except FileNotFoundError:
        return []


def check_case(full: Path) -> None:
    """Refuse a name that only differs in case from a different existing file (a Windows alias)."""
    names = _exact_names(full.parent)
    if full.name in names:
        return
    if any(name.lower() == full.name.lower() for name in names):
        raise PathRefused("a note with that name already exists in a different letter case")


def read_bytes(bot_id: str, path: str) -> Optional[bytes]:
    """The file's bytes, or None when it is not there."""
    _, full = locate(bot_id, path)
    names = _exact_names(full.parent)
    if full.name not in names:
        if any(name.lower() == full.name.lower() for name in names):
            raise PathRefused("a note with that name already exists in a different letter case")
        return None
    if not full.is_file():
        raise PathRefused("that is not a notebook file")
    with open(full, "rb") as handle:
        return handle.read()


def decode(data: Optional[bytes]) -> str:
    if data is None:
        return ""
    try:
        # Text reads with LF line ends whatever the file has; Kairos writes LF.
        return data.decode("utf-8").replace("\r\n", "\n")
    except UnicodeDecodeError:
        raise NotebookError("that file is not valid UTF-8 text, so it cannot be shown or edited here")


def write_bytes(bot_id: str, path: str, data: bytes) -> None:
    """Atomic replace: unique temporary file, flush, fsync, replace."""
    target, full = locate(bot_id, path)
    if len(data) > target.limit:
        raise CapacityError(f"{target.path} is limited to {target.limit // 1024} KiB; this is {len(data) // 1024 + 1} KiB")
    check_case(full)
    full.parent.mkdir(parents=True, exist_ok=True)
    if is_reparse(full.parent):
        raise PathRefused("that location is a link, which the notebook does not follow")
    temporary = full.with_name(f".{full.name}.{uuid.uuid4().hex[:12]}.tmp")
    try:
        with open(temporary, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        if os.name != "nt":
            os.chmod(temporary, 0o600)
        os.replace(temporary, full)
    except BaseException:
        try:
            temporary.unlink()
        except OSError:
            pass
        raise


def remove_file(bot_id: str, path: str) -> None:
    _, full = locate(bot_id, path)
    try:
        full.unlink()
    except FileNotFoundError:
        pass
    # An emptied folder of ours goes with its last file.
    for parent in (full.parent, full.parent.parent):
        if parent == workspace(bot_id):
            break
        try:
            parent.rmdir()
        except OSError:
            break


def list_files(bot_id: str) -> list[str]:
    """Every notebook file that exists, as relative paths in a stable order."""
    root = workspace(bot_id)
    found = []
    if not root.is_dir() or is_reparse(root):
        return found
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        here = Path(dirpath)
        dirnames[:] = sorted(d for d in dirnames if not is_reparse(here / d))
        for name in sorted(filenames):
            full = here / name
            if is_reparse(full):
                continue
            relative = full.relative_to(root).as_posix()
            try:
                classify(relative)
            except PathRefused:
                continue
            found.append(relative)
    return sorted(found, key=lambda p: (p != INDEX_NAME, p))


def clip_index(text: str) -> tuple[str, dict]:
    """What a turn loads of the index: at most 200 lines and 24,576 UTF-8 bytes, whichever comes first,
    never cutting a character. The report says how much of what is stored was loaded."""
    stored_bytes = len(text.encode("utf-8"))
    lines = text.splitlines(keepends=True)
    kept, used = [], 0
    for line in lines[:INDEX_LOAD_LINES]:
        size = len(line.encode("utf-8"))
        if used + size > INDEX_LOAD_BYTES:
            room = INDEX_LOAD_BYTES - used
            if room > 0:
                kept.append(line.encode("utf-8")[:room].decode("utf-8", errors="ignore"))
                used += len(kept[-1].encode("utf-8"))
            break
        kept.append(line)
        used += size
    clipped = "".join(kept)
    loaded_lines = len(kept)
    info = {"loaded_lines": loaded_lines, "stored_lines": len(lines), "loaded_bytes": used, "stored_bytes": stored_bytes,
            "line_limit": INDEX_LOAD_LINES, "byte_limit": INDEX_LOAD_BYTES,
            "clipped": used < stored_bytes or loaded_lines < len(lines)}
    return clipped, info


def over_load_limits(text: str) -> bool:
    return clip_index(text)[1]["clipped"]
