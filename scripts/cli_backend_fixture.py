"""A real Kairos backend with a scripted model, for the Kairos CLI's live
tests (scripts/test_kairos_cli_live.py and manual runs).

Everything is the real app (routes, middleware, pairing, the live feed, the
permission broker, Forge) except the model: chat_service.stream_message is
replaced by a script that reads the prompt. Start it on a fresh port with a
temp data folder, never on 8420:

    set JARVIS_DATA_DIR=%TEMP%\\kairos-cli-test & set JARVIS_UI_SECRET=...
    python -m uvicorn cli_backend_fixture:app --app-dir scripts --port 8471

Prompts it understands (the first word decides):
    lines N          stream N numbered lines, with a code fence and a table
    ask              raise a permission request, then say what was decided
    question [multi|markup] ask the person through Brain
    tool             a Forge-style tool step, started then finished
    file NAME TEXT   write a generated file and link it, as a document tool does
    edit NAME TEXT   write NAME in a Forge session's folder (checkpointed)
    slow N           stream for N seconds, so a test can stop it
    fail             end the turn with an error
    anything else    echo it back
"""
import asyncio
import os
import secrets
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import app  # noqa: E402,F401  (the real application)
from core import cli_access, file_checkpoints, model_endpoints, permissions  # noqa: E402
from core.session_manager import session_manager  # noqa: E402
from services import chat_service  # noqa: E402

# The live tests pair many terminals in a minute; the limit itself is
# covered by scripts/test_cli_access.py.
cli_access.PAIRS_PER_MINUTE = int(os.environ.get("KAIROS_TEST_PAIRS_PER_MINUTE", cli_access.PAIRS_PER_MINUTE))

FAKE_NAME = "Scripted model"
if not any(e.get("name") == FAKE_NAME for e in model_endpoints.list_endpoints()):
    model_endpoints.create_endpoint(FAKE_NAME, base_url="http://127.0.0.1:9/v1", model="scripted-1", kind="api")
# Claude Code and Codex connections, so the model picker has real catalogs
# (core/model_catalog.py's own lists). Every reply still comes from the
# script below; nothing here reaches a provider or reads a credential:
# discovery returns the local catalog, and quota readings are scripted.
for _name, _kind in (("Claude", "claude_cli"), ("Codex", "codex_cli")):
    if not any(e.get("name") == _name for e in model_endpoints.list_endpoints()):
        model_endpoints.create_endpoint(_name, kind=_kind)

from core import model_catalog, model_discovery, quota_usage  # noqa: E402


async def _local_catalog(endpoint, force=False):
    return model_catalog.list_models(endpoint.get("kind")) if endpoint.get("kind") in ("claude_cli", "codex_cli") else []


async def _scripted_quotas(force_provider=None):
    return {"providers": [{"provider": "claude", "status": "ok", "note": "", "stale": False,
                           "windows": [{"name": "5-hour", "used_percent": 35.0, "resets_at": time.time() + 3 * 3600},
                                       {"name": "weekly", "used_percent": 12.0, "resets_at": time.time() + 5 * 86400}]}],
            "models": []}


model_discovery.list_for_endpoint = _local_catalog
quota_usage.get_usage_overlay_async = _scripted_quotas


def _chunks(text: str, size: int = 7):
    for start in range(0, len(text), size):
        yield text[start:start + size]


async def fake_stream(session_id, text, attachment_ids=None, is_admin=False, reference_context="",
                      references=None, claimed=False, **_):
    started = time.time()
    session_manager.append_message(session_id, "user", text)
    words = text.split()
    command = words[0].lower() if words else ""
    reply: list[str] = []
    times: list[float] = []
    timeline = []

    async def say(piece: str, pause: float = 0.0):
        reply.append(piece)
        times.append(time.time())
        if pause:
            await asyncio.sleep(pause)
        return piece

    if command == "lines":
        count = int(words[1]) if len(words) > 1 and words[1].isdigit() else 50
        yield await say("Here are the lines.\n\n```python\ndef hello():\n    return 'kairos'\n```\n\n"
                        "| col | value |\n|---|---|\n| a | 1 |\n| b | 2 |\n\n")
        for number in range(1, count + 1):
            # About a model's delta size: a few dozen characters.
            for piece in _chunks(f"line {number:05d} **bold** and `code` text\n", 24):
                yield await say(piece)
            if number % 50 == 0:
                await asyncio.sleep(0)
    elif command == "question":
        import json
        from types import SimpleNamespace
        from core.brain import Brain
        from claude_agent_sdk import PermissionResultAllow
        questions = [{"question": "Which layout should the dashboard use?", "header": "Layout", "multiSelect": False,
                      "options": [{"label": "Two columns", "description": "Charts on the left, notes on the right"},
                                  {"label": "Single column", "description": "Everything stacked"},
                                  {"label": "Tabs", "description": "One section at a time"}]}]
        if "multi" in words:
            questions.append({"question": "Which widgets should be on it?", "header": "Widgets", "multiSelect": True,
                              "options": [{"label": name} for name in ("Calendar", "Tasks", "Weather")]})
        if "markup" in words:
            questions = [{"question": '<img src=x onerror="window.__pwned=1"><b>Bold?</b> Pick one',
                          "options": [{"label": '<script>window.__pwned=2</script>Yes'}, {"label": "No"}]}]
        brain = Brain(session_id=session_id, is_admin=is_admin)
        surface = f"chat:{session_id}"
        queue = permissions.open_channel(surface)
        task = asyncio.create_task(brain._permission("AskUserQuestion", {"questions": questions}, SimpleNamespace(suggestions=[])))
        try:
            yield {"permission": await queue.get()}
            result = await task
            yield await queue.get()
            yield await say("You answered: " + json.dumps(result.updated_input["answers"]) if isinstance(result, PermissionResultAllow)
                            else "No answer: " + result.message)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            permissions.close_channel(surface)
    elif command == "ask":
        surface = f"chat:{session_id}"
        queue = permissions.open_channel(surface)
        decision = asyncio.create_task(permissions.decide(
            surface=surface, tool="Bash", arguments={"command": "pytest scripts/test_chat.py -k forge"},
            title="Kairos wants to run a command", description="Run the Forge tests", timeout=60))
        ask = await queue.get()
        yield {"permission": ask}
        result = await decision
        closed = await queue.get()
        yield closed
        permissions.close_channel(surface)
        yield await say(f"The command was {'allowed' if result.behavior == 'allow' else 'refused'}.\n")
    elif command == "tool":
        now = time.time()
        step_id = f"t{secrets.token_hex(3)}"
        timeline = [
            {"at": now, "kind": "tool_started", "name": "read_file", "ok": None,
             "detail": '{"path": "services/forge_sessions.py"}'},
            {"at": now + 0.3, "kind": "tool_finished", "name": "read_file", "ok": True,
             "detail": "def create(...):\n    ...", "seconds": 0.3},
        ]
        yield {"tool_step": {"phase": "started", "id": step_id, "name": "read_file", "summary": "services/forge_sessions.py",
                             "ok": None, "output": "", "at": now, "seconds": 0}}
        await asyncio.sleep(0.3)
        yield {"tool_step": {"phase": "finished", "id": step_id, "name": "read_file", "summary": "services/forge_sessions.py",
                             "ok": True, "output": "def create(...):\n    ...", "at": now, "seconds": 0.3}}
        yield await say("Read it.\n")
    elif command == "edit" and len(words) >= 3:
        session = session_manager.get_session(session_id) or {}
        folder = session.get("workspace_dir")
        if not folder:
            yield await say("No workspace.\n")
        else:
            async with file_checkpoints.around_turn(f"chat:{session_id}", folder):
                (Path(folder) / words[1]).write_text(" ".join(words[2:]) + "\n", encoding="utf-8")
            yield await say(f"Wrote {words[1]}.\n")
    elif command == "file" and len(words) >= 3:
        from core import image_gen
        os.makedirs(image_gen.GENERATED_FILES_DIR, exist_ok=True)
        stored = f"{secrets.token_hex(6)}_{os.path.basename(words[1])}"
        with open(os.path.join(image_gen.GENERATED_FILES_DIR, stored), "w", encoding="utf-8") as handle:
            handle.write(" ".join(words[2:]) + "\n")
        url = f"/generated-files/{stored}"
        session_manager.register_artifact(session_id, url)
        yield await say(f"Saved [{os.path.basename(words[1])}]({url}).\n")
    elif command == "slow":
        seconds = float(words[1]) if len(words) > 1 else 10
        deadline = time.monotonic() + seconds
        number = 0
        while time.monotonic() < deadline:
            number += 1
            yield await say(f"tick {number}\n", 0.2)
    elif command == "fail":
        yield await say("Starting, then failing.\n")
        raise RuntimeError("scripted failure")
    else:
        yield await say("You said: " + text + "\n")
    session_manager.append_message(session_id, "assistant", "".join(reply))
    _record_usage(session_id, text, "".join(reply), started, times, timeline)


def _record_usage(session_id: str, prompt: str, reply: str, started: float, times: list, timeline: list) -> None:
    """The scripted model reports usage the way a provider does, so runs and
    the context meter have data: about four characters a token, and a
    growing prompt cache. Only for this test backend."""
    import uuid
    from core import session_manager_store, token_usage
    session = session_manager.get_session(session_id) or {}
    history = sum(len(m.get("content") or "") for m in session.get("messages") or [] if isinstance(m.get("content"), str))
    prompt_tokens = 1200 + history // 4
    output_tokens = max(1, len(reply) // 4)
    cached = int(prompt_tokens * 0.7) if len(session.get("messages") or []) > 2 else 0
    session_manager_store.record_run({
        "id": uuid.uuid4().hex, "parent_id": None, "surface": "chat", "session_id": session_id,
        "agent_id": None, "task_id": None, "endpoint_id": session.get("model_endpoint_id"), "model": "scripted-1",
        "started_at": started, "ended_at": time.time(), "outcome": "finished", "stop_confirmed": None,
        "tool_calls": 1 if prompt.startswith("tool") else 0, "total_tokens": prompt_tokens + output_tokens,
        "cache_read_tokens": cached, "usage_complete": 1, "detail": "",
        "input_tokens": prompt_tokens, "output_tokens": output_tokens, "cache_write_tokens": None,
        "first_output_at": times[0] if times else None, "last_output_at": times[-1] if times else None,
    }, timeline)
    usage = {"input_tokens": prompt_tokens - cached, "cache_read_input_tokens": cached, "output_tokens": output_tokens}
    if session.get("model_endpoint_id"):
        token_usage.record_usage(session["model_endpoint_id"], usage)
    session_manager.set_context_state(session_id, token_usage.build_context_state(
        usage, {"effective": 200000, "estimated": False, "source": "scripted"}, "scripted-1"))


chat_service.stream_message = fake_stream
