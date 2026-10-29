"""Authenticated, streaming workspace envelopes over core.backup's staged swap.

Header: magic + uint32 JSON length + canonical JSON. Ciphertext follows, with
the GCM tag as the last 16 bytes. Header bytes are authenticated as AAD.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import sqlite3
import struct
import sys
import time
import uuid
import zipfile

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from core import backup
from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR

MAGIC = b"KAIROSB1"
MAX_BYTES = 10 * 1024 ** 3
MAX_ENTRIES = 100_000
N, R, P = 2 ** 17, 8, 1
CHUNK = 1024 * 1024


def _folder():
    root = Path(DATA_DIR) / "bot_lifecycle" / "backups"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _password(password):
    if not isinstance(password, str) or not 12 <= len(password) <= 1024:
        raise ValueError("Use a backup password of 12 to 1,024 characters")


def _key(password, salt):
    _password(password)
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=N, r=R, p=P, dklen=32, maxmem=256 * 1024 * 1024)


def _private(path):
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _scratch():
    # Inherit directory ACLs on Windows; Python's 0700 temp ACL denies the
    # restricted runtime token there. Files themselves are private on POSIX.
    path = _folder() / ("scratch-" + uuid.uuid4().hex)
    path.mkdir()
    return path


def export(password, target):
    _password(password)
    scratch = _scratch()
    try:
        plain = scratch / "workspace.zip"
        manifest = backup.make_backup(str(plain), include_keys=False)
        _private(plain)
        backup.check_backup(str(plain))
        with zipfile.ZipFile(plain) as archive:
            entries = len(archive.infolist())
            expanded = sum(i.file_size for i in archive.infolist())
        if plain.stat().st_size > MAX_BYTES or expanded > MAX_BYTES or entries > MAX_ENTRIES:
            raise ValueError("Backup exceeds the workspace limit")
        salt, nonce = secrets.token_bytes(16), secrets.token_bytes(12)
        header = json.dumps({"format": "kairos.backup", "version": 1, "n": N, "r": R, "p": P,
                             "salt": base64.b64encode(salt).decode(), "nonce": base64.b64encode(nonce).decode(),
                             "bytes": plain.stat().st_size, "expanded_bytes": expanded, "entries": entries},
                            sort_keys=True, separators=(",", ":")).encode()
        prefix = MAGIC + struct.pack(">I", len(header)) + header
        encryptor = Cipher(algorithms.AES(_key(password, salt)), modes.GCM(nonce)).encryptor()
        encryptor.authenticate_additional_data(prefix)
        with plain.open("rb") as source, open(target, "wb") as dest:
            _private(target)
            dest.write(prefix)
            while block := source.read(CHUNK):
                dest.write(encryptor.update(block))
            dest.write(encryptor.finalize()); dest.write(encryptor.tag)
        return manifest
    except Exception:
        Path(target).unlink(missing_ok=True)
        raise
    finally:
        shutil.rmtree(scratch)


def _decrypt(source, password, dest):
    _password(password)
    source = Path(source)
    if source.stat().st_size > MAX_BYTES + 4096 + 28:
        raise ValueError("Backup exceeds 10 GB")
    try:
        with source.open("rb") as file:
            prefix = file.read(12)
            if len(prefix) != 12 or prefix[:8] != MAGIC:
                raise ValueError("Choose a Kairos .kbackup file")
            length = struct.unpack(">I", prefix[8:])[0]
            if not 1 <= length <= 4096:
                raise ValueError("Invalid backup header")
            raw = file.read(length)
            header = json.loads(raw)
            if (header.get("format") != "kairos.backup" or header.get("version") != 1
                    or (header.get("n"), header.get("r"), header.get("p")) != (N, R, P)
                    or any(type(header.get(k)) is not int or not 0 <= header[k] <= limit for k, limit in
                           (("bytes", MAX_BYTES), ("expanded_bytes", MAX_BYTES), ("entries", MAX_ENTRIES)))):
                raise ValueError("Backup parameters exceed the limit")
            size = header["bytes"]
            if source.stat().st_size != 12 + length + size + 16:
                raise ValueError("Backup size does not match its header")
            salt = base64.b64decode(header["salt"], validate=True)
            nonce = base64.b64decode(header["nonce"], validate=True)
            if len(salt) != 16 or len(nonce) != 12:
                raise ValueError("Invalid backup salt or nonce")
            file.seek(-16, 2); tag = file.read(16); file.seek(12 + length)
            decryptor = Cipher(algorithms.AES(_key(password, salt)), modes.GCM(nonce, tag)).decryptor()
            decryptor.authenticate_additional_data(prefix + raw)
            with open(dest, "wb") as out:
                _private(dest)
                remaining = size
                while remaining:
                    block = file.read(min(CHUNK, remaining))
                    if not block:
                        raise ValueError("Incomplete backup")
                    remaining -= len(block); out.write(decryptor.update(block))
                out.write(decryptor.finalize())
        manifest = backup.check_backup(str(dest))
        with zipfile.ZipFile(dest) as archive:
            if len(archive.infolist()) != header["entries"] or sum(i.file_size for i in archive.infolist()) != header["expanded_bytes"]:
                raise ValueError("Backup contents do not match the header")
        return manifest
    except InvalidTag:
        raise ValueError("Password is wrong or the backup is damaged") from None
    except (KeyError, TypeError, UnicodeError, json.JSONDecodeError):
        raise ValueError("Invalid backup header") from None
    except zipfile.BadZipFile:
        raise ValueError("The backup is damaged") from None


def _counts(path):
    counts = {"bots": 0, "routines": 0, "chats": 0, "triggers": 0}
    with zipfile.ZipFile(path) as archive:
        for filename, key in (("agents.json", "bots"), ("tasks.json", "routines"), ("triggers.json", "triggers")):
            if filename not in archive.namelist():
                continue
            if archive.getinfo(filename).file_size > 16 * 1024 * 1024:
                raise ValueError("Backup index is too large")
            value = json.loads(archive.read(filename))
            if key == "triggers":
                value = value.get("triggers", {})
            if key == "routines":
                value = [v for v in value.values() if v.get("schedule_kind") != "card"]
            counts[key] = len(value)
        for filename in ("sessions.db", "sessions.sqlite3"):
            if filename in archive.namelist():
                scratch = Path(path).parent / "count.sqlite3"
                with archive.open(filename) as src, scratch.open("wb") as dest:
                    shutil.copyfileobj(src, dest, CHUNK)
                try:
                    db = sqlite3.connect(f"file:{scratch.as_posix()}?mode=ro&immutable=1", uri=True)
                    try:
                        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").fetchone():
                            counts["chats"] = db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
                    finally:
                        db.close()
                finally:
                    scratch.unlink(missing_ok=True)
                break
    return counts


def preview(source, password, *, owner_user=None):
    scratch = _scratch()
    try:
        plain = scratch / "workspace.zip"
        manifest = _decrypt(source, password, plain)
        counts = _counts(plain)
        for meta in _folder().glob("*.json"):
            if meta.stat().st_mtime < time.time() - 3600:
                meta.with_suffix(".kbackup").unlink(missing_ok=True); meta.unlink(missing_ok=True)
        if len(list(_folder().glob("*.json"))) >= 3:
            raise ValueError("Too many pending backups. Try again later")
        ident = uuid.uuid4().hex
        target = _folder() / f"{ident}.kbackup"
        shutil.copyfile(source, target); _private(target)
        write_json_atomic(str(target.with_suffix(".json")), {"owner": owner_user, "at": time.time()}); _private(target.with_suffix(".json"))
        return {"upload_id": ident, "manifest": manifest, "counts": counts}
    finally:
        shutil.rmtree(scratch)


def server_busy():
    # Inspect live modules only. Importing a scheduler here could load stores.
    live = sys.modules.get("services.chat_live")
    if live and any(r.get("status") == "processing" for r in live.snapshot().get("runs", {}).values()):
        return True
    computer = sys.modules.get("core.computer")
    if computer and computer.running():
        return True
    scheduler = sys.modules.get("core.task_scheduler")
    if scheduler and (getattr(scheduler, "_running", {}) or getattr(scheduler, "_scheduled", set())):
        return True
    return False


def restore(upload_id, password, confirm, *, owner_user=None):
    import re
    if confirm != "REPLACE":
        raise ValueError("Type REPLACE to restore this workspace")
    if not re.fullmatch(r"[a-f0-9]{32}", upload_id or ""):
        raise ValueError("Invalid backup preview")
    source = _folder() / f"{upload_id}.kbackup"
    meta = read_json(str(source.with_suffix(".json")), {})
    if not source.is_file() or meta.get("owner") != owner_user or meta.get("at", 0) < time.time() - 3600:
        raise ValueError("Backup preview expired. Upload it again")
    if server_busy():
        raise ValueError("Wait for running work and computers to stop before restoring")
    scratch = _scratch()
    try:
        plain = scratch / "workspace.zip"
        _decrypt(source, password, plain)
        if server_busy():
            raise ValueError("Wait for running work and computers to stop before restoring")
        manifest = backup.stage_restore(str(plain), disable_automations=True)
        source.unlink(); source.with_suffix(".json").unlink()
        return {"restart_required": True, "manifest": manifest, "disable_automations": True}
    finally:
        shutil.rmtree(scratch)
