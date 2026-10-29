"""Cross-conversation recall for a bot (Bots Phase 2, unit U2; design 4.3).

A rebuildable SQLite FTS5 index at `<data>/bot-recall/recall.sqlite` over three things, always scoped to one bot
and one owner:

- the messages of the owner's own conversations with the bot,
- those conversations' digests (chat summary and compaction summary),
- the bot's notebook topic files (never the index, the archive or the daily logs).

Before an owner-started turn, `for_turn()` returns at most four notebook passages and four conversation
passages within 6,000 characters. The current conversation and the current message are left out, so are other
bots, other owners, routine and handoff conversations, and anything a "forget" removed. `search()` and
`read_message()` are the scoped model tools' backends: both take the trusted scope, never an owner or bot from
the model, and `read_message()` checks the bot and owner again against the live session.

The index is derived data. Deleting the file loses nothing: the next search rebuilds what it needs.
"""
import logging
import os
import re
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta
from typing import Optional

from core.constants import DATA_DIR

logger = logging.getLogger(__name__)

DB_DIR = os.path.join(DATA_DIR, "bot-recall")
DB_FILE = os.path.join(DB_DIR, "recall.sqlite")
SCHEMA_VERSION = 1
TURN_MEMORY, TURN_CHATS, TURN_CHARS = 4, 4, 6000
SEARCH_DEFAULT, SEARCH_MAX = 12, 25
READ_CAP = 8000
PASSAGE_CHARS = 700
QUERY_CHARS = 600
MAX_TERMS = 12
STOP_WORDS = frozenset("""a about above after again all also am an and any are as at be because been before being below between both
but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in
into is it its just me more most my no nor not now of off on once only or other our out over own same she should so some such than
that the their them then there these they this those through to too under until up us very was we were what when where which while
who whom why will with would you your yours remember recall tell told said say please hey hi hello thanks thank""".split())
_LOCK = threading.RLock()


class RecallError(ValueError):
    status = 400


class RecallNotFound(RecallError):
    status = 404


@contextmanager
def _db():
    os.makedirs(DB_DIR, exist_ok=True)
    with _LOCK:
        conn = sqlite3.connect(DB_FILE, timeout=10)
        conn.row_factory = sqlite3.Row
        try:
            _schema(conn)
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()


def _schema(conn) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS docs(id INTEGER PRIMARY KEY, bot_id TEXT NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL,
            ref TEXT NOT NULL, msg_ref TEXT NOT NULL, ts REAL, role TEXT, title TEXT, text TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS docs_owner ON docs(bot_id, owner, kind, ref);
        CREATE INDEX IF NOT EXISTS docs_ref ON docs(msg_ref);
        CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(text, tokenize='unicode61 remove_diacritics 2');
        CREATE TABLE IF NOT EXISTS sources(bot_id TEXT NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL,
            stamp TEXT NOT NULL, PRIMARY KEY(bot_id, owner, kind, ref));
    """)
    row = conn.execute("SELECT value FROM meta WHERE key='version'").fetchone()
    if row is None:
        conn.execute("INSERT INTO meta(key, value) VALUES('version', ?)", (str(SCHEMA_VERSION),))


def _drop_source(conn, bot_id, owner, kind, ref) -> None:
    doc_kind = {"session": "conversation", "topic": "memory"}[kind]
    ids = [r["id"] for r in conn.execute("SELECT id FROM docs WHERE bot_id=? AND owner=? AND kind=? AND ref=?",
                                         (bot_id, owner, doc_kind, ref))]
    for chunk in range(0, len(ids), 500):
        part = ids[chunk:chunk + 500]
        marks = ",".join("?" for _ in part)
        conn.execute(f"DELETE FROM docs_fts WHERE rowid IN ({marks})", part)
        conn.execute(f"DELETE FROM docs WHERE id IN ({marks})", part)
    conn.execute("DELETE FROM sources WHERE bot_id=? AND owner=? AND kind=? AND ref=?", (bot_id, owner, kind, ref))


def _add(conn, bot_id, owner, kind, ref, msg_ref, ts, role, title, text) -> None:
    cursor = conn.execute("INSERT INTO docs(bot_id, owner, kind, ref, msg_ref, ts, role, title, text) VALUES(?,?,?,?,?,?,?,?,?)",
                          (bot_id, owner, kind, ref, msg_ref, ts, role, title, text))
    conn.execute("INSERT INTO docs_fts(rowid, text) VALUES(?, ?)", (cursor.lastrowid, text))


def message_ref(session: dict, index: int) -> str:
    """A stable reference to a message: its tree id, else its place in the conversation."""
    row = session["messages"][index]
    return row.get("bot_message_id") or f"{session['id']}:{index}"


# -- keeping the index current -------------------------------------------------------------------------------

def _session_stamp(session: dict) -> str:
    thread = session.get("thread") or {}
    count = session.get("message_count", len(session.get("messages") or []))
    return f"{session.get('updated_at')}:{count}:{thread.get('branch_revision')}:{thread.get('active_leaf_id')}"


def _index_session(conn, bot_id: str, owner: str, session: dict) -> None:
    from services.bot_turn_context import owner_conversation
    sid = session["id"]
    _drop_source(conn, bot_id, owner, "session", sid)
    if not owner_conversation(session):
        return
    title = " ".join((session.get("title") or "Conversation").split())[:80]
    from core import bot_message_tree
    path = bot_message_tree.ancestry(session)
    active = {m.get("bot_message_id") for m in path}
    for index, message in enumerate(session.get("messages") or []):
        if message.get("bot_message_id") not in active:
            continue
        if message.get("display_only") or message.get("role") not in ("user", "assistant"):
            continue
        if message.get("role") == "assistant" and message.get("status", "complete") != "complete":
            continue
        text = (message.get("content") or "").strip()
        if text:
            _add(conn, bot_id, owner, "conversation", sid, message_ref(session, index), message.get("ts"),
                 message["role"], title, text[:20000])
    # A legacy unbound summary cannot safely be replayed after branching.
    digests = [(session.get("chat_summary") or {}).get("text")] if not (session.get("thread") or {}).get("branch_revision") else []
    compactions = bot_message_tree.checkpoints(session, path) if any(m.get("bot_message_id") for m in path) else session.get("compactions") or []
    digests.append(compactions[-1].get("summary") if compactions else None)
    for number, digest in enumerate(d for d in digests if d):
        _add(conn, bot_id, owner, "conversation", sid, f"digest:{sid}:{number}", session.get("updated_at"),
             "digest", title, digest[:8000])
    conn.execute("INSERT OR REPLACE INTO sources(bot_id, owner, kind, ref, stamp) VALUES(?,?,?,?,?)",
                 (bot_id, owner, "session", sid, _session_stamp(session)))


def _topic_blocks(text: str) -> list[str]:
    body = re.sub(r"\A---\n.*?\n---\n", "", text or "", flags=re.DOTALL)
    blocks = []
    for chunk in re.split(r"\n\s*\n|\n(?=- )", body):
        chunk = chunk.strip()
        if chunk and not chunk.startswith("#"):
            blocks.append(chunk[:2000])
    return blocks


def _index_topic(conn, bot_id: str, owner: str, name: str, text: str) -> None:
    _drop_source(conn, bot_id, owner, "topic", name)
    from services.bot_turn_context import sha
    for number, block in enumerate(_topic_blocks(text)):
        _add(conn, bot_id, owner, "memory", name, f"topic:{name}:{number}", None, "note", name, block)
    conn.execute("INSERT OR REPLACE INTO sources(bot_id, owner, kind, ref, stamp) VALUES(?,?,?,?,?)",
                 (bot_id, owner, "topic", name, sha(text)))


def sync(bot_id: str, owner: str) -> dict:
    """Bring the index up to date for one bot and owner: only changed conversations and topics are read."""
    from core.session_manager import session_manager
    from services import bot_turn_context as context
    changed = {"sessions": 0, "topics": 0}
    # A listing header does not carry the account, so a conversation of someone else is read once and then
    # remembered as foreign until it changes.
    headers = session_manager.list_sessions(agent_id=bot_id)
    with _db() as conn:
        known = {r["ref"]: r["stamp"] for r in conn.execute(
            "SELECT ref, stamp FROM sources WHERE bot_id=? AND owner=? AND kind='session'", (bot_id, owner))}
        foreign = {r["ref"]: r["stamp"] for r in conn.execute(
            "SELECT ref, stamp FROM sources WHERE bot_id=? AND owner=? AND kind='foreign:' || ?", (bot_id, "*", owner))}
        live = set()
        for header in headers:
            sid = header["id"]
            live.add(sid)
            stamp = _session_stamp(header)
            if known.get(sid) == stamp or foreign.get(sid) == stamp:
                continue
            session = session_manager.get_session(sid)
            if session is None:
                continue
            if context.owner_of(session) != owner:
                _drop_source(conn, bot_id, owner, "session", sid)
                conn.execute("INSERT OR REPLACE INTO sources(bot_id, owner, kind, ref, stamp) VALUES(?,?,?,?,?)",
                             (bot_id, "*", "foreign:" + owner, sid, stamp))
                continue
            _index_session(conn, bot_id, owner, session)
            changed["sessions"] += 1
        for gone in (set(known) | set(foreign)) - live:
            _drop_source(conn, bot_id, owner, "session", gone)
            conn.execute("DELETE FROM sources WHERE bot_id=? AND owner='*' AND kind=? AND ref=?",
                         (bot_id, "foreign:" + owner, gone))
        port = context.notebook()
        topics = {}
        if port is not None:
            for topic in port.topics(bot_id):
                data = port.read(bot_id, f"memory/{topic['name']}.md")
                if data is not None:
                    topics[topic["name"]] = data["text"]
        stamps = {r["ref"]: r["stamp"] for r in conn.execute(
            "SELECT ref, stamp FROM sources WHERE bot_id=? AND owner=? AND kind='topic'", (bot_id, owner))}
        for name, text in topics.items():
            if stamps.get(name) != context.sha(text):
                _index_topic(conn, bot_id, owner, name, text)
                changed["topics"] += 1
        for gone in set(stamps) - set(topics):
            _drop_source(conn, bot_id, owner, "topic", gone)
    return changed


def rebuild(bot_id: Optional[str] = None) -> None:
    """Throw the derived index away (all of it, or one bot's); the next search brings back what it needs."""
    with _db() as conn:
        if bot_id is None:
            conn.executescript("DELETE FROM docs; DELETE FROM docs_fts; DELETE FROM sources;")
        else:
            ids = [r["id"] for r in conn.execute("SELECT id FROM docs WHERE bot_id=?", (bot_id,))]
            for i in ids:
                conn.execute("DELETE FROM docs_fts WHERE rowid=?", (i,))
            conn.execute("DELETE FROM docs WHERE bot_id=?", (bot_id,))
            conn.execute("DELETE FROM sources WHERE bot_id=?", (bot_id,))


def forget_bot(bot_id: str) -> None:
    """A deleted bot's recall rows go with it."""
    rebuild(bot_id)


# -- dates and queries ---------------------------------------------------------------------------------------

_SPAN = re.compile(r"^(\d{1,4})\s*([hdw])$", re.IGNORECASE)


def parse_bound(value, now: Optional[float] = None, end: bool = False) -> Optional[float]:
    """A date filter: epoch seconds, a span back from now ("24h", "3d", "2w"), "today", "yesterday" or YYYY-MM-DD.
    As an upper bound, a day name means the end of that day."""
    if value in (None, ""):
        return None
    now = time.time() if now is None else now
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    text = str(value).strip().lower()
    local = datetime.fromtimestamp(now)
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
    if text == "today":
        return (midnight + timedelta(days=1)).timestamp() if end else midnight.timestamp()
    if text == "yesterday":
        return midnight.timestamp() if end else (midnight - timedelta(days=1)).timestamp()
    span = _SPAN.match(text)
    if span:
        unit = {"h": 3600, "d": 86400, "w": 604800}[span[2]]
        return now - int(span[1]) * unit
    try:
        day = datetime.strptime(text, "%Y-%m-%d")
    except ValueError:
        raise RecallError("dates are 24h, 3d, 2w, today, yesterday or YYYY-MM-DD")
    return (day + timedelta(days=1)).timestamp() if end else day.timestamp()


def terms(text: str) -> list[str]:
    seen, out = set(), []
    for word in re.findall(r"\w+", (text or "")[:QUERY_CHARS].casefold()):
        if len(word) < 2 or word in STOP_WORDS or word.isdigit() and len(word) < 3 or word in seen:
            continue
        seen.add(word)
        out.append(word)
    return out[:MAX_TERMS]


def fts_query(words: list[str]) -> str:
    """Words of three letters or more match as prefixes ("hender" finds "henderson"); shorter ones exactly."""
    return " OR ".join(f'"{w}"*' if len(w) >= 3 else f'"{w}"' for w in words)


def _forgotten(owner: str) -> list:
    from services import bot_profile
    return [bot_profile.whole_word(t) for t in bot_profile.forgotten_terms(owner)]


def _scope_ids(scope: dict) -> tuple[str, str]:
    bot_id, owner = scope.get("bot_id"), scope.get("owner")
    if not bot_id or not owner:
        raise RecallNotFound("not found")
    return bot_id, owner


def _row(r, text_cap: int = PASSAGE_CHARS) -> dict:
    text = r["text"]
    return {"kind": r["kind"], "title": r["title"], "source": r["ref"], "ref": r["msg_ref"], "role": r["role"],
            "ts": r["ts"], "text": text if len(text) <= text_cap else text[:text_cap].rstrip() + "…"}


def search(scope: dict, q: Optional[str] = None, since=None, until=None, kind: str = "all",
           limit: int = SEARCH_DEFAULT, exclude_session: Optional[str] = None,
           exclude_refs: Optional[set] = None, now: Optional[float] = None, refresh: bool = True) -> dict:
    """Search this bot's memory and conversations with this owner. Needs a query or a `since` date. kind is
    all, conversations or memory. Returns {results, count}; each result names its source and a stable message ref."""
    bot_id, owner = _scope_ids(scope)
    if kind not in ("all", "conversations", "memory"):
        raise RecallError("kind is all, conversations or memory")
    words = terms(q or "")
    after, before = parse_bound(since, now), parse_bound(until, now, end=True)
    if not words and after is None:
        raise RecallError("give words to look for, or a since date")
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        raise RecallError("limit is a number")
    limit = max(1, min(limit, SEARCH_MAX))
    if refresh:
        sync(bot_id, owner)
    where, args = ["d.bot_id=?", "d.owner=?"], [bot_id, owner]
    if kind != "all":
        where.append("d.kind=?")
        args.append("conversation" if kind == "conversations" else "memory")
    if after is not None:
        where.append("d.ts>=?")
        args.append(after)
    if before is not None:
        where.append("d.ts<?")
        args.append(before)
    if exclude_session:
        where.append("NOT (d.kind='conversation' AND d.ref=?)")
        args.append(exclude_session)
    if words:
        sql = ("SELECT d.* FROM docs_fts f JOIN docs d ON d.id=f.rowid WHERE docs_fts MATCH ? AND " + " AND ".join(where)
               + " ORDER BY bm25(docs_fts) LIMIT ?")
        args = [fts_query(words), *args]
    else:
        where.append("d.ts IS NOT NULL")
        sql = "SELECT d.* FROM docs d WHERE " + " AND ".join(where) + " ORDER BY d.ts DESC LIMIT ?"
    # Over-fetch: forgotten passages and excluded refs drop out after the query.
    args.append(limit * 4 + 8)
    forgotten = _forgotten(owner)
    results = []
    with _db() as conn:
        for r in conn.execute(sql, args):
            if exclude_refs and r["msg_ref"] in exclude_refs:
                continue
            if any(p.search(r["text"]) for p in forgotten):
                continue
            results.append(_row(r))
            if len(results) >= limit:
                break
    return {"results": results, "count": len(results)}


def for_turn(scope: dict, message: str, now: Optional[float] = None) -> dict:
    """The recalled passages for one owner-started turn: {text, found}. Empty when nothing matches."""
    from core.session_manager import session_manager
    empty = {"text": "", "found": []}
    if not terms(message):
        return empty
    session_id = scope.get("session_id")
    exclude = set()
    current = session_manager.get_session(session_id) if session_id else None
    if current:
        for index in range(len(current.get("messages") or []) - 1, -1, -1):
            if current["messages"][index].get("role") == "user":
                exclude.add(message_ref(current, index))
                break
    found = search(scope, q=message, limit=SEARCH_MAX, exclude_session=session_id, exclude_refs=exclude, now=now)["results"]
    memory = [r for r in found if r["kind"] == "memory"][:TURN_MEMORY]
    chats = [r for r in found if r["kind"] == "conversation"][:TURN_CHATS]
    lines, used, kept = [], 0, []
    for result in memory + chats:
        when = datetime.fromtimestamp(result["ts"]).strftime("%Y-%m-%d") if result.get("ts") else ""
        label = (f'your notes on "{result["title"]}"' if result["kind"] == "memory"
                 else f'{result["role"]} in "{result["title"]}", {when}, message {result["ref"]}')
        line = f"- [{label}] " + " ".join(result["text"].split())
        if used + len(line) + 1 > TURN_CHARS:
            line = line[:max(0, TURN_CHARS - used - 1)]
        if len(line) < 40:
            break
        lines.append(line)
        kept.append(result)
        used += len(line) + 1
    return {"text": "\n".join(lines), "found": kept}


def read_message(scope: dict, ref: str) -> dict:
    """One message by its stable reference, checked against the live conversation. Another bot's or another
    owner's message is a 404, the same as one that does not exist. Text is capped at 8,000 characters."""
    from core.session_manager import session_manager
    from services import bot_turn_context as context
    bot_id, owner = _scope_ids(scope)
    if not isinstance(ref, str) or not ref or len(ref) > 200:
        raise RecallNotFound("not found")
    if ref.startswith("topic:"):
        match = re.fullmatch(r"topic:([A-Za-z0-9_-]+):(\d+)", ref)
        port = context.notebook()
        data = port.read(bot_id, f"memory/{match[1]}.md") if match and port else None
        blocks = _topic_blocks(data["text"]) if data else []
        if not match or int(match[2]) >= len(blocks):
            raise RecallNotFound("not found")
        text = blocks[int(match[2])]
        return {"ref": ref, "kind": "memory", "source": match[1], "role": "note", "ts": None,
                "text": text[:READ_CAP], "truncated": len(text) > READ_CAP}
    sync(bot_id, owner)
    with _db() as conn:
        row = conn.execute("SELECT * FROM docs WHERE bot_id=? AND owner=? AND kind='conversation' AND msg_ref=?",
                           (bot_id, owner, ref)).fetchone()
    if row is None:
        raise RecallNotFound("not found")
    session = session_manager.get_session(row["ref"])
    if (not session or session.get("agent_id") != bot_id or context.owner_of(session) != owner
            or not context.owner_conversation(session)):
        raise RecallNotFound("not found")
    if ref.startswith("digest:"):
        text, role, ts = row["text"], "digest", row["ts"]
    else:
        message = next((m for i, m in enumerate(session.get("messages") or []) if message_ref(session, i) == ref), None)
        if message is None or message.get("role") not in ("user", "assistant"):
            raise RecallNotFound("not found")
        text, role, ts = (message.get("content") or ""), message["role"], message.get("ts")
    if any(p.search(text) for p in _forgotten(owner)):
        raise RecallNotFound("not found")
    return {"ref": ref, "kind": "conversation", "source": row["ref"], "title": row["title"], "role": role, "ts": ts,
            "text": text[:READ_CAP], "truncated": len(text) > READ_CAP}
