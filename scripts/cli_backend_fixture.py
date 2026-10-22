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
    tool             a Forge-style tool step, started then finished
    edit NAME TEXT   write NAME in a Forge session's folder (checkpointed)
    slow N           stream for N seconds, so a test can stop it
    fail             end the turn with an error
    anything else    echo it back
"""
import asyncio
import os
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


def _chunks(text: str, size: int = 7):
    for start in range(0, len(text), size):
        yield text[start:start + size]


async def fake_stream(session_id, text, attachment_ids=None, is_admin=False, reference_context="",
                      references=None, claimed=False, **_):
    session_manager.append_message(session_id, "user", text)
    words = text.split()
    command = words[0].lower() if words else ""
    reply: list[str] = []

    async def say(piece: str, pause: float = 0.0):
        reply.append(piece)
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
        yield {"tool_step": {"phase": "started", "id": "t1", "name": "read_file", "summary": "services/forge_sessions.py",
                             "ok": None, "output": "", "at": now, "seconds": 0}}
        await asyncio.sleep(0.3)
        yield {"tool_step": {"phase": "finished", "id": "t1", "name": "read_file", "summary": "services/forge_sessions.py",
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


chat_service.stream_message = fake_stream
