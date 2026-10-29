import json
import os
from pathlib import Path
import sqlite3
import struct
import sys
import unittest
from unittest.mock import patch
import zipfile
from contextlib import closing
from test_data_support import TestDataDirectory

ENV = TestDataDirectory("kairos-backups-")
os.environ["JARVIS_DATA_DIR"] = ENV.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core import backup
from services import bot_backup as service


class BackupTests(unittest.TestCase):
    def setUp(self):
        import uuid
        self.root = Path(ENV.name) / uuid.uuid4().hex; self.root.mkdir()
        self.out = Path(ENV.name) / (self.root.name + ".kbackup")
        self.patch = patch("core.backup._data_dir", return_value=str(self.root)); self.patch.start(); self.addCleanup(self.patch.stop)
        self.password = "a-long-test-password"
        (self.root / "agents.json").write_text('{"b1":{"name":"One"}}')
        (self.root / "tasks.json").write_text(json.dumps({"r1": {"id": "r1", "schedule_kind": "interval", "enabled": True, "next_run_at": 3, "routine": {"run_on_startup": True}}, "card": {"schedule_kind": "card", "status": "backlog"}}))
        (self.root / "triggers.json").write_text(json.dumps({"triggers": {"w1": {"id": "w1", "enabled": True}}, "pending": {"p1": {"status": "queued"}}}))
        (self.root / "task_runs.json").write_text('[{"status":"queued"}]')
        (self.root / "bot_app_triggers.json").write_text('[{"id":"a1","enabled":true}]')
        for folder in ("computer/profiles/b1", "bot-secrets"):
            (self.root / folder).mkdir(parents=True); (self.root / folder / "secret.txt").write_text("private")
        with closing(sqlite3.connect(self.root / "sessions.db")) as db, db:
            db.executescript("CREATE TABLE sessions(id TEXT); INSERT INTO sessions VALUES('s1'); CREATE TABLE bot_followups(state TEXT); INSERT INTO bot_followups VALUES('queued');")
        with closing(sqlite3.connect(self.root / "bot_automation_events.sqlite3")) as db, db:
            db.executescript("CREATE TABLE subscriptions(enabled INTEGER); INSERT INTO subscriptions VALUES(1); CREATE TABLE runs(status TEXT); INSERT INTO runs VALUES('queued');")

    def test_roundtrip_preview_no_stage_restore_disables_every_automation(self):
        service.export(self.password, self.out)
        info = service.preview(self.out, self.password, owner_user="owner")
        self.assertEqual(info["counts"], {"bots": 1, "routines": 1, "triggers": 1, "chats": 1})
        self.assertFalse((self.root / backup.RESTORE_DIR / backup.PENDING).exists())
        for confirm in ("replace", "", "YES"):
            with self.assertRaises(ValueError): service.restore(info["upload_id"], self.password, confirm, owner_user="owner")
        with patch.object(service, "server_busy", return_value=True):
            with self.assertRaisesRegex(ValueError, "running"): service.restore(info["upload_id"], self.password, "REPLACE", owner_user="owner")
        with patch.object(service, "server_busy", return_value=False):
            service.restore(info["upload_id"], self.password, "REPLACE", owner_user="owner")
        result = backup.apply_pending_restore(str(self.root))
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["automations_disabled"])
        self.assertFalse(json.loads((self.root / "tasks.json").read_text())["r1"]["enabled"])
        self.assertFalse(json.loads((self.root / "tasks.json").read_text())["r1"]["routine"]["run_on_startup"])
        self.assertFalse(json.loads((self.root / "triggers.json").read_text())["triggers"]["w1"]["enabled"])
        self.assertFalse(json.loads((self.root / "bot_app_triggers.json").read_text())[0]["enabled"])
        self.assertEqual(json.loads((self.root / "task_runs.json").read_text())[0]["status"], "failed")
        for filename, sql in (("sessions.db", "SELECT state FROM bot_followups"), ("bot_automation_events.sqlite3", "SELECT status FROM runs")):
            db = sqlite3.connect(self.root / filename)
            self.assertEqual(db.execute(sql).fetchone()[0], "failed"); db.close()
        self.assertFalse((self.root / "computer" / "profiles").exists())

    def test_wrong_password_tamper_limits_checked_before_key_derivation(self):
        service.export(self.password, self.out)
        with self.assertRaisesRegex(ValueError, "wrong|damaged"):
            service.preview(self.out, "another-long-password")
        raw = bytearray(self.out.read_bytes()); raw[-20] ^= 1; self.out.write_bytes(raw)
        with self.assertRaisesRegex(ValueError, "wrong|damaged"): service.preview(self.out, self.password)
        header = json.dumps({"format": "kairos.backup", "version": 1, "n": service.N, "r": 8, "p": 1,
                             "bytes": service.MAX_BYTES + 1, "entries": 1, "expanded_bytes": 0}).encode()
        self.out.write_bytes(service.MAGIC + struct.pack(">I", len(header)) + header)
        with patch.object(service, "_key", side_effect=AssertionError("must not derive")):
            with self.assertRaisesRegex(ValueError, "limit"): service.preview(self.out, self.password)

    def test_excluded_even_with_keys_and_restore_refuses_injected_secret(self):
        zip_path = self.root.parent / (self.root.name + ".zip")
        backup.make_backup(str(zip_path), include_keys=True)
        with zipfile.ZipFile(zip_path) as archive:
            self.assertFalse(any("profiles" in n or "bot-secrets" in n for n in archive.namelist()))
        with zipfile.ZipFile(zip_path, "a") as archive: archive.writestr("bot-secrets/secret.json", "{}")
        with self.assertRaises(backup.BackupRefused): backup.check_backup(str(zip_path))

    def test_post_restore_disable_failure_restores_safety_copy(self):
        zip_path = self.root.parent / (self.root.name + ".zip")
        backup.make_backup(str(zip_path)); backup.stage_restore(str(zip_path), disable_automations=True)
        (self.root / "marker.txt").write_text("current")
        with patch.object(backup, "disable_restored_automations", side_effect=ValueError("failed")):
            result = backup.apply_pending_restore(str(self.root))
        self.assertFalse(result["ok"]); self.assertEqual((self.root / "marker.txt").read_text(), "current")


if __name__ == "__main__": unittest.main()
