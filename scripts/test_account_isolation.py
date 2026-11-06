"""Account isolation: the multi-account leak test (Multi-Account (Build Spec), phase 0, 2026-11-05).

Two accounts on one Kairos: "david" (admin) and "bea" (not admin). Each fills every store it can
reach through the real routes, with markers unique to that account (a model API key among them).
Then every GET route that takes no parameters, and every GET route that takes one id (tried with
the OTHER account's ids), is called as each account, and the response is searched for the other
account's markers. The spec's rule (D2): not even the admin may see another account's data.
After the reads, every PATCH, PUT and then DELETE route that takes one id is tried as each account on
the other's ids (phase 2, group 1 on): any success is a finding ("changes"), since an account must not
be able to touch what it cannot see.

This is a ratchet. Today's leaks are listed in scripts/fixtures/account_leaks_known.json. The test
fails on any leak not in that list, and also on any listed leak that no longer happens, so the list
only ever shrinks, to empty when multi-account is done. Regenerate it on purpose with
    set KAIROS_UPDATE_LEAKS=1 && .venv\\Scripts\\python.exe -X utf8 scripts\\test_account_isolation.py
Background work (scheduler, routines, Kip's watch, channels) is checked from phase 1 on.
"""
import json
import tempfile
import os
import re
import secrets
import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.tab_test_support import TemporaryDirectory

_DATA = TemporaryDirectory(prefix="kairos-isolation-", dir=tempfile.gettempdir())  # the app holds its databases open at exit
os.environ["JARVIS_DATA_DIR"] = _DATA.name
os.environ["JARVIS_VAULT_DIR"] = str(Path(_DATA.name) / "vault")
os.environ["AUTH_ENABLED"] = "true"
(Path(_DATA.name) / "vault").mkdir(parents=True, exist_ok=True)

from fastapi.testclient import TestClient  # noqa: E402

import app as kairos  # noqa: E402
from core.auth import auth_manager  # noqa: E402

KNOWN = ROOT / "scripts" / "fixtures" / "account_leaks_known.json"
# Streams and long polls never end; they are not data reads.
SKIP = re.compile(r"(stream|/live\b|/live/|/sse|/events$|/ws\b|/watch$|/download|/export|/backup)")
TIMEOUT = 10


def call(client, method, path, **kwargs):
    """One request with a time limit; a route that hangs is reported, not waited on."""
    box = {}
    def run():
        try:
            box["r"] = client.request(method, path, **kwargs)
        except Exception as error:  # a crashing route is a finding, not a test error
            box["e"] = error
    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    thread.join(TIMEOUT)
    if thread.is_alive():
        return None, "timeout"
    if "e" in box:
        return None, type(box["e"]).__name__
    return box["r"], None


class Account:
    def __init__(self, name, client):
        self.name, self.client = name, client
        self.mark = f"LEAKMARK{name.upper()}{secrets.token_hex(3)}"
        self.secret = f"sk-{name}-{secrets.token_hex(8)}"
        self.ids = {}       # kind -> [ids]
        self.seeded = {}    # store -> "ok" | "denied 403" | ...

    def markers(self):
        return [self.mark, self.secret]

    def seed(self, store, method, path, body, id_kind=None, id_keys=("id",)):
        r, err = call(self.client, method, path, json=body)
        if err or r is None:
            self.seeded[store] = err or "no response"
            return None
        self.seeded[store] = "ok" if r.status_code < 300 else f"denied {r.status_code}"
        if r.status_code >= 300 or not id_kind:
            return r
        try:
            data = r.json()
        except ValueError:
            return r
        for key in id_keys:
            value = data.get(key) if isinstance(data, dict) else None
            if value is None and isinstance(data, dict):
                for inner in data.values():
                    if isinstance(inner, dict) and inner.get(key):
                        value = inner[key]
                        break
            if value:
                self.ids.setdefault(id_kind, []).append(str(value))
                break
        return r


def fill(account):
    m = account.mark
    account.seed("chats", "POST", "/api/sessions", {"title": f"{m} chat"}, "session")
    account.seed("notes", "POST", "/api/notes", {"text": f"{m} note"}, "note")
    account.seed("calendar", "POST", "/api/calendar/events", {"title": f"{m} event", "start": "2026-11-10T10:00:00Z", "end": "2026-11-10T11:00:00Z"}, "event")
    account.seed("documents", "POST", "/api/documents", {"title": f"{m} document", "content": f"{m} body"}, "document")
    account.seed("projects", "POST", "/api/projects", {"name": f"{m} project", "instructions": m}, "project")
    account.seed("model connections", "POST", "/api/models", {"name": f"{m} model", "base_url": "http://127.0.0.1:9/v1", "model": "x", "api_key": account.secret}, "endpoint")
    account.seed("tasks", "POST", "/api/tasks", {"name": f"{m} task", "prompt": m, "schedule_kind": "once", "run_at": "2030-01-01T00:00:00Z"}, "task")
    account.seed("bots", "POST", "/api/agents", {"name": f"{m} bot", "role": m, "instructions": m}, "agent")
    # The vault save route only edits an existing note, so the note is written as a file, into the account's own
    # vault (group 2): the first admin's is JARVIS_VAULT_DIR, everyone else's is in their account folder.
    from core import accounts
    from core.auth import auth_manager
    from core.vault import resolve_vault_dir
    with accounts.as_account(auth_manager.account_id(account.name)):
        vault = Path(resolve_vault_dir())
    (vault / f"{account.name}-{m}.md").write_text(f"# {m} vault note\n", encoding="utf-8")
    account.seeded["vault"] = "file"
    account.seed("designs", "POST", "/api/designs", {"title": f"{m} design"}, "design")
    account.seed("skills", "POST", "/api/skills", {"name": f"leak-{account.name}-{m[-6:].lower()}", "description": m, "body": m}, "skill", ("slug", "name", "id"))
    account.seed("hooks", "POST", "/api/hooks", {"name": f"{m} hook", "enabled": False, "event": "chat.reply", "action": "vault_note", "config": {"path": f"Logs/{m}.md"}}, "hook")
    account.seed("triggers", "POST", "/api/triggers", {"name": f"{m} trigger"}, "trigger")


ID_PARAMS = {"session": "session", "note": "note", "event": "event", "document": "document", "doc": "document",
             "project": "project", "endpoint": "endpoint", "task": "task", "routine": "task", "agent": "agent",
             "bot": "agent", "design": "design", "skill": "skill", "slug": "skill", "hook": "hook", "trigger": "trigger"}


# Fields the edit routes accept; extra ones are ignored. A route that refuses the body (422) proves nothing
# either way, so a refusal is only counted when it is a 403 or 404.
EDIT_BODY = {"text": "LEAKEDIT", "title": "LEAKEDIT", "name": "LEAKEDIT", "content": "LEAKEDIT", "instructions": "LEAKEDIT"}


def owner_view(owner, paths, path, target):
    """What the owner sees of the item: its own GET at the same path, else the list it sits in. None when
    there is no way to look."""
    for look in (target if "get" in paths.get(path, {}) else None,
                 target.rsplit("/", 1)[0] if "get" in paths.get(path.rsplit("/{", 1)[0], {}) else None):
        if look:
            r, _ = call(owner.client, "GET", look)
            return r.text if r is not None and r.status_code < 300 else ""
    return None


def changes_for(viewer, owner, paths, methods):
    """A change counts when the call succeeds AND the owner then finds the item gone (delete) or edited.
    Delete routes answer 200 for an id they do not have, so success alone proves nothing; when the owner
    has no way to look, success is counted."""
    found = set()
    for path, ops in paths.items():
        params = re.findall(r"{([^}]+)}", path)
        if len(params) != 1 or SKIP.search(path):
            continue
        kind = next((v for k, v in ID_PARAMS.items() if k in params[0].lower()), None)
        for method in methods:
            if method not in ops:
                continue
            for ident in (owner.ids.get(kind) or [])[:1]:
                target = path.replace("{" + params[0] + "}", ident)
                before = owner_view(owner, paths, path, target)
                body = None if method == "delete" else EDIT_BODY
                r, err = call(viewer.client, method.upper(), target, json=body)
                if r is None or r.status_code >= 300:
                    continue
                after = owner_view(owner, paths, path, target)
                unknown = before is None or ident not in before
                took = (ident not in (after or "")) if method == "delete" else ("LEAKEDIT" in (after or "") and "LEAKEDIT" not in before)
                if unknown or took:
                    found.add(f"{viewer.name} changes {owner.name}'s data via {method.upper()} {path}")
    return found


def leaks_for(viewer, owner, paths):
    found = set()
    markers = owner.markers()
    for path, ops in paths.items():
        if "get" not in ops or SKIP.search(path):
            continue
        params = re.findall(r"{([^}]+)}", path)
        targets = []
        if not params:
            targets = [path]
        elif len(params) == 1:
            kind = next((v for k, v in ID_PARAMS.items() if k in params[0].lower()), None)
            for ident in (owner.ids.get(kind) or [])[:2]:
                targets.append(path.replace("{" + params[0] + "}", ident))
        for target in targets:
            r, err = call(viewer.client, "GET", target)
            if r is None or r.status_code >= 300:
                continue
            body = r.text
            hits = [label for label, mark in (("data", owner.mark), ("secret", owner.secret)) if mark in body]
            for label in hits:
                found.add(f"{viewer.name} reads {owner.name}'s {label} via GET {path}")
    return found


class AccountIsolation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        auth_manager._users = {"users": {}}
        auth_manager._sessions = {}
        cls.patches = [patch("services.email_service.email_service.send_message", return_value=None)]
        for p in cls.patches:
            p.start()
        setup = TestClient(kairos.app)
        r = setup.post("/api/auth/setup", json={"username": "david", "password": "first-password-1"})
        assert r.status_code == 200, r.text
        r = setup.post("/api/auth/users", json={"username": "bea", "password": "second-password-2", "is_admin": False})
        assert r.status_code == 200, r.text
        cls.accounts = {}
        for name, password in (("david", "first-password-1"), ("bea", "second-password-2")):
            client = TestClient(kairos.app)
            r = client.post("/api/auth/login", json={"username": name, "password": password})
            assert r.status_code == 200, r.text
            cls.accounts[name] = Account(name, client)
        for account in cls.accounts.values():
            fill(account)
        paths = kairos.app.openapi()["paths"]
        david, bea = cls.accounts["david"], cls.accounts["bea"]
        leaks = leaks_for(bea, david, paths) | leaks_for(david, bea, paths)
        for methods in (("patch", "put"), ("delete",)):  # deletes last: the edits need the items there
            leaks |= changes_for(bea, david, paths, methods) | changes_for(david, bea, paths, methods)
        cls.leaks = sorted(leaks)
        cls.denied = sorted(f"bea cannot create {store}: {state}" for store, state in bea.seeded.items() if state not in ("ok", "file"))
        report = {"leaks": cls.leaks, "bea_denied": cls.denied, "seeded": {n: a.seeded for n, a in cls.accounts.items()}}
        out = ROOT / "data" / "account-isolation-report.json"; out.parent.mkdir(exist_ok=True)
        out.write_text(json.dumps(report, indent=1), encoding="utf-8")
        if os.environ.get("KAIROS_UPDATE_LEAKS") == "1":
            KNOWN.parent.mkdir(parents=True, exist_ok=True)
            KNOWN.write_text(json.dumps({"leaks": cls.leaks, "bea_denied": cls.denied}, indent=1) + "\n", encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        for p in cls.patches:
            p.stop()
        # Let the throwaway folder go: the app's own log handlers keep its log files open.
        import logging
        for logger in [logging.getLogger()] + [logging.getLogger(n) for n in logging.root.manager.loggerDict]:
            for handler in list(getattr(logger, 'handlers', [])):
                if isinstance(handler, logging.FileHandler):
                    handler.close(); logger.removeHandler(handler)

    def known(self, key):
        return json.loads(KNOWN.read_text(encoding="utf-8"))[key] if KNOWN.exists() else []

    def test_the_owner_sees_their_own_data(self):
        # The markers really were stored: each account finds its own note.
        for account in self.accounts.values():
            if account.seeded.get("notes") == "ok":
                r, _ = call(account.client, "GET", "/api/notes")
                self.assertIn(account.mark, r.text, f"{account.name} reads their own notes")

    def test_a_non_admin_reads_their_own_automation_and_bot_surfaces(self):
        # Phase 4b opened these to every signed-in account (they were admin-only): each answers 200 for bea
        # with her own (empty) data, never david's.
        david, bea = self.accounts["david"], self.accounts["bea"]
        for path in ("/api/bot-attention/inbox", "/api/bot-attention/notifications", "/api/bot-attention/needs-you",
                     "/api/bot-cards", "/api/bot-automation-changes", "/api/bot-departments", "/api/bot-onboarding",
                     "/api/bot-routines", "/api/bot-automations", "/api/bot-webhooks", "/api/bot-app-triggers",
                     "/api/triggers", "/api/runs", "/api/front-desk/work", "/api/front-desk/state",
                     "/api/bot-team/map", "/api/bot-peers/loop-guard", "/api/permissions", "/api/agent-calls/choices"):
            r, err = call(bea.client, "GET", path)
            self.assertIsNone(err, path)
            self.assertLess(r.status_code, 300, f"{path} should be open to bea, got {r.status_code} {r.text[:120]}")
            for mark in david.markers():
                self.assertNotIn(mark, r.text, f"bea read david's data via {path}")

    def test_what_stays_admin_only_in_these_areas(self):
        # Creating a trigger or a webhook, repointing a call voice server, the machine's usage limits and connectors
        # (an allow-listed sender reaches agents as an admin chat) stay with an admin until the bot reach cap
        # (phase 4c) and the machine-access gate.
        bea = self.accounts["bea"]
        for method, path, body in (("POST", "/api/triggers", {"name": "x"}), ("PATCH", "/api/triggers/nope", {"name": "x"}),
                                   ("POST", "/api/bot-webhooks", {"name": "x"}), ("PATCH", "/api/bot-webhooks/nope", {}),
                                   ("PUT", "/api/agent-calls/voices", {"url": "http://127.0.0.1:9", "protocol": "voicestudio"}),
                                   ("GET", "/api/connectors", None), ("POST", "/api/connectors", {"kind": "webhook"}),
                                   ("GET", "/api/bot-limit-resets", None)):
            r, err = call(bea.client, method, path, json=body)
            self.assertIsNone(err, path)
            self.assertEqual(r.status_code, 403, f"{method} {path} should stay admin-only, got {r.status_code}")

    def test_system_status_names_only_the_callers_discord_bots(self):
        from core.channels import discord_channel
        david, bea = self.accounts["david"], self.accounts["bea"]
        fake = {"d": {"id": "d", "name": "DavidBot", "account": auth_manager.account_id("david")},
                "b": {"id": "b", "name": "BeaBot", "account": auth_manager.account_id("bea")}}

        class Ready:
            def is_ready(self):
                return True

        with patch.object(discord_channel.discord_bots_store, "_load", return_value=fake), \
                patch.dict(discord_channel._clients, {"d": Ready(), "b": Ready()}):
            seen = {name: call(account.client, "GET", "/api/system/status")[0].json()["discord_connected_bots"]
                    for name, account in (("david", david), ("bea", bea))}
        self.assertEqual(seen, {"david": ["DavidBot"], "bea": ["BeaBot"]})

    def test_no_leak_beyond_the_known_list(self):
        new = sorted(set(self.leaks) - set(self.known("leaks")))
        self.assertEqual(new, [], "new cross-account leaks:\n" + "\n".join(new))

    def test_fixed_leaks_leave_the_list(self):
        fixed = sorted(set(self.known("leaks")) - set(self.leaks))
        self.assertEqual(fixed, [], "these no longer leak; remove them from account_leaks_known.json:\n" + "\n".join(fixed))

    def test_what_a_non_admin_cannot_do_is_known(self):
        self.assertEqual(sorted(set(self.denied) - set(self.known("bea_denied"))), [], "a non-admin lost access to more stores")
        self.assertEqual(sorted(set(self.known("bea_denied")) - set(self.denied)), [], "a non-admin gained a store; update the list")


if __name__ == "__main__":
    unittest.main()
