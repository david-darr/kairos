"""Owner-scoped attention projections. No task or approval authority lives here.

Connections are short lived so test fixtures, backups and Windows shutdown can
close the database cleanly. A source receipt outlives feed retention, preventing
an old source from alerting again when its feed row has been pruned.
"""
import hashlib
import json
import os
import sqlite3
import threading
import time
from contextlib import contextmanager

from typing import Optional

from core import accounts

DB_FILE: Optional[str] = None  # a test can point it at its own file
_LOCK = threading.RLock()


def db_file() -> str:
    return DB_FILE or accounts.path("bot-attention.sqlite3")


@contextmanager
def database():
    with _LOCK:
        path = db_file()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        db = sqlite3.connect(path, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS receipts (
                    owner TEXT NOT NULL, source TEXT NOT NULL, at REAL NOT NULL,
                    PRIMARY KEY(owner,source));
                CREATE TABLE IF NOT EXISTS notifications (
                    owner TEXT NOT NULL, id TEXT NOT NULL, at REAL NOT NULL,
                    data TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0,
                    pinned INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner,id));
                CREATE TABLE IF NOT EXISTS inbox_state (
                    owner TEXT NOT NULL, id TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0,
                    done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner,id));
                CREATE TABLE IF NOT EXISTS observations (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL,
                    id TEXT NOT NULL, bot TEXT NOT NULL, session TEXT,
                    at REAL NOT NULL, data TEXT NOT NULL, UNIQUE(owner,id));
                CREATE INDEX IF NOT EXISTS observation_thread ON observations(owner,session,at);
                CREATE INDEX IF NOT EXISTS observation_bot ON observations(owner,bot,at);
            """)
            with db:
                yield db
        finally:
            db.close()


def stable_id(*parts):
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False, sort_keys=True,
                                    default=str).encode()).hexdigest()[:32]


def publish(owner, source, row):
    """Atomically receipt a source and retain the newest 500 feed rows."""
    ident = stable_id(owner, source)
    at = float(row.get("at") or time.time())
    with database() as db:
        inserted = db.execute("INSERT OR IGNORE INTO receipts VALUES(?,?,?)", (owner, source, at)).rowcount
        if not inserted:
            return None
        data = {**row, "id": ident, "source_id": source, "at": at}
        db.execute("INSERT INTO notifications(owner,id,at,data) VALUES(?,?,?,?)",
                   (owner, ident, at, json.dumps(data, ensure_ascii=False)))
        db.execute("DELETE FROM notifications WHERE owner=? AND id NOT IN "
                   "(SELECT id FROM notifications WHERE owner=? ORDER BY at DESC,id DESC LIMIT 500)", (owner, owner))
    return data


def publish_many(owner, items):
    """publish() for many (source, row) pairs in one transaction. Returns the rows newly receipted."""
    if not items:
        return []
    made = []
    with database() as db:
        for source, row in items:
            ident = stable_id(owner, source)
            at = float(row.get("at") or time.time())
            if not db.execute("INSERT OR IGNORE INTO receipts VALUES(?,?,?)", (owner, source, at)).rowcount:
                continue
            data = {**row, "id": ident, "source_id": source, "at": at}
            db.execute("INSERT INTO notifications(owner,id,at,data) VALUES(?,?,?,?)",
                       (owner, ident, at, json.dumps(data, ensure_ascii=False)))
            made.append(data)
        if made:
            db.execute("DELETE FROM notifications WHERE owner=? AND id NOT IN "
                       "(SELECT id FROM notifications WHERE owner=? ORDER BY at DESC,id DESC LIMIT 500)", (owner, owner))
    return made


def notifications(owner):
    with database() as db:
        rows = db.execute("SELECT * FROM notifications WHERE owner=? ORDER BY pinned DESC,at DESC,id DESC",
                          (owner,)).fetchall()
    return [{**json.loads(r["data"]), "read": bool(r["read"]), "pinned": bool(r["pinned"])} for r in rows]


def update_notification(owner, ident, *, read=None, pinned=None):
    with database() as db:
        if not db.execute("SELECT 1 FROM notifications WHERE owner=? AND id=?", (owner, ident)).fetchone():
            return False
        for key, value in (("read", read), ("pinned", pinned)):
            if value is not None:
                db.execute(f"UPDATE notifications SET {key}=? WHERE owner=? AND id=?", (int(value), owner, ident))
    return True


def read_all(owner):
    with database() as db:
        db.execute("UPDATE notifications SET read=1 WHERE owner=?", (owner,))


def read_thread(owner, session_id, message_id=None, ancestry=None):
    """Read only targets actually visited. U1 supplies selected ancestry IDs."""
    for row in notifications(owner):
        target = row.get("target") or {}
        if target.get("sessionId") != session_id:
            continue
        mid = target.get("messageId")
        if mid and mid != message_id and (ancestry is None or mid not in ancestry):
            continue
        update_notification(owner, row["id"], read=True)
        if row.get("inbox_id"):
            set_inbox(owner, row["inbox_id"], read=True)


def inbox_preferences(owner):
    with database() as db:
        return {r["id"]: {"read": bool(r["read"]), "done": bool(r["done"])} for r in
                db.execute("SELECT * FROM inbox_state WHERE owner=?", (owner,))}


def set_inbox(owner, ident, *, read=None, done=None):
    with database() as db:
        db.execute("INSERT OR IGNORE INTO inbox_state(owner,id) VALUES(?,?)", (owner, ident))
        for key, value in (("read", read), ("done", done)):
            if value is not None:
                db.execute(f"UPDATE inbox_state SET {key}=? WHERE owner=? AND id=?", (int(value), owner, ident))
        if read:
            for row in db.execute("SELECT id,data FROM notifications WHERE owner=?", (owner,)).fetchall():
                if json.loads(row["data"]).get("inbox_id") == ident:
                    db.execute("UPDATE notifications SET read=1 WHERE owner=? AND id=?", (owner, row["id"]))


def observe(owner, ident, bot, session, at, data):
    with database() as db:
        db.execute("INSERT OR IGNORE INTO observations(owner,id,bot,session,at,data) VALUES(?,?,?,?,?,?)",
                   (owner, ident, bot, session, at, json.dumps(data, ensure_ascii=False)))
        db.execute("DELETE FROM observations WHERE owner=? AND (at<? OR seq NOT IN "
                   "(SELECT seq FROM observations WHERE owner=? ORDER BY at DESC,seq DESC LIMIT 4000))",
                   (owner, time.time() - 30 * 86400, owner))


def observations(owner, *, bot=None, session=None, limit=400):
    where, args = ["owner=?"], [owner]
    for key, value in (("bot", bot), ("session", session)):
        if value is not None:
            where.append(f"{key}=?")
            args.append(value)
    with database() as db:
        clause = " AND ".join(where)
        total = db.execute(f"SELECT count(*) FROM observations WHERE {clause}", args).fetchone()[0]
        rows = db.execute(f"SELECT data FROM observations WHERE {clause} ORDER BY at DESC,seq DESC LIMIT ?",
                          (*args, max(1, min(limit, 400)))).fetchall()
    return {"entries": [json.loads(r[0]) for r in rows], "total": total}
