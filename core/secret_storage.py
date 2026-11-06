"""Symmetric encryption for secrets-at-rest (email account passwords, etc.),
matching the "encrypted-at-rest credentials" requirement from the Odysseus
reference research. Keys are generated once on first use and never logged or
returned to any API response.

Two kinds of key (Multi-Account phase 3):
- The install key, data/.secret_key. Everything that belongs to the whole install (the shared Google
  app's client secret, the avatar and GitHub accounts, bot keys) is encrypted with it, and so was every
  value written before accounts had their own key.
- One key per account, data/accounts/<id>/.secret_key. encrypt() uses the current account's, so one
  account's stored passwords and tokens can't be opened by another. The first admin's account key is a
  byte-for-byte copy of the install key, so what was encrypted before this change keeps decrypting.

decrypt() tries the current account's key, then the install key (values from before accounts had keys).
Install-level files that hold an account's secret (a Discord bot, a connector) are read at start-up with no
account set, so they use encrypt_for/decrypt_for with the record's own account.
"""
import os
import threading

from cryptography.fernet import Fernet, InvalidToken

from core.constants import DATA_DIR

KEY_NAME = ".secret_key"
_KEY_FILE = os.path.join(DATA_DIR, KEY_NAME)

# A test may set this to one Fernet that then stands in for every key.
_fernet: Fernet | None = None

_cache: dict[str, Fernet] = {}
_lock = threading.RLock()


def _read_or_create(path: str, make) -> Fernet:
    """The Fernet for a key file, created from make() when absent; one cached instance per file."""
    with _lock:
        cached = _cache.get(path)
        if cached is not None and os.path.exists(path):
            return cached
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if os.path.exists(path):
            with open(path, "rb") as f:
                key = f.read()
        else:
            key = make()
            tmp = path + ".tmp"
            with open(tmp, "wb") as f:
                f.write(key)
            try:
                os.chmod(tmp, 0o600)  # no-op on Windows, real restriction on POSIX
            except OSError:
                pass
            os.replace(tmp, path)
        fernet = _cache[path] = Fernet(key)
        return fernet


def _install_fernet() -> Fernet:
    if _fernet is not None:
        return _fernet
    return _read_or_create(_KEY_FILE, Fernet.generate_key)


def _get_fernet() -> Fernet:
    """The install key's Fernet (kept under its old name)."""
    return _install_fernet()


def account_key_file(account_id: str) -> str:
    from core import accounts
    return os.path.join(accounts.account_dir(account_id, create=False), KEY_NAME)


def _account_fernet(account_id: str) -> Fernet:
    if _fernet is not None:
        return _fernet
    from core import accounts

    def make() -> bytes:
        if account_id == accounts.local_account():
            return _install_key_bytes()  # the first admin keeps the key their data was encrypted with
        return Fernet.generate_key()

    return _read_or_create(account_key_file(account_id), make)


def _install_key_bytes() -> bytes:
    _install_fernet()  # makes the file if it is the first use
    with open(_KEY_FILE, "rb") as f:
        return f.read()


def _current_fernet() -> Fernet:
    from core import accounts
    try:
        return _account_fernet(accounts.effective_account())
    except accounts.NoAccount:
        return _install_fernet()


def _encrypt(fernet: Fernet, plaintext: str) -> str:
    return fernet.encrypt(plaintext.encode("utf-8")).decode("utf-8")


def _decrypt(first: Fernet, ciphertext: str) -> str:
    data = ciphertext.encode("utf-8")
    try:
        return first.decrypt(data).decode("utf-8")
    except InvalidToken:
        fallback = _install_fernet()
        if fallback is first:
            raise
        return fallback.decrypt(data).decode("utf-8")


def encrypt(plaintext: str) -> str:
    return _encrypt(_current_fernet(), plaintext)


def decrypt(ciphertext: str) -> str:
    return _decrypt(_current_fernet(), ciphertext)


def encrypt_for(account_id: str, plaintext: str) -> str:
    return _encrypt(_account_fernet(account_id), plaintext)


def decrypt_for(account_id: str, ciphertext: str) -> str:
    return _decrypt(_account_fernet(account_id), ciphertext)


def encrypt_install(plaintext: str) -> str:
    return _encrypt(_install_fernet(), plaintext)


def decrypt_install(ciphertext: str) -> str:
    return _decrypt(_install_fernet(), ciphertext)
