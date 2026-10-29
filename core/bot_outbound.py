"""The daily allowance for a bot's outbound sends (Bots redesign, Phase 3 unit U1, 2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-3-design.md, section 5.2.

Below Full, a bot with outbound policy "allow" may send without asking until it has used its
`daily_cap` for the day; policy "ask" always asks. Each external send reserves one unit before it
happens. The ledger is a small SQLite file (bot_outbound.sqlite3), so independent turns, routines and
threads race for the last unit inside one write transaction, and a restart forgets nothing.

Rules this file keeps:
- A reservation is keyed by owner, bot and invocation id, so a retried call reuses its unit and a
  handler's second check inside one call never charges twice.
- Successful and uncertain deliveries consume the unit. Only a send that provably never left
  (a refusal before any provider call) releases it. A reservation nobody finalizes counts as spent.
- The day is the owner's own IANA date; the zone and date are written on the row. A later change of
  zone can only add to the count, never reset it.
- Exactly-once delivery is not promised for a provider with no idempotency support.
"""
import os
import sqlite3
import threading
import time
from datetime import datetime, timedelta
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from core.constants import DATA_DIR

DB_FILE = os.path.join(DATA_DIR, "bot_outbound.sqlite3")
RESERVED, COMMITTED, UNCERTAIN, RELEASED = "reserved", "committed", "uncertain", "released"
CONSUMING = (RESERVED, COMMITTED, UNCERTAIN)
KEEP_DAYS = 45
_init_lock = threading.Lock()
_ready_for: Optional[str] = None

_SCHEMA = """
CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    date TEXT NOT NULL,
    zone TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    tool TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL,
    reserved_at REAL NOT NULL,
    finalized_at REAL,
    UNIQUE (owner, bot_id, invocation_id)
);
CREATE INDEX IF NOT EXISTS reservations_day ON reservations (owner, bot_id, date);
"""


def _connect() -> sqlite3.Connection:
    global _ready_for
    path = DB_FILE
    conn = sqlite3.connect(path, timeout=15, isolation_level=None)
    conn.row_factory = sqlite3.Row
    if _ready_for != path:
        with _init_lock:
            conn.executescript(_SCHEMA)
            _ready_for = path
    return conn


def _zone(name: Optional[str]) -> ZoneInfo:
    try:
        return ZoneInfo(name) if name else ZoneInfo("UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def owner_zone(owner: Optional[str]) -> str:
    """The owner's IANA zone: what their window last reported, else the machine's, else UTC."""
    try:
        from services import bot_chat_service
        entry = (getattr(bot_chat_service, "_PRESENCE", {}) or {}).get(owner or "") or {}
        if entry.get("timezone"):
            ZoneInfo(entry["timezone"])
            return entry["timezone"]
    except Exception:
        pass
    try:
        local = datetime.now().astimezone().tzinfo
        key = getattr(local, "key", None)
        if key:
            return key
    except Exception:
        pass
    return "UTC"


def local_date(zone: str, now: Optional[float] = None) -> str:
    return datetime.fromtimestamp(time.time() if now is None else now, _zone(zone)).date().isoformat()


def next_reset(zone: str, now: Optional[float] = None) -> float:
    """The next local midnight in the zone, as a unix time."""
    now = time.time() if now is None else now
    zoned = _zone(zone)
    moment = datetime.fromtimestamp(now, zoned)
    midnight = datetime.combine(moment.date() + timedelta(days=1), datetime.min.time(), zoned)
    return midnight.timestamp()


def _counted(rows, zone: str, now: float) -> int:
    """Rows that still spend today's allowance: the row's own date is today here, or is still today in
    the zone it was made in. A zone change therefore never frees a unit that was already used."""
    today = local_date(zone, now)
    count = 0
    for row in rows:
        if row["state"] not in CONSUMING:
            continue
        if row["date"] == today or local_date(row["zone"], now) == row["date"]:
            count += 1
    return count


def _rows(conn, owner: str, bot_id: str, now: float):
    since = (datetime.fromtimestamp(now) - timedelta(days=2)).date().isoformat()
    return conn.execute("SELECT * FROM reservations WHERE owner=? AND bot_id=? AND date>=?",
                        (owner, bot_id, since)).fetchall()


def usage(owner: Optional[str], bot_id: str, cap: int, zone: Optional[str] = None,
          now: Optional[float] = None) -> dict:
    """What the allowance looks like now: {cap, used, reserved, remaining, date, zone, resets_at}."""
    owner = owner or "local"
    now = time.time() if now is None else now
    zone = zone or owner_zone(owner)
    conn = _connect()
    try:
        rows = _rows(conn, owner, bot_id, now)
    finally:
        conn.close()
    used = _counted(rows, zone, now)
    pending = sum(1 for row in rows if row["state"] == RESERVED and
                  (row["date"] == local_date(zone, now) or local_date(row["zone"], now) == row["date"]))
    return {"cap": cap, "used": used, "reserved": pending, "remaining": max(0, cap - used),
            "date": local_date(zone, now), "zone": zone, "resets_at": next_reset(zone, now)}


def reserve(owner: Optional[str], bot_id: str, invocation_id: str, cap: int, tool: str = "",
            zone: Optional[str] = None, now: Optional[float] = None) -> dict:
    """Take one unit for this invocation, or report why not.

    Returns {ok, reused, used, remaining, ...}. The check and the insert are one immediate
    transaction, so two turns cannot both take the last unit."""
    owner = owner or "local"
    now = time.time() if now is None else now
    zone = zone or owner_zone(owner)
    today = local_date(zone, now)
    conn = _connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        try:
            held = conn.execute("SELECT * FROM reservations WHERE owner=? AND bot_id=? AND invocation_id=?",
                                (owner, bot_id, invocation_id)).fetchone()
            if held is not None and held["state"] != RELEASED:
                conn.execute("COMMIT")
                return {"ok": True, "reused": True, "state": held["state"], "cap": cap}
            rows = _rows(conn, owner, bot_id, now)
            used = _counted(rows, zone, now)
            if used >= cap:
                conn.execute("COMMIT")
                return {"ok": False, "reused": False, "cap": cap, "used": used, "remaining": 0,
                        "resets_at": next_reset(zone, now)}
            if held is not None:   # a released unit taken again by a retry
                conn.execute("UPDATE reservations SET state=?, date=?, zone=?, reserved_at=?, finalized_at=NULL "
                             "WHERE id=?", (RESERVED, today, zone, now, held["id"]))
            else:
                conn.execute("INSERT INTO reservations (owner, bot_id, date, zone, invocation_id, tool, state, "
                             "reserved_at) VALUES (?,?,?,?,?,?,?,?)",
                             (owner, bot_id, today, zone, invocation_id, tool[:80], RESERVED, now))
            conn.execute("DELETE FROM reservations WHERE date < ?",
                         ((datetime.fromtimestamp(now) - timedelta(days=KEEP_DAYS)).date().isoformat(),))
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()
    return {"ok": True, "reused": False, "cap": cap, "used": used + 1, "remaining": max(0, cap - used - 1)}


def finalize(owner: Optional[str], bot_id: str, invocation_id: str, outcome: str,
             now: Optional[float] = None) -> bool:
    """Settle a reservation: `committed` (sent), `uncertain` (may have been sent) or `released` (it
    provably never left). A reservation already settled stays as it is."""
    if outcome not in (COMMITTED, UNCERTAIN, RELEASED):
        raise ValueError("outcome is committed, uncertain or released")
    now = time.time() if now is None else now
    conn = _connect()
    try:
        cursor = conn.execute("UPDATE reservations SET state=?, finalized_at=? "
                              "WHERE owner=? AND bot_id=? AND invocation_id=? AND state=?",
                              (outcome, now, owner or "local", bot_id, invocation_id, RESERVED))
        return cursor.rowcount > 0
    finally:
        conn.close()


def outcome_for(result_text) -> str:
    """How a finished tool call settles its unit, from the text the tool returned."""
    text = result_text if isinstance(result_text, str) else str(result_text or "")
    head = text.lstrip()[:40]
    if head.startswith(("Not run:", "Not allowed:", "Not sent:", "Unknown tool", "Not saved:", "Stopped")):
        return RELEASED
    if head.startswith("Tool error:"):
        return UNCERTAIN
    return COMMITTED


def reset_for_test() -> None:
    global _ready_for
    _ready_for = None
