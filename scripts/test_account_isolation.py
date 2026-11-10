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
    account.seed("model connections", "POST", "/api/models", {"name": f"{m} model", "base_url": ("http://127.0.0.1:9/v1" if account.name == "david" else "https://models.invalid/v1"), "model": "x", "api_key": account.secret}, "endpoint")
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
    # Content Studio format cards (2026-11-10) are written by the team's bots through their tools, not a route, so one is
    # put straight into the account's own studio store; the read routes are then tried across accounts like the rest.
    from services.content_studio import studio
    from datetime import date
    with accounts.as_account(auth_manager.account_id(account.name)):
        card = studio.save_format({"name": f"{m} format", "premise": f"{m} premise", "beats": ["hook", "payoff"],
                                   "length_min_s": 30, "length_max_s": 60, "source_niche": m,
                                   "audience": {"age_band": "18-30", "interests": m, "platform": "youtube", "why": m},
                                   "evidence": [{"url": "https://www.example.test/v", "channel": f"{m} channel",
                                                 "checked": date.today().isoformat()}]})
    account.ids.setdefault("format", []).append(str(card["id"]))
    account.seeded["format cards"] = "file"


ID_PARAMS = {"session": "session", "note": "note", "event": "event", "document": "document", "doc": "document",
             "project": "project", "endpoint": "endpoint", "task": "task", "routine": "task", "agent": "agent",
             "bot": "agent", "design": "design", "skill": "skill", "slug": "skill", "hook": "hook", "trigger": "trigger",
             "format_id": "format"}


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
        from services.content_studio import close_all
        close_all()  # the studio stores the format cards were written to
        from core import bot_rooms_store
        bot_rooms_store.close()  # so the throwaway folder can be deleted on Windows
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

    def test_a_non_admin_makes_and_sees_only_her_own_bots_hooks_triggers_and_connections(self):
        # Phase 4c: bea created her own bot, hook, trigger and model connection in fill(); each list shows hers
        # and none of david's, and david's shows none of hers.
        david, bea = self.accounts["david"], self.accounts["bea"]
        for kind in ("bots", "hooks", "model connections", "triggers"):
            self.assertEqual(bea.seeded.get(kind), "ok", f"bea creates {kind}")
        for path in ("/api/agents", "/api/hooks", "/api/models", "/api/triggers"):
            mine, theirs = call(bea.client, "GET", path)[0], call(david.client, "GET", path)[0]
            self.assertLess(mine.status_code, 300, path)
            for mark in david.markers():
                self.assertNotIn(mark, mine.text, f"bea read david's data via {path}")
            for mark in bea.markers():
                self.assertNotIn(mark, theirs.text, f"david read bea's data via {path}")
        # The lists that name things show hers (a trigger's list does not echo the marker back, so check the count).
        for path in ("/api/agents", "/api/hooks", "/api/models"):
            self.assertIn(bea.mark, call(bea.client, "GET", path)[0].text, f"bea sees her own via {path}")
        self.assertEqual(len(call(bea.client, "GET", "/api/triggers")[0].json()["triggers"]), 1)

    def test_what_bea_can_make_is_held_to_her_account(self):
        david, bea = self.accounts["david"], self.accounts["bea"]
        # A bot cannot be made at Full: bea has no machine access, so hers start at Ask and stay there.
        refused = call(bea.client, "POST", "/api/agents", json={"name": "Bea full bot", "approval_mode": "full"})[0]
        self.assertEqual(refused.status_code, 409, refused.text)
        made = call(bea.client, "POST", "/api/agents", json={"name": "Bea plain bot"})[0]
        self.assertLess(made.status_code, 300, made.text)
        from core import accounts, bot_policy
        with accounts.as_account(auth_manager.account_id("bea")):
            self.assertEqual(bot_policy.effective_policy(made.json()["id"]).mode, "ask")
        # No command hooks, no local MCP command, no model server on this computer, no hook to this computer.
        for method, path, body in (
                ("POST", "/api/hooks", {"name": "c", "event": "chat.reply", "action": "command", "config": {"command": "echo hi"}}),
                ("POST", "/api/hooks", {"name": "w", "event": "chat.reply", "action": "webhook", "config": {"url": "http://127.0.0.1:9/x"}}),
                ("POST", "/api/integrations/mcp-server", {"name": "s", "mcp_type": "stdio", "command": "echo"}),
                ("POST", "/api/models", {"name": "l", "base_url": "http://localhost:11434/v1", "model": "x", "kind": "local"})):
            r, err = call(bea.client, method, path, json=body)
            self.assertIsNone(err, path)
            self.assertGreaterEqual(r.status_code, 400, f"{method} {path} should be refused for bea, got {r.status_code}")
            self.assertLess(r.status_code, 500, f"{method} {path} should be a clean refusal, got {r.status_code}")
        # Her vault stays inside her own folder, and nothing is seeded elsewhere.
        outside = str(Path(_DATA.name) / "elsewhere")
        r = call(bea.client, "POST", "/api/settings/vault-dir", json={"path": outside})[0]
        self.assertEqual(r.status_code, 403, r.text)
        self.assertFalse(Path(outside).exists())
        # A tab is code for everyone: only an admin installs one from the store.
        r = call(bea.client, "POST", "/api/store/install", json={"kind": "tab", "slug": "x"})[0]
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("admin", r.text.lower())
        # Keys are hers alone (the store moved into each account in step 11).
        r = call(bea.client, "PUT", "/api/bots/keys/exa", json={"value": bea.secret})[0]
        self.assertLess(r.status_code, 300, r.text)
        for account in (bea, david):
            listing = call(account.client, "GET", "/api/bots/keys")[0]
            self.assertLess(listing.status_code, 300, listing.text)
            exa = next(k for k in listing.json()["keys"] if k["id"] == "exa")
            self.assertEqual(exa["has_value"], account is bea, f"{account.name}'s exa key")

    def test_what_stays_admin_only(self):
        # The install's own things: the call voice server, the avatar image provider and the Google OAuth app,
        # the install-wide settings, sharing a connection, the whole-folder backups, importing this computer's
        # tool setup, the browser computers, the Codex install and the store's publishing side.
        bea = self.accounts["bea"]
        for method, path, body in (
                ("PUT", "/api/agent-calls/voices", {"url": "http://127.0.0.1:9", "protocol": "voicebox"}),
                ("PUT", "/api/agents/avatar-provider", {"provider": "openai", "api_key": "x"}),
                ("POST", "/api/google/client", {"client_id": "x"}),
                ("POST", "/api/settings/computer-use", {"enabled": True}),
                ("POST", "/api/settings/agent-tools", {"disabled_tools": []}),
                ("PUT", "/api/models/nope/shares", {"usernames": []}),
                ("POST", "/api/bot-lifecycle/backups/export", {"password": "x"}),
                ("GET", "/api/bots/setup-import", None),
                ("GET", "/api/bot-workbench/computers", None),
                ("POST", "/api/model-setup/codex/install", None),
                ("GET", "/api/image-provider", None),
                ("GET", "/api/store/github", None)):
            r, err = call(bea.client, method, path, json=body)
            self.assertIsNone(err, path)
            self.assertEqual(r.status_code, 403, f"{method} {path} should stay admin-only, got {r.status_code}")

    def test_connectors_and_limits_are_each_accounts_own(self):
        david, bea = self.accounts["david"], self.accounts["bea"]
        for path in ("/api/connectors", "/api/connectors/kinds", "/api/bot-limit-resets", "/api/models/quotas", "/api/bot-usage/plan"):
            for account in (bea, david):
                r, err = call(account.client, "GET", path)
                self.assertIsNone(err, path)
                self.assertLess(r.status_code, 300, f"{path} should be open to {account.name}, got {r.status_code} {r.text[:100]}")
        from core.connectors import store as connector_store
        fake = [{"id": "dc", "kind": "slack", "name": "David connector", "account": auth_manager.account_id("david")},
                {"id": "bc", "kind": "slack", "name": "Bea connector", "account": auth_manager.account_id("bea")}]
        with patch.object(connector_store, "list_records", return_value=fake), \
                patch.object(connector_store, "get_record", side_effect=lambda i: next((r for r in fake if r["id"] == i), None)):
            seen = {a.name: [c["name"] for c in call(a.client, "GET", "/api/connectors")[0].json()] for a in (david, bea)}
            self.assertEqual(seen, {"david": ["David connector"], "bea": ["Bea connector"]})
            self.assertEqual(call(bea.client, "DELETE", "/api/connectors/dc")[0].status_code, 404)
            self.assertEqual(call(bea.client, "PATCH", "/api/connectors/dc", json={"name": "x"})[0].status_code, 404)

    def test_a_connector_message_is_an_admin_chat_only_for_an_admin(self):
        # core/channels/agent_routing.py direct(): the chat runs with the owning account's real admin status.
        import asyncio
        from core import accounts
        from core.channels import agent_routing
        seen = []

        async def fake_send(session_id, text, attachments, is_admin=False, **kwargs):
            seen.append(is_admin)
            return "ok"

        agent = {"id": "a1", "name": "Scout"}
        for name, expected in (("david", True), ("bea", False)):
            # The account first: agent_service is per account, so the patches must land on this account's.
            with accounts.as_account(auth_manager.account_id(name)),                     patch.object(agent_routing.chat_service, "send_message", fake_send),                     patch.object(agent_routing.agent_service, "chat_endpoint", return_value="e1"),                     patch.object(agent_routing.agent_service, "make_agent_chat"),                     patch.object(agent_routing.session_manager, "get_or_create_channel_session", return_value="s1"):
                asyncio.run(agent_routing.direct(agent, "hello", "conn:x", "Slack"))
            self.assertEqual(seen[-1], expected, f"{name}'s connector chat")

    def test_reach_me_and_its_stop_are_each_accounts_own(self):
        # Settings > Reach me (core/reach_me.py): the orders, quiet hours, per-bot choices and the one STOP.
        from core import accounts, reach_me
        david, bea = self.accounts["david"], self.accounts["bea"]
        r = call(bea.client, "PUT", "/api/reach-me", json={"message": ["telegram", "app"], "call": ["app"],
                                                         "quiet": {"enabled": True, "start": "21:00", "end": "06:00"}})[0]
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(call(bea.client, "POST", "/api/reach-me/pause", json={"paused": True})[0].status_code, 200)
        mine = call(david.client, "GET", "/api/reach-me")[0].json()
        self.assertIsNone(mine["paused"], "bea's STOP never pauses david's bots")
        self.assertFalse(mine["quiet"]["enabled"])
        self.assertEqual(mine["message"], list(reach_me.MESSAGE_CHANNELS))
        hers = call(bea.client, "GET", "/api/reach-me")[0].json()
        self.assertEqual((hers["message"], hers["call"], hers["quiet"]["start"]), (["telegram", "app"], ["app"], "21:00"))
        self.assertTrue(hers["paused"])
        with accounts.as_account(auth_manager.account_id("david")):
            self.assertIsNone(reach_me.paused())
        with accounts.as_account(auth_manager.account_id("bea")):
            self.assertTrue(reach_me.paused())
        call(bea.client, "POST", "/api/reach-me/pause", json={"paused": False})

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
