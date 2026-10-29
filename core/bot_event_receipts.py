"""Bots Phase 3 U4: durable receipts, attempts and subscriptions for outside events (2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-3-design.md, sections 4.3, 6 and 9.

One SQLite file, `bot_automation_events.sqlite3`, holds what must survive a
restart so an event is never lost and never run twice:

- receipts: one row per accepted delivery, unique on (source, source_id, key).
  The row is written BEFORE the sender is told "accepted", so a restart cannot
  let a retried delivery through again. It also keeps the safe event envelopes
  until they are handed to the run engine, so a crash between "accepted" and
  "queued" is retried, and an event that keeps failing is parked as poison
  after five attempts instead of looping forever.
- attempts: redacted history for the webhook page (2,000 kept, latest 30 shown).
- samples: the one captured sample per webhook (capture mode).
- subscriptions: connected-app event subscriptions, with their cursor.
- deleted webhooks: soft deletion for seven days, at most 50 kept.

Webhook definitions stay in `triggers.json` (no second registry). Secrets never
enter this file in the clear: a buried webhook keeps its already encrypted
secret field, and every stored message passes `redact()`.
"""
from __future__ import annotations

import copy
import json
import os
import re
import sqlite3
import threading
import time
import uuid
from typing import Optional

from core.constants import DATA_DIR

DB_FILE = os.path.join(DATA_DIR, "bot_automation_events.sqlite3")
SCHEMA_VERSION = 1

MAX_ATTEMPTS_KEPT = 2000
ATTEMPTS_SHOWN = 30
MAX_DELIVERY_TRIES = 5          # the fifth failed hand-off parks the event as poison
PENDING_TTL_SECONDS = 3600      # an unsettled receipt older than this no longer holds a pending slot
RECEIPT_KEEP_SECONDS = 30 * 24 * 3600
RESTORE_WINDOW_SECONDS = 7 * 24 * 3600
MAX_DELETED = 50
MAX_OPEN_RECEIPTS = 10        # accepted-but-waiting batches per source; a flood past this is dropped
SAMPLE_LIMIT = 16_000
DETAIL_LIMIT = 300

# Receipt statuses. `accepted` = durable, not yet handed to the run engine.
OPEN_STATUSES = ("accepted", "enqueued")
SETTLED_STATUSES = ("done", "dropped", "poison")

_SECRETISH = re.compile(r"(?i)\b(bearer\s+\S+|sha256=[0-9a-f]{16,}|(?:secret|token|password|key|credential)[=:]\s*\S+)")
_LONG_TOKEN = re.compile(r"[A-Za-z0-9_\-]{32,}")
_ADDRESS = re.compile(r"/api/bot-webhooks/in/[^\s\"']+")


def redact(text) -> str:
    """Strip anything that looks like a credential from text that will be stored or shown."""
    out = str(text or "")
    out = _ADDRESS.sub("[address]", out)
    out = _SECRETISH.sub("[hidden]", out)
    out = _LONG_TOKEN.sub("[hidden]", out)
    return out[:DETAIL_LIMIT]


class ReceiptStore:
    def __init__(self, path: Optional[str] = None) -> None:
        self.path = path or DB_FILE
        self._lock = threading.RLock()
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        with self._connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
                CREATE TABLE IF NOT EXISTS receipts (
                    id TEXT PRIMARY KEY, owner TEXT NOT NULL, source TEXT NOT NULL, source_id TEXT NOT NULL,
                    dedupe_key TEXT NOT NULL, event_type TEXT, summary TEXT, status TEXT NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0, detail TEXT, events TEXT,
                    created_at REAL NOT NULL, updated_at REAL NOT NULL, run_ref TEXT,
                    UNIQUE (source, source_id, dedupe_key));
                CREATE INDEX IF NOT EXISTS receipts_open ON receipts (source_id, status);
                CREATE TABLE IF NOT EXISTS event_marks (
                    source_id TEXT NOT NULL, event_id TEXT NOT NULL, at REAL NOT NULL, PRIMARY KEY (source_id, event_id));
                CREATE TABLE IF NOT EXISTS attempts (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, source_id TEXT NOT NULL,
                    owner TEXT, at REAL NOT NULL, outcome TEXT NOT NULL, event_type TEXT, delivery TEXT,
                    status_code INTEGER, detail TEXT);
                CREATE INDEX IF NOT EXISTS attempts_source ON attempts (source_id, seq);
                CREATE TABLE IF NOT EXISTS samples (
                    source_id TEXT PRIMARY KEY, owner TEXT, at REAL, content_type TEXT, kind TEXT, body TEXT);
                CREATE TABLE IF NOT EXISTS subscriptions (
                    id TEXT PRIMARY KEY, owner TEXT NOT NULL, bot_id TEXT, deleted_at REAL, blob TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS deleted_webhooks (
                    id TEXT PRIMARY KEY, owner TEXT NOT NULL, deleted_at REAL NOT NULL, blob TEXT NOT NULL);
            """)
            db.execute("INSERT OR IGNORE INTO meta (k, v) VALUES ('schema_version', ?)", (str(SCHEMA_VERSION),))

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA busy_timeout=15000")
        return _Closing(db)

    # -- receipts ------------------------------------------------------------------

    @staticmethod
    def _receipt(row) -> Optional[dict]:
        if row is None:
            return None
        out = dict(row)
        out["events"] = json.loads(out["events"]) if out.get("events") else []
        return out

    def claim(self, owner: str, source: str, source_id: str, key: str, *, event_type: str = "", summary: str = "",
              events: Optional[list] = None) -> tuple[dict, bool]:
        """(receipt, created). created is False for a delivery already seen: durable deduplication.
        The row is committed before this returns, so callers acknowledge only after it."""
        now = time.time()
        rid = uuid.uuid4().hex[:16]
        with self._lock, self._connect() as db:
            cur = db.execute(
                "INSERT OR IGNORE INTO receipts (id, owner, source, source_id, dedupe_key, event_type, summary, status,"
                " attempts, events, created_at, updated_at) VALUES (?,?,?,?,?,?,?, 'accepted', 0, ?, ?, ?)",
                (rid, owner, source, source_id, key[:200], event_type[:100], redact(summary),
                 json.dumps(events or [], ensure_ascii=False), now, now))
            row = db.execute("SELECT * FROM receipts WHERE source=? AND source_id=? AND dedupe_key=?",
                             (source, source_id, key[:200])).fetchone()
            return self._receipt(row), cur.rowcount == 1

    def accept_events(self, owner: str, source: str, source_id: str, events: list, *, max_events: int,
                      max_chars: int, summary: str = "", merge_into_open: int = 20) -> list[dict]:
        """Durably accept a burst of event envelopes in ONE transaction: drop events already marked
        for this source (a replayed poll never repeats), merge the rest into the newest receipt that
        has not been handed off yet when it has room (a burst becomes one run, not many), and open new
        receipts, each within the batch caps, for what is left. Returns the receipts touched."""
        now = time.time()
        touched: dict[str, dict] = {}
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                fresh = []
                for event in events:
                    cur = db.execute("INSERT OR IGNORE INTO event_marks (source_id, event_id, at) VALUES (?,?,?)",
                                     (source_id, str(event["id"])[:200], now))
                    if cur.rowcount == 1:
                        fresh.append(event)
                size = lambda batch: len(json.dumps(batch, ensure_ascii=False))
                queue = list(fresh)
                if queue and merge_into_open:
                    row = db.execute("SELECT * FROM receipts WHERE source=? AND source_id=? AND status='accepted'"
                                     " AND attempts=0 ORDER BY created_at DESC LIMIT 1", (source, source_id)).fetchone()
                    if row is not None:
                        have = json.loads(row["events"] or "[]")
                        while queue and len(have) < max_events and size(have + [queue[0]]) <= max_chars:
                            have.append(queue.pop(0))
                        if len(have) != len(json.loads(row["events"] or "[]")):
                            db.execute("UPDATE receipts SET events=?, updated_at=?, summary=? WHERE id=?",
                                       (json.dumps(have, ensure_ascii=False), now, redact(summary), row["id"]))
                            touched[row["id"]] = dict(row)
                open_now = db.execute("SELECT COUNT(*) FROM receipts WHERE source=? AND source_id=? AND status='accepted'"
                                      " AND events != '[]'", (source, source_id)).fetchone()[0]
                while queue and open_now < MAX_OPEN_RECEIPTS:
                    open_now += 1
                    batch: list = []
                    while queue and len(batch) < max_events and (not batch or size(batch + [queue[0]]) <= max_chars):
                        batch.append(queue.pop(0))
                    rid = uuid.uuid4().hex[:16]
                    db.execute("INSERT INTO receipts (id, owner, source, source_id, dedupe_key, event_type, summary, status,"
                               " attempts, events, created_at, updated_at) VALUES (?,?,?,?,?,?,?, 'accepted', 0, ?, ?, ?)",
                               (rid, owner, source, source_id, f"batch:{rid}", str(batch[0].get("type", ""))[:100],
                                redact(summary), json.dumps(batch, ensure_ascii=False), now, now))
                    touched[rid] = {"id": rid}
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise
        db_ids = list(touched)
        return [self.get(i) for i in db_ids]

    def enqueued(self, source_id: str) -> list[dict]:
        cutoff = time.time() - PENDING_TTL_SECONDS
        with self._connect() as db:
            rows = db.execute("SELECT * FROM receipts WHERE source_id=? AND status='enqueued' AND updated_at > ?",
                              (source_id, cutoff)).fetchall()
        return [self._receipt(r) for r in rows]

    def prune_marks(self) -> None:
        with self._lock, self._connect() as db:
            db.execute("DELETE FROM event_marks WHERE at < ?", (time.time() - RECEIPT_KEEP_SECONDS,))

    def expire(self, source: str, source_id: str, key: str, older_than: float) -> None:
        """Forget one settled delivery older than this, so a hash-keyed repeat after the window is new."""
        with self._lock, self._connect() as db:
            db.execute("DELETE FROM receipts WHERE source=? AND source_id=? AND dedupe_key=? AND created_at < ?"
                       " AND status IN ('done','dropped','poison')", (source, source_id, key[:200], time.time() - older_than))

    def seen(self, source: str, source_id: str, key: str) -> bool:
        with self._connect() as db:
            return db.execute("SELECT 1 FROM receipts WHERE source=? AND source_id=? AND dedupe_key=?",
                              (source, source_id, key[:200])).fetchone() is not None

    def get(self, receipt_id: str) -> Optional[dict]:
        with self._connect() as db:
            return self._receipt(db.execute("SELECT * FROM receipts WHERE id=?", (receipt_id,)).fetchone())

    def set_events(self, receipt_id: str, events: list) -> None:
        with self._lock, self._connect() as db:
            db.execute("UPDATE receipts SET events=?, updated_at=? WHERE id=?",
                       (json.dumps(events, ensure_ascii=False), time.time(), receipt_id))

    def set_status(self, receipt_id: str, status: str, detail: str = "", run_ref: Optional[str] = None) -> None:
        with self._lock, self._connect() as db:
            db.execute("UPDATE receipts SET status=?, detail=?, run_ref=COALESCE(?, run_ref), updated_at=? WHERE id=?",
                       (status, redact(detail), run_ref, time.time(), receipt_id))
            if status in SETTLED_STATUSES:
                db.execute("UPDATE receipts SET events='[]' WHERE id=?", (receipt_id,))  # nothing left to retry

    def fail(self, receipt_id: str, error: str) -> str:
        """One failed hand-off. The fifth parks the receipt as poison; earlier ones leave it retryable."""
        with self._lock, self._connect() as db:
            row = db.execute("SELECT attempts FROM receipts WHERE id=?", (receipt_id,)).fetchone()
            if row is None:
                return "missing"
            tries = row["attempts"] + 1
            status = "poison" if tries >= MAX_DELIVERY_TRIES else "accepted"
            db.execute("UPDATE receipts SET attempts=?, status=?, detail=?, updated_at=? WHERE id=?",
                       (tries, status, redact(error), time.time(), receipt_id))
            if status == "poison":
                db.execute("UPDATE receipts SET events='[]' WHERE id=?", (receipt_id,))
            return status

    def retryable(self, source: Optional[str] = None, limit: int = 20) -> list[dict]:
        """Accepted-but-not-handed-off receipts (a crash or a failed enqueue), oldest first."""
        sql = "SELECT * FROM receipts WHERE status='accepted' AND attempts < ? AND events != '[]'"
        args: list = [MAX_DELIVERY_TRIES]
        if source:
            sql += " AND source=?"
            args.append(source)
        with self._connect() as db:
            rows = db.execute(sql + " ORDER BY created_at LIMIT ?", (*args, limit)).fetchall()
        return [self._receipt(r) for r in rows]

    def pending_count(self, source_id: str) -> int:
        """Receipts for this source still waiting to settle (accepted or queued, and recent)."""
        cutoff = time.time() - PENDING_TTL_SECONDS
        with self._connect() as db:
            return db.execute("SELECT COUNT(*) FROM receipts WHERE source_id=? AND status IN ('accepted','enqueued')"
                              " AND updated_at > ?", (source_id, cutoff)).fetchone()[0]

    def list_receipts(self, source_id: str, limit: int = 30) -> list[dict]:
        with self._connect() as db:
            rows = db.execute("SELECT * FROM receipts WHERE source_id=? ORDER BY created_at DESC LIMIT ?",
                              (source_id, limit)).fetchall()
        return [{k: v for k, v in self._receipt(r).items() if k != "events"} for r in rows]

    def prune(self) -> None:
        cutoff = time.time() - RECEIPT_KEEP_SECONDS
        with self._lock, self._connect() as db:
            db.execute("DELETE FROM receipts WHERE status IN ('done','dropped','poison') AND updated_at < ?", (cutoff,))

    # -- attempts ------------------------------------------------------------------

    def record_attempt(self, source: str, source_id: str, owner: str, outcome: str, *, event_type: str = "",
                       delivery: str = "", status_code: Optional[int] = None, detail: str = "") -> None:
        with self._lock, self._connect() as db:
            db.execute("INSERT INTO attempts (source, source_id, owner, at, outcome, event_type, delivery, status_code, detail)"
                       " VALUES (?,?,?,?,?,?,?,?,?)",
                       (source, source_id, owner, time.time(), outcome[:40], redact(event_type)[:80],
                        redact(delivery)[:80], status_code, redact(detail)))
            db.execute("DELETE FROM attempts WHERE source_id=? AND seq <= "
                       "(SELECT seq FROM attempts WHERE source_id=? ORDER BY seq DESC LIMIT 1 OFFSET ?)",
                       (source_id, source_id, MAX_ATTEMPTS_KEPT))

    def attempts(self, source_id: str, limit: int = ATTEMPTS_SHOWN) -> list[dict]:
        limit = max(1, min(int(limit), ATTEMPTS_SHOWN))
        with self._connect() as db:
            rows = db.execute("SELECT at, outcome, event_type, delivery, status_code, detail FROM attempts"
                              " WHERE source_id=? ORDER BY seq DESC LIMIT ?", (source_id, limit)).fetchall()
        return [dict(r) for r in rows]

    def attempt_count(self, source_id: str) -> int:
        with self._connect() as db:
            return db.execute("SELECT COUNT(*) FROM attempts WHERE source_id=?", (source_id,)).fetchone()[0]

    # -- one captured sample per webhook -------------------------------------------

    def put_sample(self, source_id: str, owner: str, content_type: str, kind: str, body: str) -> None:
        with self._lock, self._connect() as db:
            db.execute("INSERT OR REPLACE INTO samples (source_id, owner, at, content_type, kind, body) VALUES (?,?,?,?,?,?)",
                       (source_id, owner, time.time(), content_type[:100], kind, body[:SAMPLE_LIMIT]))

    def get_sample(self, source_id: str) -> Optional[dict]:
        with self._connect() as db:
            row = db.execute("SELECT * FROM samples WHERE source_id=?", (source_id,)).fetchone()
        return dict(row) if row else None

    def clear_sample(self, source_id: str) -> None:
        with self._lock, self._connect() as db:
            db.execute("DELETE FROM samples WHERE source_id=?", (source_id,))

    # -- subscriptions ---------------------------------------------------------------

    def put_subscription(self, sub: dict) -> None:
        with self._lock, self._connect() as db:
            db.execute("INSERT OR REPLACE INTO subscriptions (id, owner, bot_id, deleted_at, blob) VALUES (?,?,?,?,?)",
                       (sub["id"], sub["owner_user"], sub.get("agent_id"), sub.get("deleted_at"),
                        json.dumps(sub, ensure_ascii=False)))

    def get_subscription(self, sub_id: str) -> Optional[dict]:
        with self._connect() as db:
            row = db.execute("SELECT blob FROM subscriptions WHERE id=?", (sub_id,)).fetchone()
        return json.loads(row["blob"]) if row else None

    def list_subscriptions(self, owner: Optional[str] = None, *, bot_id: Optional[str] = None,
                           deleted: bool = False) -> list[dict]:
        sql = "SELECT blob FROM subscriptions WHERE deleted_at IS " + ("NOT NULL" if deleted else "NULL")
        args: list = []
        if owner is not None:
            sql += " AND owner=?"
            args.append(owner)
        if bot_id is not None:
            sql += " AND bot_id=?"
            args.append(bot_id)
        with self._connect() as db:
            rows = db.execute(sql, args).fetchall()
        out = [json.loads(r["blob"]) for r in rows]
        return sorted(out, key=lambda s: s.get("created_at", 0))

    def remove_subscription(self, sub_id: str) -> None:
        with self._lock, self._connect() as db:
            db.execute("DELETE FROM subscriptions WHERE id=?", (sub_id,))

    def trim_deleted_subscriptions(self) -> None:
        """Seven-day restore window, at most 50 deleted entries."""
        cutoff = time.time() - RESTORE_WINDOW_SECONDS
        with self._lock:
            gone = [s["id"] for s in self.list_subscriptions(deleted=True)]
            kept = sorted(self.list_subscriptions(deleted=True), key=lambda s: s["deleted_at"], reverse=True)
            drop = {s["id"] for s in kept if s["deleted_at"] < cutoff} | {s["id"] for s in kept[MAX_DELETED:]}
            for sub_id in gone:
                if sub_id in drop:
                    self.remove_subscription(sub_id)

    # -- soft-deleted webhooks -------------------------------------------------------

    def bury_webhook(self, owner: str, trigger: dict) -> None:
        blob = json.dumps(copy.deepcopy(trigger), ensure_ascii=False, default=str)  # `secret` is already encrypted
        with self._lock, self._connect() as db:
            db.execute("INSERT OR REPLACE INTO deleted_webhooks (id, owner, deleted_at, blob) VALUES (?,?,?,?)",
                       (trigger["id"], owner, time.time(), blob))
            cutoff = time.time() - RESTORE_WINDOW_SECONDS
            db.execute("DELETE FROM deleted_webhooks WHERE deleted_at < ?", (cutoff,))
            db.execute("DELETE FROM deleted_webhooks WHERE id NOT IN "
                       "(SELECT id FROM deleted_webhooks ORDER BY deleted_at DESC LIMIT ?)", (MAX_DELETED,))

    def deleted_webhooks(self, owner: str) -> list[dict]:
        cutoff = time.time() - RESTORE_WINDOW_SECONDS
        with self._connect() as db:
            rows = db.execute("SELECT id, deleted_at, blob FROM deleted_webhooks WHERE owner IN (?, '') AND deleted_at >= ?"
                              " ORDER BY deleted_at DESC", (owner, cutoff)).fetchall()
        out = []
        for r in rows:
            data = json.loads(r["blob"])
            out.append({"id": r["id"], "name": data.get("name"), "agent_id": data.get("agent_id"),
                        "deleted_at": r["deleted_at"], "restorable_until": r["deleted_at"] + RESTORE_WINDOW_SECONDS})
        return out

    def take_webhook(self, owner: str, trigger_id: str) -> Optional[dict]:
        """The buried webhook (removing it from the bin), or None when absent or past its window."""
        cutoff = time.time() - RESTORE_WINDOW_SECONDS
        with self._lock, self._connect() as db:
            row = db.execute("SELECT blob FROM deleted_webhooks WHERE id=? AND owner IN (?, '') AND deleted_at >= ?",
                             (trigger_id, owner, cutoff)).fetchone()
            if row is None:
                return None
            db.execute("DELETE FROM deleted_webhooks WHERE id=?", (trigger_id,))
        return json.loads(row["blob"])


class _Closing:
    """A connection that commits on success and always closes (sqlite's own context manager does not close)."""

    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def __enter__(self):
        return self._db

    def __exit__(self, *exc) -> None:
        self._db.close()

    def __getattr__(self, name):
        return getattr(self._db, name)


_store: Optional[ReceiptStore] = None
_store_lock = threading.Lock()


def store() -> ReceiptStore:
    global _store
    with _store_lock:
        if _store is None:
            _store = ReceiptStore(DB_FILE)
        return _store


def reset_for_tests(path: Optional[str] = None) -> ReceiptStore:
    """Point the shared store at a fresh file (tests only)."""
    global _store
    with _store_lock:
        _store = ReceiptStore(path or DB_FILE)
        return _store
