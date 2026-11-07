"""Bots Phase 2, unit U5: saved logins, held secrets, 1Password and backup exclusion (2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-2-design.md, sections 3.4, 4.5 and 7 (U5).
Throwaway data folder, stand-in 1Password command. Run: python scripts/test_bots_logins.py
"""
import asyncio
import base64
import json
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import quote

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-logins-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core import backup, computer, permissions, system_admin  # noqa: E402
from core.bot_held_secrets import SECRET_FOLDER, held  # noqa: E402
from core.middleware import require_admin, require_user  # noqa: E402
from routes import bot_connections_routes  # noqa: E402
from services import bot_logins, bot_onepassword  # noqa: E402
from services.bot_logins import LoginError, LoginRefused  # noqa: E402

BOT_A, BOT_B = "0123456789", "abcdef0123"
PASSWORD = "Hunter2-correct-horse"
SEED = "JBSWY3DPEHPK3PXP"

app = FastAPI()
app.include_router(bot_connections_routes.router)
app.dependency_overrides[require_user] = lambda: "david"
app.dependency_overrides[require_admin] = lambda: "david"
web = TestClient(app)


def wipe():
    import shutil
    shutil.rmtree(os.path.join(_DATA.name, SECRET_FOLDER), ignore_errors=True)
    bot_logins.reset_cache()
    held.clear()
    held.add_source(bot_logins._all_passwords)


class LoginStore(unittest.TestCase):
    def setUp(self):
        wipe()

    def test_the_file_and_the_key_are_encrypted_and_in_the_excluded_folder(self):
        login = bot_logins.create("https://Example.com/login", "dana", PASSWORD, totp=SEED)
        folder = Path(_DATA.name) / SECRET_FOLDER
        self.assertEqual(sorted(p.name for p in folder.iterdir()), ["login.key", "logins.enc"])
        raw = (folder / "logins.enc").read_bytes()
        for secret in (PASSWORD.encode(), SEED.encode(), b"dana", b"example.com"):
            self.assertNotIn(secret, raw, "nothing readable is on disk")
        self.assertEqual(login["site"], "example.com")
        self.assertNotIn(".secret_key", [p.name for p in folder.iterdir()], "it has its own key, not the install key")

    def test_rows_are_masked_everywhere(self):
        bot_logins.create("example.com", "dana", PASSWORD, totp=SEED)
        for row in bot_logins.list_logins():
            self.assertEqual(set(row), {"id", "site", "username", "hosts", "has_totp", "exact_host", "bots", "source", "last_used", "created_at", "updated_at"})
        text = json.dumps(web.get("/api/bots/logins").json())
        self.assertNotIn(PASSWORD, text)
        self.assertNotIn(SEED, text)
        login_id = bot_logins.list_logins()[0]["id"]
        self.assertEqual(bot_logins.prompt_lines(BOT_A), [f"example.com (dana), login_id {login_id}"],
                         "a bot is told the site, the username and the id fill_login takes, nothing else")

    def test_blank_password_keeps_the_saved_one_and_a_new_one_replaces_it(self):
        login = bot_logins.create("example.com", "dana", PASSWORD)
        bot_logins.update(login["id"], password="", username="dana2")
        self.assertEqual(bot_logins.resolve_fill(login["id"], BOT_A, "example.com")["password"], PASSWORD)
        bot_logins.update(login["id"], password="a-new-password-1")
        self.assertEqual(bot_logins.resolve_fill(login["id"], BOT_A, "example.com")["password"], "a-new-password-1")

    def test_a_duplicate_site_and_username_is_refused(self):
        bot_logins.create("example.com", "dana", PASSWORD)
        with self.assertRaises(LoginError) as raised:
            bot_logins.create("https://example.com", "DANA", "another-password")
        self.assertEqual(raised.exception.status, 409)

    def test_a_corrupt_store_fails_closed_and_is_never_overwritten(self):
        bot_logins.create("example.com", "dana", PASSWORD)
        path = Path(_DATA.name) / SECRET_FOLDER / "logins.enc"
        path.write_bytes(b"garbage")
        bot_logins.reset_cache()
        before = path.read_bytes()
        with self.assertRaises(LoginError) as raised:
            bot_logins.list_logins()
        self.assertEqual(raised.exception.status, 503)
        with self.assertRaises(LoginError):
            bot_logins.create("other.com", "x", "password-1")
        self.assertEqual(path.read_bytes(), before, "the unreadable file was left alone")

    def test_a_missing_key_never_regenerates_over_saved_logins(self):
        bot_logins.create("example.com", "dana", PASSWORD)
        (Path(_DATA.name) / SECRET_FOLDER / "login.key").unlink()
        bot_logins.reset_cache()
        with self.assertRaises(LoginError):
            bot_logins.create("other.com", "x", "password-1")

    def test_limits(self):
        for bad in ("", "a b.com", "ftp://x.com", "https://user:pw@x.com", "*.x.com", "-x.com"):
            with self.assertRaises(LoginError, msg=bad):
                bot_logins.create(bad, "u", "password-1")
        with self.assertRaises(LoginError):
            bot_logins.create("x.com", "u", "p" * 1025)
        with self.assertRaises(LoginError):
            bot_logins.create("x.com", "u", "password-1", bots=["nope"])


class Hosts(unittest.TestCase):
    def setUp(self):
        wipe()

    def test_exact_hosts_and_subdomains(self):
        loose = bot_logins.create("example.com", "a", "password-1")
        exact = bot_logins.create("shop.example.com", "b", "password-2", exact_host=True)
        self.assertEqual([r["username"] for r in bot_logins.usable_for("example.com", BOT_A)], ["a"])
        self.assertEqual([r["username"] for r in bot_logins.usable_for("login.example.com", BOT_A)], ["a"], "a subdomain matches unless exact")
        self.assertEqual({r["username"] for r in bot_logins.usable_for("shop.example.com", BOT_A)}, {"a", "b"})
        self.assertEqual([r["username"] for r in bot_logins.usable_for("deep.shop.example.com", BOT_A)], ["a"], "exact host never matches a subdomain")
        self.assertEqual(bot_logins.usable_for("evil-example.com", BOT_A), [], "a lookalike is not a subdomain")
        self.assertEqual(bot_logins.usable_for("example.com.evil.net", BOT_A), [])
        self.assertEqual(bot_logins.usable_for("com", BOT_A), [])
        self.assertTrue(loose and exact)

    def test_punycode_and_ports_normalise(self):
        row = bot_logins.create("https://Bücher.example:8443/path", "u", "password-1")
        self.assertEqual(row["site"], "xn--bcher-kva.example")

    def test_ip_addresses_never_match_as_a_suffix(self):
        bot_logins.create("10.0.0.5", "u", "password-1")
        self.assertEqual(len(bot_logins.usable_for("10.0.0.5", BOT_A)), 1)
        self.assertEqual(bot_logins.usable_for("1.10.0.0.5", BOT_A), [])

    def test_bot_grants_all_or_listed_and_a_deleted_bot_leaves_the_lists(self):
        everyone = bot_logins.create("a.com", "u", "password-1")
        listed = bot_logins.create("b.com", "u", "password-2", bots=[BOT_A, BOT_B])
        self.assertEqual(len(bot_logins.usable_for("a.com", BOT_B)), 1)
        self.assertEqual(bot_logins.usable_for("b.com", "ffffffffff"), [])
        self.assertEqual(bot_logins.forget_bot(BOT_A), 1)
        self.assertEqual(bot_logins.usable_for("b.com", BOT_A), [])
        self.assertEqual(len(bot_logins.usable_for("b.com", BOT_B)), 1)
        self.assertEqual(bot_logins.get(everyone["id"])["bots"], "all", "an all-bots login is untouched")
        self.assertTrue(bot_logins.get(listed["id"]), "the login itself stays")


class Filling(unittest.TestCase):
    def setUp(self):
        wipe()
        self.login = bot_logins.create("example.com", "dana", PASSWORD, totp=SEED, bots=[BOT_A])

    def test_a_filled_login_returns_values_to_the_harness_and_holds_them(self):
        filled = bot_logins.resolve_fill(self.login["id"], BOT_A, "login.example.com", ["login.example.com", "example.com"], now=1_000_000)
        self.assertEqual((filled["username"], filled["password"]), ("dana", PASSWORD))
        self.assertRegex(filled["code"], r"^\d{6}$")
        self.assertEqual(filled["code"], bot_logins.totp_code(bot_logins.clean_totp(SEED), 1_000_000))
        self.assertEqual(held.scrub(f"the password is {PASSWORD} and the code {filled['code']}"), "the password is [saved password] and the code [one-time code]")
        self.assertIsNotNone(bot_logins.get(self.login["id"])["last_used"])

    def test_another_bot_gets_nothing_and_cannot_tell_the_login_exists(self):
        with self.assertRaises(LoginRefused) as raised:
            bot_logins.resolve_fill(self.login["id"], BOT_B, "example.com")
        with self.assertRaises(LoginRefused) as missing:
            bot_logins.resolve_fill("nosuchlogin", BOT_A, "example.com")
        self.assertEqual(str(raised.exception), str(missing.exception))

    def test_a_different_top_level_host_needs_the_persons_confirmation(self):
        with self.assertRaises(LoginRefused) as raised:
            bot_logins.resolve_fill(self.login["id"], BOT_A, "evil.net")
        self.assertTrue(raised.exception.needs_confirmation)
        confirmed = bot_logins.resolve_fill(self.login["id"], BOT_A, "evil.net", confirmed_cross_site=True)
        self.assertTrue(confirmed["cross_site"])

    def test_a_frame_from_another_host_counts_even_when_the_top_level_matches(self):
        with self.assertRaises(LoginRefused) as raised:
            bot_logins.resolve_fill(self.login["id"], BOT_A, "example.com", ["example.com", "pay.thirdparty.io"])
        self.assertTrue(raised.exception.needs_confirmation)

    def test_a_redirect_lands_on_the_real_host_which_is_what_is_checked(self):
        # The harness passes the page's actual host after any redirect, never the address that was typed.
        with self.assertRaises(LoginRefused):
            bot_logins.resolve_fill(self.login["id"], BOT_A, "example.com.attacker.net")

    def test_totp_options(self):
        seed = bot_logins.clean_totp({"secret": "jbsw y3dp-ehpk 3pxp", "algorithm": "sha256", "digits": 8, "period": 60})
        self.assertEqual(seed, {"secret": SEED, "algorithm": "SHA256", "digits": 8, "period": 60})
        self.assertEqual(len(bot_logins.totp_code(seed, 59)), 8)
        uri = bot_logins.clean_totp(f"otpauth://totp/Acme:dana?secret={SEED}&digits=6&period=30&algorithm=SHA1")
        self.assertEqual(uri["secret"], SEED)
        # RFC 6238's SHA1 test vector: time 59 gives 94287082 as eight digits (secret "12345678901234567890").
        rfc = bot_logins.clean_totp({"secret": base64.b32encode(b"12345678901234567890").decode(), "digits": 8})
        self.assertEqual(bot_logins.totp_code(rfc, 59), "94287082")
        for bad in ({"secret": SEED, "digits": 5}, {"secret": SEED, "period": 5}, {"secret": SEED, "algorithm": "MD5"}, "not base32!", "otpauth://hotp/x?secret=" + SEED):
            with self.assertRaises(LoginError, msg=str(bad)):
                bot_logins.clean_totp(bad)


class Scrubbing(unittest.TestCase):
    def setUp(self):
        wipe()
        bot_logins.create("example.com", "dana", PASSWORD, totp=SEED)

    def test_saved_passwords_are_scrubbed_in_every_encoding(self):
        raw = PASSWORD.encode()
        spellings = {
            "plain": PASSWORD, "json": json.dumps({"p": PASSWORD}), "url": "q=" + quote(PASSWORD), "hex": raw.hex(),
            "base64": base64.b64encode(raw).decode(), "base64 urlsafe": base64.urlsafe_b64encode(raw).decode(),
            "embedded base64 (1)": base64.b64encode(b"x" + raw + b"yz").decode(), "embedded base64 (2)": base64.b64encode(b"xy" + raw + b"z").decode(),
            "html": f"<input value='{PASSWORD}'>", "seed": SEED,
        }
        for label, text in spellings.items():
            clean = held.scrub(f"page said: {text}")
            self.assertNotIn(PASSWORD, clean, label)
            self.assertNotIn(SEED, clean, label)
            self.assertNotIn(raw.hex(), clean, label)
            self.assertNotIn(base64.b64encode(raw).decode(), clean, label)
            self.assertNotEqual(clean, f"page said: {text}", label)

    def test_nested_results_and_unrelated_text(self):
        value = {"a": [f"x {PASSWORD}", {"b": PASSWORD}], "n": 5, "ok": "nothing secret here"}
        out = held.scrub_value(value)
        self.assertNotIn(PASSWORD, json.dumps(out))
        self.assertEqual(out["ok"], "nothing secret here")
        self.assertEqual(out["n"], 5)

    def test_a_code_is_scrubbed_only_while_it_is_recent(self):
        now = [1000.0]
        from core.bot_held_secrets import HeldSecrets
        clock = HeldSecrets(clock=lambda: now[0])
        clock.hold_code("482913")
        self.assertEqual(clock.scrub("code 482913"), "code [one-time code]")
        now[0] += 400
        self.assertEqual(clock.scrub("code 482913"), "code 482913")

    def test_a_broken_source_cannot_open_a_leak_or_break_a_turn(self):
        from core.bot_held_secrets import HeldSecrets
        fresh = HeldSecrets()
        fresh.add_source(lambda: (_ for _ in ()).throw(RuntimeError("boom")))
        fresh.hold("secret-value-1")
        self.assertEqual(fresh.scrub("a secret-value-1 b"), "a [saved password] b")


class BackupExclusion(unittest.TestCase):
    def setUp(self):
        wipe()
        self.login = bot_logins.create("example.com", "dana", PASSWORD, totp=SEED)
        self.zips = []

    def make(self, include_keys):
        target = os.path.join(_DATA.name, f"backup-{include_keys}.zip")
        backup.make_backup(target, include_keys=include_keys)
        self.zips.append(target)
        with zipfile.ZipFile(target) as archive:
            return archive, target

    def test_neither_the_logins_nor_their_key_are_in_a_backup_even_with_keys(self):
        for include_keys in (False, True):
            target = os.path.join(_DATA.name, f"b{include_keys}.zip")
            backup.make_backup(target, include_keys=include_keys)
            with zipfile.ZipFile(target) as archive:
                names = archive.namelist()
                blob = b"".join(archive.read(n) for n in names)
            self.assertFalse([n for n in names if SECRET_FOLDER in n or n.endswith(("login.key", "logins.enc"))], names)
            self.assertNotIn(PASSWORD.encode(), blob)
            self.assertNotIn((Path(_DATA.name) / SECRET_FOLDER / "login.key").read_bytes().strip(), blob)
            self.assertNotIn((Path(_DATA.name) / SECRET_FOLDER / "logins.enc").read_bytes(), blob)

    def test_a_backup_that_carries_logins_is_refused(self):
        target = os.path.join(_DATA.name, "forged.zip")
        backup.make_backup(target)
        with zipfile.ZipFile(target, "a") as archive:
            archive.writestr(f"{SECRET_FOLDER}/logins.enc", b"planted")
            archive.writestr(f"{SECRET_FOLDER}/login.key", b"planted")
        with self.assertRaises(backup.BackupRefused):
            backup.check_backup(target)
        with self.assertRaises(backup.BackupRefused):
            backup.stage_restore(target)

    def test_a_restore_keeps_this_installs_logins_and_key(self):
        target = os.path.join(_DATA.name, "clean.zip")
        backup.make_backup(target, include_keys=True)
        before = {n: (Path(_DATA.name) / SECRET_FOLDER / n).read_bytes() for n in ("login.key", "logins.enc")}
        backup.stage_restore(target)
        result = backup.apply_pending_restore(_DATA.name)
        self.assertTrue(result and result["ok"], result)
        after = {n: (Path(_DATA.name) / SECRET_FOLDER / n).read_bytes() for n in ("login.key", "logins.enc")}
        self.assertEqual(before, after, "a restore never replaces, removes or adds logins")
        bot_logins.reset_cache()
        self.assertEqual(bot_logins.resolve_fill(self.login["id"], BOT_A, "example.com")["password"], PASSWORD)

    def test_the_settings_export_and_import_never_carry_logins(self):
        exported = json.dumps(system_admin.export_backup())
        self.assertNotIn(PASSWORD, exported)
        self.assertNotIn("dana", exported, "no login rows in the export")
        imported = system_admin.import_backup({"logins": [{"site": "evil.com", "username": "x", "password": "planted-1"}], "bot-secrets": {"x": 1}})
        self.assertEqual(imported, {"settings": 0, "notes": 0, "tasks": 0, "skills": 0})
        self.assertEqual([r["site"] for r in bot_logins.list_logins()], ["example.com"])


class FakeDriver:
    """The contained computer's driver: answers state, login_fields and fill_login from a script."""

    def __init__(self, url, fields, frames=None, opaque=False):
        self.stdin, self.stdout, self.stderr = self, asyncio.StreamReader(), asyncio.StreamReader()
        self.stderr.feed_eof()
        self.returncode, self.calls, self.buffer = None, [], b""
        self.url, self.fields, self.frames, self.opaque, self.fail_fill = url, fields, frames or [url], opaque, None

    def write(self, data):
        self.buffer += data

    async def drain(self):
        for line in self.buffer.splitlines():
            command = json.loads(line)
            if "driver" in command:
                continue
            self.calls.append(command)
            self.stdout.feed_data((json.dumps(self.reply(command)) + "\n").encode())
        self.buffer = b""

    def reply(self, command):
        action, out = command["action"], {"id": command["id"]}
        if action == "state":
            out.update(url=self.url, title="Sign in")
        elif action == "login_fields":
            out.update(url=self.url, frames=self.frames, fields=self.fields, opaque=self.opaque)
        elif action == "fill_login":
            if self.fail_fill:
                out["error"] = self.fail_fill
            else:
                out.update(url=self.url, filled=[k for k in ("username", "password", "code") if command["values"].get(k)])
        elif action == "read":
            out.update(url=self.url, title="Sign in", text="page", elements=[{"ref": "1", "label": "Password", "value": f"echo {PASSWORD}"}])
        else:
            out.update(url=self.url, title="Sign in")
        return out

    def close(self):
        self.returncode = 0

    async def wait(self):
        return 0

    def kill(self):
        self.returncode = -9


FIELDS = [{"kind": "username", "frame": 0, "index": 0, "label": "Email"}, {"kind": "password", "frame": 0, "index": 1, "label": "Password"}]


class ComputerFilling(unittest.IsolatedAsyncioTestCase):
    """core/computer.py's fill_login: the harness fills, checks the real host and frames, never submits, never tells a model the values."""

    def setUp(self):
        wipe()
        self.login = bot_logins.create("example.com", "dana", PASSWORD, totp=SEED, bots=[BOT_A])
        self.ctx = SimpleNamespace(permission_surface="chat:test", is_admin=True, turn_taint=None)

    async def started(self, driver, hosts=("login.example.com",)):
        manager = computer.ComputerManager(process_factory=None)
        c = computer.Computer("chat:test", driver, "test-computer", last_action=0, hosts=set(hosts))
        c.reader_task = asyncio.create_task(manager._read(c))
        manager._computers["chat:test"] = c
        self.addAsyncCleanup(self.finish, manager, driver, c)
        return manager

    async def finish(self, manager, driver, c):
        manager._computers.pop("chat:test", None)
        driver.stdout.feed_eof()
        await asyncio.sleep(0)
        c.reader_task.cancel()

    async def test_the_harness_fills_username_password_and_code_and_submits_nothing(self):
        driver = FakeDriver("https://login.example.com/signin", FIELDS + [{"kind": "code", "frame": 0, "index": 2, "label": "Code"}])
        manager = await self.started(driver)
        result = await manager.fill_login("chat:test", BOT_A, self.login["id"], self.ctx)
        self.assertIn("Filled username, password, code for the saved login at example.com", result["text"])
        self.assertIn("Nothing was submitted", result["text"])
        self.assertNotIn(PASSWORD, json.dumps(result))
        fill = next(c for c in driver.calls if c["action"] == "fill_login")
        self.assertEqual(fill["values"]["password"], PASSWORD, "the values cross to the driver only")
        self.assertEqual(fill["expected_url"], "https://login.example.com/signin")
        self.assertEqual(fill["expected_frames"], ["https://login.example.com/signin"])
        self.assertEqual({c["action"] for c in driver.calls}, {"state", "login_fields", "fill_login"}, "no click, key or submit")

    async def test_a_page_that_echoes_the_password_is_scrubbed_before_a_model_sees_it(self):
        driver = FakeDriver("https://login.example.com/signin", FIELDS)
        manager = await self.started(driver)
        await manager.fill_login("chat:test", BOT_A, self.login["id"], self.ctx)
        shown = await manager.act("chat:test", "read", {}, self.ctx)
        self.assertNotIn(PASSWORD, json.dumps(shown, default=str))
        self.assertIn("[saved password]", json.dumps(shown["state"]))

    async def test_another_bot_and_unknown_logins_are_refused_alike(self):
        driver = FakeDriver("https://login.example.com/signin", FIELDS)
        manager = await self.started(driver)
        other = await manager.fill_login("chat:test", BOT_B, self.login["id"], self.ctx)
        missing = await manager.fill_login("chat:test", BOT_A, "nosuchlogin", self.ctx)
        self.assertEqual(other["text"], missing["text"])
        self.assertNotIn("fill_login", [c["action"] for c in driver.calls])

    async def test_another_site_needs_the_persons_own_answer_not_an_automatic_one(self):
        for reason, behavior, expect_fill in (("Allowed by the owner.", "allow", True), ("Allowed by this chat's Auto mode.", "allow", False),
                                              ("Allowed: agents run in Auto mode.", "allow", False), ("refused by the owner.", "deny", False)):
            driver = FakeDriver("https://evil.net/login", FIELDS)
            manager = await self.started(driver, hosts=("evil.net",))
            asked = []

            async def decide(**kwargs):
                asked.append(kwargs)
                return permissions.Decision(behavior, reason)
            with patch.object(permissions, "decide", decide):
                result = await manager.fill_login("chat:test", BOT_A, self.login["id"], self.ctx)
            self.assertEqual(any(c["action"] == "fill_login" for c in driver.calls), expect_fill, reason)
            self.assertEqual(asked[0]["tool"], "computer_fill_login")
            self.assertTrue(asked[0]["force_prompt"], "the request is always put to a person")
            self.assertEqual([c["id"] for c in asked[0]["choices"]], ["once", "reject"])
            self.assertNotIn(PASSWORD, json.dumps(result))
            if not expect_fill:
                self.assertTrue(result["text"].startswith("Not filled:"), result["text"])
            await self.finish(manager, driver, manager._computers["chat:test"])

    async def test_a_frame_from_another_host_holding_the_fields_needs_confirmation(self):
        driver = FakeDriver("https://login.example.com/signin", [{**f, "frame": 1} for f in FIELDS],
                            frames=["https://login.example.com/signin", "https://pay.other.io/frame"])
        manager = await self.started(driver, hosts=("login.example.com", "pay.other.io"))
        seen = []

        async def decide(**kwargs):
            seen.append(kwargs["target"])
            return permissions.Decision("deny", "refused by the owner.")
        with patch.object(permissions, "decide", decide):
            result = await manager.fill_login("chat:test", BOT_A, self.login["id"], self.ctx)
        self.assertEqual(seen, ["login.example.com"])
        self.assertIn("did not confirm", result["text"])

    async def test_an_unreadable_frame_a_page_without_fields_and_a_person_in_control_all_refuse(self):
        driver = FakeDriver("https://login.example.com/signin", FIELDS, opaque=True)
        manager = await self.started(driver)
        self.assertIn("embedded frame", (await manager.fill_login("chat:test", BOT_A, self.login["id"], self.ctx))["text"])
        driver.opaque, driver.fields = False, []
        self.assertIn("no sign-in fields", (await manager.fill_login("chat:test", BOT_A, self.login["id"], self.ctx))["text"])
        driver.fields = FIELDS
        manager._computers["chat:test"].taken_over = True
        self.assertIn("person has control", (await manager.fill_login("chat:test", BOT_A, self.login["id"], self.ctx))["text"])
        self.assertNotIn("fill_login", [c["action"] for c in driver.calls])

    async def test_a_page_that_changed_before_typing_is_refused_by_the_driver_and_the_error_is_scrubbed(self):
        driver = FakeDriver("https://login.example.com/signin", FIELDS)
        driver.fail_fill = f"the page changed; check it again before filling ({PASSWORD})"
        manager = await self.started(driver)
        result = await manager.fill_login("chat:test", BOT_A, self.login["id"], self.ctx)
        self.assertTrue(result["text"].startswith("Not filled:"))
        self.assertNotIn(PASSWORD, result["text"])

    async def test_not_on_a_web_page_or_no_computer(self):
        manager = computer.ComputerManager(process_factory=None)
        self.assertIn("open the site", (await manager.fill_login("chat:none", BOT_A, self.login["id"], self.ctx))["text"])
        driver = FakeDriver("about:blank", FIELDS)
        manager = await self.started(driver)
        self.assertIn("not on a web page", (await manager.fill_login("chat:test", BOT_A, self.login["id"], self.ctx))["text"])

    def test_the_driver_source_compiles_and_its_fill_never_presses_anything(self):
        from core.computer_driver import SOURCE
        compile(SOURCE.replace("DESKTOP_APPS_MAPPING", "{}"), "driver", "exec")
        block = SOURCE[SOURCE.index("async def login_command"):SOURCE.index("async def execute")]
        for word in (".click(", "press(", "submit(", "requestSubmit", "keyboard"):
            self.assertNotIn(word, block)


class OnePassword(unittest.TestCase):
    def setUp(self):
        wipe()
        bot_onepassword.disconnect()
        self.calls = []

        def runner(args, env, timeout):
            self.calls.append((list(args), dict(env), timeout))
            token = env.get("OP_SERVICE_ACCOUNT_TOKEN")
            if token != "ops_good_token":
                return 1, ""
            if args[:2] == ["vault", "list"]:
                return 0, json.dumps([{"id": "v1", "name": "Work"}, {"id": "v2", "name": "Family"}])
            if args[:2] == ["item", "list"]:
                return 0, json.dumps([{"id": "i1", "additional_information": "dana@work.test", "urls": [{"href": "https://portal.example.org/login"}]}])
            if args[:2] == ["item", "get"]:
                return 0, json.dumps({"fields": [{"purpose": "USERNAME", "value": "dana@work.test"}, {"purpose": "PASSWORD", "value": "op-secret-Passw0rd"},
                                                 {"type": "OTP", "totp": "123456"}], "urls": [{"href": "https://portal.example.org/login"}]})
            return 1, ""
        bot_onepassword.set_runner(runner)
        self.addCleanup(bot_onepassword.set_runner, None)

    def test_connect_stores_the_token_sealed_and_each_vault_starts_with_no_bots(self):
        state = bot_onepassword.connect("ops_good_token")
        self.assertTrue(state["connected"])
        self.assertEqual([(v["name"], v["bots"]) for v in state["vaults"]], [("Work", []), ("Family", [])])
        raw = (Path(_DATA.name) / SECRET_FOLDER / "onepassword.json").read_bytes()
        self.assertNotIn(b"ops_good_token", raw)
        self.assertNotIn("ops_good_token", json.dumps(bot_onepassword.status()))

    def test_a_bad_token_is_refused_and_nothing_is_saved(self):
        with self.assertRaises(LoginError):
            bot_onepassword.connect("ops_wrong")
        self.assertFalse(bot_onepassword.status()["connected"])

    def test_items_appear_only_for_vaults_a_bot_may_use_and_passwords_are_read_at_fill_time(self):
        bot_onepassword.connect("ops_good_token")
        self.assertEqual(bot_logins.usable_for("portal.example.org", BOT_A), [])
        bot_onepassword.set_vault_bots("v1", [BOT_A])
        rows = bot_logins.usable_for("portal.example.org", BOT_A)
        self.assertEqual([(r["source"], r["site"], r["username"]) for r in rows], [("1password", "portal.example.org", "dana@work.test")])
        self.assertEqual(bot_logins.usable_for("portal.example.org", BOT_B), [])
        self.assertFalse(any(c[0][:2] == ["item", "get"] for c in self.calls), "no password is read until a fill")
        filled = bot_logins.resolve_fill(rows[0]["id"], BOT_A, "portal.example.org")
        self.assertEqual((filled["username"], filled["password"], filled["code"]), ("dana@work.test", "op-secret-Passw0rd", "123456"))
        self.assertEqual(held.scrub("pw op-secret-Passw0rd"), "pw [saved password]")
        with self.assertRaises(LoginRefused):
            bot_logins.resolve_fill(rows[0]["id"], BOT_B, "portal.example.org")
        with self.assertRaises(LoginRefused) as cross:
            bot_logins.resolve_fill(rows[0]["id"], BOT_A, "evil.net")
        self.assertTrue(cross.exception.needs_confirmation)

    def test_op_runs_with_fixed_arguments_and_no_other_secrets(self):
        bot_onepassword.connect("ops_good_token")
        self.assertTrue(all(isinstance(a, str) for c in self.calls for a in c[0]))
        self.assertEqual({k for c in self.calls for k in c[1]}, {"OP_SERVICE_ACCOUNT_TOKEN"})

    def test_missing_command_line_reports_unavailable(self):
        bot_onepassword.set_runner(None)
        from unittest.mock import patch
        with patch("shutil.which", return_value=None):
            state = bot_onepassword.status()
        self.assertFalse(state["available"])
        self.assertIn("not installed", state["reason"])


class Routes(unittest.TestCase):
    def setUp(self):
        wipe()

    def test_add_change_and_delete_over_http_with_masked_answers(self):
        made = web.post("/api/bots/logins", json={"site": "example.com", "username": "dana", "password": PASSWORD, "totp": SEED, "bots": [BOT_A]})
        self.assertEqual(made.status_code, 200, made.text)
        body = made.json()
        self.assertNotIn(PASSWORD, made.text)
        self.assertEqual((body["has_totp"], body["bots"]), (True, [BOT_A]))
        changed = web.patch(f"/api/bots/logins/{body['id']}", json={"exact_host": True, "bots": "all"})
        self.assertEqual((changed.status_code, changed.json()["exact_host"], changed.json()["bots"]), (200, True, "all"))
        self.assertEqual(web.patch(f"/api/bots/logins/{body['id']}", json={"totp": None}).json()["has_totp"], False)
        self.assertEqual(web.patch(f"/api/bots/logins/{body['id']}", json={"password": ""}).status_code, 200)
        self.assertEqual(web.post("/api/bots/logins", json={"site": "example.com", "username": "dana", "password": "x" * 8}).status_code, 409)
        self.assertEqual(web.post("/api/bots/logins", json={"site": "x.com", "username": "u", "password": "password-1", "surprise": 1}).status_code, 422)
        self.assertEqual(web.delete(f"/api/bots/logins/{body['id']}").status_code, 200)
        self.assertEqual(web.delete(f"/api/bots/logins/{body['id']}").status_code, 404)

    def test_onepassword_routes_come_before_the_login_id_routes(self):
        self.assertEqual(web.get("/api/bots/logins/onepassword").status_code, 200)
        self.assertIn("connected", web.get("/api/bots/logins/onepassword").json())


if __name__ == "__main__":
    unittest.main()
