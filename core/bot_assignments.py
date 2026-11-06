"""Durable admission, lifecycle and recovery for card-backed delegated work.

No provider is started here. Cards remain the execution vehicle. Mutations and
their replay events share one SQLite transaction; callbacks run after commit.
"""
import hashlib
import json
import logging
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Optional

from core import accounts

PATH: Optional[str] = None  # a test can point it at its own file
TERMINAL = frozenset(("completed", "failed", "cancelled"))
STATUSES = TERMINAL | {"queued", "running", "needs_input", "waiting", "resume"}
OUTCOMES = {"done", "needs_input", "stalled", "interrupted", "budget", "provider_error", "denied",
            "expired", "stopped", "refused", "duplicate", "loop"}
_LOCK = threading.RLock()
_SINKS = {}
_LISTENERS = []
logger = logging.getLogger(__name__)


class Refused(ValueError):
    pass


def db_path() -> str:
    return PATH or accounts.path("bot_assignments.sqlite3")


@contextmanager
def _db():
    with _LOCK:
        path = Path(db_path())
        path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(path, timeout=15)
        connection.row_factory = sqlite3.Row
        try:
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS assignments (
                  id TEXT PRIMARY KEY, root_id TEXT NOT NULL, parent_id TEXT,
                  status TEXT NOT NULL, assignee_bot_id TEXT NOT NULL,
                  fingerprint TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS assignment_root ON assignments(root_id);
                CREATE TABLE IF NOT EXISTS events (
                  seq INTEGER PRIMARY KEY AUTOINCREMENT, assignment_id TEXT NOT NULL,
                  at REAL NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS budgets (
                  root_id TEXT PRIMARY KEY, requests INTEGER NOT NULL DEFAULT 0,
                  executions INTEGER NOT NULL DEFAULT 0, wakes INTEGER NOT NULL DEFAULT 0,
                  progress_at REAL NOT NULL);
            """)
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()


def _get(db, aid):
    row = db.execute("SELECT payload FROM assignments WHERE id=?", (aid,)).fetchone()
    return json.loads(row[0]) if row else None


def _rows(db, root_id=None):
    rows = db.execute("SELECT payload FROM assignments" + (" WHERE root_id=?" if root_id else ""),
                      (root_id,) if root_id else ()).fetchall()
    return [json.loads(row[0]) for row in rows]


def _put(db, node, kind, now):
    node["updated_at"] = now
    db.execute("INSERT INTO assignments VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET "
               "status=excluded.status,payload=excluded.payload", (node["id"], node["root_id"], node["parent_id"],
               node["status"], node["assignee_bot_id"], node["fingerprint"], json.dumps(node)))
    db.execute("INSERT INTO events(assignment_id,at,kind,detail) VALUES(?,?,?,?)",
               (node["id"], now, kind, json.dumps(node)))


def on_change(fn):
    if fn not in _LISTENERS:
        _LISTENERS.append(fn)
    return lambda: _LISTENERS.remove(fn) if fn in _LISTENERS else None


def register_sink(kind, fn):
    _SINKS[kind] = fn
    return lambda: _SINKS.pop(kind, None)


def _changed(node):
    for fn in tuple(_LISTENERS):
        try:
            fn(dict(node))
        except Exception:
            logger.exception("assignment observer failed")


def get(aid):
    with _db() as db:
        return _get(db, aid)


def tree(root_id=None, *, bot_id=None, status=None):
    with _db() as db:
        rows = _rows(db, root_id)
    return sorted((n for n in rows if (not bot_id or n["assignee_bot_id"] == bot_id or
                  n["requester"].get("bot_id") == bot_id) and (not status or n["status"] == status)),
                  key=lambda n: (n["created_at"], n["id"]))


def events(aid):
    with _db() as db:
        return [{"at": r[0], "kind": r[1], "detail": json.loads(r[2])} for r in db.execute(
            "SELECT at,kind,detail FROM events WHERE assignment_id=? ORDER BY seq", (aid,))]


def _text(value, maximum, label, required=False):
    if not isinstance(value, str) or len(value) > maximum or (required and not value.strip()):
        raise Refused(f"{label} must be {'1' if required else '0'} to {maximum} characters.")
    return value.strip()


def admit(requester, assignee_bot_id, brief, *, parent_id=None, origin="person", destination="work_thread",
          mode="work", reply="resume", done_when="", reason="", title="", rework=False,
          room_lane=False, now=None, approved=False, request_id=None):
    from services import bot_peers
    now = time.time() if now is None else now
    brief = _text(brief, 12000, "Brief", True)
    done_when, reason, title = (_text(done_when, 1000, "Done when"), _text(reason, 200, "Reason"), _text(title, 80, "Title"))
    requester = dict(requester)
    requester.setdefault("bot_id", requester.get("agent_id"))
    if requester.get("kind") not in ("chat", "bot", "room") or not requester.get("run_id"):
        raise Refused("Start this from a run or conversation.")
    if origin not in ("person", "routine", "room", "outside") or destination not in (
            "work_thread", "standing_thread", "room_thread") or mode not in ("work", "consult", "notify") or reply not in ("resume", "none"):
        raise Refused("Invalid assignment options.")
    if mode == "consult" and reply == "none":
        raise Refused("A consult needs a reply.")
    if mode == "notify":
        reply = "none"
    target = bot_peers._bot(assignee_bot_id)
    if target.get("hidden"):
        raise Refused("The assignee is unavailable.")
    source = requester.get("bot_id")
    if source == assignee_bot_id:
        raise Refused("This would create a bot delegation cycle.")
    if source:
        bot_peers.authorize(source, assignee_bot_id, approved=approved, session_id=requester.get("session_id"))
    fingerprint = hashlib.sha256(json.dumps([requester, parent_id, assignee_bot_id, brief, mode,
        rework, request_id], sort_keys=True).encode()).hexdigest()
    with _db() as db:
        existing = db.execute("SELECT payload FROM assignments WHERE fingerprint=?", (fingerprint,)).fetchone()
        if existing:
            return json.loads(existing[0])
        parent = _get(db, parent_id) if parent_id else None
        if parent_id and not parent:
            raise Refused("Parent assignment not found.")
        if parent and (parent["assignee_bot_id"] != source or parent["status"] in TERMINAL):
            raise Refused("This bot cannot delegate from that assignment.")
        depth = parent["depth"] + 1 if parent else 1
        if depth > 4:
            raise Refused("A delegation chain may have at most 4 hops.")
        ancestor = parent
        while ancestor:
            if assignee_bot_id in (ancestor["assignee_bot_id"], ancestor["requester"].get("bot_id")):
                raise Refused("This would create a bot delegation cycle.")
            ancestor = _get(db, ancestor["parent_id"]) if ancestor["parent_id"] else None
        if source == assignee_bot_id:
            raise Refused("This would create a bot delegation cycle.")
        rows = _rows(db)
        siblings = [n for n in rows if n["parent_id"] == parent_id and n["requester"].get("session_id") == requester.get("session_id")
                    and n["requester"].get("bot_id") == source and n["assignee_bot_id"] == assignee_bot_id
                    and n["brief"] == brief and n["mode"] == mode]
        if siblings and not (rework and all(n["status"] in TERMINAL for n in siblings)):
            raise Refused("Duplicate assignment. Use rework after it finishes.")
        if sum(n["requester"].get("run_id") == requester["run_id"] and n["requester"].get("bot_id") == source for n in rows) >= 5:
            raise Refused("At most 5 assignments per turn.")
        aid = uuid.uuid4().hex[:16]
        root_id = parent["root_id"] if parent else aid
        db.execute("INSERT OR IGNORE INTO budgets(root_id,progress_at) VALUES(?,?)", (root_id, now))
        budget = db.execute("SELECT * FROM budgets WHERE root_id=?", (root_id,)).fetchone()
        if budget["requests"] >= 64 or budget["executions"] >= 96:
            raise Refused("The assignment tree reached its budget.")
        db.execute("UPDATE budgets SET requests=requests+1 WHERE root_id=?", (root_id,))
        node = dict(id=aid, root_id=root_id, parent_id=parent_id, depth=depth, origin=origin, requester=requester,
                    assignee_bot_id=assignee_bot_id, destination=destination, mode=mode, reply=reply, brief=brief,
                    done_when=done_when, reason=reason, title=title, card_id=None, work_session_id=None,
                    room_lane=bool(room_lane), status="queued", outcome=None, level_source="own", executions=0,
                    restarts=0, restart_marker=None, result="", evidence={}, rework=bool(rework), question=None,
                    answer=None, batch_key=requester["run_id"], created_at=now, updated_at=now,
                    fingerprint=fingerprint, reported=False, stale_continuations=0, identical_errors=0)
        _put(db, node, "admitted", now)
    _changed(node)
    return node


def update(aid, *, now=None, **fields):
    allowed = {"card_id", "work_session_id", "status", "outcome", "question", "answer", "result", "evidence",
               "level_source", "level", "run_id", "restart_marker", "reported", "restarts", "stale_continuations", "identical_errors", "last_error", "progress_marker"}
    if set(fields) - allowed or ("status" in fields and fields["status"] not in STATUSES):
        raise ValueError("Invalid assignment update")
    now = time.time() if now is None else now
    with _db() as db:
        node = _get(db, aid)
        if not node:
            raise KeyError(aid)
        if node["status"] in TERMINAL and fields.get("status", node["status"]) != node["status"]:
            return node
        if fields.get("status") == "running" and node["status"] != "running":
            budget = db.execute("SELECT executions FROM budgets WHERE root_id=?", (node["root_id"],)).fetchone()[0]
            if budget >= 96:
                fields.update(status="failed", outcome="budget")
            else:
                db.execute("UPDATE budgets SET executions=executions+1 WHERE root_id=?", (node["root_id"],))
                node["executions"] += 1
        if fields.get("status") in TERMINAL and fields.get("outcome") not in OUTCOMES:
            raise ValueError("A terminal assignment needs an outcome")
        if all(node.get(k) == v for k, v in fields.items()):
            return node
        node.update(fields)
        _put(db, node, "changed", now)
    _changed(node)
    return node


def progress(aid, marker, *, now=None):
    """Only a new durable artifact/result renews budgets. Activity does not."""
    now = time.time() if now is None else now
    with _db() as db:
        node = _get(db, aid)
        if not node:
            raise KeyError(aid)
        if not marker or marker == node.get("progress_marker"):
            return False
        node["progress_marker"] = marker
        db.execute("UPDATE budgets SET requests=0,executions=0,wakes=0,progress_at=? WHERE root_id=?", (now, node["root_id"]))
        _put(db, node, "progress", now)
    _changed(node)
    return True


def settle(aid, outcome="done", result="", *, evidence=None, now=None):
    node = get(aid)
    if not node:
        raise KeyError(aid)
    if node["status"] in TERMINAL:
        return node
    result = str(result)[:12000]
    if outcome == "done":
        progress(aid, hashlib.sha256(result.encode()).hexdigest() if result else None, now=now)
    return update(aid, status="completed" if outcome == "done" else "failed", outcome=outcome,
                  result=result, evidence=evidence or {}, now=now)


def cancel(aid, outcome="stopped", *, whole_tree=False, now=None):
    node = get(aid)
    if not node:
        raise KeyError(aid)
    rows = tree(node["root_id"])
    selected = {aid}
    for row in sorted(rows, key=lambda n: n["depth"]):
        if row["parent_id"] in selected:
            selected.add(row["id"])
    for row in rows:
        if row["status"] not in TERMINAL and (whole_tree or row["id"] in selected):
            update(row["id"], status="cancelled", outcome=outcome, now=now)
    return get(aid)


def live_edges(limit=12):
    return [{"assignment_id": n["id"], "source": n["requester"].get("bot_id"), "target": n["assignee_bot_id"],
             "reason": n["reason"], "status": n["status"], "room_id": n["requester"].get("room_id")}
            for n in tree() if n["status"] not in TERMINAL][:min(limit, 12)]


def has_work(bot_id):
    """True when the bot ever asked for or received delegated work, finished or not."""
    with _db() as db:
        return any(n["assignee_bot_id"] == bot_id or n["requester"].get("bot_id") == bot_id for n in _rows(db))


def consume_wake(root_id):
    with _db() as db:
        row = db.execute("SELECT wakes FROM budgets WHERE root_id=?", (root_id,)).fetchone()
        if not row or row[0] >= 48:
            return False
        db.execute("UPDATE budgets SET wakes=wakes+1 WHERE root_id=?", (root_id,))
    return True


def continuation(aid, marker=None, error=None, *, now=None):
    node = get(aid)
    stale = node["stale_continuations"] + 1 if not marker or marker == node.get("progress_marker") else 0
    errors = node["identical_errors"] + 1 if error and error == node.get("last_error") else int(bool(error))
    if marker and not stale:
        progress(aid, marker, now=now)
    update(aid, stale_continuations=stale, identical_errors=errors, last_error=error, now=now)
    if stale >= 2 or errors >= 3:
        return settle(aid, "loop", "Delegated work stopped making progress.", now=now)
    return update(aid, status="queued", now=now)


def evidence(run_id):
    from core import session_manager_store
    timeline = session_manager_store.run_events(run_id) if run_id else []
    tools, files, errors, outward = [], [], [], []
    for event in timeline:
        name, detail = event.get("name") or "", event.get("detail") or ""
        if event.get("kind") == "tool_started":
            tools.append(name)
            if _outward(name, detail):
                outward.append({"tool": name, "detail": _redact(detail)})
            if any(word in name.lower() for word in ("write", "edit", "patch")):
                files.append(_redact(detail))
        if event.get("ok") is False:
            errors.append(_redact(detail))
    return {"tools": tools[:200], "files_changed": files[:100], "errors": errors[:100], "outward_actions": outward[:100]}


def _redact(text):
    from core.logs import scrub_credentials
    return scrub_credentials(str(text))[:2000]


def _outward(name, detail):
    # Phase 2's tool catalogue only knows read and write, not outward, so the
    # outward test is explicit: git push or commit, and sending or destroying tools.
    import re
    return bool(re.search(r"\bgit\s+(?:[^;&|\n]*\s)?(?:push|commit)\b", detail, re.I) or
                re.search(r"send|publish|payment|pay_invoice|delete|remove|post_to_room", name, re.I))


def reconcile_startup(*, now=None, read_evidence=None):
    read_evidence = read_evidence or (lambda n: evidence(n.get("run_id")))
    rows = tree()
    for node in rows:
        if node["status"] == "needs_input":
            continue
        if node["status"] != "running":
            continue
        proof = read_evidence(node)
        if proof.get("outward_actions"):
            settle(node["id"], "interrupted", "Work was interrupted after an outward action.", evidence=proof, now=now)
        elif any(n["parent_id"] == node["id"] for n in rows):
            update(node["id"], status="waiting", restart_marker="cut", now=now)
        elif node["restarts"]:
            settle(node["id"], "interrupted", "Work was interrupted twice.", evidence=proof, now=now)
        else:
            update(node["id"], status="queued", restarts=1, restart_marker="rerun", now=now)
    return tree()


def tick(*, now=None, parked=None, reachable=None):
    from services import bot_peers
    now = time.time() if now is None else now
    parked = parked or (lambda n: False)
    reachable = reachable or (lambda n: not n["requester"].get("bot_id") or bot_peers.can_reach(n["requester"]["bot_id"], n["assignee_bot_id"]))
    rows = tree()
    with _db() as db:
        budgets = {row["root_id"]: dict(row) for row in db.execute("SELECT * FROM budgets")}
    for node in rows:
        if node["status"] in TERMINAL:
            continue
        aid, age = node["id"], now - node["updated_at"]
        if not reachable(node):
            cancel(aid, "refused", whole_tree=True, now=now)
        elif node["status"] == "queued" and now - node["created_at"] > 86400:
            settle(aid, "expired", now=now)
        elif node["status"] == "needs_input" and age > 1800 and not parked(node):
            settle(aid, "expired", now=now)
        elif node["status"] == "running" and age > 1200 and not parked(node):
            settle(aid, "stalled", now=now)
        elif now - budgets[node["root_id"]]["progress_at"] > 14400 and not any(
                parked(n) for n in rows if n["root_id"] == node["root_id"]):
            cancel(aid, "stalled", whole_tree=True, now=now)
    rows = tree()
    for node in rows:
        children = [n for n in rows if n["parent_id"] == node["id"]]
        if node["status"] == "waiting" and children and all(n["status"] in TERMINAL for n in children):
            update(node["id"], status="resume", now=now)
        if node["status"] in TERMINAL and not node["reported"]:
            sink = _SINKS.get(node["requester"]["kind"])
            if sink:
                try:
                    sink(node)  # sink must deduplicate by assignment ID
                    update(node["id"], reported=True, now=now)
                except Exception:
                    logger.exception("assignment report delivery failed")
    with _db() as db:
        for root in {n["root_id"] for n in rows}:
            group = [n for n in rows if n["root_id"] == root]
            if all(n["status"] in TERMINAL and now - n["updated_at"] > 30 * 86400 for n in group):
                db.execute("DELETE FROM events WHERE assignment_id IN (SELECT id FROM assignments WHERE root_id=?)", (root,))
                db.execute("DELETE FROM assignments WHERE root_id=?", (root,))
                db.execute("DELETE FROM budgets WHERE root_id=?", (root,))
    return tree()
