"""Content Studio team: the scoring record, selection rules, pipeline view and weekly report (build spec
"Content Studio Team", steps 2 and 4). No platform APIs; metrics arrive by manual entry or import for now.

`studio` is the current account's store (data/accounts/<id>/content_studio/studio.db), one per account. Background
work calls it inside accounts.as_account(id) for each of accounts.all_accounts().
"""
import os

from core import accounts

from . import pipeline, report, review, scoring
from .store import StudioError, Store


def db_path():
    return os.path.join(accounts.account_dir(), "content_studio", "studio.db")


studio = accounts.PerAccount(Store, db_path)


def close_all():
    """Closes every account's open database (a test about to delete its data folder, or shutdown)."""
    for store in list(studio._instances.values()):
        store.close()
    studio.forget()


__all__ = ["studio", "close_all", "StudioError", "Store", "pipeline", "report", "review", "scoring"]
