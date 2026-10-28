"""Part 2 g6 / A12 benchmarks: scheduler idle cost, queue delay, bursts, large
boards and history, outbox retries, per-run fixed overhead, and what a card's
prompt carries. Prints numbers; asserts nothing (targets live in the report).

Run: python -B -X utf8 scripts/bench_g6_tasks.py
"""
import asyncio
import json
import os
import statistics
import sys
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch

_DATA = tempfile.TemporaryDirectory(prefix="jarvis-g6-bench-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

REAL_AROUND = None
from core import file_checkpoints, outbox, runs, session_manager_store as store, task_scheduler  # noqa: E402
from services import task_service as task_module  # noqa: E402
from services.task_service import task_service  # noqa: E402


class Fast:
    seen: list = []

    async def connect(self): pass
    async def disconnect(self): pass

    async def events(self, prompt, stream=True):
        Fast.seen.append(prompt)
        yield runs.usage_event({"input_tokens": 10, "output_tokens": 5, "total_tokens": 15})
        yield runs.text(Fast.reply if hasattr(Fast, "reply") else "ok")
        yield runs.result(True)


@asynccontextmanager
async def no_snapshot(source, workspace=None):
    yield


def pct(values, p):
    values = sorted(values)
    return values[min(len(values) - 1, int(round(p / 100 * (len(values) - 1))))]


def line(name, values, unit="ms"):
    scale = 1000 if unit == "ms" else 1
    print(f"{name:58s} n={len(values):4d} p50={pct(values, 50) * scale:9.2f}{unit} p95={pct(values, 95) * scale:9.2f}{unit} max={max(values) * scale:9.2f}{unit}")


def timed(fn, n):
    out = []
    for _ in range(n):
        s = time.perf_counter()
        fn()
        out.append(time.perf_counter() - s)
    return out


def reset():
    task_service._tasks.clear()
    task_service._runs.clear()
    task_service._save_tasks()
    task_service._save_runs()


def main():
    global REAL_AROUND
    REAL_AROUND = file_checkpoints.around_turn
    patches = [patch.object(task_scheduler, "_task_brain", lambda t: Fast()),
               patch.object(task_scheduler, "task_endpoint_id", lambda t: "ep"),
               patch("core.token_usage.record_usage"),
               patch("core.channels.registry.send_to_channel", lambda c, t: _ok())]
    for p in patches:
        p.start()
    with patch("core.file_checkpoints.around_turn", no_snapshot):
        run_benchmarks()


async def _ok():
    return True


def run_benchmarks():
    print("== per-run fixed overhead (one tiny task, no model time)")
    reset()
    task = task_service.create_task("t", "p", "interval", interval_seconds=3600)
    asyncio.run(task_scheduler.start_run(task, "manual"))
    line("start_run, checkpoints off", timed(lambda: asyncio.run(task_scheduler.start_run(task, "manual")), 15))
    writes = {"n": 0, "bytes": 0}
    real_write = task_module.write_json_atomic

    def counting(path, data, *a, **k):
        writes["n"] += 1
        writes["bytes"] += len(json.dumps(data))
        return real_write(path, data, *a, **k)
    with patch.object(task_module, "write_json_atomic", counting):
        asyncio.run(task_scheduler.start_run(task, "manual"))
    print(f"json file rewrites per run: {writes['n']} ({writes['bytes']} bytes total)")

    with patch("core.file_checkpoints.around_turn", REAL_AROUND):
        line("start_run, checkpoints ON (vault + repo, twice)", timed(lambda: asyncio.run(task_scheduler.start_run(task, "manual")), 3))
    for root in file_checkpoints._roots(None):
        s = time.perf_counter()
        _, manifest, _ = file_checkpoints._snapshot(root)
        print(f"  snapshot of {root.name or root}: {len(manifest)} files, {(time.perf_counter() - s) * 1000:.0f} ms")

    print("== scheduler idle tick (nothing due)")
    for cards, tasks in ((0, 0), (200, 20), (2000, 200)):
        reset()
        for i in range(tasks):
            task_service.create_task(f"s{i}", "p", "interval", interval_seconds=3600)
        for i in range(cards):
            task_service.create_task(f"c{i}", "p", "card", status="backlog")['status'] if False else task_service.create_task(f"c{i}", "p", "card", status="backlog").update(status="done" if i % 2 else "backlog")
        saves = {"n": 0}
        with patch.object(task_module, "write_json_atomic", lambda *a, **k: saves.__setitem__("n", saves["n"] + 1)):
            async def one():
                await task_scheduler._tick()
                lane = task_scheduler._lanes["card"]
                if lane:
                    await lane
            asyncio.run(one())
            samples = []
            for _ in range(15):
                s = time.perf_counter()
                asyncio.run(one())
                samples.append(time.perf_counter() - s)
        line(f"idle _tick, {tasks} tasks + {cards} cards", samples)
        print(f"  file writes in an idle tick: {saves['n'] // 16}; ticks per minute at the 15 s poll: 4")

    print("== queue delay and bursts")
    reset()
    for i in range(50):
        t = task_service.create_task(f"b{i}", "p", "interval", interval_seconds=3600)
        t["next_run_at"] = (__import__("datetime").datetime.now(__import__("datetime").timezone.utc) - __import__("datetime").timedelta(seconds=10)).isoformat()
    task_service._save_tasks()
    s = time.perf_counter()

    async def drain():
        await task_scheduler._tick()
        await task_scheduler._lanes["schedule"]
    asyncio.run(drain())
    total = time.perf_counter() - s
    done = [r for r in task_service.list_runs() if r["outcome"] == "succeeded"]
    print(f"50 tasks all due at once: all ran={len(done)} in {total * 1000:.0f} ms ({total / 50 * 1000:.1f} ms each, serial lane); last waits {total * 1000:.0f} ms behind the first")
    reset()
    for i in range(40):
        task_service.create_task(f"k{i}", "p", "card", status="ready")
    s = time.perf_counter()
    passes = 0
    while task_service.next_card() is not None and passes < 100:
        asyncio.run(task_scheduler.dispatch_cards())
        passes += 1
    print(f"40 ready cards: {passes} dispatch passes (one card per pass, one pass per 15 s poll = {passes * 15 / 60:.1f} min of poll time), cpu {(time.perf_counter() - s) * 1000:.0f} ms")

    print("== large board")
    reset()
    for i in range(3000):
        c = task_service.create_task(f"card {i}", "prompt " * 20, "card", status="backlog")
        c["status"] = ["backlog", "ready", "done", "review", "blocked"][i % 5]
        c["comments"] = [{"at": 0, "kind": "result", "text": "x" * 1500, "by": "jarvis"}]
    task_service._save_tasks()
    size = Path(task_module.TASKS_FILE).stat().st_size
    print(f"tasks.json with 3000 cards: {size / 1e6:.1f} MB")
    line("list_tasks (route payload build)", timed(lambda: json.dumps(task_service.list_tasks()), 10))
    line("next_card", timed(task_service.next_card, 30))
    line("_save_tasks (every claim/finish/status move)", timed(task_service._save_tasks, 10))
    print(f"GET /api/tasks payload: {len(json.dumps(task_service.list_tasks())) / 1e6:.1f} MB for the Tasks first load")

    print("== large history")
    reset()
    for i in range(200):
        t = task_service.create_task(f"h{i}", "p", "interval", interval_seconds=3600)
        for j in range(task_module.MAX_RUNS_PER_TASK):
            task_service._runs.append({"id": f"{i}-{j}", "task_id": t["id"], "task_name": t["name"], "started_at": j, "ran_at": j, "duration_seconds": 1,
                                       "outcome": "succeeded", "output": "o" * 800, "error": None, "delivered": None, "delivery_id": None,
                                       "run_id": None, "source": "manual", "scheduled_for": None, "late_seconds": None, "endpoint_id": None,
                                       "model": "Claude", "attempt": None})
    task_service._save_runs()
    ids = [t["id"] for t in task_service.list_tasks()]
    print(f"task_runs.json: {len(task_service._runs)} runs, {Path(task_module.TASK_RUNS_FILE).stat().st_size / 1e6:.1f} MB")
    line("list_runs(one task) (opened per task row)", timed(lambda: task_service.list_runs(ids[0]), 30))
    line("list_runs(all)", timed(task_service.list_runs, 5))
    line("_save_runs (3 per run: queued, running, finished)", timed(task_service._save_runs, 8))
    line("200 x list_runs(task) = history of every row", timed(lambda: [task_service.list_runs(i) for i in ids], 3))

    print("== outbox")
    with store.transaction() as conn:
        conn.execute("DELETE FROM deliveries")
    for i in range(300):
        outbox.enqueue(f"b:{i}", "discord", "hello " * 50)
    calls = {"n": 0}

    async def failing(channel, text):
        calls["n"] += 1
        return False
    with patch("core.channels.registry.send_to_channel", failing):
        s = time.perf_counter()
        sent_batches = 0
        while asyncio.run(_pending_due()) and sent_batches < 40:
            asyncio.run(outbox.send_due())
            sent_batches += 1
        print(f"300 pending, all failing: {sent_batches} send_due passes, {calls['n']} send attempts, {(time.perf_counter() - s) * 1000:.0f} ms")
        s = time.perf_counter()
        asyncio.run(outbox.send_due(time.time() + 61))
        print(f"idle retry pass later (20 per batch): {(time.perf_counter() - s) * 1000:.0f} ms; backlog drains at {outbox.BATCH} messages per 15 s poll => 300 takes {300 / outbox.BATCH * 15:.0f} s")
    with store.transaction() as conn:
        conn.execute("DELETE FROM deliveries")

    print("== what a card's prompt carries (tokens ~ chars/4)")
    reset()
    Fast.seen.clear()
    Fast.reply = "R" * 20000
    a = task_service.create_task("a", "Collect the numbers.", "card", status="ready")
    asyncio.run(task_scheduler.dispatch_cards())
    task_service.set_card_status(a["id"], "done")
    b = task_service.create_task("b", "Summarise.", "card", status="ready", depends_on=[a["id"]])
    c = task_service.create_task("c", "Review.", "card", status="ready", depends_on=[b["id"], a["id"]])
    Fast.reply = "short"
    asyncio.run(task_scheduler.dispatch_cards())
    task_service.set_card_status(b["id"], "done")
    asyncio.run(task_scheduler.dispatch_cards())
    for who, prompt in zip("abc", Fast.seen):
        print(f"card {who}: prompt {len(prompt)} chars (~{len(prompt) // 4} tokens); fixed instruction {len(task_module.CARD_RESULT_INSTRUCTION)} chars")
    print("a 20,000-char result is copied whole into every dependent's prompt (no cap), and again into the re-run after feedback")


async def _pending_due():
    with store.transaction() as conn:
        return conn.execute("SELECT COUNT(*) AS n FROM deliveries WHERE status='pending' AND next_try_at <= ?", (time.time(),)).fetchone()["n"]


if __name__ == "__main__":
    main()
    store.close()
