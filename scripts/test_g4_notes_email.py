"""A08 Notes and Email backend proof (Part 2, group g4). Isolated data, no network, no real accounts.

Tests named test_BUG_* assert the CORRECT behaviour and currently FAIL on dev; each is reported to David.
Run: .venv\\Scripts\\python.exe -B -X utf8 scripts\\test_g4_notes_email.py
"""
import asyncio
import json
import os
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.tab_test_support import TemporaryDirectory
_DATA = TemporaryDirectory(prefix="g4-notes-email-")
os.environ["JARVIS_DATA_DIR"] = _DATA.name
os.environ["JARVIS_VAULT_DIR"] = str(Path(_DATA.name) / "vault")

from fastapi import FastAPI
from fastapi.testclient import TestClient
from core import vault_sync, builtin_tasks, email_triage, email_send
from core.auth import auth_manager
from core.middleware import require_user, require_admin
from core.secret_storage import decrypt
from routes import notes_routes, email_routes
from services import notes_service as notes_module, email_service as email_module, calendar_service as cal_module

NOTES_FILE_TEXT = (
    "# Active Priorities\n\n## Work\n- [ ] Ship the report\n- [x] Pay the invoice\n\n"
    "## Home\n- [ ] Nothing tracked yet.\n- [ ] Fix the sink\n"
)


def client(router, user="david", admin=True):
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[require_user] = lambda: user
    if admin:
        app.dependency_overrides[require_admin] = lambda: user
    return TestClient(app)


class NotesBase(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory(dir=_DATA.name)
        self.addCleanup(self.tmp.cleanup)
        self.vault = Path(self.tmp.name) / "vault"
        self.vault.mkdir()
        patches = [patch.object(notes_module, "NOTES_FILE", str(Path(self.tmp.name) / "notes.json")),
                   patch.object(vault_sync, "resolve_vault_dir", lambda: str(self.vault)),
                   patch.object(cal_module, "EVENTS_FILE", str(Path(self.tmp.name) / "events.json"))]
        for p in patches:
            p.start(); self.addCleanup(p.stop)
        # The module-level singleton caches its file in memory; swap its dict for a clean one.
        self.notes = notes_module.notes_service
        self.notes._notes = {}
        self.addCleanup(lambda: setattr(self.notes, "_notes", {}))
        self.api = client(notes_routes.router)

    def write_vault(self, text, newline=""):
        (self.vault / "Active Priorities.md").write_bytes(text.encode("utf-8"))

    def read_vault(self):
        return (self.vault / "Active Priorities.md").read_bytes().decode("utf-8")


class NoteCrudTests(NotesBase):
    def test_create_list_complete_delete_through_the_routes(self):
        a = self.api.post("/api/notes", json={"text": "Buy milk", "due_date": "2026-11-01T09:00:00.000Z"}).json()
        b = self.api.post("/api/notes", json={"text": "No date"}).json()
        self.assertEqual((a["completed"], a["project"]), (False, "personal"))
        done = self.api.patch(f"/api/notes/{a['id']}", json={"completed": True}).json()
        self.assertTrue(done["completed"])
        listed = self.api.get("/api/notes").json()
        self.assertEqual([n["id"] for n in listed][-1], a["id"], "finished notes sort last")
        self.assertEqual([n["id"] for n in self.api.get("/api/notes?include_completed=false").json()], [b["id"]])
        self.assertEqual(self.api.patch(f"/api/notes/{a['id']}", json={"completed": False}).json()["completed"], False)
        self.assertEqual(self.api.delete(f"/api/notes/{a['id']}").json(), {"ok": True})
        self.assertEqual(self.api.delete(f"/api/notes/{a['id']}").json(), {"ok": True}, "deleting twice is harmless")
        self.assertEqual(self.api.patch("/api/notes/missing", json={"text": "x"}).status_code, 404)
        # Saved to disk and restored by a fresh service (restart).
        reloaded = notes_module.NotesService()
        self.assertEqual([n["text"] for n in reloaded.list_notes()], ["No date"])

    def test_BUG_a_due_date_can_be_cleared(self):
        n = self.api.post("/api/notes", json={"text": "Dated", "due_date": "2026-11-01T09:00:00Z"}).json()
        r = self.api.patch(f"/api/notes/{n['id']}", json={"due_date": None}).json()
        self.assertIsNone(r["due_date"], "PATCH due_date:null is dropped by `if v is not None` in routes/notes_routes.py")

    def test_clear_finished_partial_failure_leaves_the_rest(self):
        ids = [self.api.post("/api/notes", json={"text": f"n{i}"}).json()["id"] for i in range(3)]
        for i in ids:
            self.api.patch(f"/api/notes/{i}", json={"completed": True})
        real = self.notes.delete_note
        def flaky(note_id):
            if note_id == ids[1]:
                raise OSError("disk full")
            real(note_id)
        with patch.object(self.notes, "delete_note", flaky):
            app = FastAPI(); app.include_router(notes_routes.router); app.dependency_overrides[require_user] = lambda: "david"
            codes = [TestClient(app, raise_server_exceptions=False).delete(f"/api/notes/{i}").status_code for i in ids]
        self.assertEqual(codes, [200, 500, 200], "the UI's Promise.allSettled reports exactly the failed one")
        self.assertEqual([n["id"] for n in self.notes.list_notes()], [ids[1]])

    def test_large_notes_list_is_fast_and_ordered(self):
        for i in range(2000):
            self.notes._notes[f"id{i}"] = {"id": f"id{i}", "text": f"note {i}", "due_date": None if i % 3 else f"2026-11-{1 + i % 28:02d}T09:00:00Z",
                                           "project": "p", "completed": i % 5 == 0, "created_at": i, "updated_at": i, "vault_source": None}
        times = []
        for _ in range(20):
            t = time.perf_counter(); r = self.api.get("/api/notes").json(); times.append((time.perf_counter() - t) * 1000)
        times.sort()
        print(f"\n[bench] GET /api/notes 2000 notes p50={times[10]:.1f}ms p95={times[18]:.1f}ms bytes={len(json.dumps(r))}")
        self.assertEqual(len(r), 2000)
        first_done = next(i for i, n in enumerate(r) if n["completed"])
        self.assertTrue(all(n["completed"] for n in r[first_done:]))
        t = time.perf_counter()
        for i in range(20):
            self.notes.update_note(f"id{i + 1}", text="edited")
        print(f"[bench] 20 PATCH writes on 2000 notes: {(time.perf_counter() - t) * 1000 / 20:.1f}ms each (whole file rewritten per write)")


class VaultSyncTests(NotesBase):
    def test_import_is_idempotent_and_maps_headings_checkboxes_and_skips_placeholders(self):
        self.write_vault(NOTES_FILE_TEXT)
        s1 = vault_sync.sync_from_vault()
        self.assertEqual((s1["imported"], s1["updated"], s1["removed"]), (3, 0, 0))
        got = {n["text"]: (n["project"], n["completed"]) for n in self.notes.list_notes()}
        self.assertEqual(got, {"Ship the report": ("Work", False), "Pay the invoice": ("Work", True), "Fix the sink": ("Home", False)})
        s2 = vault_sync.sync_from_vault()
        self.assertEqual((s2["imported"], s2["updated"], s2["removed"]), (0, 0, 0))
        self.assertEqual(len(self.notes.list_notes()), 3, "no duplicates after a second sync")

    def test_app_tick_writes_one_checkbox_back_byte_exact_and_vault_edit_comes_back(self):
        crlf = NOTES_FILE_TEXT.replace("\n", "\r\n")
        self.write_vault(crlf)
        vault_sync.sync_from_vault()
        note = next(n for n in self.notes.list_notes() if n["text"] == "Ship the report")
        self.api.patch(f"/api/notes/{note['id']}", json={"completed": True})
        after = self.read_vault()
        self.assertEqual(after, crlf.replace("- [ ] Ship the report", "- [x] Ship the report"), "only that checkbox changed; CRLF kept")
        # Untick in the app, then tick in the vault and re-sync: both halves agree, still 3 notes.
        self.api.patch(f"/api/notes/{note['id']}", json={"completed": False})
        self.assertIn("- [ ] Ship the report", self.read_vault())
        self.write_vault(self.read_vault().replace("- [ ] Fix the sink", "- [x] Fix the sink"))
        s = vault_sync.sync_from_vault()
        self.assertEqual((s["imported"], s["removed"]), (1, 1), "the checkbox is part of the matching key, so a vault tick replaces the note")
        self.assertTrue(next(n for n in self.notes.list_notes() if n["text"] == "Fix the sink")["completed"])
        self.assertEqual(len(self.notes.list_notes()), 3)

    def test_edited_line_skips_writeback_and_failure_never_fails_the_click(self):
        self.write_vault(NOTES_FILE_TEXT)
        vault_sync.sync_from_vault()
        note = next(n for n in self.notes.list_notes() if n["text"] == "Ship the report")
        self.write_vault(NOTES_FILE_TEXT.replace("Ship the report", "Ship the report today"))
        before = self.read_vault()
        r = self.api.patch(f"/api/notes/{note['id']}", json={"completed": True})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.read_vault(), before, "a changed line is never guessed at")
        with patch.object(vault_sync, "write_back_completion", side_effect=OSError("locked")):
            r = self.api.patch(f"/api/notes/{note['id']}", json={"completed": False})
        self.assertEqual((r.status_code, r.json()["completed"]), (200, False), "vault write failure does not fail the click")
        # Next sync reconciles from the vault: the edited line is a new item, the old one is removed.
        s = vault_sync.sync_from_vault()
        self.assertEqual((s["imported"], s["removed"]), (1, 1))

    def test_item_removed_from_vault_leaves_the_app_and_native_notes_survive(self):
        self.write_vault(NOTES_FILE_TEXT)
        vault_sync.sync_from_vault()
        native = self.api.post("/api/notes", json={"text": "Native"}).json()
        self.write_vault(NOTES_FILE_TEXT.replace("- [ ] Fix the sink\n", ""))
        s = vault_sync.sync_from_vault()
        self.assertEqual(s["removed"], 1)
        texts = {n["text"] for n in self.notes.list_notes()}
        self.assertEqual(texts, {"Ship the report", "Pay the invoice", "Native"})
        self.assertIn(native["id"], {n["id"] for n in self.notes.list_notes()})

    def test_long_item_is_summarised_but_matched_on_its_exact_line(self):
        long = "- [ ] " + ("Write the quarterly plan. " * 30).strip()
        self.write_vault("## Work\n" + long + "\n")
        vault_sync.sync_from_vault()
        n = self.notes.list_notes()[0]
        self.assertLessEqual(len(n["text"]), vault_sync.DISPLAY_MAX + 1)
        self.api.patch(f"/api/notes/{n['id']}", json={"completed": True})
        self.assertTrue(self.read_vault().splitlines()[1].startswith("- [x] Write the quarterly plan."))

    def test_BUG_clear_finished_on_a_vault_item_does_not_come_back_at_next_sync(self):
        self.write_vault(NOTES_FILE_TEXT)
        vault_sync.sync_from_vault()
        done = next(n for n in self.notes.list_notes() if n["text"] == "Pay the invoice")
        self.assertTrue(done["completed"])
        self.api.delete(f"/api/notes/{done['id']}")  # exactly what Notes > Clear finished sends
        vault_sync.sync_from_vault()                # runs at every app start
        self.assertNotIn("Pay the invoice", [n["text"] for n in self.notes.list_notes()],
                         "the vault line stays '- [x]', so the finished note is re-imported: Clear finished is undone on restart")

    def test_BUG_a_due_date_set_in_the_app_survives_a_tick_made_in_the_vault(self):
        self.write_vault(NOTES_FILE_TEXT)
        vault_sync.sync_from_vault()
        note = next(n for n in self.notes.list_notes() if n["text"] == "Fix the sink")
        self.api.patch(f"/api/notes/{note['id']}", json={"due_date": "2026-11-02T09:00:00Z"})
        self.write_vault(NOTES_FILE_TEXT.replace("- [ ] Fix the sink", "- [x] Fix the sink"))
        vault_sync.sync_from_vault()
        after = next(n for n in self.notes.list_notes() if n["text"] == "Fix the sink")
        self.assertEqual((after["id"], after["due_date"]), (note["id"], "2026-11-02T09:00:00Z"),
                         "the replaced note gets a new id and loses its due date (Calendar link breaks)")

    def test_BUG_identical_lines_under_two_headings_are_two_notes(self):
        self.write_vault("## A\n- [ ] Call the bank\n## B\n- [ ] Call the bank\n")
        vault_sync.sync_from_vault()
        s = vault_sync.sync_from_vault()
        self.assertEqual(len(self.notes.list_notes()), 2, "two vault checkboxes collapse into one note (matched on file+line text only)")
        self.assertEqual(s["updated"], 0, "and the project label flips on every sync")


class CalendarAgreementTests(NotesBase):
    def listing(self, start, end):
        cal = cal_module.CalendarService()
        return cal.list_range(start, end)

    def test_due_notes_show_in_calendar_until_completed_and_agree_with_notes(self):
        n = self.api.post("/api/notes", json={"text": "Due soon", "due_date": "2026-10-28T13:00:00.000Z"}).json()
        ev = [e for e in self.listing("2026-10-28T00:00:00.000Z", "2026-10-29T00:00:00.000Z") if e["source"] == "note"]
        self.assertEqual([(e["id"], e["title"]) for e in ev], [(n["id"], "Due soon")])
        self.api.patch(f"/api/notes/{n['id']}", json={"completed": True})
        self.assertEqual([e for e in self.listing("2026-10-28T00:00:00.000Z", "2026-10-29T00:00:00.000Z") if e["source"] == "note"], [])
        dates = cal_module.CalendarService().list_for_dates("2026-10-28", "2026-10-28")
        self.assertEqual([e for e in dates if e["source"] == "note"], [], "completed notes leave the day view too")

    def test_BUG_note_due_with_an_offset_lands_in_the_right_calendar_window(self):
        # 09:00 at -04:00 is 13:00Z, so it belongs to the 2026-10-28 window ending 12:00Z? No: it must be OUTSIDE [00:00Z,12:00Z).
        self.api.post("/api/notes", json={"text": "Offset", "due_date": "2026-10-28T09:00:00-04:00"})
        inside = [e for e in self.listing("2026-10-28T00:00:00.000Z", "2026-10-28T12:00:00.000Z") if e["source"] == "note"]
        self.assertEqual(inside, [], "list_due_between compares raw strings, so an offset note shows 4h early (agents write due_date in any format)")


class EmailBase(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory(dir=_DATA.name)
        self.addCleanup(self.tmp.cleanup)
        p = patch.object(email_module, "ACCOUNTS_FILE", str(Path(self.tmp.name) / "accounts.json")); p.start(); self.addCleanup(p.stop)
        p = patch.object(email_triage, "TRIAGE_FILE", str(Path(self.tmp.name) / "triage.json")); p.start(); self.addCleanup(p.stop)
        self.svc = email_module.email_service
        self.old = self.svc._accounts
        self.svc._accounts = {}
        self.addCleanup(lambda: setattr(self.svc, "_accounts", self.old))
        self.api = client(email_routes.router)

    def add(self, address="me@example.com", password="s3cret-pw"):
        return self.api.post("/api/email/accounts", json={"email": address, "password": password, "imap_host": "imap.x", "smtp_host": "smtp.x"}).json()


class EmailAccountTests(EmailBase):
    def test_password_is_encrypted_at_rest_and_never_returned(self):
        a = self.add()
        self.assertNotIn("password", json.dumps(a)); self.assertNotIn("s3cret-pw", json.dumps(self.api.get("/api/email/accounts").json()))
        disk = Path(email_module.ACCOUNTS_FILE).read_text()
        self.assertNotIn("s3cret-pw", disk)
        self.assertEqual(decrypt(self.svc._accounts[a["id"]]["password_encrypted"]), "s3cret-pw")
        self.assertEqual(self.api.delete(f"/api/email/accounts/{a['id']}").json(), {"ok": True})
        self.assertEqual(self.api.get("/api/email/accounts").json(), [])
        self.assertNotIn(a["id"], Path(email_module.ACCOUNTS_FILE).read_text(), "disconnect deletes the stored credentials")

    def test_bad_credentials_report_per_protocol_without_the_password(self):
        a = self.add()
        with patch.object(email_module.imaplib, "IMAP4_SSL", side_effect=OSError("imap refused")), \
             patch.object(email_module.smtplib, "SMTP_SSL", side_effect=OSError("smtp refused")):
            r = self.api.post(f"/api/email/accounts/{a['id']}/test").json()
        self.assertEqual((r["imap"], r["smtp"], r["imap_error"], r["smtp_error"]), (False, False, "imap refused", "smtp refused"))
        self.assertNotIn("s3cret-pw", json.dumps(r))
        self.assertEqual(self.api.post("/api/email/accounts/nope/test").status_code, 404)

    def test_provider_failure_is_a_502_and_does_not_break_other_accounts(self):
        a, b = self.add("a@x.com"), self.add("b@x.com", "other-pw")
        fake = MagicMock()
        fake.__enter__.return_value = fake
        def imap(host, port, timeout=0):
            return fake
        calls = []
        def login(user, pw):
            calls.append(user)
            if user == "a@x.com":
                raise email_module.imaplib.IMAP4.error("LOGIN failed")
        fake.login.side_effect = login
        fake.search.return_value = ("OK", [b""])
        with patch.object(email_module.imaplib, "IMAP4_SSL", imap):
            ra = self.api.get(f"/api/email/accounts/{a['id']}/messages")
            rb = self.api.get(f"/api/email/accounts/{b['id']}/messages")
        self.assertEqual(ra.status_code, 502); self.assertNotIn("s3cret-pw", ra.text)
        self.assertEqual((rb.status_code, rb.json()), (200, []))

    def test_BUG_a_zero_or_huge_limit_cannot_pull_the_whole_mailbox(self):
        a = self.add()
        fake = MagicMock(); fake.__enter__.return_value = fake
        fake.search.return_value = ("OK", [b" ".join(str(i).encode() for i in range(1, 501))])
        fake.fetch.return_value = ("OK", [(b"1 (FLAGS ())", b"From: x@y.z\r\nSubject: s\r\nDate: d\r\n\r\n")])
        with patch.object(email_module.imaplib, "IMAP4_SSL", return_value=fake):
            r = self.api.get(f"/api/email/accounts/{a['id']}/messages?limit=0")
        self.assertLessEqual(len(r.json()), 100, "ids[-0:] is the whole list: limit=0 fetched all 500 headers (and limit has no ceiling)")

    def test_email_tab_accounts_are_owner_scoped(self):
        """David's decision (2026-10-27): members get their own Email accounts.
        A member sees and uses only accounts they added; an admin sees all;
        an account with no owner (made before ownership) is admins only."""
        a = self.add()  # added by "david"
        member = client(email_routes.router, user="member", admin=False)
        other = client(email_routes.router, user="other", admin=False)
        boss = client(email_routes.router, user="boss", admin=False)
        self.assertFalse(auth_manager.is_admin("member"))
        self.assertEqual(self.svc._accounts[a["id"]]["owner"], "david", "create stores the owner")
        mine = member.post("/api/email/accounts", json={"email": "m@x.co", "password": "pw", "imap_host": "i", "smtp_host": "s"}).json()
        legacy = self.add("old@x.co"); self.svc._accounts[legacy["id"]].pop("owner")
        self.svc._accounts[legacy["id"]]["owner"] = None
        sent = []
        with patch.object(self.svc, "send_message", lambda *args, **kw: sent.append(args)),                 patch.object(self.svc, "list_messages", lambda *args, **kw: []),                 patch.object(self.svc, "test_connection", lambda *args, **kw: {"imap": True, "smtp": True}),                 patch.object(email_routes.auth_manager, "is_admin", lambda u: u == "boss"):
            for victim in (a["id"], legacy["id"]):
                for method, path, body in (("post", f"/api/email/accounts/{victim}/send", {"to": "x@y.z", "subject": "s", "body": "b"}),
                                           ("get", f"/api/email/accounts/{victim}/messages", None),
                                           ("post", f"/api/email/accounts/{victim}/test", None),
                                           ("delete", f"/api/email/accounts/{victim}", None)):
                    with self.subTest(method=method, path=path):
                        r = getattr(member, method)(path, **({"json": body} if body else {}))
                        self.assertEqual(r.status_code, 404, "another owner's (or an ownerless) account is not found")
            self.assertEqual(sent, [])
            self.assertEqual([x["id"] for x in member.get("/api/email/accounts").json()], [mine["id"]])
            self.assertEqual(other.get("/api/email/accounts").json(), [])
            self.assertEqual(member.get(f"/api/email/accounts/{mine['id']}/messages").status_code, 200)
            self.assertEqual(member.post(f"/api/email/accounts/{mine['id']}/send", json={"to": "x@y.z", "subject": "s", "body": "b"}).status_code, 200)
            self.assertEqual(len(sent), 1)
            self.assertEqual({x["id"] for x in boss.get("/api/email/accounts").json()}, {a["id"], legacy["id"], mine["id"]}, "an admin sees all")
            self.assertEqual(boss.post(f"/api/email/accounts/{legacy['id']}/test").status_code, 200)
            self.assertEqual(member.delete(f"/api/email/accounts/{mine['id']}").json(), {"ok": True})
        self.assertIn(a["id"], self.svc._accounts, "the admin's account survived the member's attempts")

    def test_triage_shows_a_member_only_their_own_accounts(self):
        a = self.add("david@x.co"); member = client(email_routes.router, user="member", admin=False)
        mine = member.post("/api/email/accounts", json={"email": "m@x.co", "password": "pw", "imap_host": "i", "smtp_host": "s"}).json()
        email_triage.save([{"account": "david@x.co", "subject": "secret"}, {"account": "m@x.co", "subject": "mine"}], 2)
        got = member.get("/api/email/triage").json()
        self.assertEqual([i["subject"] for i in got["items"]], ["mine"])


class SendingAccountTests(EmailBase):
    def test_sender_is_the_chosen_owned_account_and_revalidated_after_approval(self):
        a = self.add("office@club.org")
        with patch.object(email_send.google, "status", return_value={"accounts": [
                {"id": "g1", "email": "me@gmail.com", "can_send_email": True}], "configured": True}):
            msg = email_send.validate({"from_account": "ME@gmail.com", "to": "x@y.co", "subject": "s", "body": "b"}, "david")
            self.assertEqual((msg["via"], msg["account_id"]), ("Google", "g1"))
            smtp = email_send.validate({"from_account": "office@club.org", "to": "x@y.co", "subject": "s", "body": "b"}, "david")
            self.assertEqual(smtp["via"], "Email tab")
            for bad in ({"from_account": "ghost@x.co"}, {"from_account": "office@club.org", "to": "bad"},
                        {"from_account": "office@club.org", "to": "x@y.co", "subject": "a\r\nBcc: z@z.co"}):
                with self.assertRaises(ValueError):
                    email_send.validate({"subject": "s", "body": "b", "to": "x@y.co", **bad}, "david")
            self.api.delete(f"/api/email/accounts/{a['id']}")  # removed while approval was pending
            with self.assertRaisesRegex(ValueError, "no longer available"):
                asyncio.run(email_send.send(smtp, "david"))

    def test_other_users_email_tab_accounts_are_not_offered_as_senders(self):
        a = self.add("theirs@x.co")
        self.svc._accounts[a["id"]]["owner"] = "someone-else"
        with patch.object(email_send.google, "status", return_value={"accounts": [], "configured": False}):
            self.assertEqual(email_send.accounts("david"), [])


class TriageTests(EmailBase):
    def run_triage(self, listing, reply="NONE"):
        self.add("a@x.com"); self.add("b@x.com")
        prompts = []
        async def complete(brain, prompt, task, surface):
            prompts.append(prompt); return reply
        brain = MagicMock(); brain.connect = AsyncMock(); brain.disconnect = AsyncMock()
        class Ctx:
            async def __aenter__(self): return None
            async def __aexit__(self, *a): return False
        with patch.object(self.svc, "list_messages", listing), patch("core.brain.Brain", return_value=brain), \
             patch("core.task_scheduler.complete", complete), patch("core.file_checkpoints.around_turn", lambda *_: Ctx()):
            summary = asyncio.run(builtin_tasks._run_triage_email())
        return summary, prompts

    def test_one_failing_account_does_not_block_the_others_and_the_error_is_recorded(self):
        def listing(account_id, **kw):
            if self.svc._accounts[account_id]["email"] == "a@x.com":
                raise OSError("a is down")
            return [{"uid": "1", "from": "Boss <boss@x.com>", "subject": "Contract due", "date": "d", "seen": False}]
        summary, prompts = self.run_triage(listing, "0 | needs a reply by Friday")
        stored = email_triage.load()
        self.assertEqual([i["subject"] for i in stored["items"]], ["Contract due"])
        self.assertEqual(stored["items"][0]["account"], "b@x.com")
        self.assertIn("a@x.com: a is down", stored["error"])
        self.assertNotIn("s3cret-pw", json.dumps(stored))

    def test_no_accounts_is_honest_and_every_account_failing_records_the_errors(self):
        self.assertIn("No email accounts", asyncio.run(builtin_tasks._run_triage_email()))
        self.assertEqual(email_triage.load()["error"], "No email accounts connected.")
        def listing(account_id, **kw):
            raise OSError("down")
        summary, _ = self.run_triage(listing)
        self.assertIn("No unread mail", summary)
        self.assertEqual(email_triage.load()["items"], [])
        self.assertIn("down", email_triage.load()["error"])

    def test_triage_prompt_size_scales_with_accounts_and_has_no_overall_cap(self):
        def listing(account_id, **kw):
            return [{"uid": str(i), "from": f"Sender Name {i} <sender{i}@example.com>", "subject": f"Subject line number {i} about things", "date": "Mon, 26 Oct 2026 09:00:00 -0400", "seen": False}
                    for i in range(kw["limit"])]
        _, prompts = self.run_triage(listing)
        print(f"\n[bench] triage prompt, 2 accounts x 60 unread headers = {len(prompts[0])} chars (~{len(prompts[0]) // 4} tokens); 1 model call; headers only (no bodies)")
        self.assertEqual(prompts[0].count("From:"), 120, "TRIAGE_MAX_MESSAGES is per account, so 5 accounts send 300 headers")
        self.assertEqual(len(prompts), 1)


if __name__ == "__main__":
    unittest.main(verbosity=1)
