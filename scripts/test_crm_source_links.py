"""Native webmail provenance and owned source resolution; no network or real mail."""
import unittest
from contextlib import nullcontext
from unittest.mock import MagicMock, patch
from urllib.parse import parse_qs, unquote, urlsplit

from test_crm import CRMService, tab_crm, tab_api, settings, message, FakeMailbox, read_mailbox
from fastapi import FastAPI
from fastapi.testclient import TestClient


class GmailLinkTests(unittest.TestCase):
    account = {"id": "mail", "email": "me+work@gmail.com", "imap_host": "imap.gmail.com", "imap_port": 993}

    def test_native_id_is_the_google_documented_hex_id_and_uid_is_validated(self):
        box = MagicMock()
        box.uid.return_value = ("OK", [b"9 (UID 23 X-GM-MSGID 1278455344230334865)"])
        mailbox = tab_api._ReadOnlyMailbox(box, gmail_account=self.account["email"])
        url = mailbox.message_link(b"23")
        parsed = urlsplit(url)
        self.assertEqual(parsed.hostname, "mail.google.com")
        self.assertEqual(parsed.fragment, "all/" + format(1278455344230334865, "x"))
        self.assertEqual(parse_qs(parsed.query)["authuser"], [self.account["email"]])
        box.uid.assert_called_once_with("fetch", "23", "(X-GM-MSGID)")
        for invalid in ("23\r\nSTORE", "0", "1:1000", "ALL"):
            with self.assertRaises(ValueError):
                mailbox.message_link(invalid)

    def test_non_gmail_mailbox_does_not_try_a_provider_extension(self):
        box = MagicMock()
        self.assertIsNone(tab_api._ReadOnlyMailbox(box).message_link(b"23"))
        box.uid.assert_not_called()

    def test_new_mail_scans_capture_native_links_without_mutating_mail(self):
        class GmailMailbox(FakeMailbox):
            def uid(self, command, *args):
                if command == "fetch" and args[1] == "(X-GM-MSGID)":
                    self.calls.append((command, *args))
                    return "OK", [b"9 (UID 23 X-GM-MSGID 1278455344230334865)"]
                return super().uid(command, *args)
        account = {**self.account, "password_encrypted": "opaque"}
        with patch.object(tab_api, "email_accounts", return_value=[account]), \
             patch("services.email_service.email_service.get_account", return_value=account), \
             patch.object(tab_api.imaplib, "IMAP4_SSL", GmailMailbox), \
             patch.object(tab_api.secret_storage, "decrypt", return_value="test"):
            rows, _ = read_mailbox({"connection_id": "mail", "folder": "INBOX"}, {"lookback_days": 14, "max_messages": 1}, set())
        self.assertIn("#all/" + format(1278455344230334865, "x"), rows[0]["url"])
        self.assertFalse(any(call[0] == "store" for call in GmailMailbox.calls))

    def resolve(self, mailbox, identity="10:23", mid="<message@test>", lookup=True):
        with patch("services.email_service.email_service.get_account", return_value=self.account), \
             patch.object(tab_api, "open_mailbox", return_value=nullcontext(mailbox)):
            return tab_api.email_message_link("mail", "INBOX", identity, mid, lookup=lookup)

    def test_unchanged_uidvalidity_resolves_the_captured_message(self):
        box = MagicMock()
        box.response.return_value = ("UIDVALIDITY", [b"10"])
        box.message_link.return_value = "https://mail.google.com/mail/u/?authuser=me%40gmail.com#all/abc"
        result = self.resolve(box)
        self.assertTrue(result["direct"])
        box.message_link.assert_called_once_with("23")
        box.uid.assert_not_called()

    def test_changed_uidvalidity_uses_message_id_never_a_reused_uid(self):
        box = MagicMock()
        box.response.return_value = ("UIDVALIDITY", [b"99"])
        box.uid.return_value = ("OK", [b"24"])
        box.message_link.return_value = "https://mail.google.com/mail/u/?authuser=me%40gmail.com#all/abc"
        self.assertTrue(self.resolve(box)["direct"])
        box.message_link.assert_called_once_with(b"24")
        box.uid.assert_called_once_with("search", None, "HEADER", "Message-ID", '"<message@test>"')

    def test_ambiguous_or_moved_mail_has_an_exact_search_fallback(self):
        box = MagicMock()
        box.response.return_value = ("UIDVALIDITY", [b"99"])
        box.uid.return_value = ("OK", [b"24 25"])
        result = self.resolve(box)
        self.assertFalse(result["direct"])
        self.assertEqual(unquote(urlsplit(result["url"]).fragment), "search/in:anywhere rfc822msgid:message@test")
        box.message_link.assert_not_called()

    def test_metadata_only_fallback_never_connects_and_unknown_providers_are_not_invented(self):
        with patch("services.email_service.email_service.get_account", return_value=self.account), \
             patch.object(tab_api, "open_mailbox") as opened:
            result = tab_api.email_message_link("mail", "INBOX", "10:23", "<message@test>", lookup=False)
            self.assertFalse(result["direct"])
            opened.assert_not_called()
            self.assertIsNone(tab_api.email_message_link("mail", "INBOX", "bad", "bad\nMessage-ID", lookup=False))
        with patch("services.email_service.email_service.get_account", return_value={**self.account, "imap_host": "imap.example.com"}):
            self.assertIsNone(tab_api.email_message_link("mail", "INBOX", "10:23", "<message@test>"))


class OriginalSourceRouteTests(unittest.TestCase):
    def setUp(self):
        settings.update_settings(enabled_tab_templates=["crm"])
        self.store = CRMService("source-links-" + self._testMethodName + ".json")
        source = self.store.add_source("alice", "email", "mail", "Gmail")
        self.message = self.store.capture(source, message(message_id="<message@test>", folder="INBOX"))
        task = self.store.create_task("alice", {"title": "Reply to customer"})
        self.task_id = task["id"]
        with self.store.transaction():
            self.store._data["tasks"][task["id"]]["evidence"].append({"message_id": self.message["id"], "quote": "Reply", "url": None})
        self.patch = patch.object(tab_crm, "crm_service", self.store)
        self.patch.start(); self.addCleanup(self.patch.stop)
        app = FastAPI(); app.include_router(tab_crm.router)
        app.dependency_overrides[tab_crm.require_user] = lambda: "alice"
        self.client = TestClient(app)
        self.client.__enter__(); self.addCleanup(self.client.__exit__, None, None, None)
        self.path = f"/api/tab-crm/messages/{self.message['id']}/original"

    def test_legacy_links_resolve_once_and_update_existing_task_evidence(self):
        url = "https://mail.google.com/mail/u/?authuser=me%40gmail.com#all/abc"
        with patch.object(tab_api, "is_admin", return_value=True), \
             patch.object(tab_api, "email_message_link", return_value={"url": url, "direct": True}) as lookup:
            self.assertEqual(self.client.get(self.path).json()["url"], url)
            self.assertEqual(self.client.get(self.path).json()["url"], url)
            lookup.assert_called_once_with("mail", "INBOX", "10:23", "<message@test>", lookup=True)
        self.assertEqual(self.store.task("alice", self.task_id)["evidence"][0]["url"], url)

    def test_other_owners_cannot_resolve_source_connections(self):
        source = self.store.add_source("bob", "email", "private", "Private")
        foreign = self.store.capture(source, message())
        with patch.object(tab_api, "email_message_link") as lookup:
            self.assertEqual(self.client.get(f"/api/tab-crm/messages/{foreign['id']}/original").status_code, 404)
            lookup.assert_not_called()

    def test_non_admin_can_read_owned_links_without_polling_shared_mailbox(self):
        with patch.object(tab_api, "is_admin", return_value=False), \
             patch.object(tab_api, "email_message_link", return_value={"url": None}) as lookup:
            self.assertIsNone(self.client.get(self.path).json()["url"])
            self.assertFalse(lookup.call_args.kwargs["lookup"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
