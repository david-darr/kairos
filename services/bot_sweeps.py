"""Daily run-event pruning. Run totals and the monthly ledger are untouched."""
import asyncio
import logging
import time

from services import bot_usage

log = logging.getLogger(__name__)
_task = None


def sweep(now=None):
    from core import session_manager_store as store
    now = time.time() if now is None else now
    config = bot_usage.settings()
    cutoff = now - config["event_retention_days"] * 86400
    cap = int(config["event_size_cap_mb"] * 1024 * 1024)
    with store.transaction() as db:
        expired = db.execute("DELETE FROM run_events WHERE at < ?", (cutoff,)).rowcount
        # Account for UTF-8 payload bytes plus bounded SQLite row overhead.
        size_sql = "length(CAST(COALESCE(detail,'') AS BLOB)) + length(CAST(COALESCE(name,'') AS BLOB)) + 96"
        total = db.execute(f"SELECT COALESCE(SUM({size_sql}),0) FROM run_events").fetchone()[0]
        trimmed = 0
        if total > cap:
            for row in db.execute(f"SELECT run_id,seq,{size_sql} AS bytes FROM run_events ORDER BY at,run_id,seq").fetchall():
                if total <= cap: break
                db.execute("DELETE FROM run_events WHERE run_id=? AND seq=?", (row["run_id"], row["seq"]))
                total -= row["bytes"]; trimmed += 1
    return {"expired": expired, "trimmed": trimmed, "event_bytes": total}


async def _loop():
    while True:
        from core import accounts
        for account_id in accounts.all_accounts():  # each account's run details (Multi-Account group 4)
            with accounts.as_account(account_id):
                try: await asyncio.to_thread(sweep)
                except Exception: log.exception("Run details could not be pruned")
        await asyncio.sleep(86400)


def start():
    global _task
    if _task is None or _task.done(): _task = asyncio.create_task(_loop())


def stop():
    global _task
    if _task: _task.cancel()
    _task = None
