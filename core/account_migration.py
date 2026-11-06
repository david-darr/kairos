"""Moving personal data into account folders (Multi-Account phase 1, 2026-11-05; spec: the vault note
"Multi-Account (Build Spec)", decision D7).

Each step moves one group of entries from the top of the data folder into the first admin's account folder
(data/accounts/<id>/, core/accounts.py), or the "local" folder while there are no accounts. run() is called
by app.py at start, after a staged restore and before any module reads the data folder (most stores open
their files when imported), so nothing is open while it moves.

- The data folder records how far it has come in layout.json; only newer steps run, so a restart, or a
  restore of a backup taken before a step, simply carries on from where that data stands.
- Before the first pending step, a backup (core/backup.py, keys included: it stays inside the data folder,
  as sensitive as the folder itself) goes to .layout/before-layout-<version>-<time>.zip. Like every backup it
  leaves out a vault kept inside the data folder and saved logins, so a step that moves either names it in
  copy_first and gets its own copy beside the zip. Backups and restores leave .layout alone.
- Once a run has worked, older before-layout-* backups are removed: the newest holds everything.
- Moves are renames on the same disk. If any move fails, everything moved in this run goes back, layout.json
  is left as it was, and the app starts on the old layout; the failure is logged and returned.
- An entry already present in the account folder stops the run: two copies are never merged.

Phase 2 adds one step per store group in the same change that makes that store read from account_dir(),
so nothing moves before its code is ready. A data folder with none of a step's names (a new install) just
records the version, with no backup.
"""
import fnmatch
import json
import logging
import os
import shutil
import time
from dataclasses import dataclass
from typing import Callable, Optional

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
    # the shared skills library (bot-skills-library), speech models and runtime, Discord bots (group 6),
    # Swarm (group 8), and bot secrets, keys, logins and connections (phase 3). Checked against the
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
]


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


def _target_account() -> str:
    from core.accounts import local_account
    return local_account()


def run(data_dir: Optional[str] = None, steps: Optional[list] = None, account: Optional[str] = None,
        backup=None) -> Optional[dict]:
    """Run the pending steps. Returns None when there is nothing to do, else what happened, which is also
    kept in .layout/last-run.json: this runs before the app's logging is set up, so the log files would
    not show a failure."""
    data_dir = data_dir or DATA_DIR
    result = _run(data_dir, steps, account, backup)
    if result is not None:
        try:
            os.makedirs(os.path.join(data_dir, ".layout"), exist_ok=True)
            write_json_atomic(os.path.join(data_dir, ".layout", "last-run.json"), {**result, "at": time.time()})
        except OSError as error:
            log.error("Account layout: could not record the run: %s", error)
    return result


def _run(data_dir, steps, account, backup) -> Optional[dict]:
    _moved.pop(data_dir, None)  # re-read the layout after this run, whatever it does
    steps = sorted(STEPS if steps is None else steps, key=lambda s: s.version)
    current = layout_version(data_dir)
    pending = [s for s in steps if s.version > current]
    if not pending:
        return None
    account = account or _target_account()
    from core.accounts import _checked
    target = os.path.join(data_dir, "accounts", _checked(account))
    result = {"ok": False, "from_version": current, "to_version": current, "account": account,
              "steps": [s.name for s in pending], "moved": [], "backup": None, "error": None}
    kept = set()
    for step in pending:
        if step.keep:
            kept |= step.keep(data_dir)
    def what_to_move():
        return [(step, name) for step in pending for entry in step.entries for name in _expand(data_dir, entry)
                if name not in kept and os.path.lexists(os.path.join(data_dir, name))]
    to_move = what_to_move()
    if not to_move:
        # A new install, or one that never had these stores: nothing to back up or move.
        write_json_atomic(os.path.join(data_dir, "layout.json"),
                          {"version": pending[-1].version, "account": account, "updated_at": time.time()})
        _moved.pop(data_dir, None)
        result.update(ok=True, to_version=pending[-1].version)
        return result
    folder = os.path.join(data_dir, ".layout")
    stamp = f"before-layout-{pending[-1].version}-{time.strftime('%Y%m%d-%H%M%S')}"
    made = []
    try:
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, stamp + ".zip")
        (backup or _backup)(path)
        made.append(path)
        result["backup"] = path
        for step, name in to_move:
            if name in step.copy_first:
                copy = os.path.join(folder, f"{stamp}-{name}")
                shutil.copytree(os.path.join(data_dir, name), copy, symlinks=True)
                made.append(copy)
                result.setdefault("copies", []).append(copy)
    except Exception as error:  # no backup, no move
        result["error"] = f"backup failed: {error}"
        log.error("Account layout: %s; nothing moved", result["error"])
        return result
    # Again after the backup: copying a database opens it, and SQLite can leave a new -wal or -shm file
    # beside it that must move with it (found rehearsing group 3 on a copy of David's dev profile).
    to_move = what_to_move()
    moved = []
    try:
        os.makedirs(target, exist_ok=True)
        for step, name in to_move:
            source, destination = os.path.join(data_dir, name), os.path.join(target, name)
            if os.path.lexists(destination):
                raise FileExistsError(f"{name} is already in the account folder")
            os.makedirs(os.path.dirname(destination), exist_ok=True)
            os.replace(source, destination)
            moved.append((source, destination))
        write_json_atomic(os.path.join(data_dir, "layout.json"),
                          {"version": pending[-1].version, "account": account, "updated_at": time.time()})
        _moved.pop(data_dir, None)
    except Exception as error:
        result["error"] = str(error)
        undone = True
        for source, destination in reversed(moved):
            try:
                os.replace(destination, source)
            except Exception as undo_error:  # left where it is; the backup holds it
                undone = False
                log.error("Account layout: could not move %s back: %s", destination, undo_error)
        if undone:
            # Nothing changed, so this run's own copies are not needed; a start that fails every time
            # must not leave another whole-folder backup behind each time.
            result["pruned"] = _prune(folder, keep=[], only=made)
        log.error("Account layout: %s; moved everything back, staying on layout %s", error, current)
        return result
    result.update(ok=True, to_version=pending[-1].version, moved=[os.path.relpath(d, data_dir) for _, d in moved],
                  kept=sorted(kept))
    result["pruned"] = _prune(folder, keep=made)
    log.info("Account layout %s -> %s for %s: %s", current, result["to_version"], account, ", ".join(result["steps"]))
    return result


def _prune(folder: str, keep: list, only: Optional[list] = None) -> list:
    """After a run that worked, only its own safety copies stay: each backup is the whole data folder
    (about 1 GB on David's dev profile), and the newest one already holds everything an older one does,
    the moved stores included. With only, removes just those paths. Returns the names removed."""
    removed = []
    norm = lambda p: os.path.normcase(os.path.abspath(p))
    keep = {norm(p) for p in keep}
    only = None if only is None else {norm(p) for p in only}
    for name in sorted(os.listdir(folder)):
        path = os.path.join(folder, name)
        if not name.startswith("before-layout-") or norm(path) in keep or (only is not None and norm(path) not in only):
            continue
        try:
            shutil.rmtree(path) if os.path.isdir(path) and not os.path.islink(path) else os.remove(path)
            removed.append(name)
        except OSError as error:  # left for the next run
            log.warning("Account layout: could not remove old backup %s: %s", name, error)
    return removed


def _backup(path: str) -> None:
    from core import backup
    backup.make_backup(path, include_keys=True)
