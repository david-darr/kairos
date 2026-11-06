"""Which account a piece of work belongs to, and where its files live (Multi-Account phase 1, 2026-11-05;
spec: the vault note "Multi-Account (Build Spec)").

Every account gets its own folder, data/accounts/<account id>/, for everything personal: chats, notes,
calendar, memory, bots and Kip, routines, connections and keys. Isolation comes from the folder, not from
filtering records by owner, so code that never heard of accounts still only sees its own account's files.

- The current account is set per request (core/middleware.py's AccountContextMiddleware) from the existing
  sign-in check or a model tool call's turn token, and per job for background work (as_account). A request
  with nobody signed in has no account: account_dir() refuses (the app answers 401), never guesses.
- Background work that has not been made per-account yet (it sets no account at all) works in the first
  admin's account, which is where all background work ran before accounts had folders. Each phase 2 group
  that moves a background loop to as_account() removes one such caller.
- Account ids are random folder-safe names kept on each account's record (core/auth.py), never user names:
  Windows treats "David" and "david" as one folder.
- Accounts off: the single local user is the first admin's account, or "local" while there are no accounts.
  The first account created on such an install takes the "local" folder over, so turning accounts on or off
  never splits one person's data (decision D7).

Phase 2 moves each store into the account folder together with the code change that reads it from there
(core/account_migration.py): a store asks for path("notes.json"), and a service that keeps its store in
memory sits behind PerAccount, one instance per account under the same name.
"""
import contextvars
import os
import re
import threading
from contextlib import contextmanager
from typing import Iterator, Optional

from core.constants import DATA_DIR

ACCOUNTS_DIR = os.path.join(DATA_DIR, "accounts")
LOCAL_ID = "local"
_VALID_ID = re.compile(r"[a-z0-9]{1,32}")

# None: no request set anything (background work, start-up). NOBODY: a request with nobody signed in.
NOBODY = ""
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
    """The account set for this request or job, or None when none is."""
    return _current.get() or None


def effective_account() -> str:
    """The account whose data this work reads and writes: the one set, else, for background work that has
    not been made per-account yet, the first admin's. A request with nobody signed in raises NoAccount."""
    account_id = _current.get()
    if account_id:
        return account_id
    if account_id == NOBODY:
        raise NoAccount("nobody is signed in")
    return local_account()


def account_dir(account_id: Optional[str] = None, create: bool = True) -> str:
    """The folder of an account: the given one, else effective_account()'s."""
    path = os.path.join(ACCOUNTS_DIR, _checked(effective_account() if account_id is None else account_id))
    if create:
        os.makedirs(path, exist_ok=True)
    return path


def path(*parts: str) -> str:
    """Where a store's file or folder is: inside the current account's folder once the migration has moved
    it (path("notes.json"), path("documents")), else the shared place it always had (core/account_migration.py)."""
    from core import account_migration
    if parts and parts[0] not in account_migration.moved_names():
        return os.path.join(DATA_DIR, *parts)
    return os.path.join(account_dir(), *parts)


def set_current(account_id: Optional[str]) -> contextvars.Token:
    """Set the account for a request (None: nobody is signed in); returns the token for reset_current."""
    return _current.set(_checked(account_id) if account_id else NOBODY)


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


class PerAccount:
    """One instance of a service per data file, behind the name the rest of the app already imports.

    notes_service = PerAccount(NotesService, notes_file) makes every notes_service.x() go to the current
    account's NotesService, created on first use from notes_file()'s path. Keyed by the path rather than
    the account, so a test that points the store at its own file gets its own instance too."""

    __slots__ = ("_factory", "_path_for", "_instances", "_lock")

    def __init__(self, factory, path_for):
        object.__setattr__(self, "_factory", factory)
        object.__setattr__(self, "_path_for", path_for)
        object.__setattr__(self, "_instances", {})
        object.__setattr__(self, "_lock", threading.Lock())

    def current(self):
        path = self._path_for()
        with self._lock:
            instance = self._instances.get(path)
            if instance is None:
                instance = self._instances[path] = self._factory(path)
        return instance

    def forget(self) -> None:
        """Drop every loaded instance (after a restore, or an account's data being removed)."""
        with self._lock:
            self._instances.clear()

    def __getattr__(self, name):
        return getattr(self.current(), name)

    def __setattr__(self, name, value):
        setattr(self.current(), name, value)

    def __delattr__(self, name):  # so patching a method (unittest.mock) also unpatches cleanly
        delattr(self.current(), name)

    @property
    def __dict__(self):  # the current instance's, so nested patches restore what they replaced
        return self.current().__dict__
