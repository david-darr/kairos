"""Per-run input and output tokens and output timing (schema v8, David
2026-10-22: "have the backend record per-reply input and output tokens so the
CLI can show them and tok/s").

What these prove, with scripted provider payloads and no real model:
- every surface's usage reaches the run row with its parts, and a part the
  provider did not report stays null (Claude Code, Codex, an
  OpenAI-compatible endpoint streamed and plain, Ollama's native reply, the
  Anthropic and OpenAI native APIs);
- the first and last output times are those of the visible text;
- tok/s is output tokens over that window, and only when both exist;
- total_tokens is unchanged;
- an older store gains the columns with its old rows left null.
"""
import asyncio
import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
environment = tempfile.TemporaryDirectory(prefix="jarvis-run-tokens-")
os.environ["JARVIS_DATA_DIR"] = environment.name

import httpx  # noqa: E402
from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock  # noqa: E402
from claude_agent_sdk.types import StreamEvent  # noqa: E402

from core import ollama_client, runs, session_manager_store as store  # noqa: E402
from core.brain import Brain  # noqa: E402
from core.codex_brain import CodexBrain  # noqa: E402
from core.external_brain import ExternalBrain  # noqa: E402
from core.providers import native_api, openai_compatible  # noqa: E402

K = runs.EventKind


async def run_and_record(adapter, prompt="x", stream=True):
    """Run an adapter's events through a Tally and record it, as a chat or
    task does; return the stored row."""
    context = runs.RunContext("chat", session_id=None)
    tally = runs.Tally()
    async for item in adapter.events(prompt, stream=True if stream is None else stream):
        tally.add(item)
        await asyncio.sleep(0.02)          # time passes between chunks
    runs.record(context, tally, "finished")
    return store.get_run(context.run_id)


class Stream:
    """A scripted event stream standing in for an adapter."""

    def __init__(self, items):
        self.items = items

    async def events(self, prompt, stream=True):
        for item in self.items:
            yield item


# -- Claude Code ----------------------------------------------------------------

def stream_event(payload):
    return StreamEvent(uuid="t", session_id="sdk", event=payload)


class FakeSDK:
    def __init__(self, messages):
        self.messages = messages

    async def query(self, text):
        pass

    async def receive_response(self):
        for message in self.messages:
            await asyncio.sleep(0.03)
            yield message

    async def disconnect(self):
        pass


CLAUDE_USAGE = {"input_tokens": 3, "cache_read_input_tokens": 900, "cache_creation_input_tokens": 40,
                "output_tokens": 12}


class ClaudeCodeTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_result_message_fills_every_part(self):
        brain = Brain(vault_dir=environment.name)
        brain._client = FakeSDK([
            stream_event({"type": "message_start"}),
            stream_event({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "One "}}),
            stream_event({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "two."}}),
            AssistantMessage(content=[TextBlock(text="One two.")], model="test"),
            ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False, num_turns=1,
                          session_id="cli-1", usage=CLAUDE_USAGE)])
        row = await run_and_record(brain)
        self.assertEqual((row["input_tokens"], row["output_tokens"], row["cache_read_tokens"], row["cache_write_tokens"]),
                         (943, 12, 900, 40), "input is the whole input: uncached 3 + read 900 + written 40")
        self.assertEqual(row["total_tokens"], 955, "the total is as before")
        self.assertLess(row["first_output_at"], row["last_output_at"])
        rate = runs.tokens_per_second(row)
        self.assertAlmostEqual(rate, 12 / (row["last_output_at"] - row["first_output_at"]), places=0)


# -- Codex ------------------------------------------------------------------------

class FakeProc:
    def __init__(self, lines):
        self.stdout = asyncio.StreamReader()
        self.stdout.feed_data("".join(json.dumps(line) + "\n" for line in lines).encode())
        self.stdout.feed_eof()
        self.returncode = 0

    async def wait(self):
        return 0


def codex_turn(usage):
    return [{"type": "thread.started", "thread_id": "th-1"},
            {"type": "item.completed", "item": {"id": "i1", "type": "agent_message", "text": "Done."}},
            {"type": "turn.completed", "usage": usage}]


class CodexTests(unittest.IsolatedAsyncioTestCase):
    async def events(self, usage):
        brain = CodexBrain(vault_dir=environment.name)
        stderr = asyncio.create_task(asyncio.sleep(0, result=b""))
        return [item async for item in brain._consume_process(FakeProc(codex_turn(usage)), stderr, True, "x")]

    async def test_turn_completed_fills_input_output_and_cache_reads(self):
        items = await self.events({"input_tokens": 1000, "cached_input_tokens": 800, "output_tokens": 100})
        row = await run_and_record(Stream(items), stream=None)
        self.assertEqual((row["input_tokens"], row["output_tokens"], row["cache_read_tokens"], row["cache_write_tokens"]),
                         (1000, 100, 800, None), "Codex reports no cache writes")
        self.assertEqual(row["total_tokens"], 1100)

    async def test_a_part_codex_leaves_out_stays_null(self):
        items = await self.events({"input_tokens": 1000, "output_tokens": 100})
        row = await run_and_record(Stream(items), stream=None)
        self.assertIsNone(row["cache_read_tokens"], "never a 0 that reads as measured")
        self.assertEqual(row["output_tokens"], 100)

    async def test_one_message_has_no_measurable_rate(self):
        """Codex hands the reply over in one piece: first and last output are
        the same moment, so there is no tok/s."""
        items = await self.events({"input_tokens": 1000, "output_tokens": 100})
        row = await run_and_record(Stream(items), stream=None)
        self.assertEqual(row["first_output_at"], row["last_output_at"])
        self.assertIsNone(runs.tokens_per_second(row))


# -- OpenAI-compatible, streamed and plain ----------------------------------------------

class SSEServer:
    """A streamed /chat/completions, chunk by chunk, with usage on the last
    chunk when stream_options asked for it."""

    def __init__(self, with_usage=True):
        self.with_usage = with_usage
        self.bodies = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.bodies.append(body)
        chunks = [{"choices": [{"delta": {"content": part}}]} for part in ("Hel", "lo ", "there.")]
        if self.with_usage and body.get("stream_options", {}).get("include_usage"):
            chunks.append({"choices": [], "usage": {"prompt_tokens": 120, "completion_tokens": 9, "total_tokens": 129,
                                                    "prompt_tokens_details": {"cached_tokens": 100}}})
        text = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"
        return httpx.Response(200, text=text, headers={"content-type": "text/event-stream"})


class OpenAICompatibleTests(unittest.IsolatedAsyncioTestCase):
    async def run_streamed(self, server):
        real = httpx.AsyncClient

        def client(*args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(server)
            return real(*args, **kwargs)
        with patch.object(openai_compatible.httpx, "AsyncClient", client):
            items = [item async for item in openai_compatible.turn_events(
                "http://local.test/v1", "m", None, [{"role": "user", "content": "hi"}])]
        return await run_and_record(Stream(items), stream=None)

    async def test_streamed_usage_comes_from_stream_options(self):
        server = SSEServer()
        row = await self.run_streamed(server)
        self.assertEqual(server.bodies[0]["stream_options"], {"include_usage": True})
        self.assertEqual((row["input_tokens"], row["output_tokens"], row["cache_read_tokens"], row["cache_write_tokens"]),
                         (120, 9, 100, None))
        self.assertEqual(row["total_tokens"], 129)

    async def test_a_server_that_ignores_stream_options_leaves_nulls(self):
        row = await self.run_streamed(SSEServer(with_usage=False))
        for field in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "total_tokens"):
            self.assertIsNone(row[field], field)
        self.assertIsNotNone(row["first_output_at"], "the text still arrived")
        self.assertIsNone(runs.tokens_per_second(row))

    async def test_plain_tool_rounds_sum_their_calls(self):
        replies = [{"choices": [{"message": {"role": "assistant", "content": None, "tool_calls": [
                       {"id": "c1", "type": "function", "function": {"name": "search_vault", "arguments": "{}"}}]}}],
                    "usage": {"prompt_tokens": 400, "completion_tokens": 20, "total_tokens": 420}},
                   {"choices": [{"message": {"role": "assistant", "content": "Found it."}}],
                    "usage": {"prompt_tokens": 480, "completion_tokens": 30, "total_tokens": 510}}]

        async def post(client, base_url, api_key, body):
            return replies.pop(0)
        brain = ExternalBrain("http://fake", "m", None, session_id=None)

        async def run_tool(name, args):
            return "a note"
        brain._run_tool = run_tool
        with patch.object(openai_compatible, "_post_chat", new=post):
            row = await run_and_record(brain)
        self.assertEqual((row["input_tokens"], row["output_tokens"], row["total_tokens"]), (880, 50, 930))
        self.assertIsNone(row["cache_read_tokens"])


# -- Ollama and the native APIs ---------------------------------------------------------

class ProviderShapeTests(unittest.IsolatedAsyncioTestCase):
    def test_ollama_native_counts_and_a_cached_prompt(self):
        full = ollama_client.openai_shaped({"message": {"content": "x"}, "prompt_eval_count": 50, "eval_count": 7})
        usage = runs.normalize_usage(full["usage"])
        self.assertEqual((usage.prompt_tokens, usage.output_tokens, usage.total_tokens), (50, 7, 57))
        cached = ollama_client.openai_shaped({"message": {"content": "x"}, "eval_count": 7})
        usage = runs.normalize_usage(cached["usage"])
        self.assertIsNone(usage.prompt_tokens, "Ollama left the prompt count out: it stays unknown, not 0")
        self.assertEqual((usage.output_tokens, usage.total_tokens), (7, 7))

    async def test_anthropic_native_api(self):
        def server(request):
            return httpx.Response(200, json={"content": [{"type": "text", "text": "Hi"}],
                                             "usage": {"input_tokens": 10, "cache_read_input_tokens": 200,
                                                       "output_tokens": 5}})
        async with httpx.AsyncClient(transport=httpx.MockTransport(server)) as client:
            data = await native_api.post(client, "https://api.anthropic.com/v1", "claude-x", "key",
                                         [{"role": "user", "content": "hi"}])
        self.assertEqual(data["usage"], {"input_tokens": 10, "cache_read_input_tokens": 200, "output_tokens": 5,
                                         "total_tokens": 215}, "no cache write reported, so none is invented")
        usage = runs.normalize_usage(data["usage"])
        self.assertEqual((usage.prompt_tokens, usage.output_tokens, usage.cache_read_tokens, usage.cache_write_tokens),
                         (210, 5, 200, None))

    async def test_openai_native_responses_api(self):
        def server(request):
            return httpx.Response(200, json={"output": [{"type": "message", "content": [{"type": "output_text", "text": "Hi"}]}],
                                             "usage": {"input_tokens": 120, "output_tokens": 30, "total_tokens": 150,
                                                       "input_tokens_details": {"cached_tokens": 100}}})
        async with httpx.AsyncClient(transport=httpx.MockTransport(server)) as client:
            data = await native_api.post(client, "https://api.openai.com/v1", "gpt-x", "key",
                                         [{"role": "user", "content": "hi"}])
        usage = runs.normalize_usage(data["usage"])
        self.assertEqual((usage.prompt_tokens, usage.output_tokens, usage.cache_read_tokens), (120, 30, 100))


# -- the rate, the timing and the migration ----------------------------------------------

class RateTests(unittest.TestCase):
    def test_tok_per_s_needs_both_numbers_and_a_real_window(self):
        self.assertEqual(runs.tokens_per_second({"output_tokens": 100, "first_output_at": 10.0, "last_output_at": 14.0}), 25.0)
        self.assertIsNone(runs.tokens_per_second({"output_tokens": None, "first_output_at": 10.0, "last_output_at": 14.0}))
        self.assertIsNone(runs.tokens_per_second({"output_tokens": 100, "first_output_at": None, "last_output_at": 14.0}))
        self.assertIsNone(runs.tokens_per_second({"output_tokens": 100, "first_output_at": 10.0, "last_output_at": 10.0}))
        self.assertIsNone(runs.tokens_per_second({}))

    def test_only_visible_text_moves_the_clock(self):
        tally = runs.Tally()
        tally.add(runs.usage_event({"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}))
        tally.add(runs.tool_started("c1", "Bash", {}))
        self.assertIsNone(tally.first_output_at)
        tally.add(runs.text(""))
        self.assertIsNone(tally.first_output_at, "an empty chunk is not output")
        tally.add(runs.text("a"))
        first = tally.first_output_at
        time.sleep(0.01)
        tally.add(runs.text("b"))
        self.assertEqual(tally.first_output_at, first)
        self.assertGreater(tally.last_output_at, first)


class MigrationTests(unittest.TestCase):
    def test_a_v7_store_gains_the_columns_and_old_rows_stay_null(self):
        folder = tempfile.mkdtemp(dir=environment.name)
        path = os.path.join(folder, "sessions.db")
        old = sqlite3.connect(path)
        old.executescript("""
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO meta VALUES ('schema_version', '7');
            CREATE TABLE runs (id TEXT PRIMARY KEY, parent_id TEXT, surface TEXT NOT NULL, session_id TEXT,
                agent_id TEXT, task_id TEXT, endpoint_id TEXT, model TEXT, started_at REAL, ended_at REAL,
                outcome TEXT NOT NULL, stop_confirmed INTEGER, tool_calls INTEGER NOT NULL DEFAULT 0,
                total_tokens INTEGER, cache_read_tokens INTEGER, usage_complete INTEGER NOT NULL DEFAULT 0,
                detail TEXT);
            INSERT INTO runs (id, surface, outcome, total_tokens, cache_read_tokens, started_at)
                VALUES ('old', 'chat', 'finished', 500, 100, 1.0);
        """)
        old.commit()
        old.close()
        store.close()
        try:
            with patch.object(store, "DB_FILE", path):
                conn = store.connection()
                columns = {r["name"] for r in conn.execute("PRAGMA table_info(runs)")}
                for name, _ in store.RUN_V8_COLUMNS:
                    self.assertIn(name, columns)
                row = store.get_run("old")
                self.assertEqual((row["total_tokens"], row["cache_read_tokens"]), (500, 100))
                for name, _ in store.RUN_V8_COLUMNS:
                    self.assertIsNone(row[name], f"{name} is not back-filled")
                self.assertEqual(conn.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()[0], "9")
                self.assertTrue(os.path.exists(path + ".pre-v7"), "the old database is kept first")
                store.close()
                conn = store.connection()       # a second start changes nothing
                self.assertEqual(len([r for r in conn.execute("PRAGMA table_info(runs)")]), len(columns))
        finally:
            store.close()

    def test_the_runs_route_carries_the_new_fields(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from core import auth
        from routes import run_routes
        store.record_run({"id": "r1", "surface": "chat", "outcome": "finished", "started_at": 1.0, "ended_at": 9.0,
                          "total_tokens": 1000, "cache_read_tokens": 700, "input_tokens": 900, "output_tokens": 100,
                          "cache_write_tokens": None, "first_output_at": 2.0, "last_output_at": 6.0,
                          "tool_calls": 0, "usage_complete": 1}, [])
        app = FastAPI()
        app.include_router(run_routes.router)
        with patch.object(auth, "UI_SECRET", None):
            client = TestClient(app)
            listed = {r["id"]: r for r in client.get("/api/runs").json()}
            one = client.get("/api/runs/r1").json()
        for row in (listed["r1"], one):
            self.assertEqual((row["input_tokens"], row["output_tokens"], row["cache_write_tokens"]), (900, 100, None))
            self.assertEqual(row["tokens_per_second"], 25.0)


def tearDownModule():
    store.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
