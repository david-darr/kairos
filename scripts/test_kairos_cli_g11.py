"""Kairos CLI resilience and efficiency (A18, group g11): absent backend, wrong
port, backend dying mid-run, dropped live stream with no lost/duplicated text,
restart of the backend under a paired terminal, plus launch/pair/stream numbers.
Reuses the real fixture backend from test_kairos_cli_live (scripted model, own
port, temp data, never 8420).
Run (as the live suite):  TERM=xterm-256color, NO_COLOR unset
    python scripts/test_kairos_cli_g11.py
test_bug_* assert behaviour the CLI does not have yet (see report).
"""
import asyncio
import http.server
import os
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path

import httpx
import json

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts import test_kairos_cli_live as L  # noqa: E402
from kairos_cli import chat  # noqa: E402
from kairos_cli.connection import Connection  # noqa: E402
from kairos_cli.live import LiveFeed  # noqa: E402

ROOT = L.ROOT


def setUpModule():
    L.setUpModule()


def tearDownModule():
    for attempt in range(10):  # Windows can hold the backend's log a moment after the kill
        try:
            L.tearDownModule()
            return
        except PermissionError:
            time.sleep(1)


def run_cli(port, *args, timeout=60, env_extra=None):
    env = {**os.environ, "PYTHONPATH": str(ROOT / "cli"), "PYTHONIOENCODING": "utf-8", "NO_COLOR": "1", **(env_extra or {})}
    started = time.monotonic()
    result = subprocess.run([sys.executable, "-m", "kairos_cli", "--port", str(port), "--no-start", *args], cwd=ROOT,
                            env=env, capture_output=True, text=True, timeout=timeout, encoding="utf-8")
    return result, time.monotonic() - started


class Proxy:
    """Loopback TCP forwarder that can cut every open connection and counts bytes."""
    def __init__(self, target_port):
        self.target, self.port, self.down_bytes, self.conns, self._writers = target_port, 0, 0, 0, []

    async def start(self):
        self.server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        self.url = f"http://127.0.0.1:{self.port}"

    async def _handle(self, reader, writer):
        self.conns += 1
        try:
            up_r, up_w = await asyncio.open_connection("127.0.0.1", self.target)
        except OSError:
            writer.close(); return
        self._writers += [writer, up_w]

        async def pipe(src, dst, count=False):
            try:
                while data := await src.read(8192):
                    if count:
                        self.down_bytes += len(data)
                    dst.write(data); await dst.drain()
            except (OSError, asyncio.CancelledError):
                pass
            finally:
                dst.close()
        await asyncio.gather(pipe(reader, up_w), pipe(up_r, writer, True))

    def cut(self):
        for w in self._writers:
            w.close()
        self._writers = []

    async def stop(self):
        self.server.close()
        self.cut()


class Absent(unittest.TestCase):
    def test_absent_backend_is_a_one_line_error_fast(self):
        port = L.free_port()
        for args in (("status",), ("agents",), ("-p", "hi"), ("login",)):
            result, took = run_cli(port, *args)
            self.assertEqual(result.returncode, 1, (args, result.stderr))
            self.assertIn(f"Kairos is not running on http://127.0.0.1:{port}", result.stderr)
            self.assertNotIn("Traceback", result.stderr)
            self.assertEqual(result.stdout, "")
            self.assertLess(took, 8, args)
        print(f"[bench] cli absent backend: last error exit in {took:.2f}s (incl. Python start)")

    def test_a_listener_that_is_not_kairos_is_not_attached(self):
        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(404); self.end_headers()
            log_message = lambda *a: None
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown)
        result, _ = run_cli(srv.server_address[1], "status")
        self.assertEqual(result.returncode, 1)
        self.assertIn("not running", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_bug_a_listener_that_answers_health_but_is_not_kairos_fails_cleanly(self):
        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200); self.send_header("Content-Type", "text/plain"); self.end_headers(); self.wfile.write(b"hello")
            do_POST = do_DELETE = do_GET
            log_message = lambda *a: None
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown)
        result, took = run_cli(srv.server_address[1], "status", timeout=40)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertLess(took, 30)


class Live(unittest.IsolatedAsyncioTestCase):
    async def test_dropped_stream_loses_and_duplicates_nothing(self):
        proxy = Proxy(L.BACKEND.port); await proxy.start()
        conn = Connection(proxy.url, say=lambda t: None)
        L.approve_next("allow")
        await conn.sign_in(interactive=False, on_words=lambda w: None)
        try:
            choices = await chat.model_choices(conn)
            session = await chat.new_session(conn)
            await chat.set_model(conn, session["id"], choices[0])
            states, events = [], []
            feed = LiveFeed(conn, events.append, states.append)
            feed.start()
            await asyncio.wait_for(feed.connected.wait(), 10)
            idle_start, bytes0 = time.monotonic(), proxy.down_bytes
            await asyncio.sleep(5)
            idle_rate = (proxy.down_bytes - bytes0) / (time.monotonic() - idle_start) * 60
            t0 = time.monotonic()
            await chat.start_turn(conn, session["id"], "lines 600")
            while not any(e.kind == "text" or getattr(e, "turn", None) and e.turn.text for e in events):
                await asyncio.sleep(0.01)
            first_ms = (time.monotonic() - t0) * 1000
            await asyncio.sleep(0.15)
            cut_at = time.monotonic(); proxy.cut()
            while "connected" != states[-1] or states.count("reconnecting") < 1:
                await asyncio.sleep(0.02)
                if time.monotonic() - cut_at > 15:
                    self.fail(f"never reconnected: {states}")
            reconnect_ms = (time.monotonic() - cut_at) * 1000
            deadline = time.monotonic() + 30
            while not any(e.kind == "finished" for e in events) and time.monotonic() < deadline:
                await asyncio.sleep(0.05)
            finished = [e for e in events if e.kind == "finished"]
            self.assertTrue(finished, "turn never finished after the drop")
            text = finished[-1].turn.text
            lines = [l for l in text.splitlines() if l.startswith("line ")]
            self.assertEqual(len(lines), 600, "lost or duplicated lines after reconnect")
            self.assertEqual(lines, [l for l in sorted(lines)], "lines out of order")
            self.assertEqual(len(set(lines)), 600)
            self.assertEqual(len(finished), 1, "finish delivered twice")
            total = proxy.down_bytes
            print(f"[bench] cli stream: first text {first_ms:.0f} ms; drop->reconnected {reconnect_ms:.0f} ms; "
                  f"600-line reply (~{len(text)} B text) cost {total} B downstream incl. replay; idle SSE {idle_rate:.0f} B/min; "
                  f"connections opened {proxy.conns}")
            await feed.stop()
        finally:
            await conn.close(); await proxy.stop()

    async def test_stream_latency_percentiles(self):
        conn = Connection(L.BACKEND.url, say=lambda t: None)
        L.approve_next("allow")
        await conn.sign_in(interactive=False, on_words=lambda w: None)
        try:
            choices = await chat.model_choices(conn)
            session = await chat.new_session(conn)
            await chat.set_model(conn, session["id"], choices[0])
            seen = asyncio.Queue()
            feed = LiveFeed(conn, seen.put_nowait); feed.start()
            await asyncio.wait_for(feed.connected.wait(), 10)
            firsts, totals = [], []
            for i in range(12):
                while not seen.empty():
                    seen.get_nowait()
                t = time.monotonic()
                await chat.start_turn(conn, session["id"], f"lines 100")
                first = None
                while True:
                    ev = await asyncio.wait_for(seen.get(), 20)
                    if first is None and ev.kind in ("text", "started") and getattr(ev, "turn", None) and ev.turn.text:
                        first = time.monotonic() - t
                    if ev.kind == "finished":
                        break
                firsts.append((first or 0) * 1000); totals.append((time.monotonic() - t) * 1000)
            firsts.sort(); totals.sort()
            p = lambda xs, q: xs[min(len(xs) - 1, int(len(xs) * q))]
            print(f"[bench] cli turn 'lines 100' x12: first text p50={p(firsts, .5):.0f} p95={p(firsts, .95):.0f} ms; "
                  f"done p50={p(totals, .5):.0f} p95={p(totals, .95):.0f} ms")
            await feed.stop()
        finally:
            await conn.close()

    def test_unicode_prompt_and_reply_round_trip_headless(self):
        text = "héllo 日本語 \U0001F642 مرحبا"
        result = L.cli("--model", "Scripted", "-p", "--output-format", "json", stdin=text)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["text"], "You said: " + text + "\n")

    def test_launch_and_pair_timing(self):
        import json
        runs = []
        for _ in range(5):
            approver = L.approve_next("allow")
            result, took = run_cli(L.BACKEND.port, "status")
            approver.join(timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            runs.append(took)
        cold = []
        for _ in range(3):
            r, t = run_cli(L.BACKEND.port, "--complete-models", "")
            cold.append(t)
        runs.sort(); cold.sort()
        print(f"[bench] cli launch+pair+status wall: p50={runs[2]:.2f}s max={runs[-1]:.2f}s; python+import only (--complete-models) p50={cold[1]:.2f}s")


class Restart(unittest.IsolatedAsyncioTestCase):
    """A second backend we may kill/restart (the shared one must stay up)."""

    def start_backend(self, port=None, data=None):
        b = L.Backend.__new__(L.Backend)
        b.port = port or L.free_port()
        b.data = data or __import__("tempfile").mkdtemp(prefix="kairos-cli-g11-")
        os.makedirs(os.path.join(b.data, "vault"), exist_ok=True)
        env = {**os.environ, "JARVIS_DATA_DIR": b.data, "JARVIS_VAULT_DIR": os.path.join(b.data, "vault"), "APP_PORT": str(b.port),
               "JARVIS_INSTANCE": "clig11", "JARVIS_UI_SECRET": L.SECRET, "KAIROS_TEST_PAIRS_PER_MINUTE": "1000"}
        b.log = open(os.path.join(b.data, "backend.log"), "a")
        b.process = subprocess.Popen([L.BACKEND_PYTHON, "-m", "uvicorn", "cli_backend_fixture:app", "--app-dir", "scripts",
                                      "--host", "127.0.0.1", "--port", str(b.port)], cwd=ROOT, env=env, stdout=b.log, stderr=subprocess.STDOUT)
        b.url = f"http://127.0.0.1:{b.port}"
        for _ in range(120):  # a 503 "updating" from the start-up progress server means wait, as a refused connection does
            try:
                if httpx.get(b.url + "/api/health", timeout=2).status_code == 200:
                    return b
            except httpx.HTTPError:
                pass
            time.sleep(0.5)
        raise RuntimeError("backend did not start")

    def kill(self, b):
        if b.process.poll() is None:
            b.process.kill()  # this owned, scripted backend has no process children
        b.process.wait(timeout=20)

    async def asyncSetUp(self):
        self.b = self.start_backend()
        self.saved = L.BACKEND
        L.BACKEND = self.b  # approve_next / app_window play the app against this one

    async def asyncTearDown(self):
        L.BACKEND = self.saved
        if self.b.process.poll() is None:
            self.kill(self.b)
        self.b.log.close()
        for attempt in range(10):
            try:
                L.remove_tree(self.b.data)
                break
            except PermissionError:
                await asyncio.sleep(1)

    async def test_bug_backend_dying_mid_headless_run_is_a_clear_error_not_a_hang(self):
        def killer():
            with L.app_window() as w:
                for _ in range(150):
                    try:
                        runs = w.get("/api/chat/live/snapshot").json().get("runs", {})
                    except httpx.HTTPError:
                        return
                    if any(r.get("status") == "processing" for r in runs.values()):
                        time.sleep(1); self.kill(self.b); return
                    time.sleep(0.1)
        threading.Thread(target=killer, daemon=True).start()
        try:
            result = await asyncio.to_thread(L.cli, "--model", "Scripted", "-p", "slow 30", timeout=45)
        except subprocess.TimeoutExpired:
            self.fail("kairos -p never exits after the backend dies mid-turn (live feed reconnects forever, headless waits forever)")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("Traceback", result.stderr, result.stderr[-600:])
        self.assertIn("kairos:", result.stderr)

    async def test_paired_terminal_after_a_backend_restart_gets_a_clear_state(self):
        conn = Connection(self.b.url, say=lambda t: None)
        L.approve_next("allow")
        await conn.sign_in(interactive=False, on_words=lambda w: None)
        states = []
        feed = LiveFeed(conn, lambda e: None, states.append)
        feed.start()
        await asyncio.wait_for(feed.connected.wait(), 10)
        self.kill(self.b)
        t = time.monotonic()
        while "reconnecting" not in states and time.monotonic() - t < 10:
            await asyncio.sleep(0.05)
        self.assertIn("reconnecting", states)
        down_ms = (time.monotonic() - t) * 1000
        self.b = self.start_backend(self.b.port, self.b.data)
        L.BACKEND = self.b
        t = time.monotonic()
        while states[-1] == "reconnecting" and time.monotonic() - t < 20:
            await asyncio.sleep(0.1)
        after_ms = (time.monotonic() - t) * 1000
        print(f"[bench] cli backend killed: 'reconnecting' shown after {down_ms:.0f} ms; after restart state={states[-1]} in {after_ms:.0f} ms")
        self.assertIn(states[-1], ("connected", "unauthorized"))
        if states[-1] == "unauthorized":
            from kairos_cli.connection import KairosError
            with self.assertRaises(KairosError) as caught:
                await conn.get("/api/chat/live/snapshot")
            self.assertIn("pair", str(caught.exception))
        await feed.stop(); await conn.close()


if __name__ == "__main__":
    unittest.main()
