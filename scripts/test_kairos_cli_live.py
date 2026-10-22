"""The Kairos CLI against a real backend: its own, on a free port, with a
temp data folder and a UI secret (so pairing is required), and a scripted
model (scripts/cli_backend_fixture.py). Never the real app on 8420.

The test plays the app window by sending the UI cookie, which only it knows
because it started the backend.

Run with a Python that has the backend's packages plus Rich and
prompt_toolkit (the CLI's own requirements):
    python scripts/test_kairos_cli_live.py
"""
import asyncio
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))

from kairos_cli import chat, forge, render  # noqa: E402
from kairos_cli import palette as palettes  # noqa: E402
from kairos_cli.connection import Connection, KairosError  # noqa: E402
from kairos_cli.live import LiveFeed  # noqa: E402

SECRET = "live-test-secret-" + os.urandom(6).hex()
COOKIE = {"jarvis_ui": SECRET}
BACKEND_PYTHON = os.environ.get("KAIROS_TEST_BACKEND_PYTHON") or str(ROOT / ".venv" / "Scripts" / "python.exe")
if not Path(BACKEND_PYTHON).exists():
    BACKEND_PYTHON = sys.executable


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Backend:
    def __init__(self):
        self.port = free_port()
        assert self.port != 8420
        self.data = tempfile.mkdtemp(prefix="kairos-cli-live-")
        os.makedirs(os.path.join(self.data, "vault"))
        env = {**os.environ, "JARVIS_DATA_DIR": self.data, "JARVIS_VAULT_DIR": os.path.join(self.data, "vault"),
               "APP_PORT": str(self.port), "JARVIS_INSTANCE": "clilive", "JARVIS_UI_SECRET": SECRET,
               "KAIROS_TEST_PAIRS_PER_MINUTE": "1000"}
        self.log = open(os.path.join(self.data, "backend.log"), "w")
        self.process = subprocess.Popen(
            [BACKEND_PYTHON, "-m", "uvicorn", "cli_backend_fixture:app", "--app-dir", "scripts",
             "--host", "127.0.0.1", "--port", str(self.port)],
            cwd=ROOT, env=env, stdout=self.log, stderr=subprocess.STDOUT)
        self.url = f"http://127.0.0.1:{self.port}"
        for _ in range(120):
            try:
                if httpx.get(self.url + "/api/health", timeout=2).status_code == 200:
                    break
            except httpx.HTTPError:
                time.sleep(0.5)
        else:
            raise RuntimeError("test backend did not start")

    def stop(self):
        subprocess.run(["taskkill", "/PID", str(self.process.pid), "/T", "/F"], capture_output=True) \
            if sys.platform == "win32" else self.process.kill()
        self.process.wait(timeout=20)
        self.log.close()
        shutil.rmtree(self.data, ignore_errors=True)


BACKEND: Backend | None = None


def setUpModule():
    global BACKEND
    BACKEND = Backend()


def tearDownModule():
    if BACKEND:
        BACKEND.stop()


def app_window() -> httpx.Client:
    return httpx.Client(base_url=BACKEND.url, cookies=COOKIE, timeout=30)


def approve_next(choice="allow", timeout=30.0):
    """Plays the person in the app window: answers the next pairing prompt."""
    def run():
        with app_window() as window:
            deadline = time.time() + timeout
            while time.time() < deadline:
                pairs = window.get("/api/chat/live/snapshot").json().get("cliPairs") or []
                if pairs:
                    window.post(f"/api/permissions/{pairs[0]['id']}/answer", json={"choice": choice})
                    return
                time.sleep(0.2)
    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread


def cli(*args, cwd=None, timeout=90, approve="allow", stdin=None):
    """Run the kairos command as a person would, approving its pairing."""
    approver = approve_next(approve) if approve else None
    env = {**os.environ, "PYTHONPATH": str(ROOT / "cli"), "PYTHONIOENCODING": "utf-8", "NO_COLOR": "1"}
    result = subprocess.run([sys.executable, "-m", "kairos_cli", "--port", str(BACKEND.port), "--no-start", *args],
                            cwd=cwd or ROOT, env=env, capture_output=True, text=True, timeout=timeout,
                            encoding="utf-8", input=stdin)
    if approver:
        approver.join(timeout=5)
    return result


def paired(test) -> Connection:
    """An in-process connection, paired through the app window."""
    async def go():
        conn = Connection(BACKEND.url, say=lambda text: None)
        approve_next("allow")
        await conn.sign_in(interactive=False, on_words=lambda words: None)
        return conn
    return go()


class PairingLive(unittest.IsolatedAsyncioTestCase):
    async def test_pairing_and_status(self):
        result = cli("status")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("paired in the app", result.stdout)
        self.assertIn("Approve this terminal in the Kairos app", result.stderr)

    async def test_rejecting_fails_closed(self):
        result = cli("status", approve="reject")
        self.assertEqual(result.returncode, 1)
        self.assertIn("rejected this terminal", result.stderr)

    async def test_an_agent_shell_cannot_get_a_token_without_the_click(self):
        """A process on this machine, with no cookie: it can ask, it cannot
        answer its own prompt, it can reach nothing, and its claim stays
        pending. Only the window's own answer (Reject here) ends it, and
        no token is ever handed over."""
        async with httpx.AsyncClient(base_url=BACKEND.url, timeout=30) as shell:
            started = (await shell.post("/api/auth/cli-pair", json={"pid": 1, "terminal": "agent shell"})).json()
            self.assertIn("claim", started)
            with app_window() as window:
                prompt = window.get("/api/chat/live/snapshot").json()["cliPairs"][0]
            for choice in ("allow", "reject"):
                answered = await shell.post(f"/api/permissions/{prompt['id']}/answer", json={"choice": choice})
                self.assertIn(answered.status_code, (401, 404))
            for path in ("/api/sessions", "/api/chat/live/snapshot", "/api/auth/cli/terminals"):
                self.assertEqual((await shell.get(path)).status_code, 401, path)
            pending = await shell.post(f"/api/auth/cli-pair/{started['request_id']}/claim",
                                       json={"claim": started["claim"], "wait": 0})
            self.assertEqual(pending.json(), {"status": "pending"})
            with app_window() as window:
                window.post(f"/api/permissions/{prompt['id']}/answer", json={"choice": "reject"})
            final = await shell.post(f"/api/auth/cli-pair/{started['request_id']}/claim",
                                     json={"claim": started["claim"], "wait": 5})
            self.assertEqual(final.json()["status"], "rejected")
            self.assertNotIn("token", final.json())

    async def test_a_token_dies_with_its_terminal_and_when_revoked(self):
        conn = await paired(self)
        token = conn.client.headers["X-Kairos-CLI-Token"]
        self.assertEqual((await conn.client.get("/api/sessions")).status_code, 200)
        with app_window() as window:
            terminals = window.get("/api/auth/cli/terminals").json()["terminals"]
            mine = [t for t in terminals if t["id"] == conn.terminal_id]
            self.assertEqual(len(mine), 1)
            window.delete(f"/api/auth/cli/terminals/{conn.terminal_id}")
        self.assertEqual((await conn.client.get("/api/sessions")).status_code, 401)
        await conn.close()
        async with httpx.AsyncClient(base_url=BACKEND.url) as stranger:
            self.assertEqual((await stranger.get("/api/sessions", headers={"X-Kairos-CLI-Token": token})).status_code, 401)
        conn = await paired(self)
        token = conn.client.headers["X-Kairos-CLI-Token"]
        await conn.close()      # goodbye on exit
        async with httpx.AsyncClient(base_url=BACKEND.url) as stranger:
            self.assertEqual((await stranger.get("/api/sessions", headers={"X-Kairos-CLI-Token": token})).status_code, 401)


class HeadlessLive(unittest.TestCase):
    def run_p(self, *args, cwd=None):
        start = time.monotonic()
        result = cli("--model", "Scripted", *args, cwd=cwd)
        self.assertLess(time.monotonic() - start, 60, "headless must never hang")
        return result

    def test_text(self):
        result = self.run_p("-p", "hello from a script")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "You said: hello from a script\n")

    def test_json_and_a_refused_permission(self):
        result = self.run_p("-p", "ask", "--output-format", "json")
        self.assertEqual(result.returncode, 2, result.stderr)
        body = json.loads(result.stdout)
        self.assertEqual(body["status"], "done")
        self.assertEqual(body["text"], "The command was refused.\n")
        self.assertEqual(body["permissions"]["denied"][0]["choice"], "reject")

    def test_stream_json(self):
        result = self.run_p("-p", "tool", "--output-format", "stream-json")
        self.assertEqual(result.returncode, 0, result.stderr)
        kinds = [json.loads(line)["type"] for line in result.stdout.splitlines()]
        self.assertEqual(kinds[0], "started")
        self.assertEqual(kinds[-1], "finished")
        self.assertIn("tool_step", kinds)
        self.assertIn("text", kinds)

    def test_failed_turn_exits_1(self):
        result = self.run_p("-p", "fail")
        self.assertEqual(result.returncode, 1)

    def test_stopped_turn_exits_2(self):
        def stopper():
            with app_window() as window:
                for _ in range(100):
                    runs = window.get("/api/chat/live/snapshot").json()["runs"]
                    busy = [sid for sid, run in runs.items() if run.get("status") == "processing" and run.get("prompt") == "slow 20"]
                    if busy:
                        time.sleep(0.5)
                        window.post("/api/chat/live/stop", json={"session_id": busy[0]})
                        return
                    time.sleep(0.2)
        thread = threading.Thread(target=stopper, daemon=True)
        thread.start()
        result = self.run_p("-p", "slow 20")
        thread.join(timeout=5)
        self.assertEqual(result.returncode, 2, result.stderr)

    def test_prompt_from_stdin_and_continue_in_this_folder(self):
        with tempfile.TemporaryDirectory() as folder:
            first = cli("--model", "Scripted", "-p", "--output-format", "json", cwd=folder, stdin="from stdin")
            self.assertEqual(first.returncode, 0, first.stderr)
            body = json.loads(first.stdout)
            self.assertEqual(body["text"], "You said: from stdin\n")
            again = cli("-c", "-p", "second", "--output-format", "json", cwd=folder)
            self.assertEqual(json.loads(again.stdout)["session_id"], body["session_id"])
            by_id = cli("-r", body["session_id"], "-p", "third", "--output-format", "json")
            self.assertEqual(json.loads(by_id.stdout)["session_id"], body["session_id"])

    def test_no_model_is_a_clear_error_not_a_hang(self):
        result = cli("-p", "hi")
        self.assertEqual(result.returncode, 1)
        self.assertIn("--model", result.stderr)


class BothWaysLive(unittest.IsolatedAsyncioTestCase):
    """A chat started in the terminal shows in the app and the reverse; a
    permission answered in either closes in both."""

    async def asyncSetUp(self):
        self.conn = await paired(self)
        choices = await chat.model_choices(self.conn)
        self.session = await chat.new_session(self.conn)
        await chat.set_model(self.conn, self.session["id"], choices[0])
        self.events = asyncio.Queue()
        self.feed = LiveFeed(self.conn, self.events.put_nowait)
        self.feed.start()
        await asyncio.wait_for(self.feed.connected.wait(), 10)

    async def asyncTearDown(self):
        await self.feed.stop()
        await self.conn.close()

    async def until(self, kind, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            event = await asyncio.wait_for(self.events.get(), deadline - time.monotonic())
            if event.session_id == self.session["id"] and event.kind == kind:
                return event
        self.fail(f"no {kind}")

    async def test_started_in_the_app_shows_in_the_terminal(self):
        with app_window() as window:
            window.post("/api/chat/live", json={"session_id": self.session["id"], "message": "from the app"})
        started = await self.until("started")
        self.assertEqual(started.turn.prompt, "from the app")
        finished = await self.until("finished")
        self.assertEqual(finished.turn.text, "You said: from the app\n")

    async def test_started_in_the_terminal_shows_in_the_app(self):
        async with httpx.AsyncClient(base_url=BACKEND.url, cookies=COOKIE, timeout=30) as window:
            async with window.stream("GET", "/api/chat/live/events") as stream:
                await chat.start_turn(self.conn, self.session["id"], "from the terminal")
                seen = ""
                async for chunk in stream.aiter_text():
                    seen += chunk
                    mark = seen.find("You said: from the terminal")
                    if mark >= 0 and '"status": "done"' in seen[mark:]:
                        break
        self.assertIn('"prompt": "from the terminal"', seen)
        self.assertIn("You said: from the terminal", seen)

    async def test_answered_in_the_app_closes_in_the_terminal(self):
        await chat.start_turn(self.conn, self.session["id"], "ask")
        asked = await self.until("permission")
        with app_window() as window:
            window.post(f"/api/permissions/{asked.value['id']}/answer", json={"choice": "once"})
        closed = await self.until("permission_closed")
        self.assertEqual(closed.value["id"], asked.value["id"])
        # The terminal's own late answer is told it was already answered.
        self.assertEqual(await chat.answer_permission(self.conn, asked.value["id"], "reject"), "gone")
        finished = await self.until("finished")
        self.assertIn("allowed", finished.turn.text)

    async def test_answered_in_the_terminal_closes_in_the_app(self):
        await chat.start_turn(self.conn, self.session["id"], "ask")
        asked = await self.until("permission")
        self.assertEqual(await chat.answer_permission(self.conn, asked.value["id"], "reject"), "answered")
        with app_window() as window:
            for _ in range(50):
                run = window.get("/api/chat/live/snapshot").json()["runs"].get(self.session["id"]) or {}
                if not run.get("permission"):
                    break
                time.sleep(0.1)
            self.assertIsNone(run.get("permission"))
        finished = await self.until("finished")
        self.assertIn("refused", finished.turn.text)


class ForgeAndAgentsLive(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.conn = await paired(self)
        self.folder = tempfile.mkdtemp(prefix="kairos-cli-forge-")
        for command in (["git", "init", "-q", "-b", "main"], ["git", "config", "user.email", "t@example.com"],
                        ["git", "config", "user.name", "Test"]):
            subprocess.run(command, cwd=self.folder, check=True)
        Path(self.folder, "a.txt").write_text("before\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=self.folder, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "first"], cwd=self.folder, check=True)
        self.choices = await chat.model_choices(self.conn)

    async def asyncTearDown(self):
        await self.conn.close()
        shutil.rmtree(self.folder, ignore_errors=True)

    async def turn(self, session_id, text):
        events = asyncio.Queue()
        feed = LiveFeed(self.conn, events.put_nowait)
        feed.start()
        await asyncio.wait_for(feed.connected.wait(), 10)
        await chat.start_turn(self.conn, session_id, text)
        try:
            while True:
                event = await asyncio.wait_for(events.get(), 30)
                if event.session_id == session_id and event.kind == "finished":
                    return event.turn
        finally:
            await feed.stop()

    async def test_in_place_by_default_and_the_diff_matches_the_app(self):
        session = await forge.start(self.conn, "change a", folder=self.folder, model_endpoint_id=self.choices[0]["id"])
        self.assertEqual(session["forge"]["isolation"], "in_place")
        self.assertEqual(os.path.normcase(session["forge"]["worktree"]), os.path.normcase(str(Path(self.folder).resolve())))
        turn = await self.turn(session["id"], "edit a.txt after the edit")
        self.assertEqual(turn.status, "done")
        self.assertEqual(Path(self.folder, "a.txt").read_text(encoding="utf-8"), "after the edit\n")
        mine = await forge.changes(self.conn, session["id"])
        with app_window() as window:
            app_view = window.get(f"/api/forge/sessions/{session['id']}/changes").json()
        self.assertEqual(mine, app_view)
        from rich.console import Console
        import io
        console = Console(file=io.StringIO(), width=100, color_system=None)
        console.print(render.render_diff(mine["files"], palettes.Palette("night", "none"), 100))
        drawn = console.file.getvalue()
        self.assertIn("a.txt", drawn)
        self.assertIn("- before", drawn)
        self.assertIn("+ after the edit", drawn)
        undone = await forge.undo_last(self.conn, session["id"])
        self.assertTrue(undone["result"]["restored"])
        self.assertEqual(Path(self.folder, "a.txt").read_text(encoding="utf-8"), "before\n")
        await self.turn(session["id"], "edit a.txt again")
        await forge.revert_file(self.conn, session["id"], "a.txt")
        self.assertEqual(Path(self.folder, "a.txt").read_text(encoding="utf-8"), "before\n")

    async def test_worktree_opts_into_isolation(self):
        session = await forge.start(self.conn, "isolated", folder=self.folder, worktree=True,
                                    model_endpoint_id=self.choices[0]["id"])
        self.assertEqual(session["forge"]["isolation"], "new_worktree")
        self.assertNotEqual(os.path.normcase(session["forge"]["worktree"]), os.path.normcase(self.folder))
        await self.turn(session["id"], "edit a.txt isolated")
        self.assertEqual(Path(self.folder, "a.txt").read_text(encoding="utf-8"), "before\n")

    async def test_agents_list_matches_the_app(self):
        with app_window() as window:
            window.post("/api/agents", json={"name": "Scout", "role": "research"})
            expected = window.get("/api/agents").json()
            inbox = window.get("/api/agents/inbox").json()
        self.assertEqual(await self.conn.get("/api/agents"), expected)
        self.assertEqual(await self.conn.get("/api/agents/inbox"), inbox)
        result = cli("agents")
        self.assertEqual(result.returncode, 0, result.stderr)
        for agent in expected:
            self.assertIn(agent["name"], result.stdout)


@unittest.skipUnless(sys.platform == "win32", "ConPTY harness")
class InteractiveLive(unittest.TestCase):
    """The interactive view in a real pseudo-terminal (ConPTY through
    pywinpty): the Phase 1 spike's checks, kept as a test. A long streamed
    reply lands in scrollback line by line, every line exactly once, and the
    alternate screen is never taken; a number key answers a prompt."""

    def drive(self, steps, timeout=120):
        import re
        try:
            from winpty import PtyProcess
        except ImportError:
            self.skipTest("pywinpty is not installed")
        approver = approve_next("allow")
        env = {**os.environ, "PYTHONPATH": str(ROOT / "cli"), "PYTHONIOENCODING": "utf-8", "WT_SESSION": "test"}
        process = PtyProcess.spawn([sys.executable, "-X", "utf8", "-m", "kairos_cli", "--port", str(BACKEND.port),
                                    "--no-start", "--model", "Scripted", "--no-motion"],
                                   dimensions=(40, 120), env=env, cwd=str(ROOT))
        chunks = []
        reader = threading.Thread(target=lambda: self._read(process, chunks), daemon=True)
        reader.start()

        def plain():
            text = "".join(chunks)
            text = re.sub(r"\x1b\][^\x07]*\x07", "", text)
            return re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", text)

        def wait_for(pattern, seconds=60):
            deadline = time.time() + seconds
            while time.time() < deadline:
                if re.search(pattern, plain()):
                    return
                time.sleep(0.1)
            self.fail(f"never saw {pattern!r}")
        try:
            for kind, value in steps:
                if kind == "wait":
                    wait_for(value)
                elif kind == "send":
                    process.write(value)
                    time.sleep(0.3)
        finally:
            if process.isalive():
                process.write("\x04")
                time.sleep(1.5)
            if process.isalive():
                process.terminate(force=True)
            approver.join(timeout=2)
        return "".join(chunks), plain()

    @staticmethod
    def _read(process, chunks):
        while True:
            try:
                chunks.append(process.read(65536))
            except EOFError:
                return

    def test_a_long_reply_keeps_every_line_in_scrollback(self):
        import re
        raw, text = self.drive([("wait", "help for commands"), ("send", "lines 600\r"), ("wait", r"done in [0-9.]+s")])
        self.assertNotIn("\x1b[?1049h", raw, "the alternate screen must not be used")
        numbers = [int(n) for n in re.findall(r"line (\d{5}) bold and code text", text)]
        self.assertEqual(sorted(numbers), list(range(1, 601)))
        self.assertIn("def hello", text)

    def test_a_number_key_answers_a_permission_prompt(self):
        _, text = self.drive([("wait", "help for commands"), ("send", "ask\r"), ("wait", "Kairos wants to use Bash"),
                              ("send", "1"), ("wait", r"The command was allowed\.")])
        self.assertIn("Allowed: Allow once", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
