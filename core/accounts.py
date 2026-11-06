"""Which account a piece of work belongs to, and where its files live (Multi-Account phase 1, 2026-11-05;
spec: the vault note "Multi-Account (Build Spec)").

Every account gets its own folder, data/accounts/<account id>/, for everything personal: chats, notes,
calendar, memory, bots and Kip, routines, connections and keys. Isolation comes from the folder, not from
filtering records by owner, so code that never heard of accounts still only sees its own account's files.

- The current account is set per request (core/middleware.py's AccountContextMiddleware) from the existing
  sign-in check, and per job for background work (as_account). A request or job with no account has none:
  account_dir() refuses rather than guessing.
- Account ids are random folder-safe names kept on each account's record (core/auth.py), never user names:
  Windows treats "David" and "david" as one folder.
- Accounts off: the single local user is the first admin's account, or "local" while there are no accounts.
  The first account created on such an install takes the "local" folder over, so turning accounts on or off
  never splits one person's data (decision D7).

Phase 1 adds the resolver and nothing reads from it yet; phase 2 moves each store into the account folder
together with the code change that reads it from there (core/account_migration.py).
"""
import contextvars
import os
import re
from contextlib import contextmanager
from typing import Iterator, Optional

from core.constants import DATA_DIR

ACCOUNTS_DIR = os.path.join(DATA_DIR, "accounts")
LOCAL_ID = "local"
_VALID_ID = re.compile(r"[a-z0-9]{1,32}")

_current: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("kairos_account", default=None)


class NoAccount(RuntimeError):
    """Personal data was asked for with no account set: a request with no sign-in, or background work
    that did not say whose it is."""


def _checked(account_id: str) -> str:
    if not isinstance(account_id, str) or not _VALID_ID.fullmatch(account_id):
        raise ValueError(f"not an account id: {account_id!r}")
    return account_id


def local_account() -> str:
    """The account the single local user (accounts off) works in."""
    from core.auth import auth_manager
    return auth_manager.first_admin_account() or LOCAL_ID


def account_for_user(username: Optional[str]) -> Optional[str]:
    """The account id for a signed-in user name, or None for no user or one that no longer exists."""
    from core.auth import SINGLE_USER, auth_manager
    if not username:
        return None
    if username == SINGLE_USER:
        return local_account()
    return auth_manager.account_id(username)


def current_account() -> Optional[str]:
    return _current.get()


def account_dir(account_id: Optional[str] = None, create: bool = True) -> str:
    """The folder of an account: the given one, else the current one. Raises NoAccount when there is none."""
    account_id = account_id or _current.get()
    if not account_id:
        raise NoAccount("no account is set for this work")
    path = os.path.join(ACCOUNTS_DIR, _checked(account_id))
    if create:
        os.makedirs(path, exist_ok=True)
    return path


def set_current(account_id: Optional[str]) -> contextvars.Token:
    """Set the current account (None for none); returns the token for reset_current."""
    return _current.set(_checked(account_id) if account_id else None)


def reset_current(token: contextvars.Token) -> None:
    _current.reset(token)


@contextmanager
def as_account(account_id: str) -> Iterator[str]:
    """Run background work (a routine, Kip's watch, a channel message) as one account."""
    token = set_current(account_id)
    try:
        yield account_id
    finally:
        _current.reset(token)


def all_accounts() -> list[str]:
    """Every account on this install, for background work that loops over them: each account's id, or
    just "local" while there are no accounts."""
    from core.auth import auth_manager
    ids = auth_manager.account_ids()
    return ids or [LOCAL_ID]
