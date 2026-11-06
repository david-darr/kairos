"""Library Vault Polish (locked 2026-10-22): the vault routes against a
throwaway fixture vault. Never touches a real vault: JARVIS_DATA_DIR and
JARVIS_VAULT_DIR point into a temp folder before anything is imported.

    .venv\\Scripts\\python.exe scripts\\test_vault_routes.py
"""
import asyncio
import hashlib
import os
import sys
import time
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.tab_test_support import TemporaryDirectory

_DATA = TemporaryDirectory(prefix=".tab-test-vault-", dir=str(Path(__file__).resolve().parent))
VAULT = Path(_DATA.name) / "vault"
os.environ["JARVIS_DATA_DIR"] = _DATA.name
os.environ["JARVIS_VAULT_DIR"] = str(VAULT)

from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from core import file_checkpoints, middleware, settings, vault_graph, vault_library
from core.auth import auth_manager
from routes import vault_routes

assert Path(vault_graph.resolve_vault_dir()).resolve() == VAULT.resolve(), "tests must run against the temp vault"

TEMPLATE = """---
status: active
project: personal
type: log
created: {{date:YYYY-MM-DD}}
---

# {{Day of week}}, {{Month}} {{Day}}, {{Year}}

## Index
- **Session topic name**
"""


def write(rel, text, raw=None):
    path = VAULT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw if raw is not None else text.encode("utf-8"))
    return path


def build_fixture():
    import shutil
    if VAULT.exists():
        shutil.rmtree(VAULT)
    VAULT.mkdir()
    write("Vault Index.md", "---\nstatus: active\nproject: meta\ntype: index\n---\n# Vault Index\n\n"
          "See [[Projects/Alpha]] and [[Beta|the beta note]] and [[Alpha#Goals]].\n"
          "Missing: [[Nowhere Note]]. Image: ![[diagram.png]]. Embed: ![[Beta]].\n"
          "```\n[[Inside Code]]\n```\nInline `[[Also Code]]`.\n")
    write("Projects/Alpha.md", "---\nstatus: draft\nproject: kairos\ntype: plan\ntags: [one, two]\nowner: David\n"
          "nested:\n  key: value\n---\n# Alpha\n\nThe quartz harmonica protocol lives here. Links to [[Gamma]].\n")
    write("Projects/Beta.md", "No frontmatter, a lone note about quartz harmonica tuning.\n")
    write("Archive/Gamma.md", "---\nstatus: done\n---\nGamma body. [[Projects/Alpha|back to alpha]]\n")
    write("Archive/Alpha.md", "A second note named Alpha, deeper, never the basename winner.\n")
    write("Orphan.md", "---\nstatus: active\nproject: misc\ntype: note\n---\nNothing links here.\n")
    write("CRLF.md", "", raw="---\r\nstatus: active\r\n---\r\nline one\r\nline two\r\n".encode())
    write("BOM.md", "", raw=b"\xef\xbb\xbf# BOM note\nbody\n")
    write("Latin.md", "", raw="caf\xe9 au lait\n".encode("latin-1"))
    write("01 - Daily Notes/01 - Daily Notes.md", "---\nstatus: active\ntype: index\n---\n# Daily Notes\n\n"
          "- [[Daily Note Template]]: required structure.\n- [[2026-10-20]]: daily session log.\n- [[2026-10-21]]: daily session log.\n\nTrailing text.\n")
    write("01 - Daily Notes/Daily Note Template.md", TEMPLATE)
    write("01 - Daily Notes/2026-10-20.md", "# Tuesday\n")
    write("01 - Daily Notes/2026-10-21.md", "# Wednesday\n")


def principal(request: Request):
    return request.headers.get("x-test-user", "admin")


class VaultRouteTests(unittest.TestCase):
    def setUp(self):
        build_fixture()
        self.source = Path(_DATA.name) / ("source-" + self.id().rsplit(".", 1)[-1])
        self.source.mkdir(exist_ok=True)
        self.patches = [
            patch.object(file_checkpoints, "STORE", Path(_DATA.name) / ("cp-" + self.id().rsplit(".", 1)[-1])),
            patch.object(file_checkpoints, "BASE_DIR", str(self.source)),
            patch.object(middleware, "get_current_user", principal),
            patch.object(auth_manager, "is_admin", lambda user: user == "admin"),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)
        settings.update_settings(vault_pins={})
        app = FastAPI()
        app.include_router(vault_routes.router)
        self.client = TestClient(app)

    def get(self, url, user="admin", **params):
        return self.client.get(url, params=params, headers={"x-test-user": user})

    def note(self, path, user="admin"):
        response = self.get("/api/vault/note", user, path=path)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def save(self, path, content, version, user="admin", **extra):
        return self.client.post("/api/vault/note", json={"path": path, "content": content, "version": version, **extra},
                                headers={"x-test-user": user})

    # -- graph and resolver ---------------------------------------------------
    def test_graph_resolves_path_alias_heading_and_embed_links(self):
        graph = self.get("/api/vault/graph").json()
        links = {(e["source"], e["target"]) for e in graph["edges"] if e["kind"] == "link"}
        self.assertIn(("Vault Index.md", "Projects/Alpha.md"), links, "[[Folder/Note]] resolves by exact path")
        self.assertIn(("Vault Index.md", "Projects/Beta.md"), links, "[[Note|alias]] and ![[embed]] resolve")
        self.assertIn(("Archive/Gamma.md", "Projects/Alpha.md"), links, "[[Folder/Note|alias]] resolves")
        self.assertIn(("Projects/Alpha.md", "Archive/Gamma.md"), links)
        # [[Alpha#Goals]] picks the shallowest Alpha, not Archive/Alpha.md.
        self.assertNotIn(("Vault Index.md", "Archive/Old/Alpha.md"), links)
        missing = {(m["source"], m["target"]) for m in graph["missing"]}
        self.assertEqual(missing, {("Vault Index.md", "Nowhere Note")}, "attachments and code are not missing links")
        self.assertFalse(any("Code" in t for _, t in links | missing))

    def test_graph_nodes_carry_meta_frontmatter_and_daily_flag(self):
        nodes = {n["id"]: n for n in self.get("/api/vault/graph").json()["nodes"]}
        alpha = nodes["Projects/Alpha.md"]
        self.assertEqual(alpha["frontmatter"], {"status": "draft", "project": "kairos", "type": "plan",
                                                "tags": ["one", "two"], "owner": "David"})
        self.assertTrue(alpha["has_frontmatter"])
        self.assertGreater(alpha["mtime"], 0)
        self.assertGreater(alpha["size"], 0)
        self.assertGreater(alpha["words"], 5)
        self.assertNotIn("frontmatter", nodes["Projects/Beta.md"])
        self.assertFalse(nodes["Projects/Beta.md"]["has_frontmatter"])
        self.assertTrue(nodes["01 - Daily Notes/2026-10-21.md"]["daily"])
        self.assertFalse(nodes["Orphan.md"]["daily"])

    def test_frontmatter_parser_never_fails(self):
        self.assertEqual(vault_graph.parse_frontmatter("a: [x, 'y']\nb:\n  - one\n  - two\nc: |\n  multi\nd: \"q\""),
                         {"a": ["x", "y"], "b": ["one", "two"], "d": "q"})
        self.assertEqual(vault_graph.parse_frontmatter(": broken\n\t- odd\n{x}"), {})
        write("Weird.md", "---\nkey: [unclosed\n: :\n---\nbody\n")
        self.assertIn("Weird.md", {n["id"] for n in self.get("/api/vault/graph").json()["nodes"]})

    def test_graph_is_cached_until_a_note_changes(self):
        first = vault_graph.build_vault_graph()
        self.assertIs(vault_graph.build_vault_graph(), first, "an unchanged vault is not re-read")
        time.sleep(0.02)
        write("Orphan.md", "---\nstatus: active\n---\nNow links to [[Beta]].\n")
        second = vault_graph.build_vault_graph()
        self.assertIsNot(second, first)
        self.assertIn(("Orphan.md", "Projects/Beta.md"), {(e["source"], e["target"]) for e in second["edges"] if e["kind"] == "link"})

    def test_note_read_has_version_links_and_edit_rights(self):
        note = self.note("Vault Index.md")
        raw = (VAULT / "Vault Index.md").read_bytes()
        self.assertEqual(note["version"], hashlib.sha1(raw).hexdigest())
        self.assertTrue(note["can_edit"])
        by_raw = {link["raw"]: link for link in note["links"]}
        self.assertEqual(by_raw["Projects/Alpha"]["id"], "Projects/Alpha.md")
        self.assertEqual(by_raw["Beta|the beta note"]["alias"], "the beta note")
        self.assertEqual(by_raw["Alpha#Goals"]["heading"], "Goals")
        self.assertEqual(by_raw["Nowhere Note"]["kind"], "missing")
        self.assertEqual(by_raw["diagram.png"]["kind"], "attachment")
        self.assertTrue(by_raw["Beta"]["embed"])
        self.assertNotIn("Inside Code", by_raw)
        alpha = self.note("Projects/Alpha.md")
        contexts = {b["id"]: b["snippet"] for b in alpha["backlinks"]}
        self.assertEqual(contexts["Archive/Gamma.md"], "Gamma body. [[Projects/Alpha|back to alpha]]")
        self.assertTrue(contexts["Vault Index.md"].startswith("See [[Projects/Alpha]]"))
        crlf = self.note("CRLF.md")
        self.assertNotIn("\r", crlf["content"])
        self.assertEqual(crlf["line_ending"], "crlf")
        self.assertTrue(self.note("BOM.md")["bom"])
        self.assertFalse(self.note("BOM.md")["content"].startswith("﻿"))

    def test_reads_refuse_paths_outside_the_vault(self):
        for path in ("../secret.md", "..\\secret.md", str(VAULT.parent / "x.md"), "Projects", "nope.md"):
            self.assertEqual(self.get("/api/vault/note", path=path).status_code, 404, path)

    # -- safe save -------------------------------------------------------------
    def test_save_after_an_outside_edit_returns_409_and_loses_nothing(self):
        opened = self.note("Projects/Alpha.md")
        outside = opened["content"] + "\nAdded in Obsidian.\n"
        (VAULT / "Projects/Alpha.md").write_bytes(outside.encode("utf-8"))
        response = self.save("Projects/Alpha.md", opened["content"] + "\nMy edit.\n", opened["version"])
        self.assertEqual(response.status_code, 409)
        body = response.json()
        self.assertEqual(body["code"], "version_conflict")
        self.assertEqual(body["current_version"], hashlib.sha1(outside.encode()).hexdigest())
        self.assertEqual((VAULT / "Projects/Alpha.md").read_bytes(), outside.encode("utf-8"), "the outside edit survives")
        self.assertEqual(file_checkpoints.list_events(), [], "a refused save records nothing")

    def test_save_keeps_crlf_and_bom_and_is_checkpointed_and_restorable(self):
        opened = self.note("CRLF.md")
        response = self.save("CRLF.md", opened["content"].replace("line two", "line 2"), opened["version"])
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual((VAULT / "CRLF.md").read_bytes(), b"---\r\nstatus: active\r\n---\r\nline one\r\nline 2\r\n")
        self.assertEqual(response.json()["version"], hashlib.sha1((VAULT / "CRLF.md").read_bytes()).hexdigest())
        bom = self.note("BOM.md")
        self.assertEqual(self.save("BOM.md", bom["content"] + "more\n", bom["version"]).status_code, 200)
        self.assertEqual((VAULT / "BOM.md").read_bytes(), b"\xef\xbb\xbf# BOM note\nbody\nmore\n")
        self.assertEqual(sorted(p.name for p in VAULT.iterdir() if p.name.startswith(".kairos-save-")), [], "no temp files left")
        # It shows in Settings > File checkpoints like a model turn...
        events = file_checkpoints.list_events()
        self.assertEqual([e["source"] for e in events], ["library:admin", "library:admin"])
        crlf_event = next(e for e in events if e["roots"][0]["changes"][0]["path"] == "CRLF.md")
        full = file_checkpoints.get_event(crlf_event["id"])
        self.assertIn("-line two", full["roots"][0]["changes"][0]["diff"])
        # ...and restores like one.
        root = str(VAULT.resolve())
        file_checkpoints.restore(crlf_event["id"], [{"root": root, "path": "CRLF.md"}])
        self.assertEqual((VAULT / "CRLF.md").read_bytes(), b"---\r\nstatus: active\r\n---\r\nline one\r\nline two\r\n")

    def test_restore_refuses_after_a_later_edit(self):
        opened = self.note("Orphan.md")
        self.assertEqual(self.save("Orphan.md", opened["content"] + "first\n", opened["version"]).status_code, 200)
        event = file_checkpoints.list_events()[0]
        (VAULT / "Orphan.md").write_text("changed again elsewhere\n", encoding="utf-8")
        with self.assertRaisesRegex(file_checkpoints.Conflict, "Changed since checkpoint"):
            file_checkpoints.restore(event["id"], [{"root": str(VAULT.resolve()), "path": "Orphan.md"}])
        history = self.get("/api/vault/activity", path="Orphan.md").json()
        self.assertEqual(history["entries"][0]["restore_state"], "changed_since")
        self.assertEqual(history["outside"]["label"], "Edited outside Kairos")

    def test_a_non_admin_works_in_their_own_vault(self):
        # Every account has its own vault (Multi-Account group 2), so phase 4b lets any signed-in person edit,
        # create today's note and see what changed in theirs; the vault the route reaches is the caller's.
        note = self.note("Projects/Alpha.md", user="bob")
        self.assertTrue(note["can_edit"])
        self.assertIn("last_change", note)
        saved = self.save("Projects/Alpha.md", note["content"] + "Bob was here.", note["version"], user="bob")
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertIn("Bob was here.", (VAULT / "Projects/Alpha.md").read_text(encoding="utf-8"))
        self.assertNotEqual(self.client.post("/api/vault/daily", headers={"x-test-user": "bob"}).status_code, 403)
        self.assertEqual(self.get("/api/vault/activity", user="bob").status_code, 200)
        self.assertTrue(self.get("/api/vault/daily", user="bob").json()["can_create"])
        self.assertEqual(self.get("/api/vault/graph", user="bob").status_code, 200)
        self.assertEqual(self.get("/api/vault/search", user="bob", q="quartz").status_code, 200)

    def test_save_needs_a_version_and_an_existing_utf8_note(self):
        note = self.note("Orphan.md")
        self.assertEqual(self.save("Orphan.md", "x", "").status_code, 400)
        self.assertEqual(self.save("New Note.md", "x", note["version"]).status_code, 404, "save never creates")
        latin = self.note("Latin.md")
        self.assertFalse(latin["editable"])
        self.assertFalse(latin["can_edit"])
        self.assertEqual(self.save("Latin.md", "cafe", latin["version"]).status_code, 400)
        self.assertEqual((VAULT / "Latin.md").read_bytes(), "caf\xe9 au lait\n".encode("latin-1"))

    def test_removing_the_properties_block_needs_confirmation(self):
        note = self.note("Orphan.md")
        _, body = vault_graph.split_frontmatter(note["content"])
        refused = self.save("Orphan.md", body, note["version"])
        self.assertEqual(refused.status_code, 409)
        self.assertEqual(refused.json()["code"], "properties_removed")
        self.assertTrue((VAULT / "Orphan.md").read_text().startswith("---"))
        self.assertEqual(self.save("Orphan.md", body, note["version"], allow_remove_properties=True).status_code, 200)
        self.assertFalse((VAULT / "Orphan.md").read_text().startswith("---"))

    # -- finding things -----------------------------------------------------------
    def test_search_finds_a_phrase_inside_a_body_with_marks(self):
        body = self.get("/api/vault/search", q="harmonica protocol").json()
        self.assertEqual(body["results"][0]["path"], "Projects/Alpha.md")
        open_mark, close_mark = body["mark"]
        self.assertIn(open_mark + "harmonica" + close_mark, body["results"][0]["snippet"])
        self.assertEqual(self.get("/api/vault/search", q="").json()["results"], [])

    def test_related_uses_keywords_and_skips_linked_notes(self):
        results = self.get("/api/vault/related", path="Projects/Beta.md").json()["results"]
        paths = [r["path"] for r in results]
        self.assertNotIn("Projects/Beta.md", paths)
        self.assertNotIn("Vault Index.md", paths, "a note linking here is not 'related'")
        self.assertIn("Projects/Alpha.md", paths, "shares 'quartz harmonica'")

    def test_pins_are_per_user_and_validated(self):
        put = self.client.put("/api/vault/pins", json={"pins": ["Projects/Alpha.md", "Orphan.md", "Orphan.md"]},
                              headers={"x-test-user": "admin"})
        self.assertEqual(put.json()["pins"], ["Projects/Alpha.md", "Orphan.md"])
        self.assertEqual(self.get("/api/vault/pins").json()["pins"], ["Projects/Alpha.md", "Orphan.md"])
        self.assertEqual(self.get("/api/vault/pins", user="bob").json()["pins"], [])
        bad = self.client.put("/api/vault/pins", json={"pins": ["../../etc.md"]}, headers={"x-test-user": "bob"})
        self.assertEqual(bad.status_code, 400)

    # -- history --------------------------------------------------------------------
    def test_a_chat_turn_that_edits_a_note_shows_in_its_history(self):
        async def turn():
            async with file_checkpoints.around_turn("chat:s-42"):
                (VAULT / "Projects/Beta.md").write_text("Edited by the model.\n", encoding="utf-8")
        from core.session_manager import session_manager
        asyncio.run(turn())
        with patch.object(session_manager, "get_session", lambda sid: {"title": "Plan the week"} if sid == "s-42" else None):
            history = self.get("/api/vault/activity", path="Projects/Beta.md").json()
            recent = self.get("/api/vault/activity").json()["recent"]
        self.assertEqual(history["entries"][0]["label"], "Chat: Plan the week")
        self.assertEqual(history["entries"][0]["restore_state"], "available")
        self.assertEqual((history["entries"][0]["added"], history["entries"][0]["removed"]), (1, 1))
        self.assertIsNone(history["outside"])
        beta = next(r for r in recent if r["path"] == "Projects/Beta.md")
        self.assertEqual(beta["label"], "Chat: Plan the week")
        self.assertTrue(beta["kairos"])
        others = [r for r in recent if r["path"] != "Projects/Beta.md"]
        self.assertTrue(all(r["label"] == "Edited outside Kairos" for r in others))
        self.assertEqual(vault_library.source_label("task:triage-email", "admin"), "Email triage")
        self.assertEqual(vault_library.source_label("library:admin", "admin"), "You, in Library")
        self.assertEqual(vault_library.source_label("library:bob", "admin"), "bob, in Library")

    # -- today's note ------------------------------------------------------------------
    def test_todays_note_comes_from_the_template_and_never_overwrites(self):
        today = datetime(2026, 10, 22, 9, 30)
        with patch.object(vault_routes, "datetime") as clock:
            clock.now.return_value = today
            status = self.get("/api/vault/daily").json()
            self.assertEqual(status["path"], "01 - Daily Notes/2026-10-22.md")
            self.assertFalse(status["exists"])
            created = self.client.post("/api/vault/daily", headers={"x-test-user": "admin"}).json()
            self.assertTrue(created["created"])
            text = (VAULT / "01 - Daily Notes/2026-10-22.md").read_text(encoding="utf-8")
            self.assertIn("created: 2026-10-22", text)
            self.assertIn("# Thursday, October 22, 2026", text)
            proposal = created["index"]
            self.assertEqual(proposal["line"], "- [[2026-10-22]]: daily session log.")
            self.assertEqual(proposal["after"], "- [[2026-10-21]]: daily session log.")
            index_before = (VAULT / "01 - Daily Notes/01 - Daily Notes.md").read_text(encoding="utf-8")
            self.assertNotIn("2026-10-22", index_before, "the index line goes in only on a click")
            (VAULT / "01 - Daily Notes/2026-10-22.md").write_text("my notes\n", encoding="utf-8")
            again = self.client.post("/api/vault/daily", headers={"x-test-user": "admin"}).json()
            self.assertFalse(again["created"])
            self.assertEqual((VAULT / "01 - Daily Notes/2026-10-22.md").read_text(), "my notes\n", "never overwrites")
        applied = self.save(proposal["path"], proposal["content"], proposal["version"])
        self.assertEqual(applied.status_code, 200)
        index_after = (VAULT / "01 - Daily Notes/01 - Daily Notes.md").read_text(encoding="utf-8")
        self.assertIn("- [[2026-10-21]]: daily session log.\n- [[2026-10-22]]: daily session log.\n\nTrailing text.", index_after)
        self.assertIsNone(vault_graph.index_proposal("01 - Daily Notes", "01 - Daily Notes/2026-10-22.md"))
        self.assertEqual(file_checkpoints.list_events()[-1]["source"], "library:admin", "the create is checkpointed too")

    def test_todays_note_goes_into_the_current_month_folder(self):
        (VAULT / "01 - Daily Notes/09 - September 2026").mkdir()
        rel, created = vault_graph.create_daily_note("01 - Daily Notes/Daily Note Template.md", "01 - Daily Notes",
                                                     datetime(2026, 10, 3), "admin")
        self.assertTrue(created)
        self.assertEqual(rel, "01 - Daily Notes/10 - October 2026/2026-10-03.md")
        self.assertTrue((VAULT / rel).is_file())

    def test_obsidian_url_stays_in_the_vault(self):
        url = self.get("/api/vault/obsidian-url", path="Projects/Alpha.md").json()["url"]
        self.assertTrue(url.startswith("obsidian://open?path="))
        self.assertEqual(self.get("/api/vault/obsidian-url", path="../x.md").status_code, 404)
        self.assertEqual(self.get("/api/vault/obsidian-url", user="bob", path="Projects/Alpha.md").status_code, 200)


if __name__ == "__main__":
    unittest.main(verbosity=2)
