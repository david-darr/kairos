"""core/store_writer.py: coalesced, off-loop saves of tasks.json and task_runs.json (100-bot scale test,
2026-11-10: each routine run rewrote both files about ten times on the event loop, and 100 routines due in one
minute froze the app for up to 45 s)."""
import asyncio
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

_DATA = tempfile.TemporaryDirectory(prefix="kairos-store-writer-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core import atomic_io, events, store_writer  # noqa: E402
from services import task_service as task_module  # noqa: E402


class Recorder:
    """Every replace onto a watched file, with the thread that made it."""

    def __init__(self):
        self.calls = []
        self.real = atomic_io._replace

    def __call__(self, tmp, path, *args, **kwargs):
        self.calls.append((os.path.basename(path), threading.current_thread().name))
        return self.real(tmp, path, *args, **kwargs)


class StoreWriterTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(dir=_DATA.name))
        self.recorder = Recorder()
        p = patch.object(store_writer, "_replace", self.recorder)
        p.start()
        self.addCleanup(p.stop)

    def test_saves_on_the_loop_are_coalesced_and_written_off_it(self):
        path = str(self.dir / "tasks.json")
        state = {"n": 0}

        async def burst():
            for n in range(1, 51):
                state["n"] = n
                store_writer.save(path, lambda: state)
            self.assertEqual(self.recorder.calls, [], "nothing is written while the loop is saving")
            await asyncio.sleep(store_writer.COALESCE_SECONDS + 0.3)
        asyncio.run(burst())
        store_writer.flush(path)
        self.assertEqual(json.loads(Path(path).read_text(encoding="utf-8")), {"n": 50})
        self.assertEqual(len(self.recorder.calls), 1, "fifty saves, one write")
        self.assertEqual(self.recorder.calls[0][1], "store-writer", "written by the background writer, not the loop")

    def test_landed_waits_for_the_write_without_writing_on_the_loop(self):
        path = str(self.dir / "tasks.json")

        async def run():
            store_writer.save(path, lambda: {"claimed": True})
            await store_writer.landed(path)
            self.assertEqual(json.loads(Path(path).read_text(encoding="utf-8")), {"claimed": True})
            await store_writer.landed(path)  # nothing waiting: returns at once
        asyncio.run(run())
        self.assertEqual(self.recorder.calls, [("tasks.json", "store-writer")])

    def test_off_the_loop_a_save_lands_at_once(self):
        path = str(self.dir / "runs.json")
        store_writer.save(path, lambda: [1, 2, 3])
        self.assertEqual(json.loads(Path(path).read_text(encoding="utf-8")), [1, 2, 3])

    def test_flush_writes_what_waits_and_an_older_state_never_lands_over_a_newer_one(self):
        path = str(self.dir / "tasks.json")
        state = {"v": "first"}

        async def save_then_flush():
            store_writer.save(path, lambda: dict(state))
            store_writer.flush(path)  # e.g. a store reloading from disk
            self.assertEqual(json.loads(Path(path).read_text(encoding="utf-8")), {"v": "first"})
            state["v"] = "second"
            store_writer.save(path, lambda: dict(state))
            await asyncio.sleep(store_writer.COALESCE_SECONDS + 0.3)
        asyncio.run(save_then_flush())
        store_writer.flush(path)
        # A stale write arriving late (an old sequence number) is dropped.
        store_writer._write(path, 1, b'{"v": "stale"}')
        self.assertEqual(json.loads(Path(path).read_text(encoding="utf-8")), {"v": "second"})

    def test_a_save_left_on_a_closed_loop_is_written_by_the_next_loop(self):
        path = str(self.dir / "tasks.json")
        state = {"v": 1}

        async def save_only():
            store_writer.save(path, lambda: dict(state))
        asyncio.run(save_only())  # the loop closes before its timer fires
        state["v"] = 2

        async def save_again():
            store_writer.save(path, lambda: dict(state))
            await asyncio.sleep(store_writer.COALESCE_SECONDS + 0.3)
        asyncio.run(save_again())
        store_writer.flush(path)
        self.assertEqual(json.loads(Path(path).read_text(encoding="utf-8")), {"v": 2})

    def test_task_saves_on_the_loop_do_not_write_on_the_loop(self):
        service = task_module.TaskService(str(self.dir / "tasks.json"))

        async def run():
            started = time.perf_counter()
            for n in range(20):
                service._tasks[f"t{n}"] = {"id": f"t{n}", "created_at": n, "name": "x" * 200}
                service._save_tasks()
                service._runs.append({"id": f"r{n}", "task_id": f"t{n}", "outcome": "succeeded"})
                service._save_runs()
            self.assertEqual(self.recorder.calls, [], "no file write happened on the event loop")
            await asyncio.sleep(store_writer.COALESCE_SECONDS + 0.3)
            return time.perf_counter() - started
        asyncio.run(run())
        store_writer.flush()
        self.assertEqual({name for name, _ in self.recorder.calls}, {"tasks.json", "task_runs.json"})
        self.assertLessEqual(len(self.recorder.calls), 4)
        again = task_module.TaskService(str(self.dir / "tasks.json"))
        self.assertEqual(len(again._tasks), 20)
        self.assertEqual(len(again._runs), 20)

    def test_the_activity_feed_keeps_every_event_and_is_saved_coalesced(self):
        feed = str(self.dir / "events.json")

        async def run():
            with patch.object(events, "EVENTS_FILE", feed):
                for n in range(30):
                    events.emit("task.run", f"event {n}")
                self.assertEqual(self.recorder.calls, [])
                self.assertEqual(events.recent(1)[0]["message"], "event 29")
                await asyncio.sleep(store_writer.COALESCE_SECONDS + 0.3)
        asyncio.run(run())
        store_writer.flush(feed)
        saved = json.loads(Path(feed).read_text(encoding="utf-8"))
        self.assertEqual([e["message"] for e in saved], [f"event {n}" for n in range(30)])
        self.assertEqual(len(self.recorder.calls), 1)


if __name__ == "__main__":
    unittest.main()
