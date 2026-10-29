"""Test support for the Bots memory lifecycle (Phase 2, unit U2): an in-memory stand-in for unit U1's notebook
and a scripted side-job model. Import it AFTER setting JARVIS_DATA_DIR to a throwaway folder.
"""
import asyncio
import re

from services import bot_side_jobs, bot_turn_context as ctx

OWNER = "david"


class FakeNotebook(ctx.NotebookPort):
    """Files in a dict, a hash per file, expected-hash checks, and a record of every call."""

    def __init__(self):
        self.files: dict[str, dict[str, str]] = {}
        self.calls: list[tuple] = []
        self.transactions: list[dict] = []
        self.fail_next_conflict = 0
        self.limit_bytes = None

    def put(self, bot_id, path, text):
        self.files.setdefault(bot_id, {})[path] = text

    def text(self, bot_id, path, default=""):
        return self.files.get(bot_id, {}).get(path, default)

    def read(self, bot_id, path):
        text = self.files.get(bot_id, {}).get(path)
        return None if text is None else {"text": text, "hash": ctx.sha(text)}

    def topics(self, bot_id):
        rows = []
        for path, text in sorted(self.files.get(bot_id, {}).items()):
            match = re.fullmatch(r"memory/([A-Za-z0-9_-]+)\.md", path)
            if match and match[1] != "archive":
                rows.append({"name": match[1], "description": f"about {match[1]}", "aliases": [], "bytes": len(text.encode())})
        return rows

    def apply(self, bot_id, changes, *, actor, source, thread_id=None, run_id=None):
        if self.fail_next_conflict:
            self.fail_next_conflict -= 1
            raise ctx.NotebookConflict("changed")
        files = self.files.setdefault(bot_id, {})
        for change in changes:
            current = files.get(change["path"])
            expected = change["expected_hash"]
            if (current is None and expected is not None) or (current is not None and expected != ctx.sha(current)):
                raise ctx.NotebookConflict("changed")
            if self.limit_bytes and len(change["text"].encode()) > self.limit_bytes:
                raise ctx.NotebookCapacity("too big")
        for change in changes:
            files[change["path"]] = change["text"]
        self.transactions.append({"bot": bot_id, "actor": actor, "source": source, "run_id": run_id, "thread_id": thread_id,
                                  "paths": [c["path"] for c in changes]})
        return {"ok": True}

    def begin_turn(self, bot_id, thread_id=None):
        self.calls.append(("begin", bot_id, thread_id))

    def end_turn(self, bot_id, thread_id=None, run_id=None, status="done"):
        self.calls.append(("end", bot_id, thread_id, run_id, status))


class ScriptedModel:
    """Replaces the side-job model call. `answers` are returned in order (a callable is called with the prompt);
    every request is kept in `.requests` as (endpoint kind, prompt, system)."""

    def __init__(self, answers=None):
        self.answers = list(answers or [])
        self.requests = []
        self.usage = {"input_tokens": 10, "output_tokens": 5}

    async def __call__(self, endpoint, model, prompt, system, timeout):
        self.requests.append((endpoint["kind"], prompt, system, timeout))
        if not self.answers:
            return '{"items": []}', self.usage
        answer = self.answers.pop(0)
        if callable(answer):
            answer = answer(prompt)
        if isinstance(answer, BaseException):
            raise answer
        if asyncio.iscoroutine(answer):
            answer = await answer
        return answer, self.usage

    def install(self):
        bot_side_jobs.set_runner(self)
        return self

    def remove(self):
        bot_side_jobs.set_runner(None)
