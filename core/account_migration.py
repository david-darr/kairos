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
  leaves out a vault kept inside the data folder and saved logins, so a step that moves either must keep its
  own copy first. Backups and restores leave .layout alone.
- Moves are renames on the same disk. If any move fails, everything moved in this run goes back, layout.json
  is left as it was, and the app starts on the old layout; the failure is logged and returned.
- An entry already present in the account folder stops the run: two copies are never merged.

Phase 1 ships this with no steps. Phase 2 adds one step per store group in the same change that makes that
store read from account_dir(), so nothing moves before its code is ready.
"""
import json
import logging
import os
import shutil
import time
from dataclasses import dataclass
from typing import Optional

from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Step:
    version: int        # steps run in version order; each one only once per data folder
    name: str           # what moves, in plain words ("chats and sessions")
    entries: tuple      # top-level names in the data folder to move into the account folder


# Phase 2 appends here, one group at a time, with the code that reads each group from account_dir().
STEPS: list[Step] = []


def layout_version(data_dir: str = DATA_DIR) -> int:
    return int(read_json(os.path.join(data_dir, "layout.json"), {}).get("version") or 0)


def _target_account() -> str:
    from core.accounts import local_account
    return local_account()


def run(data_dir: Optional[str] = None, steps: Optional[list] = None, account: Optional[str] = None,
        backup=None) -> Optional[dict]:
    """Run the pending steps. Returns None when there is nothing to do, else what happened."""
    data_dir = data_dir or DATA_DIR
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
    try:
        folder = os.path.join(data_dir, ".layout")
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, f"before-layout-{pending[-1].version}-{time.strftime('%Y%m%d-%H%M%S')}.zip")
        (backup or _backup)(path)
        result["backup"] = path
    except Exception as error:  # no backup, no move
        result["error"] = f"backup failed: {error}"
        log.error("Account layout: %s; nothing moved", result["error"])
        return result
    moved = []
    try:
        os.makedirs(target, exist_ok=True)
        for step in pending:
            for name in step.entries:
                source, destination = os.path.join(data_dir, name), os.path.join(target, name)
                if not os.path.lexists(source):
                    continue
                if os.path.lexists(destination):
                    raise FileExistsError(f"{name} is already in the account folder")
                os.makedirs(os.path.dirname(destination), exist_ok=True)
                os.replace(source, destination)
                moved.append((source, destination))
        write_json_atomic(os.path.join(data_dir, "layout.json"),
                          {"version": pending[-1].version, "account": account, "updated_at": time.time()})
    except Exception as error:
        result["error"] = str(error)
        for source, destination in reversed(moved):
            try:
                os.replace(destination, source)
            except Exception as undo_error:  # left where it is; the backup holds it
                log.error("Account layout: could not move %s back: %s", destination, undo_error)
        log.error("Account layout: %s; moved everything back, staying on layout %s", error, current)
        return result
    result.update(ok=True, to_version=pending[-1].version, moved=[os.path.relpath(d, data_dir) for _, d in moved])
    log.info("Account layout %s -> %s for %s: %s", current, result["to_version"], account, ", ".join(result["steps"]))
    return result


def _backup(path: str) -> None:
    from core import backup
    backup.make_backup(path, include_keys=True)
