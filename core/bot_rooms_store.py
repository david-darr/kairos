"""Durable storage for Bots rooms (Phase 4, unit U2): data/bot_rooms.sqlite3.

Rooms keep their own store so they never show up in a bot's chat list or in
Kairos chat history. A room is a name, a short list of members, threads of
messages, a durable queue of messages waiting for a turn, a log of turns and a
ring buffer of recent posts for the posting guard. Every member speaks through
a private seat session (see services/bot_rooms.py); the person-visible
transcript is `room_messages` here.

Rules this file keeps:
- One writer lock and one connection; every change is a single transaction.
- A message sent with the same `send_id` is stored once; the retry gets the
  first row back.
- `seq` rises by one per room, with no gaps, so a reader can ask for "after N".
- JSON columns are decoded on the way out; callers see plain dicts.
Nothing here imports another service, so tests can use it alone.
"""
import json
import os
import sqlite3
import threading
import time
import uuid

from core import constants

DB_FILE = os.path.join(constants.DATA_DIR, "bot_rooms.sqlite3")
_LOCK = threading.RLock()
_CONN: sqlite3.Connection | None = None
_CONN_PATH: str | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS rooms(
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, context TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '', bulletin TEXT NOT NULL DEFAULT '', cwd TEXT,
  default_responder TEXT NOT NULL, turn_timeout_minutes INTEGER NOT NULL DEFAULT 5,
  setup_state TEXT NOT NULL DEFAULT 'pending', pinned_message_id TEXT, revision INTEGER NOT NULL DEFAULT 1,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL, archived_at REAL);
CREATE TABLE IF NOT EXISTS room_members(
  room_id TEXT NOT NULL, bot_id TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, seat_session_id TEXT,
  last_seen_seq INTEGER NOT NULL DEFAULT 0, held_at REAL, held_for TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(room_id, bot_id));
CREATE TABLE IF NOT EXISTS room_threads(
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', goal TEXT, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS room_messages(
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL, thread_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL,
  bot_id TEXT, text TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'text', reply_to_id TEXT, send_id TEXT,
  run_id TEXT, turn_id TEXT, meta TEXT NOT NULL DEFAULT '{}', created_at REAL NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS room_messages_seq ON room_messages(room_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS room_messages_send ON room_messages(room_id, send_id) WHERE send_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS room_messages_thread ON room_messages(room_id, thread_id, seq);
CREATE TABLE IF NOT EXISTS room_queue(
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL, thread_id TEXT NOT NULL, send_id TEXT, payload TEXT NOT NULL,
  sequence INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', created_at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS room_queue_pending ON room_queue(room_id, thread_id, state, sequence);
CREATE TABLE IF NOT EXISTS room_turns(
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL, thread_id TEXT NOT NULL, bot_id TEXT NOT NULL, hop INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT 'person', attended INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'running',
  outcome TEXT, deadline REAL, run_id TEXT, started_at REAL NOT NULL, ended_at REAL);
CREATE INDEX IF NOT EXISTS room_turns_room ON room_turns(room_id, status);
CREATE TABLE IF NOT EXISTS room_routines(
  routine_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, lead_bot_id TEXT NOT NULL, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS room_posts(
  room_id TEXT NOT NULL, bot_id TEXT NOT NULL, at REAL NOT NULL, fingerprint TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS room_posts_room ON room_posts(room_id, at);
"""

ROOM_JSON = ("default_responder",)
MEMBER_JSON = ("held_for", "state")


class Missing(KeyError):
    """The room, thread or message does not exist (a 404)."""


class Stale(ValueError):
    """The caller's revision is behind the stored one (a 409)."""


def _conn() -> sqlite3.Connection:
    global _CONN, _CONN_PATH
    if _CONN is None or _CONN_PATH != DB_FILE:
        if _CONN is not None:
            _CONN.close()
        os.makedirs(os.path.dirname(DB_FILE) or ".", exist_ok=True)
        _CONN = sqlite3.connect(DB_FILE, check_same_thread=False, isolation_level=None)
        _CONN.row_factory = sqlite3.Row
        try:
            _CONN.execute("PRAGMA journal_mode=WAL")
        except sqlite3.DatabaseError:
            pass
        _CONN.execute("PRAGMA busy_timeout=5000")
        _CONN.executescript(SCHEMA)
        _CONN_PATH = DB_FILE
    return _CONN


class _Tx:
    def __enter__(self):
        _LOCK.acquire()
        self.conn = _conn()
        self.conn.execute("BEGIN IMMEDIATE")
        return self.conn

    def __exit__(self, kind, error, tb):
        try:
            self.conn.execute("ROLLBACK" if kind else "COMMIT")
        finally:
            _LOCK.release()
        return False


def transaction() -> _Tx:
    return _Tx()


def close() -> None:
    global _CONN, _CONN_PATH
    with _LOCK:
        if _CONN is not None:
            _CONN.close()
        _CONN, _CONN_PATH = None, None


def _new_id() -> str:
    return uuid.uuid4().hex[:16]


def _decode(row, json_fields=()) -> dict | None:
    if row is None:
        return None
    data = dict(row)
    for field in json_fields:
        if field in data and isinstance(data[field], str):
            try:
                data[field] = json.loads(data[field])
            except ValueError:
                data[field] = None
    return data


def _room(row) -> dict | None:
    return _decode(row, ROOM_JSON)


def _message(row) -> dict | None:
    return _decode(row, ("meta",))


# -- rooms ---------------------------------------------------------------------

def create_room(owner: str, name: str, *, context: str = "", description: str = "", bulletin: str = "",
                cwd: str | None = None, default_responder: dict, turn_timeout_minutes: int = 5,
                setup_state: str = "pending", member_ids=(), now: float | None = None) -> dict:
    now = time.time() if now is None else now
    room_id = _new_id()
    with transaction() as conn:
        conn.execute("INSERT INTO rooms(id,owner,name,context,description,bulletin,cwd,default_responder,"
                     "turn_timeout_minutes,setup_state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                     (room_id, owner, name, context, description, bulletin, cwd, json.dumps(default_responder),
                      turn_timeout_minutes, setup_state, now))
        for position, bot_id in enumerate(member_ids):
            conn.execute("INSERT INTO room_members(room_id,bot_id,position) VALUES(?,?,?)", (room_id, bot_id, position))
        conn.execute("INSERT INTO room_threads(id,room_id,title,created_at) VALUES(?,?,?,?)",
                     (_new_id(), room_id, "", now))
    return get_room(room_id)


def get_room(room_id: str) -> dict | None:
    with _LOCK:
        return _room(_conn().execute("SELECT * FROM rooms WHERE id=?", (room_id,)).fetchone())


def list_rooms(owner: str | None = None, include_archived: bool = False) -> list[dict]:
    sql, args = "SELECT * FROM rooms", []
    clauses = []
    if owner is not None:
        clauses.append("owner=?")
        args.append(owner)
    if not include_archived:
        clauses.append("archived_at IS NULL")
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    with _LOCK:
        return [_room(r) for r in _conn().execute(sql + " ORDER BY created_at, id", args).fetchall()]


def update_room(room_id: str, fields: dict, expected_revision: int | None = None) -> dict:
    allowed = {"name", "context", "description", "bulletin", "cwd", "default_responder", "turn_timeout_minutes",
               "setup_state", "pinned_message_id", "archived_at", "last_read_seq"}
    with transaction() as conn:
        row = conn.execute("SELECT revision FROM rooms WHERE id=?", (room_id,)).fetchone()
        if row is None:
            raise Missing(room_id)
        if expected_revision is not None and row["revision"] != expected_revision:
            raise Stale("The room changed. Reload and try again.")
        sets, args = ["revision=revision+1"] if set(fields) != {"last_read_seq"} else [], []
        for key, value in fields.items():
            if key not in allowed:
                raise ValueError(f"unknown room field {key}")
            sets.append(f"{key}=?")
            args.append(json.dumps(value) if key in ROOM_JSON else value)
        conn.execute(f"UPDATE rooms SET {', '.join(sets)} WHERE id=?", (*args, room_id))
    return get_room(room_id)


def delete_room(room_id: str) -> None:
    with transaction() as conn:
        for table in ("room_members", "room_threads", "room_messages", "room_queue", "room_turns", "room_posts", "room_routines"):
            conn.execute(f"DELETE FROM {table} WHERE room_id=?", (room_id,))
        conn.execute("DELETE FROM rooms WHERE id=?", (room_id,))


# -- members -------------------------------------------------------------------

def members(room_id: str) -> list[dict]:
    with _LOCK:
        rows = _conn().execute("SELECT * FROM room_members WHERE room_id=? ORDER BY position, bot_id", (room_id,)).fetchall()
    return [_decode(r, MEMBER_JSON) for r in rows]


def member(room_id: str, bot_id: str) -> dict | None:
    with _LOCK:
        return _decode(_conn().execute("SELECT * FROM room_members WHERE room_id=? AND bot_id=?",
                                       (room_id, bot_id)).fetchone(), MEMBER_JSON)


def rooms_of_bot(bot_id: str) -> list[str]:
    with _LOCK:
        return [r["room_id"] for r in _conn().execute("SELECT room_id FROM room_members WHERE bot_id=?", (bot_id,))]


def room_for_seat(session_id: str) -> tuple[str, str] | None:
    """(room id, bot id) a seat session belongs to."""
    with _LOCK:
        row = _conn().execute("SELECT room_id,bot_id FROM room_members WHERE seat_session_id=?", (session_id,)).fetchone()
    return (row["room_id"], row["bot_id"]) if row else None


def set_members(room_id: str, bot_ids: list[str]) -> list[dict]:
    """Make the member list exactly `bot_ids`, in that order; kept members keep their seat and state."""
    with transaction() as conn:
        have = {r["bot_id"] for r in conn.execute("SELECT bot_id FROM room_members WHERE room_id=?", (room_id,))}
        for bot_id in have - set(bot_ids):
            conn.execute("DELETE FROM room_members WHERE room_id=? AND bot_id=?", (room_id, bot_id))
        for position, bot_id in enumerate(bot_ids):
            if bot_id in have:
                conn.execute("UPDATE room_members SET position=? WHERE room_id=? AND bot_id=?", (position, room_id, bot_id))
            else:
                conn.execute("INSERT INTO room_members(room_id,bot_id,position) VALUES(?,?,?)", (room_id, bot_id, position))
    return members(room_id)


def update_member(room_id: str, bot_id: str, **fields) -> dict:
    allowed = {"seat_session_id", "last_seen_seq", "held_at", "held_for", "state"}
    with transaction() as conn:
        sets, args = [], []
        for key, value in fields.items():
            if key not in allowed:
                raise ValueError(f"unknown member field {key}")
            sets.append(f"{key}=?")
            args.append(json.dumps(value) if key in MEMBER_JSON else value)
        if sets:
            conn.execute(f"UPDATE room_members SET {', '.join(sets)} WHERE room_id=? AND bot_id=?", (*args, room_id, bot_id))
    found = member(room_id, bot_id)
    if found is None:
        raise Missing(bot_id)
    return found


# -- threads -------------------------------------------------------------------

def threads(room_id: str) -> list[dict]:
    with _LOCK:
        return [_decode(r, ("goal",)) for r in _conn().execute(
            "SELECT * FROM room_threads WHERE room_id=? ORDER BY created_at, id", (room_id,)).fetchall()]


def get_thread(room_id: str, thread_id: str) -> dict | None:
    with _LOCK:
        return _decode(_conn().execute("SELECT * FROM room_threads WHERE room_id=? AND id=?",
                                       (room_id, thread_id)).fetchone(), ("goal",))


def create_thread(room_id: str, title: str = "", now: float | None = None) -> dict:
    thread_id = _new_id()
    with transaction() as conn:
        conn.execute("INSERT INTO room_threads(id,room_id,title,created_at) VALUES(?,?,?,?)",
                     (thread_id, room_id, title, time.time() if now is None else now))
    return get_thread(room_id, thread_id)


def update_thread(room_id: str, thread_id: str, *, title=None, goal="__keep__") -> dict:
    with transaction() as conn:
        if conn.execute("SELECT 1 FROM room_threads WHERE room_id=? AND id=?", (room_id, thread_id)).fetchone() is None:
            raise Missing(thread_id)
        if title is not None:
            conn.execute("UPDATE room_threads SET title=? WHERE id=?", (title, thread_id))
        if goal != "__keep__":
            conn.execute("UPDATE room_threads SET goal=? WHERE id=?", (None if goal is None else json.dumps(goal), thread_id))
    return get_thread(room_id, thread_id)


def delete_threads(room_id: str, thread_ids: list[str]) -> list[str]:
    """Delete these threads and everything in them, keeping at least one. Returns the ids removed."""
    with transaction() as conn:
        existing = [r["id"] for r in conn.execute("SELECT id FROM room_threads WHERE room_id=? ORDER BY created_at", (room_id,))]
        doomed = [t for t in dict.fromkeys(thread_ids) if t in existing]
        if len(doomed) >= len(existing):
            doomed = doomed[:-1] if doomed else []  # the room always keeps one thread
        for thread_id in doomed:
            conn.execute("DELETE FROM room_messages WHERE room_id=? AND thread_id=?", (room_id, thread_id))
            conn.execute("DELETE FROM room_queue WHERE room_id=? AND thread_id=?", (room_id, thread_id))
            conn.execute("DELETE FROM room_threads WHERE id=?", (thread_id,))
    return doomed


# -- messages ------------------------------------------------------------------

def add_message(room_id: str, thread_id: str, role: str, text: str, *, bot_id: str | None = None, kind: str = "text",
                reply_to_id: str | None = None, send_id: str | None = None, run_id: str | None = None,
                turn_id: str | None = None, meta: dict | None = None, now: float | None = None) -> tuple[dict, bool]:
    """(message, created). A repeated send_id returns the stored message and False."""
    with transaction() as conn:
        if send_id:
            row = conn.execute("SELECT * FROM room_messages WHERE room_id=? AND send_id=?", (room_id, send_id)).fetchone()
            if row is not None:
                return _message(row), False
        seq = conn.execute("SELECT COALESCE(MAX(seq),0)+1 FROM room_messages WHERE room_id=?", (room_id,)).fetchone()[0]
        message_id = _new_id()
        conn.execute("INSERT INTO room_messages(id,room_id,thread_id,seq,role,bot_id,text,kind,reply_to_id,send_id,run_id,"
                     "turn_id,meta,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                     (message_id, room_id, thread_id, seq, role, bot_id, text, kind, reply_to_id, send_id, run_id, turn_id,
                      json.dumps(meta or {}), time.time() if now is None else now))
        return _message(conn.execute("SELECT * FROM room_messages WHERE id=?", (message_id,)).fetchone()), True


def get_message(room_id: str, message_id: str) -> dict | None:
    with _LOCK:
        return _message(_conn().execute("SELECT * FROM room_messages WHERE room_id=? AND id=?", (room_id, message_id)).fetchone())


def update_message(room_id: str, message_id: str, *, text=None, meta=None) -> dict:
    with transaction() as conn:
        row = conn.execute("SELECT * FROM room_messages WHERE room_id=? AND id=?", (room_id, message_id)).fetchone()
        if row is None:
            raise Missing(message_id)
        if text is not None:
            conn.execute("UPDATE room_messages SET text=? WHERE id=?", (text, message_id))
        if meta is not None:
            merged = {**(json.loads(row["meta"]) or {}), **meta}
            conn.execute("UPDATE room_messages SET meta=? WHERE id=?", (json.dumps(merged), message_id))
    return get_message(room_id, message_id)


def unread_count(room_id: str) -> int:
    """Messages from bots or webhooks after the person last read the room."""
    with _LOCK:
        return _conn().execute(
            "SELECT COUNT(*) FROM room_messages m JOIN rooms r ON r.id=m.room_id WHERE m.room_id=? AND m.seq>r.last_read_seq "
            "AND m.role='bot'", (room_id,)).fetchone()[0]


def last_seq(room_id: str) -> int:
    with _LOCK:
        return _conn().execute("SELECT COALESCE(MAX(seq),0) FROM room_messages WHERE room_id=?", (room_id,)).fetchone()[0]


def messages(room_id: str, thread_id: str | None = None, *, limit: int = 50, before: int | None = None,
             after: int | None = None) -> list[dict]:
    """Oldest first. `before`/`after` are seq values; with `before` the newest `limit` rows under it."""
    clauses, args = ["room_id=?"], [room_id]
    if thread_id:
        clauses.append("thread_id=?")
        args.append(thread_id)
    if before is not None:
        clauses.append("seq<?")
        args.append(before)
    if after is not None:
        clauses.append("seq>?")
        args.append(after)
    order = "ASC" if after is not None and before is None else "DESC"
    sql = f"SELECT * FROM room_messages WHERE {' AND '.join(clauses)} ORDER BY seq {order} LIMIT ?"
    with _LOCK:
        rows = [_message(r) for r in _conn().execute(sql, (*args, limit)).fetchall()]
    return rows if order == "ASC" else list(reversed(rows))


def message_count(room_id: str, thread_id: str | None = None) -> int:
    with _LOCK:
        if thread_id:
            return _conn().execute("SELECT COUNT(*) FROM room_messages WHERE room_id=? AND thread_id=?",
                                   (room_id, thread_id)).fetchone()[0]
        return _conn().execute("SELECT COUNT(*) FROM room_messages WHERE room_id=?", (room_id,)).fetchone()[0]


# -- queue ---------------------------------------------------------------------

def queue_add(room_id: str, thread_id: str, payload: dict, send_id: str | None = None) -> dict:
    with transaction() as conn:
        sequence = conn.execute("SELECT COALESCE(MAX(sequence),0)+1 FROM room_queue WHERE room_id=?", (room_id,)).fetchone()[0]
        queue_id = _new_id()
        conn.execute("INSERT INTO room_queue(id,room_id,thread_id,send_id,payload,sequence,created_at) VALUES(?,?,?,?,?,?,?)",
                     (queue_id, room_id, thread_id, send_id, json.dumps(payload), sequence, time.time()))
    return queue_get(queue_id)


def queue_get(queue_id: str) -> dict | None:
    with _LOCK:
        return _decode(_conn().execute("SELECT * FROM room_queue WHERE id=?", (queue_id,)).fetchone(), ("payload",))


def queue_list(room_id: str, thread_id: str | None = None, states=("pending", "dispatching")) -> list[dict]:
    marks = ",".join("?" * len(states))
    sql, args = f"SELECT * FROM room_queue WHERE room_id=? AND state IN ({marks})", [room_id, *states]
    if thread_id:
        sql += " AND thread_id=?"
        args.append(thread_id)
    with _LOCK:
        return [_decode(r, ("payload",)) for r in _conn().execute(sql + " ORDER BY sequence", args).fetchall()]


def queue_mark(queue_ids: list[str], state: str, only_from: tuple = ()) -> int:
    changed = 0
    with transaction() as conn:
        for queue_id in queue_ids:
            sql, args = "UPDATE room_queue SET state=? WHERE id=?", [state, queue_id]
            if only_from:
                sql += f" AND state IN ({','.join('?' * len(only_from))})"
                args += list(only_from)
            changed += conn.execute(sql, args).rowcount
    return changed


def queue_prune(room_id: str, keep: int = 64) -> None:
    with transaction() as conn:
        conn.execute("DELETE FROM room_queue WHERE room_id=? AND state IN ('consumed','cancelled') AND id NOT IN "
                     "(SELECT id FROM room_queue WHERE room_id=? AND state IN ('consumed','cancelled') "
                     "ORDER BY sequence DESC LIMIT ?)", (room_id, room_id, keep))


def threads_with_pending() -> list[tuple[str, str]]:
    with _LOCK:
        return [(r["room_id"], r["thread_id"]) for r in _conn().execute(
            "SELECT DISTINCT room_id,thread_id FROM room_queue WHERE state IN ('pending','dispatching')")]


# -- turns ---------------------------------------------------------------------

def turn_start(room_id: str, thread_id: str, bot_id: str, *, hop: int, origin: str, attended: bool,
               deadline: float | None, now: float | None = None) -> dict:
    turn_id = _new_id()
    with transaction() as conn:
        conn.execute("INSERT INTO room_turns(id,room_id,thread_id,bot_id,hop,origin,attended,deadline,started_at) "
                     "VALUES(?,?,?,?,?,?,?,?,?)", (turn_id, room_id, thread_id, bot_id, hop, origin, int(attended), deadline,
                                                   time.time() if now is None else now))
    return turn_get(turn_id)


def turn_get(turn_id: str) -> dict | None:
    with _LOCK:
        row = _conn().execute("SELECT * FROM room_turns WHERE id=?", (turn_id,)).fetchone()
    if row is None:
        return None
    data = dict(row)
    data["attended"] = bool(data["attended"])
    return data


def turn_end(turn_id: str, outcome: str, status: str = "ended", run_id: str | None = None,
             now: float | None = None) -> None:
    with transaction() as conn:
        conn.execute("UPDATE room_turns SET status=?, outcome=?, run_id=COALESCE(?,run_id), ended_at=? WHERE id=?",
                     (status, outcome, run_id, time.time() if now is None else now, turn_id))


def turns(room_id: str, status: str | None = None, limit: int = 200) -> list[dict]:
    sql, args = "SELECT * FROM room_turns WHERE room_id=?", [room_id]
    if status:
        sql += " AND status=?"
        args.append(status)
    with _LOCK:
        rows = _conn().execute(sql + " ORDER BY started_at DESC, rowid DESC LIMIT ?", (*args, limit)).fetchall()
    return [{**dict(r), "attended": bool(r["attended"])} for r in rows]


def interrupt_running(now: float | None = None) -> int:
    """After a restart no turn is still running: mark every one interrupted. Never replayed."""
    with transaction() as conn:
        return conn.execute("UPDATE room_turns SET status='ended', outcome='interrupted', ended_at=? WHERE status='running'",
                            (time.time() if now is None else now,)).rowcount


# -- team-goal routines (which scheduled goals aim at which room, and who leads them) ----

def link_routine(routine_id: str, room_id: str, lead_bot_id: str) -> None:
    with transaction() as conn:
        conn.execute("INSERT OR REPLACE INTO room_routines(routine_id,room_id,lead_bot_id,created_at) VALUES(?,?,?,?)",
                     (routine_id, room_id, lead_bot_id, time.time()))


def unlink_routine(routine_id: str) -> None:
    with transaction() as conn:
        conn.execute("DELETE FROM room_routines WHERE routine_id=?", (routine_id,))


def routine_link(routine_id: str) -> dict | None:
    with _LOCK:
        row = _conn().execute("SELECT * FROM room_routines WHERE routine_id=?", (routine_id,)).fetchone()
    return dict(row) if row else None


def routines_of_room(room_id: str) -> list[dict]:
    with _LOCK:
        return [dict(r) for r in _conn().execute("SELECT * FROM room_routines WHERE room_id=?", (room_id,)).fetchall()]


# -- posts (the posting guard's ring buffer) ---------------------------------------

def post_add(room_id: str, bot_id: str, at: float, fingerprint: str) -> None:
    with transaction() as conn:
        conn.execute("INSERT INTO room_posts(room_id,bot_id,at,fingerprint) VALUES(?,?,?,?)", (room_id, bot_id, at, fingerprint))
        conn.execute("DELETE FROM room_posts WHERE room_id=? AND at<?", (room_id, at - 3600))


def posts_since(room_id: str, since: float) -> list[dict]:
    with _LOCK:
        return [dict(r) for r in _conn().execute("SELECT * FROM room_posts WHERE room_id=? AND at>=? ORDER BY at",
                                                 (room_id, since)).fetchall()]
