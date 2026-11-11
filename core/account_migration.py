"""Moving personal data into account folders (Multi-Account phase 1, 2026-11-05; spec: the vault note
"Multi-Account (Build Spec)", decision D7).

Each step moves one group of entries from the top of the data folder into the first admin's account folder
(data/accounts/<id>/, core/accounts.py), or the "local" folder while there are no accounts. run() is called
by app.py at start, after a staged restore and before any module reads the data folder (most stores open
their files when imported), so nothing is open while it moves. While it runs, core/startup_progress.py
answers on the app's port with the phase and counts, and the desktop app shows them.

- The data folder records how far it has come in layout.json; only newer steps run, so a restart, or a
  restore of a backup taken before a step, simply carries on from where that data stands.
- The safety net (2026-11-10; it replaced a zip of the whole data folder, which took 30 minutes on David's
  8 GB profile, so the desktop app gave up and every relaunch started another zip): every move is a rename on
  the same disk, which changes no file, so what has to be recoverable is which entries moved, not their bytes.
  1. A safety copy, in .layout/run-<version>-<time>/: every small store file the new version may rewrite
     (JSON, SQLite with its -wal/-shm, keys; at most SAFETY_MAX_FILE each), anywhere in the data folder but
     the large folders of generated or downloaded files (generated files and images, checkpoints,
     attachments, computer use, videos, models, logs, installed code), which are only renamed. A step's
     copy_first entries (the vault, saved logins) are copied whole. About 100 MB on David's profile.
     Prepared as run-...partial and renamed when complete, so a start cut off here leaves nothing that counts.
  2. A journal, .layout/journal.json, written and flushed to disk before the first rename: every planned
     move. A start that finds it carries the run on (or, if it was undoing a failed run, carries the undo
     on). Each entry's place is read from the disk, so a cut at any instant is recoverable: a rename either
     happened or it didn't. The one move that is not a rename (below) records "copying" and "copied" in the
     journal, so the side to keep is always known.
  3. layout.json is written, the journal becomes run-.../journal.json (the record of the run, used by
     revert()), and the active journal is removed.
  An earlier attempt's leftovers (a cut-off zip from before this design, a partial safety copy) are removed
  at the next start; after a run that worked, only its own run folder stays.
- revert() undoes the newest run with the app stopped: entries go back, the safety copies are put back over
  the stores they came from, layout.json returns to where it was. Files the new version created stay.
- Windows can refuse a rename of a folder that Defender or the search indexer still holds open (found
  rehearsing on a copy of David's profile: WinError 5 on a 5.5 GB folder just copied), so a refused rename
  is retried with a short backoff for about 10 seconds, and if it still fails that entry is copied, checked
  (every file's path and size) and only then deleted from the old place. last-run.json says which way each
  entry went ("strategies"). If any move fails, everything moved in this run goes back, layout.json is left
  as it was, and the app starts on the old layout; the failure is recorded and returned.
- An entry already present in the account folder stops the run before anything moves: two copies are never
  merged.
- Junctions and symlinks are never followed (core/links.py): a copy makes them again as links.

Phase 2 adds one step per store group in the same change that makes that store read from account_dir(),
so nothing moves before its code is ready. A data folder with none of a step's names (a new install) just
records the version, with no safety copy.
"""
import errno
import fnmatch
import json
import logging
import os
import shutil
import time
import zipfile
from dataclasses import dataclass
from typing import Callable, Optional

from core import links, startup_progress
from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Step:
    version: int        # steps run in version order; each one only once per data folder
    name: str           # what moves, in plain words ("chats and sessions")
    entries: tuple      # top-level names in the data folder to move into the account folder (wildcards allowed)
    copy_first: tuple = ()  # entries no backup carries (the vault): copied into .layout before they move
    keep: Optional[Callable[[str], set]] = None  # names to leave where they are this time, given the data folder


def _vault_in_use(data_dir: str) -> set:
    """A vault folder named in Settings or JARVIS_VAULT_DIR stays where it is, even when that is the
    default data/vault: the setting points at it, and moving it would leave the setting pointing at
    nothing."""
    from core import settings as settings_store
    chosen = settings_store.get_setting("vault_dir") or os.getenv("JARVIS_VAULT_DIR")
    if chosen and os.path.normcase(os.path.realpath(chosen)) ==             os.path.normcase(os.path.realpath(os.path.join(data_dir, "vault"))):
        return {"vault"}
    return set()


# Phase 2 appends here, one group at a time, with the code that reads each group from account_dir().
STEPS: list[Step] = [
    Step(1, "notes, calendar, documents, projects and contacts",
         ("notes.json", "calendar_events.json", "documents", "documents_index.json", "projects.json", "contacts.json")),
    # The vault's search index (memory/) and the default vault. A vault chosen in Settings, like David's
    # Obsidian folder, is not in the data folder and does not move.
    Step(2, "memory and the vault", ("memory", "vault"), copy_first=("vault",), keep=_vault_in_use),
    # Chats: the database with its write-ahead files and the copies kept before each schema upgrade, the
    # JSON chats it replaced, background work per chat, uploads waiting to be sent, the activity feed and
    # agent conversation choices. The phone activity database stays shared: its rows already name their
    # owner and it holds the install's push key. jobs.json and jobs/ stay too: an installed tab's own code
    # (tabs/services/jobs_service.py) reads them at the top of the data folder; tab data moves with
    # group 7 (found when step 3 first ran on David's dev profile and the tab made a new empty file).
    Step(3, "chats", ("sessions.db", "sessions.db-wal", "sessions.db-shm", "sessions.db.pre-v*",
                      "sessions.pre-sqlite-backup", "chat_tasks", "attachments", "events.json",
                      "agent_conversations.json")),
    # Bots and Kip: each account's bots, their notebooks, memory, rooms, cards, routines' state, usage,
    # calls and voice choices, and Kip's own folder (front_desk/). Install-level and left where they are:
    # speech models and runtime, Discord bots (group 6), Swarm (group 8); the shared skills library and
    # bot secrets, keys, logins and connections moved in step 11. Checked against the
    # installed tabs and add-ons (data/tabs, data/addons): none reads these files directly.
    Step(4, "bots and Kip", ("agents.json", "agents.json.*", "agents", "agent_voice.json", "call_voice.json",
                             "agent_calls", "bot-attention.sqlite3*", "bot-grants-state.json", "bot-memory-state",
                             "bot-recall", "bot-skill-state", "bot-teams", "bot-workspaces", "bot-profiles",
                             "bot-room-files", "bot-tool-results", "bot-activity", "bot_approval_state.json",
                             "bot_assignments.sqlite3*", "bot_automation_events.sqlite3*",
                             "bot_automation_changes.json", "bot_cards.json", "bot_data", "bot_decisions",
                             "bot_departments.json", "bot_onboarding.json", "bot_peer_state.json",
                             "bot_rooms.sqlite3*", "bot_outbound.sqlite3*", "bot_usage", "bot_workbench.json",
                             "bot_routine_trash.json", "bot_defaults.json", "bot_presets.json", "bot_reports",
                             "bot_voice", "front_desk")),
    # Tasks, cards and routines with their run history and the routines' first-write copy, webhooks and
    # triggers, and lifecycle hooks. The outbox and helpers live in the chat database (step 3). Checked
    # against the installed tabs and add-ons: the job tab only goes through task_service.
    Step(5, "tasks, routines, triggers and hooks", ("tasks.json", "tasks.json.*", "task_runs.json",
                                                    "triggers.json", "hooks.json")),
    # Mail, its triage, standing permission grants, integrations (MCP servers, API services, calendar and
    # contact feeds) and each person's Google sign-ins. google_accounts.json is new: the shared
    # google_workspace.json keeps the install's OAuth app, and the first admin's sign-ins move out of it
    # the first time that account loads (core/google_workspace.py). Discord bots and connectors stay one
    # file per install, each record naming the account it answers as; the GitHub publishing identity is
    # install-level; the creative add-on's connections move with add-on data (group 7).
    Step(6, "mail, Google, permissions and integrations", ("email_accounts.json", "email_triage.json",
                                                            "permissions.json", "integrations.json",
                                                            "google_accounts.json")),
    # A person's skills (bundled ones are copied in per account; skill_templates/ stays with the app),
    # designs and saved styles (the bundled looks stay with the app), videos, generated images and
    # files, the Forge project list (the project folders stay where the person put them), file
    # checkpoints and computer-use profiles, trajectories and screens. Tab data, the creative add-on's
    # connections and the job tab's files are left where they are: installed tab and add-on code reads
    # them at fixed paths, so moving them waits for David's call (group 7b).
    Step(7, "skills, designs, videos, generated files, Forge, checkpoints and computer use",
         ("skills", "designs", "design_systems", "design_style_drafts", "videos", "generated_files",
          "generated_images", "forge", "file_checkpoints", "computer")),
    # Token and image usage counts (the daily image limit itself stays an install setting; each account
    # counts its own). Bots' usage moved with step 4.
    Step(8, "usage counts", ("token_usage.json", "token_usage_daily.json", "image_usage.json")),
    Step(9, "tab data and creative add-on connections", ("tab-data", "creative-connections.json")),
    Step(10, "model connections", ("model_endpoints.json",)),
    # Bot keys and resource settings, saved logins with their own key and the 1Password link (bot-secrets,
    # which no backup carries, so it gets its own copy first), app-connection aliases, the skills library
    # with its sharing queue, and what the community store installed. The store's catalog cache is the same
    # public file for everyone and stays. Checked against the installed tabs and add-ons: none reads these.
    Step(11, "bot keys, logins, connections and skills library",
         ("bot-keys.json", "bot-secrets", "bot-connections", "bot-resource-settings", "bot-skills-library",
          "store-installs.json"), copy_first=("bot-secrets",)),
]


RENAME_RETRY_SECONDS = 10.0   # how long a refused rename is retried before the entry is copied instead
_RENAME_WAIT = (0.05, 0.1, 0.2, 0.4, 0.8, 1.0)  # the pauses between tries; the last one repeats
_BUSY = (5, 32, 33)           # WinError 5 access denied, 32 sharing violation, 33 lock violation

LAYOUT_DIR = ".layout"
JOURNAL = "journal.json"
SAFETY_MAX_FILE = 256 * 1024 ** 2  # a store file larger than this is only renamed, never copied
# Folders of generated, downloaded or installed files, at any depth: renamed with their entry, never copied.
_NOT_COPIED = {"generated_files", "generated_images", "file_checkpoints", "attachments", "computer", "videos",
               "logs", "speech_models", "gguf_models", "mcp_servers", "tabs", "addons", "minecraft_servers",
               "node_modules", "worktrees", "__pycache__", ".git", "vault", "bot-secrets", LAYOUT_DIR, ".restore"}
_STORE_ENDINGS = (".json", ".db", ".sqlite", ".sqlite3", ".jsonl", "-wal", "-shm", ".secret_key")
# Which side of a move holds the whole entry when both exist, by the journal's mark for it.
_WHOLE_SIDE = {"copying": "source", "copied": "destination", "back-copying": "destination", "back-copied": "source"}


def _refused(error: BaseException) -> bool:
    """A rename Windows (or another disk) turned down for a reason that can pass or be worked around."""
    return isinstance(error, PermissionError) or (
        isinstance(error, OSError) and (getattr(error, "winerror", None) in _BUSY or error.errno == errno.EXDEV))


def _sizes(path: str) -> dict:
    """Relative path -> size for every file under path ("" for a single file), directories as -1, links
    as -2: what a copy has to match exactly. Links are never followed."""
    if links.is_link(path) or not os.path.isdir(path):
        return {"": -2 if links.is_link(path) else os.path.getsize(path)}
    found = {}
    for folder, dirs, files, found_links in links.walk(path):
        for name in dirs:
            found[os.path.relpath(os.path.join(folder, name), path)] = -1
        for name in found_links:
            found[os.path.relpath(os.path.join(folder, name), path)] = -2
        for name in files:
            full = os.path.join(folder, name)
            found[os.path.relpath(full, path)] = os.path.getsize(full)
    return found


def _copy_link(source: str, destination: str) -> None:
    to = links.target(source)
    if to is None:
        raise OSError(f"could not read the link {source}")
    links.make(destination, to, links.kind(source))


def _copy_tree(source: str, destination: str) -> None:
    """Copy a file or folder, links made again as links, with progress: a folder of several GB takes minutes."""
    if links.is_link(source):
        _copy_link(source, destination)
        return
    if not os.path.isdir(source):
        shutil.copy2(source, destination, follow_symlinks=False)
        return
    name, count, at = os.path.basename(source), 0, time.monotonic()
    for folder, _, files, found_links in links.walk(source):
        out = os.path.normpath(os.path.join(destination, os.path.relpath(folder, source)))
        os.makedirs(out, exist_ok=True)
        for file_name in files:
            shutil.copy2(os.path.join(folder, file_name), os.path.join(out, file_name), follow_symlinks=False)
            count += 1
            if count % 200 == 0:
                startup_progress.update(**{**_progress_now(), "detail": f"Copying {name}: {count} files so far"})
                if time.monotonic() - at >= 5:
                    at = time.monotonic()
                    log.info("Account layout: copying %s: %d files so far", name, count)
        for link_name in found_links:
            _copy_link(os.path.join(folder, link_name), os.path.join(out, link_name))


def _progress_now() -> dict:
    state = startup_progress.snapshot()
    return {"phase": state["phase"], "detail": state["detail"], "done": state["done"], "total": state["total"]}


def _remove(path: str) -> None:
    if links.is_link(path):
        links.remove(path)
    elif os.path.isdir(path):
        for attempt in range(6):  # the same handles that refused the rename can hold a file here
            try:
                shutil.rmtree(path)  # never enters a junction (Python 3.12 removes the link itself)
                return
            except OSError:
                if attempt == 5:
                    raise
                time.sleep(0.2 * (attempt + 1))
    else:
        os.remove(path)


def _restore_missing(copy: str, original: str) -> None:
    """The delete after a copy failed halfway: put back whatever of the original is gone, so it is whole."""
    if links.is_link(copy) or not os.path.isdir(copy):
        if not os.path.lexists(original):
            _copy_tree(copy, original)
        return
    for folder, _, files, found_links in links.walk(copy):
        target = os.path.normpath(os.path.join(original, os.path.relpath(folder, copy)))
        os.makedirs(target, exist_ok=True)
        for name in files:
            if not os.path.lexists(os.path.join(target, name)):
                shutil.copy2(os.path.join(folder, name), os.path.join(target, name), follow_symlinks=False)
        for name in found_links:
            if not os.path.lexists(os.path.join(target, name)):
                _copy_link(os.path.join(folder, name), os.path.join(target, name))


def _move(source: str, destination: str, mark: Optional[Callable[[str], None]] = None, back: bool = False) -> str:
    """Move one entry, which must not exist at the destination yet. Returns how it went: "rename",
    "rename after N retries", or "copy" (copied, every path and size checked, then removed from the old
    place; the old place is only touched once the copy is proven). mark records the copy's progress in the
    journal ("copying", then "copied"; "back-" while undoing). Raises if neither way works, leaving the entry
    whole at the source and nothing at the destination."""
    deadline = time.monotonic() + RENAME_RETRY_SECONDS
    tries = 0
    while True:
        try:
            os.replace(source, destination)
            return "rename" if not tries else f"rename after {tries} retries"
        except OSError as error:
            if not _refused(error):
                raise
            if time.monotonic() >= deadline:
                log.warning("Account layout: renaming %s kept failing (%s); copying it instead",
                            os.path.basename(source), error)
                break
            tries += 1
            time.sleep(_RENAME_WAIT[min(tries, len(_RENAME_WAIT)) - 1])
    prefix = "back-" if back else ""
    if mark:
        mark(prefix + "copying")
    try:
        _copy_tree(source, destination)
        if _sizes(source) != _sizes(destination):
            raise OSError(f"the copy of {os.path.basename(source)} does not match the original")
    except BaseException:
        if os.path.lexists(destination):
            try:
                _remove(destination)
            except OSError as undo_error:
                log.error("Account layout: could not clear the partial copy %s: %s", destination, undo_error)
        raise
    if mark:
        mark(prefix + "copied")
    try:
        _remove(source)
    except BaseException:
        _restore_missing(destination, source)  # the copy is complete, so the original can be made whole
        if _sizes(source) == _sizes(destination):
            _remove(destination)
        if mark:
            mark(None)
        raise
    log.info("Account layout: copied %s (rename was refused)", os.path.basename(source))
    return "copy"


def _expand(data_dir: str, entry: str) -> list:
    if not any(ch in entry for ch in "*?["):
        return [entry]
    try:
        return sorted(n for n in os.listdir(data_dir) if fnmatch.fnmatch(n, entry))
    except OSError:
        return []


def layout_version(data_dir: str = DATA_DIR) -> int:
    return int(read_json(os.path.join(data_dir, "layout.json"), {}).get("version") or 0)


_moved: dict = {}


def moved_names(data_dir: str = DATA_DIR) -> frozenset:
    """The data folder's names that now live in account folders: those of every step its layout has
    reached. core/accounts.py's path() sends every other name to the shared place it always had, so a
    migration that failed and moved everything back leaves the app reading the old layout."""
    names = _moved.get(data_dir)
    if names is None:
        version = layout_version(data_dir)
        names = _moved[data_dir] = frozenset(n for s in STEPS if s.version <= version for n in s.entries)
    return names


def is_moved(name: str, data_dir: str = DATA_DIR) -> bool:
    """Whether a top-level name now lives in account folders, wildcard entries included
    ("bot_rooms.sqlite3*" covers the database and its -wal and -shm files)."""
    names = moved_names(data_dir)
    return name in names or any(any(ch in n for ch in "*?[") and fnmatch.fnmatch(name, n) for n in names)


def pending(data_dir: Optional[str] = None) -> bool:
    """Whether the next start has moving to do: a newer step, or a run that was cut off."""
    data_dir = data_dir or DATA_DIR
    return (os.path.exists(os.path.join(data_dir, LAYOUT_DIR, JOURNAL))
            or any(s.version > layout_version(data_dir) for s in STEPS))


def _target_account() -> str:
    from core.accounts import local_account
    return local_account()


# --- writing to disk so it survives a cut-off start -----------------------------------------------------

def _replace_durably(source: str, destination: str) -> None:
    """Rename over, flushed through to the disk before returning."""
    if os.name == "nt":
        import ctypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.MoveFileExW.argtypes = (ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint)
        if not kernel32.MoveFileExW(source, destination, 0x1 | 0x8):  # REPLACE_EXISTING | WRITE_THROUGH
            raise ctypes.WinError(ctypes.get_last_error())
    else:
        os.replace(source, destination)
        folder = os.open(os.path.dirname(destination) or ".", os.O_RDONLY)
        try:
            os.fsync(folder)
        finally:
            os.close(folder)


def _write_durably(path: str, data) -> None:
    """Write JSON so that the file is either the old one or the whole new one, and on the disk."""
    # A brand-new data folder may not exist yet (a backend started without the desktop app, or the macOS
    # build check: 2.3.0-beta.3's first build stopped here). write_json_atomic made it; this must too.
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)
        f.flush()
        os.fsync(f.fileno())
    _replace_durably(temporary, path)


def _write_layout(data_dir: str, version: int, account: str) -> None:
    _write_durably(os.path.join(data_dir, "layout.json"),
                   {"version": version, "account": account, "updated_at": time.time()})
    _moved.pop(data_dir, None)


# --- the safety copy ------------------------------------------------------------------------------------

def _is_store(name: str) -> bool:
    lowered = name.lower()
    return (lowered.endswith(_STORE_ENDINGS) and ".pre-v" not in lowered and ".corrupt-" not in lowered
            and not lowered.endswith(".tmp"))


def _safety_files(data_dir: str, whole: set) -> list:
    """(relative path, size) of every store file the safety copy keeps (see the module docstring)."""
    found = []
    for folder, dirs, files, _ in links.walk(data_dir):
        top = os.path.normcase(folder) == os.path.normcase(data_dir)
        dirs[:] = [d for d in dirs if d not in _NOT_COPIED and not (top and d in whole)]
        for name in files:
            if top and name in whole or not _is_store(name):
                continue
            path = os.path.join(folder, name)
            try:
                size = os.lstat(path).st_size
            except OSError:
                continue
            if size <= SAFETY_MAX_FILE:
                found.append((os.path.relpath(path, data_dir), size))
    return found


def _make_safety_copy(data_dir: str, run_dir: str, whole: list) -> dict:
    """Fill run_dir (a .partial folder) with the store copies and the copy_first entries."""
    files = _safety_files(data_dir, set(whole))
    total = len(files) + len(whole)
    startup_progress.update("safety", "Keeping a safety copy of your settings and chats", 0, total)
    copies = os.path.join(run_dir, "copies")
    done = 0
    for rel, _ in files:
        destination = os.path.join(copies, rel)
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        shutil.copyfile(os.path.join(data_dir, rel), destination, follow_symlinks=False)
        done += 1
        if done % 25 == 0:
            startup_progress.update("safety", "Keeping a safety copy of your settings and chats", done, total)
    for name in whole:
        _copy_tree(os.path.join(data_dir, name), os.path.join(run_dir, "copy-first", name))
        done += 1
    startup_progress.update("safety", "Keeping a safety copy of your settings and chats", done, total)
    return {"files": len(files), "bytes": sum(size for _, size in files), "whole": list(whole)}


def _tidy(folder: str) -> list:
    """What an earlier, cut-off start left in .layout: a zip of the whole data folder that was never
    finished (the safety net before this one), a safety copy that was never finished or whose run never
    wrote its journal (so nothing moved), half-written files. Not while a journal names a run to carry on."""
    removed = []
    try:
        names = sorted(os.listdir(folder))
    except OSError:
        return removed
    active = os.path.exists(os.path.join(folder, JOURNAL))
    for name in names:
        path = os.path.join(folder, name)
        unfinished = ((name.startswith("before-layout-") and name.endswith(".zip") and not zipfile.is_zipfile(path))
                      or (name.startswith("run-") and name.endswith(".partial"))
                      or (name.startswith("run-") and not active and os.path.isdir(path)
                          and not os.path.exists(os.path.join(path, JOURNAL)))
                      or name.endswith(".tmp") or (name.startswith(".tmp_") and name.endswith(".json")))
        if not unfinished:
            continue
        try:
            _remove(path)
            removed.append(name)
        except OSError as error:
            log.warning("Account layout: could not remove the unfinished %s: %s", name, error)
    return removed


def _prune(folder: str, keep: list, only: Optional[list] = None) -> list:
    """After a run that worked, only its own safety copy stays (older run folders, and whole-folder zips and
    vault copies from before this design, go). With only, removes just those paths. Returns the names removed."""
    removed = []
    norm = lambda p: os.path.normcase(os.path.abspath(p))
    keep = {norm(p) for p in keep}
    only = None if only is None else {norm(p) for p in only}
    for name in sorted(os.listdir(folder)):
        path = os.path.join(folder, name)
        if (not name.startswith(("before-layout-", "run-")) or norm(path) in keep
                or (only is not None and norm(path) not in only)):
            continue
        try:
            _remove(path)
            removed.append(name)
        except OSError as error:  # left for the next run
            log.warning("Account layout: could not remove old safety copy %s: %s", name, error)
    return removed


# --- the run ---------------------------------------------------------------------------------------------

def run(data_dir: Optional[str] = None, steps: Optional[list] = None, account: Optional[str] = None,
        safety: Optional[Callable[[str], None]] = None) -> Optional[dict]:
    """Run the pending steps, or carry on a run that was cut off. Returns None when there is nothing to do,
    else what happened, which is also kept in .layout/last-run.json: this runs before the app's logging is
    set up, so the log files would not show a failure. safety, for tests, is called with the finished safety
    copy's folder before anything moves (raising there stops the run)."""
    data_dir = data_dir or DATA_DIR
    result = _run(data_dir, steps, account, safety)
    if result is not None:
        try:
            os.makedirs(os.path.join(data_dir, LAYOUT_DIR), exist_ok=True)
            write_json_atomic(os.path.join(data_dir, LAYOUT_DIR, "last-run.json"), {**result, "at": time.time()})
        except OSError as error:
            log.error("Account layout: could not record the run: %s", error)
    return result


def _run(data_dir, steps, account, safety) -> Optional[dict]:
    _moved.pop(data_dir, None)  # re-read the layout after this run, whatever it does
    folder = os.path.join(data_dir, LAYOUT_DIR)
    tidied = _tidy(folder)
    journal_path = os.path.join(folder, JOURNAL)
    if os.path.exists(journal_path):
        return _resume(data_dir, journal_path, tidied)
    steps = sorted(STEPS if steps is None else steps, key=lambda s: s.version)
    current = layout_version(data_dir)
    pending_steps = [s for s in steps if s.version > current]
    if not pending_steps:
        return None
    to_version = pending_steps[-1].version
    account = account or _target_account()
    from core.accounts import _checked
    target = os.path.join(data_dir, "accounts", _checked(account))
    result = {"ok": False, "from_version": current, "to_version": current, "account": account,
              "steps": [s.name for s in pending_steps], "moved": [], "safety": None, "error": None,
              "strategies": {}, "resumed": False}
    if tidied:
        result["tidied"] = tidied
    startup_progress.update("checking", "Checking your data")
    kept = set()
    for step in pending_steps:
        if step.keep:
            kept |= step.keep(data_dir)
    plan = [(step, name) for step in pending_steps for entry in step.entries for name in _expand(data_dir, entry)
            if name not in kept and os.path.lexists(os.path.join(data_dir, name))]
    if not plan:
        # A new install, or one that never had these stores: nothing to copy or move.
        _write_layout(data_dir, to_version, account)
        result.update(ok=True, to_version=to_version)
        return result
    taken = [name for _, name in plan if os.path.lexists(os.path.join(target, name))]
    if taken:
        result["error"] = f"{taken[0]} is already in the account folder"
        log.error("Account layout: %s; nothing moved, staying on layout %s", result["error"], current)
        return result
    stamp = f"run-{to_version}-{time.strftime('%Y%m%d-%H%M%S')}-{os.urandom(3).hex()}"  # two starts can share a second
    run_dir = os.path.join(folder, stamp)
    partial = run_dir + ".partial"
    whole = [name for step, name in plan if name in step.copy_first]
    try:
        os.makedirs(partial)
        result["safety_copy"] = _make_safety_copy(data_dir, partial, whole)
        os.replace(partial, run_dir)
        if safety:
            safety(run_dir)
    except Exception as error:  # no safety copy, no move
        result["error"] = f"safety copy failed: {error}"
        for path in (partial, run_dir):
            if os.path.lexists(path):
                try:
                    _remove(path)
                except OSError:
                    pass
        log.error("Account layout: %s; nothing moved", result["error"])
        return result
    result["safety"] = run_dir
    if whole:
        result["copies"] = [os.path.join(run_dir, "copy-first", name) for name in whole]
    journal = {"state": "moving", "from_version": current, "to_version": to_version, "account": account,
               "steps": result["steps"], "run": stamp, "kept": sorted(kept), "started_at": time.time(),
               "moves": [{"name": name, "source": name, "destination": os.path.relpath(os.path.join(target, name), data_dir),
                          "mark": None} for _, name in plan]}
    try:
        _write_durably(journal_path, journal)
    except OSError as error:
        result["error"] = f"could not write the journal: {error}"
        _prune(folder, keep=[], only=[run_dir])
        return result
    return _carry_on(data_dir, journal_path, journal, result)


def _resume(data_dir: str, journal_path: str, tidied: list) -> dict:
    try:
        with open(journal_path, encoding="utf-8") as f:
            journal = json.load(f)
        journal["moves"]
    except (OSError, ValueError, KeyError, TypeError) as error:
        # Written whole or not at all, so this means the disk itself was damaged: leave it for a person.
        log.error("Account layout: the journal of a cut-off run can't be read (%s); nothing moved", error)
        return {"ok": False, "error": f"the journal of a cut-off run can't be read: {error}", "resumed": True,
                "from_version": layout_version(data_dir), "to_version": layout_version(data_dir)}
    result = {"ok": False, "from_version": journal["from_version"], "to_version": journal["from_version"],
              "account": journal["account"], "steps": journal.get("steps", []), "moved": [],
              "safety": os.path.join(data_dir, LAYOUT_DIR, journal["run"]), "error": None, "strategies": {},
              "resumed": True}
    if tidied:
        result["tidied"] = tidied
    log.warning("Account layout: carrying on a run that was cut off (%s)", journal["state"])
    if journal["state"] == "rolling-back":
        return _undo(data_dir, journal_path, journal, result, journal.get("error") or "an earlier start failed")
    return _carry_on(data_dir, journal_path, journal, result)


def _marker(journal_path: str, journal: dict, move: dict):
    def mark(value):
        move["mark"] = value
        _write_durably(journal_path, journal)
    return mark


def _carry_on(data_dir: str, journal_path: str, journal: dict, result: dict) -> dict:
    moves = journal["moves"]
    total = len(moves)
    try:
        for done, move in enumerate(moves):
            startup_progress.update("moving", f"Moving your files into your account ({move['name']})", done, total)
            source = os.path.join(data_dir, move["source"])
            destination = os.path.join(data_dir, move["destination"])
            has_source, has_destination = os.path.lexists(source), os.path.lexists(destination)
            if has_source and has_destination:
                whole = _WHOLE_SIDE.get(move.get("mark"))
                if whole is None:
                    raise FileExistsError(f"{move['name']} is already in the account folder")
                if whole == "destination":  # the copy was complete; the old place was being cleared
                    _remove(source)
                    result["strategies"][move["name"]] = "copy"
                    continue
                _remove(destination)  # a copy cut off halfway
                has_destination = False
            if has_destination:
                result["strategies"].setdefault(move["name"], "moved before")
                continue
            if not has_source:
                raise FileNotFoundError(f"{move['name']} is in neither place")
            os.makedirs(os.path.dirname(destination), exist_ok=True)
            result["strategies"][move["name"]] = _move(source, destination, _marker(journal_path, journal, move))
        startup_progress.update("finishing", "Finishing up", total, total)
        if layout_version(data_dir) < journal["to_version"]:
            _write_layout(data_dir, journal["to_version"], journal["account"])
    except Exception as error:
        return _undo(data_dir, journal_path, journal, result, str(error))
    _finish(data_dir, journal_path, journal, "done")
    folder = os.path.join(data_dir, LAYOUT_DIR)
    result.update(ok=True, to_version=journal["to_version"], moved=[m["destination"] for m in moves],
                  kept=journal.get("kept", []))
    result["pruned"] = _prune(folder, keep=[result["safety"]])
    log.info("Account layout %s -> %s for %s: %s", journal["from_version"], journal["to_version"],
             journal["account"], ", ".join(journal.get("steps", [])))
    return result


def _undo(data_dir: str, journal_path: str, journal: dict, result: dict, error: str) -> dict:
    """Put every entry of this run back where it was, from whatever state a failure or a cut left it in."""
    result["error"] = error
    if journal["state"] != "rolling-back":
        journal.update(state="rolling-back", error=error)
        try:
            _write_durably(journal_path, journal)
        except OSError as write_error:
            log.error("Account layout: could not record the undo: %s", write_error)
    moves = journal["moves"]
    undone = True
    for done, move in enumerate(reversed(moves)):
        startup_progress.update("undoing", "Putting your files back as they were", done, len(moves))
        source = os.path.join(data_dir, move["source"])
        destination = os.path.join(data_dir, move["destination"])
        try:
            has_source, has_destination = os.path.lexists(source), os.path.lexists(destination)
            if has_source and has_destination:
                whole = _WHOLE_SIDE.get(move.get("mark"))
                if whole is None:
                    continue  # never moved; what is in the account folder is not this run's
                if whole == "source":
                    _remove(destination)
                    continue
                _remove(source)
                has_source = False
            if has_destination and not has_source:
                _move(destination, source, _marker(journal_path, journal, move), back=True)
        except Exception as undo_error:  # left where it is; the journal still names it
            undone = False
            log.error("Account layout: could not move %s back: %s", move["name"], undo_error)
    folder = os.path.join(data_dir, LAYOUT_DIR)
    if undone:
        if layout_version(data_dir) != journal["from_version"]:
            _write_layout(data_dir, journal["from_version"], journal["account"])
        os.remove(journal_path)
        # Nothing changed, so this run's own safety copy is not needed; a start that fails every time must
        # not leave another one behind each time.
        result["pruned"] = _prune(folder, keep=[], only=[os.path.join(folder, journal["run"])])
    log.error("Account layout: %s; %s, staying on layout %s", error,
              "moved everything back" if undone else "some entries could not be moved back yet",
              journal["from_version"])
    return result


def _finish(data_dir: str, journal_path: str, journal: dict, state: str) -> None:
    """The run is complete: its journal becomes the record in its run folder, and the active one goes."""
    journal.update(state=state, finished_at=time.time())
    record = os.path.join(data_dir, LAYOUT_DIR, journal["run"], JOURNAL)
    try:
        _write_durably(record, journal)
    except OSError as error:
        log.error("Account layout: could not keep the record of the run: %s", error)
    os.remove(journal_path)


def revert(data_dir: Optional[str] = None) -> dict:
    """Undo the newest finished run, with Kairos stopped: entries go back to the top of the data folder, the
    safety copies are put back over the stores they came from, and layout.json returns to the version before
    the run. Files the new version created in the account folder are left there."""
    data_dir = data_dir or DATA_DIR
    folder = os.path.join(data_dir, LAYOUT_DIR)
    records = sorted((name for name in os.listdir(folder) if name.startswith("run-") and not name.endswith(".partial")
                      and os.path.exists(os.path.join(folder, name, JOURNAL))),
                     key=lambda name: os.path.getmtime(os.path.join(folder, name, JOURNAL)))
    if not records:
        raise FileNotFoundError("no finished run to undo")
    run_dir = os.path.join(folder, records[-1])
    journal = read_json(os.path.join(run_dir, JOURNAL), {})
    if journal.get("state") != "done" or layout_version(data_dir) != journal.get("to_version"):
        raise ValueError("the newest run is not the one this data folder is on")
    for move in reversed(journal["moves"]):
        source, destination = os.path.join(data_dir, move["source"]), os.path.join(data_dir, move["destination"])
        if os.path.lexists(destination) and not os.path.lexists(source):
            _move(destination, source)
    copies = os.path.join(run_dir, "copies")
    kept = [os.path.relpath(os.path.join(root, name), copies)
            for root, _, files, _ in (links.walk(copies) if os.path.isdir(copies) else ()) for name in files]
    for rel in kept:
        os.makedirs(os.path.dirname(os.path.join(data_dir, rel)), exist_ok=True)
        shutil.copyfile(os.path.join(copies, rel), os.path.join(data_dir, rel))
        # A database's write-ahead files from after the run belong to the newer database: with the older
        # one put back they would be applied to the wrong pages.
        for side in ("-wal", "-shm", "-journal"):
            if rel + side not in kept and os.path.exists(os.path.join(data_dir, rel + side)):
                os.remove(os.path.join(data_dir, rel + side))
    restored = len(kept)
    _write_layout(data_dir, journal["from_version"], journal["account"])
    journal.update(state="reverted", reverted_at=time.time())
    _write_durably(os.path.join(run_dir, JOURNAL), journal)
    return {"ok": True, "run": records[-1], "moved_back": len(journal["moves"]), "stores_restored": restored,
            "layout": journal["from_version"]}


if __name__ == "__main__":
    import sys
    if sys.argv[1:] != ["revert"]:
        sys.exit("usage: python -m core.account_migration revert   (with Kairos stopped)")
    print(json.dumps(revert(), indent=2))
