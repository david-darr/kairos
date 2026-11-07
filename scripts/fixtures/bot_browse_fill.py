"""Run by scripts/browser-smoke.cjs (browse-keeper-checks.cjs botPasswordChecks): bots filling the person's
Browse passwords, through the real harness (core/computer.py fill_login) and store (services/browse_passwords.py),
against sign-in pages that a real Chromium page in the smoke scanned with the driver's own field script.

Reads {"site", "username", "password", "scans": {name: {"url", "frames", "fields"}}} on stdin, prints JSON:
for each case what the model was told ("text") and what reached the driver ("values"), plus the use list, the
bot prompt line on and off, and every log line written meanwhile. A throwaway data folder; nothing is kept.
"""
import asyncio
import json
import logging
import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
DATA = tempfile.TemporaryDirectory(prefix="kairos-bot-browse-fill-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = DATA.name

ALICE, BOB = "alice1", "bobby2"
BOTS = {ALICE: {"0123456789": "Scout"}, BOB: {"abcdef0123": "Rex"}}


class Driver:
    """Stands in for the contained computer's driver: replays one real page scan and keeps what it was told to type."""

    def __init__(self, scan):
        self.stdin, self.stdout, self.stderr = self, asyncio.StreamReader(), asyncio.StreamReader()
        self.stderr.feed_eof()
        self.returncode, self.buffer, self.scan, self.values = None, b"", scan, None

    def write(self, data):
        self.buffer += data

    async def drain(self):
        for line in self.buffer.splitlines():
            command = json.loads(line)
            out = {"id": command["id"]}
            if command["action"] == "login_fields":
                out.update(url=self.scan["url"], frames=self.scan["frames"], fields=self.scan["fields"], opaque=False)
            elif command["action"] == "fill_login":
                if command.get("expected_frames") != self.scan["frames"] or command.get("expected_url") != self.scan["url"]:
                    out["error"] = "the page changed; check it again before filling"
                else:
                    self.values = command["values"]
                    out.update(url=self.scan["url"], filled=[k for k in ("username", "password", "code") if command["values"].get(k)])
            else:
                out.update(url=self.scan["url"], title="Sign in")
            self.stdout.feed_data((json.dumps(out) + "\n").encode())
        self.buffer = b""

    def close(self):
        self.returncode = 0

    async def wait(self):
        return 0

    def kill(self):
        self.returncode = -9


async def fill(computer, scan, bot_id):
    from urllib.parse import urlsplit
    manager = computer.ComputerManager(process_factory=None)
    driver = Driver(scan)
    c = computer.Computer("agent:" + bot_id, driver, "smoke-computer", last_action=0,
                          hosts={urlsplit(scan["url"]).hostname})
    c.reader_task = asyncio.create_task(manager._read(c))
    manager._computers[c.owner] = c
    ctx = SimpleNamespace(permission_surface="smoke", is_admin=True, turn_taint=None)
    try:
        result = await manager.fill_login(c.owner, bot_id, "browse", ctx)
    finally:
        manager._computers.pop(c.owner, None)
        driver.stdout.feed_eof()
        await asyncio.sleep(0)
        c.reader_task.cancel()
    return {"text": result["text"], "values": driver.values}


async def main():
    job = json.loads(sys.stdin.read())
    from core import accounts, computer
    from services import browse_passwords as pw
    logs = []
    handler = logging.Handler(logging.DEBUG)
    handler.emit = lambda record: logs.append(record.getMessage())
    logging.getLogger().addHandler(handler)
    logging.getLogger().setLevel(logging.DEBUG)
    out = {"cases": {}}
    with patch.object(pw, "_bot_name", lambda bot_id: BOTS.get(accounts.current_account(), {}).get(bot_id)):
        with accounts.as_account(ALICE):
            pw.save(job["site"] + "/login", job["username"], job["password"])
            out["prompt_on"] = pw.bot_prompt_line()
            out["cases"]["exact site"] = await fill(computer, job["scans"]["login"], "0123456789")
            out["cases"]["another site"] = await fill(computer, job["scans"]["other"], "0123456789")
            out["cases"]["a frame of another site"] = await fill(computer, job["scans"]["framed"], "0123456789")
            pw.set_bots_allowed(False)
            out["prompt_off"] = pw.bot_prompt_line()
            out["cases"]["switched off"] = await fill(computer, job["scans"]["login"], "0123456789")
            pw.set_bots_allowed(True)
        with accounts.as_account(BOB):
            out["cases"]["another account's bot"] = await fill(computer, job["scans"]["login"], "abcdef0123")
            out["cases"]["a bot of another account"] = await fill(computer, job["scans"]["login"], "0123456789")
            out["bob_uses"] = pw.bot_uses()
            out["prompt_bob"] = pw.bot_prompt_line()
        with accounts.as_account(ALICE):
            out["uses"] = pw.bot_uses()
            out["listed"] = pw.list_logins()
    out["logs"] = logs
    print(json.dumps(out))


if __name__ == "__main__":
    asyncio.run(main())
