"""Durable mobile projection of chat_live, device enrollment and notification outbox.

Separate SQLite store, no writes on import. All operations use short transactions.
No transcript or tool arguments are included in the notification payload.
"""
import hashlib
import json
import os
import sqlite3
import time
import uuid
from contextlib import contextmanager

from cryptography.hazmat.primitives.asymmetric import ec
from core.constants import DATA_DIR
from core import web_push

DB_FILE = os.path.join(DATA_DIR, "mobile_activity.db")
TERMINAL = {"completed", "failed", "stopped", "interrupted"}
EVENT_LIMIT = 1000


@contextmanager
def database():
    os.makedirs(os.path.dirname(DB_FILE), exist_ok=True)
    db = sqlite3.connect(DB_FILE, timeout=10)
    db.row_factory = sqlite3.Row
    try:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY, private TEXT, public TEXT, subject TEXT);
        CREATE TABLE IF NOT EXISTS activity (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, owner TEXT NOT NULL,
          request_id TEXT, fingerprint TEXT, state TEXT NOT NULL, snapshot TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0, updated REAL NOT NULL,
          UNIQUE(owner, session_id, request_id));
        CREATE INDEX IF NOT EXISTS activity_session ON activity(session_id, updated);
        CREATE TABLE IF NOT EXISTS events (
          run_id TEXT, revision INTEGER, payload TEXT, PRIMARY KEY(run_id, revision));
        CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY, owner TEXT NOT NULL, endpoint TEXT UNIQUE NOT NULL,
          subscription TEXT NOT NULL, binding TEXT NOT NULL, preferences TEXT NOT NULL,
          created REAL NOT NULL, last_status INTEGER, last_delivery REAL);
        CREATE TABLE IF NOT EXISTS outbox (
          id TEXT PRIMARY KEY, device_id TEXT NOT NULL, run_id TEXT NOT NULL, kind TEXT NOT NULL,
          permission_id TEXT, payload TEXT NOT NULL, expires REAL NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0, next_attempt REAL NOT NULL, status TEXT NOT NULL DEFAULT 'pending');
        CREATE INDEX IF NOT EXISTS outbox_due ON outbox(status, next_attempt);
        """)
        with db:
            yield db
    finally:
        db.close()


def config(create=False, subject=None) -> dict | None:
    with database() as db:
        row = db.execute("SELECT * FROM config WHERE id=1").fetchone()
        if not row and create:
            key = ec.generate_private_key(ec.SECP256R1())
            # A contact URI is supplied by the host; default is the app project.
            contact = os.getenv("KAIROS_PUSH_CONTACT") or subject or ""
            private = web_push.b64(key.private_numbers().private_value.to_bytes(32, "big"))
            db.execute("INSERT INTO config VALUES(1,?,?,?)", (private, web_push.b64(web_push.public_key(key)), contact))
            row = db.execute("SELECT * FROM config WHERE id=1").fetchone()
        if row and not row["subject"] and subject:
            db.execute("UPDATE config SET subject=? WHERE id=1", (subject,))
            row = db.execute("SELECT * FROM config WHERE id=1").fetchone()
        return dict(row) if row else None


def create_run(run_id, session, owner, request_id, fingerprint):
    now = time.time()
    snapshot = {"id": run_id, "session_id": session["id"], "state": "running", "text": "",
                "title": session.get("title", "Chat"), "forge": bool(session.get("forge")),
                "started_at": now, "updated_at": now, "revision": 0,
                "permissions": [], "tool_steps": [], "tool_events": []}
    with database() as db:
        db.execute("INSERT INTO activity VALUES(?,?,?,?,?,?,?,?,?)",
                   (run_id, session["id"], owner, request_id, fingerprint, "running", json.dumps(snapshot), 0, now))
    return snapshot


def find_request(owner, session_id, request_id):
    if not request_id:
        return None
    with database() as db:
        row = db.execute("SELECT id,fingerprint FROM activity WHERE owner=? AND session_id=? AND request_id=?",
                         (owner, session_id, request_id)).fetchone()
        return dict(row) if row else None


def read_run(run_id):
    with database() as db:
        row = db.execute("SELECT * FROM activity WHERE id=?", (run_id,)).fetchone()
        return {**dict(row), "snapshot": json.loads(row["snapshot"])} if row else None


def list_runs(owner, *, session_id=None, active=True):
    with database() as db:
        sql, args = "SELECT snapshot FROM activity WHERE owner=?", [owner]
        if session_id:
            sql += " AND session_id=?"
            args.append(session_id)
        if active:
            sql += " AND state IN ('running','awaiting_permission')"
        return [json.loads(row[0]) for row in db.execute(sql + " ORDER BY updated DESC LIMIT 100", args)]


def publish(run_id, payload, state=None):
    with database() as db:
        row = db.execute("SELECT * FROM activity WHERE id=?", (run_id,)).fetchone()
        snap = json.loads(row["snapshot"])
        if "chunk" in payload:
            snap["text"] += payload["chunk"]
        if "permission" in payload:
            snap["permissions"].append(payload["permission"])
        if "permission_closed" in payload:
            snap["permissions"] = [p for p in snap["permissions"] if p["id"] != payload["permission_closed"]]
            db.execute("UPDATE outbox SET status='expired' WHERE run_id=? AND permission_id=? AND status='pending'",
                       (run_id, payload["permission_closed"]))
        for field, key in (("tool_steps", "tool_step"), ("tool_events", "tool_event")):
            if key in payload:
                snap[field] = (snap[field] + [payload[key]])[-200:]
        if "handoffs" in payload:
            snap["handoffs"] = payload["handoffs"]
        if "error" in payload:
            snap["error"] = payload["error"]
        if "run_id" in payload:
            snap["run_id"] = payload["run_id"]
        snap["state"] = state or ("awaiting_permission" if snap["permissions"] else "running")
        if snap["state"] in TERMINAL:
            snap["permissions"] = []
            db.execute("UPDATE outbox SET status='expired' WHERE run_id=? AND kind='permission' AND status='pending'", (run_id,))
        snap["revision"] += 1
        snap["updated_at"] = time.time()
        db.execute("UPDATE activity SET state=?,snapshot=?,revision=?,updated=? WHERE id=?",
                   (snap["state"], json.dumps(snap), snap["revision"], snap["updated_at"], run_id))
        db.execute("INSERT INTO events VALUES(?,?,?)", (run_id, snap["revision"], json.dumps(payload)))
        db.execute("DELETE FROM events WHERE run_id=? AND revision<=?", (run_id, snap["revision"] - EVENT_LIMIT))
    return snap


def project_live(packet):
    """Translate live packets to mobile persistence and alerts only."""
    if packet["type"] == "snapshot":
        return
    run_id = packet.get("turnId") or packet.get("run", {}).get("turnId")
    if not run_id or not read_run(run_id):
        return
    if packet["type"] == "started":
        return
    if packet["type"] == "chunk":
        publish(run_id, {"chunk": packet["chunk"]})
    elif packet["type"] in ("tool_event", "tool_step"):
        publish(run_id, {packet["type"]: packet["value"]})
    elif packet["type"] == "update":
        changes = packet["changes"]
        payload = {}
        if "runId" in changes:
            payload["run_id"] = changes["runId"]
        if "handoffs" in changes:
            payload["handoffs"] = changes["handoffs"]
        previous = read_run(run_id)["snapshot"]["permissions"]
        if "permission" in changes:
            for permission in previous:
                if not changes["permission"] or permission["id"] != changes["permission"]["id"]:
                    publish(run_id, {"permission_closed": permission["id"]})
            if changes["permission"] and not any(p["id"] == changes["permission"]["id"] for p in previous):
                payload["permission"] = changes["permission"]
        state = {"done": "completed", "failed": "failed", "stopped": "stopped"}.get(changes.get("status"))
        if changes.get("error"):
            payload["error"] = changes["error"]
        snap = publish(run_id, payload, state)
        if payload.get("permission", {}).get("expires_at"):
            enqueue(run_id, "permission", payload["permission"])
        if state in ("completed", "failed") and not snap.get("handoffs"):
            enqueue(run_id, state)


def replay(run_id, after):
    with database() as db:
        rows = db.execute("SELECT revision,payload FROM events WHERE run_id=? AND revision>? ORDER BY revision", (run_id, after)).fetchall()
        return [(r[0], json.loads(r[1])) for r in rows]


def recover():
    """Host restarts never replay tool calls. Mark unfinished work interrupted."""
    with database() as db:
        ids = [r[0] for r in db.execute("SELECT id FROM activity WHERE state IN ('running','awaiting_permission')")]
        cutoff = time.time() - 7 * 86400
        db.execute("DELETE FROM events WHERE run_id IN (SELECT id FROM activity WHERE updated<?)", (cutoff,))
        db.execute("DELETE FROM activity WHERE updated<?", (cutoff,))
        db.execute("DELETE FROM outbox WHERE expires<? OR status!='pending'", (time.time(),))
    for run_id in ids:
        record = read_run(run_id)
        if record:
            publish(run_id, {"error": "The Kairos host restarted. This response was interrupted.", "done": True, "state": "interrupted"}, "interrupted")
            from core.session_manager import session_manager
            from core import runs, session_manager_store
            session = session_manager.get_session(record["session_id"])
            canonical_id = record["snapshot"].get("run_id") or run_id
            if session and not any(m.get("run_id") == canonical_id and m["role"] == "assistant" for m in session.get("messages", [])):
                session_manager.append_message(record["session_id"], "assistant", record["snapshot"]["text"],
                                               status="interrupted", extra={"run_id": canonical_id})
            if not session_manager_store.get_run(canonical_id):
                runs.record(runs.RunContext("chat", run_id=canonical_id, session_id=record["session_id"],
                                            started_at=record["snapshot"]["started_at"]),
                            runs.Tally(), "stopped", detail="The Kairos host restarted; this run was interrupted.")


def binding(token):
    return hashlib.sha256(token.encode()).hexdigest() if token else "local"


def enroll(owner, subscription, session_binding):
    subscription = web_push.validate(subscription)
    with database() as db:
        row = db.execute("SELECT * FROM devices WHERE endpoint=?", (subscription["endpoint"],)).fetchone()
        if row and row["owner"] != owner:
            # An endpoint belongs to one account. It must be removed before
            # another account can claim it, even if a user copies its URL.
            raise ValueError("This device is enrolled for another account. Disable its notifications first.")
        if not row and db.execute("SELECT COUNT(*) FROM devices WHERE owner=?", (owner,)).fetchone()[0] >= 10:
            raise ValueError("Remove an old device before adding another (10 device limit)")
        device_id = row["id"] if row else uuid.uuid4().hex
        prefs = row["preferences"] if row else json.dumps({"completed": True, "failed": True, "permission": True})
        db.execute("INSERT INTO devices(id,owner,endpoint,subscription,binding,preferences,created) VALUES(?,?,?,?,?,?,?) "
                   "ON CONFLICT(id) DO UPDATE SET subscription=excluded.subscription,binding=excluded.binding",
                   (device_id, owner, subscription["endpoint"], json.dumps(subscription), session_binding, prefs, time.time()))
        return device_id


def devices(owner, session_binding=None):
    with database() as db:
        return [{"id": r["id"], "preferences": json.loads(r["preferences"]), "created_at": r["created"],
                 "last_status": r["last_status"], "last_delivery": r["last_delivery"],
                 "current_login": r["binding"] == session_binding if session_binding else True}
                for r in db.execute("SELECT * FROM devices WHERE owner=?", (owner,))]


def change_device(owner, device_id, preferences=None):
    with database() as db:
        if preferences is None:
            db.execute("DELETE FROM outbox WHERE device_id IN (SELECT id FROM devices WHERE owner=? AND id=?)", (owner, device_id))
            cursor = db.execute("DELETE FROM devices WHERE owner=? AND id=?", (owner, device_id))
        else:
            cursor = db.execute("UPDATE devices SET preferences=? WHERE owner=? AND id=?", (json.dumps(preferences), owner, device_id))
            if cursor.rowcount:
                for kind, enabled in preferences.items():
                    if not enabled:
                        db.execute("UPDATE outbox SET status='disabled' WHERE device_id=? AND kind=? AND status='pending'", (device_id, kind))
        return cursor.rowcount > 0


def revoke(*, owner=None, session_binding=None):
    with database() as db:
        field, value = ("owner", owner) if owner is not None else ("binding", session_binding)
        db.execute(f"DELETE FROM outbox WHERE device_id IN (SELECT id FROM devices WHERE {field}=?)", (value,))
        db.execute(f"DELETE FROM devices WHERE {field}=?", (value,))


def enqueue(run_id, kind, permission=None):
    with database() as db:
        run = db.execute("SELECT * FROM activity WHERE id=?", (run_id,)).fetchone()
        snap = json.loads(run["snapshot"])
        now = time.time()
        expiry = permission["expires_at"] if permission else now + 3600
        text = {"completed": "Your reply is ready. Tap to open the chat.", "failed": "A chat could not finish. Tap to review.",
                "permission": "A chat needs your permission. Tap to review before the request expires.",
                "test": "Notifications are enabled on this device."}[kind]
        payload = {"title": "Kairos", "body": text, "url": "/?chat=" + run["session_id"],
                   "tag": "kairos-" + run_id, "kind": kind, "expires_at": expiry}
        for device in db.execute("SELECT * FROM devices WHERE owner=?", (run["owner"],)).fetchall():
            if kind != "test" and not json.loads(device["preferences"]).get(kind):
                continue
            event_id = hashlib.sha256(f"{device['id']}:{run_id}:{kind}:{(permission or {}).get('id', '')}".encode()).hexdigest()
            db.execute("INSERT OR IGNORE INTO outbox(id,device_id,run_id,kind,permission_id,payload,expires,next_attempt) VALUES(?,?,?,?,?,?,?,?)",
                       (event_id, device["id"], run_id, kind, (permission or {}).get("id"), json.dumps(payload), expiry, now))


def due():
    with database() as db:
        db.execute("UPDATE outbox SET status='expired' WHERE status='pending' AND expires<=?", (time.time(),))
        return [dict(r) for r in db.execute("SELECT o.*,d.subscription,d.owner,d.binding FROM outbox o JOIN devices d ON d.id=o.device_id "
                                          "WHERE o.status='pending' AND o.next_attempt<=? ORDER BY o.next_attempt LIMIT 20", (time.time(),))]


def enqueue_test(owner, device_id):
    with database() as db:
        device = db.execute("SELECT id FROM devices WHERE id=? AND owner=?", (device_id, owner)).fetchone()
        if not device:
            return False
        now = time.time()
        # Bound repeated taps without needing a general broadcast endpoint.
        recent = db.execute("SELECT id FROM outbox WHERE device_id=? AND kind='test' AND expires>?", (device_id, now)).fetchone()
        if recent:
            return True
        payload = {"kind": "test", "url": "/", "tag": "kairos-test", "expires_at": now + 60}
        db.execute("INSERT INTO outbox(id,device_id,run_id,kind,payload,expires,next_attempt) VALUES(?,?,?,?,?,?,?)",
                   (uuid.uuid4().hex, device_id, "", "test", json.dumps(payload), now + 60, now))
        return True


def delivery_result(item, status, retry_after=0):
    with database() as db:
        db.execute("UPDATE devices SET last_status=?,last_delivery=? WHERE id=?", (status, time.time(), item["device_id"]))
        if status in (404, 410):
            db.execute("DELETE FROM devices WHERE id=?", (item["device_id"],))
            db.execute("DELETE FROM outbox WHERE device_id=?", (item["device_id"],))
            return
        attempts = item["attempts"] + 1
        retry = (status == 0 or status in (408, 429) or status >= 500) and attempts < 5
        state = "sent" if 200 <= status < 300 else "pending" if retry else "failed"
        delay = min(900, max(2 ** attempts * 5, retry_after))
        db.execute("UPDATE outbox SET status=?,attempts=?,next_attempt=? WHERE id=?", (state, attempts, time.time() + delay, item["id"]))
