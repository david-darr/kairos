"""Bots Phase 6 unit U2: what SQL a bot may run (2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-6-design.md, sections 5.2 and 10 (the fuzz-style list is a merge gate).
Throwaway data folder. Run: python scripts/test_bots_data_guard.py
"""
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-dataguard-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import bot_data, bot_data_guard as guard  # noqa: E402
from services.bot_data import DataError  # noqa: E402

BOT = "guardbot"


class ParseCase(unittest.TestCase):
    def refused(self, sql, *words):
        with self.assertRaises(guard.GuardError, msg=sql) as caught:
            guard.parse(sql)
        for word in words:
            self.assertIn(word.lower(), str(caught.exception).lower())

    def test_reads_pass(self):
        for sql in ("SELECT 1", "select * from t;", "WITH a AS (SELECT 1) SELECT * FROM a", "VALUES (1),(2)",
                    "-- note\nSELECT 'a;b' AS x", "/* c */ select \"x;y\" from t", "SELECT 1;  ;  "):
            self.assertEqual(guard.parse(sql).kind, "read", sql)

    def test_semicolons_in_quotes_and_comments_are_not_statements(self):
        self.assertEqual(guard.parse("SELECT ';' , \";\", `;`, [;] FROM t").kind, "read")
        self.assertEqual(guard.parse("SELECT 1 -- ; DROP TABLE t").kind, "read")
        self.assertEqual(guard.parse("SELECT 1 /* ; DROP TABLE t */").kind, "read")
        self.assertEqual(guard.parse("SELECT 'it''s; fine'").kind, "read")

    def test_a_second_statement_is_refused_however_it_hides(self):
        self.refused("SELECT 1; DROP TABLE t", "one statement")
        self.refused("SELECT 1;\n-- harmless\nSELECT 2", "one statement")
        self.refused("SELECT 1 /* x */ ; /* y */ DELETE FROM t", "one statement")
        self.refused("SELECT 'a'; SELECT 'b'", "one statement")

    def test_unterminated_things_are_refused(self):
        self.refused("SELECT 'oops", "quote")
        self.refused("SELECT \"oops", "quote")
        self.refused("SELECT 1 /* never closed", "comment")
        self.refused("SELECT [oops", "[name]")

    def test_writes_and_admin_statements_are_refused(self):
        for sql in ("INSERT INTO t VALUES (1)", "UPDATE t SET a=1", "DELETE FROM t", "DROP TABLE t", "ALTER TABLE t ADD c",
                    "ATTACH DATABASE 'x.db' AS x", "DETACH DATABASE x", "PRAGMA table_info(t)", "VACUUM", "REINDEX",
                    "BEGIN", "COMMIT", "SAVEPOINT a", "CREATE INDEX i ON t(a)", "CREATE TRIGGER x AFTER INSERT ON t BEGIN SELECT 1; END",
                    "CREATE VIRTUAL TABLE v USING fts5(a)", "REPLACE INTO t VALUES (1)", "EXPLAIN SELECT 1", "ANALYZE"):
            self.refused(sql)

    def test_comment_and_case_tricks_do_not_hide_a_write(self):
        self.refused("/* SELECT */ DROP TABLE t")
        self.refused("-- SELECT\nDROP TABLE t")
        self.refused("dRoP tAbLe t")
        self.refused("\n\t  INSERT INTO t VALUES (1)")

    def test_create_forms(self):
        parsed = guard.parse("CREATE OR REPLACE TABLE totals AS SELECT a, SUM(b) FROM t GROUP BY a;")
        self.assertEqual((parsed.kind, parsed.object_kind, parsed.name, parsed.replace), ("create", "table", "totals", True))
        self.assertEqual(parsed.body, "SELECT a, SUM(b) FROM t GROUP BY a")
        view = guard.parse("create view v as with x as (select 1) select * from x")
        self.assertEqual((view.object_kind, view.name, view.replace, view.body.split()[0].lower()), ("view", "v", False, "with"))
        self.assertTrue(guard.parse("CREATE TEMP TABLE scratch AS SELECT 1").temp)
        self.assertEqual(guard.parse('CREATE TABLE "quoted_name" AS SELECT 1').name, "quoted_name")

    def test_create_refusals(self):
        self.refused("CREATE TABLE t (a INTEGER)", "AS")
        self.refused("CREATE TABLE t AS DELETE FROM x", "SELECT")
        self.refused("CREATE TABLE t AS", "SELECT")
        self.refused("CREATE TABLE main.t AS SELECT 1", "schema")
        self.refused("CREATE TABLE sqlite_evil AS SELECT 1", "reserved")
        self.refused("CREATE TABLE _kairos_x AS SELECT 1", "reserved")
        self.refused("CREATE TABLE \"a b\" AS SELECT 1", "usable")
        self.refused("CREATE TABLE 1abc AS SELECT 1")
        self.refused("CREATE SCHEMA x", "tables and views")
        self.refused("CREATE OR IGNORE TABLE t AS SELECT 1", "REPLACE")

    def test_limits(self):
        self.refused("", "query")
        self.refused("   \n", "query")
        self.refused("SELECT 1 /*" + "x" * (guard.MAX_SQL_BYTES + 1) + "*/", "too long")
        self.refused("SELECT 1\x00", "null")

    def test_error_lines(self):
        with self.assertRaises(guard.GuardError) as caught:
            guard.parse("SELECT 1;\nSELECT 2")
        self.assertEqual(caught.exception.line, 2)
        self.assertEqual(guard.locate("SELECT *\nFRM t", 'near "FRM": syntax error'), 2)


class EngineCase(unittest.TestCase):
    """The authorizer is the second layer: it refuses even text the tokenizer let through."""

    @classmethod
    def setUpClass(cls):
        cls.engine = bot_data.engine(BOT)
        cls.engine.replace_table("people", ["name", "age"], ["TEXT", "INTEGER"], [("Ann", 30), ("Bo", 41), ("Cy", 25)])

    @classmethod
    def tearDownClass(cls):
        bot_data.close_all()

    def refused(self, sql):
        with self.assertRaises(DataError, msg=sql):
            self.engine.run(sql)

    def test_reads(self):
        result = self.engine.run("SELECT name FROM people WHERE age > 26 ORDER BY age")
        self.assertEqual(result["rows"], [["Ann"], ["Bo"]])

    def test_extension_loading_and_files_are_refused(self):
        self.refused("SELECT load_extension('x.dll')")
        self.refused("SELECT readfile('C:/Windows/win.ini')")
        self.refused("SELECT writefile('x.txt', 'a')")
        self.refused("SELECT fts3_tokenizer('simple')")

    def test_pragmas_and_attach_are_refused_in_every_spelling(self):
        self.refused("PRAGMA table_info(people)")
        self.refused("SELECT * FROM pragma_table_info('people')")
        self.refused("SELECT * FROM pragma_database_list")
        self.refused("ATTACH DATABASE ':memory:' AS other")
        self.refused("/* x */ ATTACH ':memory:' AS other")

    def test_attached_databases_are_impossible_even_directly(self):
        conn = self.engine._open()
        with self.assertRaises(sqlite3.Error):
            conn.execute("ATTACH DATABASE ':memory:' AS other")

    def test_writes_to_existing_tables_and_sqlite_tables_are_refused(self):
        for sql in ("INSERT INTO people VALUES ('x', 1)", "UPDATE people SET age = 0", "DELETE FROM people",
                    "DROP TABLE people", "UPDATE sqlite_master SET name = 'x'", "DELETE FROM sqlite_master",
                    "INSERT INTO sqlite_master VALUES ('table','x','x',1,'')"):
            self.refused(sql)
        self.assertEqual(self.engine.run("SELECT COUNT(*) FROM people")["rows"], [[3]])

    def test_a_second_statement_never_runs(self):
        self.refused("SELECT 1; DROP TABLE people")
        self.assertEqual(self.engine.run("SELECT COUNT(*) FROM people")["rows"], [[3]])

    def test_create_makes_only_its_named_object(self):
        made = self.engine.run("CREATE TABLE adults AS SELECT * FROM people WHERE age >= 30")
        self.assertEqual(made["created"], {"name": "adults", "kind": "table"})
        self.assertEqual(sorted(r[0] for r in self.engine.run("SELECT name FROM adults")["rows"]), ["Ann", "Bo"])

    def test_create_does_not_replace_without_or_replace(self):
        self.engine.run("CREATE TABLE once AS SELECT 1 AS n")
        with self.assertRaises(DataError) as caught:
            self.engine.run("CREATE TABLE once AS SELECT 2 AS n")
        self.assertIn("REPLACE", caught.exception.hint)
        self.assertEqual(self.engine.run("SELECT n FROM once")["rows"], [[1]])

    def test_create_or_replace_replaces_and_keeps_the_old_one_on_failure(self):
        self.engine.run("CREATE OR REPLACE TABLE swap AS SELECT 1 AS n")
        self.engine.run("CREATE OR REPLACE TABLE swap AS SELECT 2 AS n")
        self.assertEqual(self.engine.run("SELECT n FROM swap")["rows"], [[2]])
        with self.assertRaises(DataError):
            self.engine.run("CREATE OR REPLACE TABLE swap AS SELECT * FROM does_not_exist")
        self.assertEqual(self.engine.run("SELECT n FROM swap")["rows"], [[2]], "a failed replace leaves the old table")

    def test_create_or_replace_can_switch_between_table_and_view(self):
        self.engine.run("CREATE OR REPLACE VIEW shape AS SELECT 1 AS n")
        self.engine.run("CREATE OR REPLACE TABLE shape AS SELECT 5 AS n")
        self.assertEqual(self.engine.run("SELECT n FROM shape")["rows"], [[5]])
        kinds = {t["name"]: t["kind"] for t in self.engine.tables()}
        self.assertEqual(kinds["shape"], "table")

    def test_a_create_cannot_smuggle_a_write_in_its_body(self):
        for sql in ("CREATE TABLE evil AS SELECT 1; DROP TABLE people", "CREATE TABLE evil AS DELETE FROM people"):
            self.refused(sql)
        self.assertEqual(self.engine.run("SELECT COUNT(*) FROM people")["rows"], [[3]])

    def test_huge_values_are_refused_not_built(self):
        self.refused("SELECT hex(zeroblob(100000000))")
        self.refused("SELECT length(replace(hex(zeroblob(40000000)), '0', 'ab'))")

    def test_a_runaway_query_is_stopped(self):
        started = __import__("time").monotonic()
        with self.assertRaises(DataError) as caught:
            self.engine.run("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT COUNT(*) FROM n", timeout=0.4)
        self.assertEqual(caught.exception.status, 408)
        self.assertLess(__import__("time").monotonic() - started, 10)
        self.assertEqual(self.engine.run("SELECT 1")["rows"], [[1]], "the engine still answers afterwards")


if __name__ == "__main__":
    unittest.main()
