"""The Kairos CLI on its own: no backend needed (scripts/test_kairos_cli_live.py
runs it against one).

Run with a Python that has Rich, prompt_toolkit, httpx and Pillow:
    python scripts/test_kairos_cli.py
    python scripts/test_kairos_cli.py --update-snapshots   (rewrite the goldens)

Snapshot screens are also exported as SVG for review when
KAIROS_CLI_SNAPSHOT_SVG names a folder.
"""
import asyncio
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))

from rich.console import Console  # noqa: E402
from rich.text import Text  # noqa: E402

from kairos_cli import chat, headless, mascot, palette as palettes, render, sanitize  # noqa: E402
from kairos_cli.live import TurnBook  # noqa: E402
from kairos_cli.sse import SSEParser  # noqa: E402

FIXTURES = ROOT / "scripts" / "fixtures" / "kairos_cli"
SNAPSHOTS = FIXTURES / "snapshots"
UPDATE = "--update-snapshots" in sys.argv
if UPDATE:
    sys.argv.remove("--update-snapshots")


def recorded_packets():
    parser = SSEParser()
    raw = (FIXTURES / "live_feed.sse").read_text(encoding="utf-8")
    events = []
    for start in range(0, len(raw), 37):     # deliberately awkward chunk boundaries
        events.extend(parser.feed(raw[start:start + 37]))
    return [e["data"] for e in events if e["event"] == "message"]


class SSETests(unittest.TestCase):
    def test_recorded_feed_parses_whole_packets(self):
        packets = recorded_packets()
        self.assertEqual(packets[0]["type"], "snapshot")
        self.assertEqual({p["type"] for p in packets}, {"snapshot", "started", "chunk", "tool_step", "update"})

    def test_keepalives_multiline_data_and_crlf(self):
        parser = SSEParser()
        events = parser.feed(": keepalive\r\n\r\ndata: {\"a\":\ndata: 1}\r\n\r\nevent: x\ndata: plain\n\n")
        self.assertEqual(events[0], {"event": "keepalive"})
        self.assertEqual(events[1], {"event": "message", "data": {"a": 1}})
        self.assertEqual(events[2], {"event": "x", "data": "plain"})


class TurnBookTests(unittest.TestCase):
    def test_recorded_feed_reduces_to_four_turns(self):
        book = TurnBook()
        kinds = []
        for packet in recorded_packets():
            kinds.extend((e.kind, e.turn.prompt) for e in book.apply(packet))
        finished = [prompt for kind, prompt in kinds if kind == "finished"]
        self.assertEqual(finished, ["hello", "tool", "ask", "lines 3"])
        self.assertIn(("permission", "ask"), kinds)
        self.assertIn(("permission_closed", "ask"), kinds)
        self.assertEqual(book.turns["SESSION"].text.count("line 0000"), 3)

    def test_old_revisions_are_ignored_and_strangers_resync(self):
        book = TurnBook()
        book.apply({"type": "started", "sessionId": "s", "run": {"turnId": "t", "revision": 1}})
        self.assertEqual(len(book.apply({"type": "chunk", "sessionId": "s", "turnId": "t", "revision": 2, "chunk": "a"})), 1)
        self.assertEqual(book.apply({"type": "chunk", "sessionId": "s", "turnId": "t", "revision": 2, "chunk": "a"}), [])
        self.assertEqual(book.apply({"type": "chunk", "sessionId": "s", "turnId": "other", "revision": 9, "chunk": "x"})[0].kind, "resync")

    def test_snapshot_after_a_drop_fills_only_what_was_missed(self):
        book = TurnBook()
        book.apply({"type": "started", "sessionId": "s", "run": {"turnId": "t", "revision": 1}})
        book.apply({"type": "chunk", "sessionId": "s", "turnId": "t", "revision": 2, "chunk": "Hello "})
        events = book.apply({"type": "snapshot", "runs": {"s": {"turnId": "t", "text": "Hello world", "revision": 5,
                                                                 "status": "processing", "permission": {"id": "p"}}}})
        self.assertEqual([(e.kind, e.text) for e in events], [("text", "world"), ("permission", "")])
        events = book.apply({"type": "snapshot", "runs": {}})
        self.assertEqual([e.kind for e in events], ["permission_closed", "finished"])


class StreamTests(unittest.TestCase):
    def test_commits_at_newlines_only(self):
        committer = render.StreamCommitter()
        self.assertEqual(committer.feed("Hel"), [])
        self.assertEqual(committer.tail(), "Hel")
        blocks = committer.feed("lo\nwor")
        self.assertEqual([(b.kind, b.text) for b in blocks], [("line", "Hello")])
        self.assertEqual(committer.tail(), "wor")
        self.assertEqual([b.text for b in committer.finish()], ["wor"])

    def test_code_fences_and_tables_wait_until_closed(self):
        committer = render.StreamCommitter()
        self.assertEqual(committer.feed("```python\ndef a():\n"), [])
        self.assertEqual(committer.tail(), "writing python code · 1 lines")
        blocks = committer.feed("    return 1\n```\n| a | b |\n|---|---|\n")
        self.assertEqual([(b.kind, b.lang, b.lines) for b in blocks], [("code", "python", ("def a():", "    return 1"))])
        self.assertEqual(committer.tail(), "writing a table · 2 rows")
        blocks = committer.feed("| 1 | 2 |\nafter\n")
        self.assertEqual([b.kind for b in blocks], ["table", "line"])

    def test_an_unclosed_fence_is_committed_when_the_turn_ends(self):
        committer = render.StreamCommitter()
        committer.feed("```\nx = 1\n")
        self.assertEqual([(b.kind, b.lines) for b in committer.finish()], [("code", ("x = 1",))])


class SanitizeTests(unittest.TestCase):
    def test_escape_sequences_and_controls_are_removed(self):
        hostile = ("ok\x1b[2J\x1b[H\x1b]0;pwned\x07\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\"
                   "\x1bP+q\x1b\\\x9b31m\rred\x07\x00 ‮evil")
        self.assertEqual(sanitize.clean(hostile), "oklinkred evil")
        self.assertEqual(sanitize.clean("line\n\tindent"), "line\n\tindent")

    def test_model_text_cannot_draw_markup_or_escapes(self):
        committer = render.StreamCommitter()
        blocks = committer.feed("[bold red]fake[/] \x1b[31mprompt\n")
        console = Console(file=io.StringIO(), force_terminal=True, color_system="truecolor", width=80)
        console.print(render.render_block(blocks[0], palettes.Palette("night", "truecolor")))
        out = console.file.getvalue()
        self.assertIn("[bold red]fake[/]", out)
        self.assertNotIn("\x1b[31m", out)


class PaletteTests(unittest.TestCase):
    def test_night_is_readable_on_dark_terminals(self):
        for background in ("#0C0C0C", "#1E1E1E", "#282C34", "#2A201A"):
            for role in ("text", "dim", "meta", "accent", "danger", "success", "warn", "info"):
                with self.subTest(background=background, role=role):
                    self.assertGreaterEqual(palettes.contrast(palettes.NIGHT[role][0], background), 4.5)

    def test_parchment_is_readable_on_light_terminals(self):
        for background in ("#FFFFFF", "#F3EADB", "#FBF6EE"):
            for role in ("text", "dim", "meta", "accent", "danger", "success", "warn"):
                with self.subTest(background=background, role=role):
                    self.assertGreaterEqual(palettes.contrast(palettes.PARCHMENT[role][0], background), 4.5)

    def test_fallback_tables_are_complete_and_close(self):
        from rich.color import Color, ColorSystem
        sixteen = {"", "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "bright_black",
                   "bright_red", "bright_green", "bright_yellow", "bright_blue", "bright_magenta", "bright_cyan",
                   "bright_white"}
        for name, table in palettes.THEMES.items():
            self.assertEqual(set(table), set(palettes.ROLES))
            for role, (true, index, named) in table.items():
                with self.subTest(theme=name, role=role):
                    self.assertIn(named, sixteen)
                    self.assertTrue(16 <= index <= 255)
                    ours = Color.from_ansi(index).get_truecolor()
                    want = Color.parse(true).get_truecolor()
                    self.assertLess(sum(abs(a - b) for a, b in zip(ours, want)), 120, (true, index))
            pal = palettes.Palette(name, "16")
            self.assertIsNone(pal.band().bgcolor)

    def test_gold_is_never_body_text(self):
        for name in palettes.THEMES:
            pal = palettes.Palette(name, "truecolor")
            self.assertNotEqual(pal.color("text"), "#B8893B")

    def test_detection(self):
        self.assertEqual(palettes.parse_osc11("\x1b]11;rgb:ffff/fafa/f0f0\x07"), "#FFFAF0")
        self.assertEqual(palettes.parse_osc11("\x1b]11;rgb:0c/0c/0c\x1b\\"), "#0C0C0C")
        self.assertIsNone(palettes.parse_osc11("garbage"))
        self.assertEqual(palettes.theme_for_background("#FFFAF0"), "parchment")
        self.assertEqual(palettes.theme_for_background("#0C0C0C"), "night")
        self.assertEqual(palettes.color_depth({"NO_COLOR": "1"}), "none")
        self.assertEqual(palettes.color_depth({"KAIROS_COLOR": "256"}), "256")
        self.assertEqual(palettes.choose(env={"COLORFGBG": "0;15"}, depth="16", probe=False).name, "parchment")
        self.assertEqual(palettes.choose(env={}, depth="16", probe=False).name, "night")
        self.assertEqual(palettes.choose("light", env={}, depth="16", probe=False).name, "parchment")


class MascotTests(unittest.TestCase):
    """Kip from the mascot work's real assets (static/img/mascot/kip)."""

    def test_the_real_assets_load_in_both_themes_and_sizes(self):
        manifest = mascot.load_manifest()
        self.assertEqual((manifest["format"], manifest["version"]), ("kairos-kip-sheet", 1))
        for theme in ("parchment", "night"):
            for size, grid in (("full", 24), ("mini", 12)):
                sheet = mascot.load_sheet(theme=theme, size=size)
                self.assertIsNotNone(sheet, (theme, size))
                self.assertEqual(set(sheet.frames), set(mascot.ASSET_STATES))
                for state, count in manifest["frame_counts"].items():
                    self.assertEqual(len(sheet.frames[state]), count)
                self.assertEqual(len(sheet.frame("idle", 0)), grid)

    def test_cli_states_map_onto_the_assets(self):
        sheet = mascot.load_sheet(theme="night")
        self.assertIs(sheet.frame("needs", 0), sheet.frames["needs-you"][0])
        self.assertIs(sheet.frame("success", 3), sheet.frames["done"][3])
        self.assertIs(sheet.frame("sleeping", 0), sheet.frames["idle"][0])

    def test_banner_is_24_by_12_and_the_slot_12_by_6(self):
        kip = mascot.Kip(palettes.Palette("night", "truecolor"))
        banner = kip.banner("idle", 0)
        self.assertEqual((len(banner), {line.cell_len for line in banner}), (12, {24}))
        slot = kip.slot("thinking", 0.5)
        self.assertEqual((len(slot), {line.cell_len for line in slot}), (6, {12}))

    def test_lower_colour_depths_use_the_assets_plain_still(self):
        kip = mascot.Kip(palettes.Palette("night", "256"))
        self.assertEqual(kip.tier, "blocks")
        self.assertEqual([line.plain for line in kip.banner("idle")], mascot.plain_still("idle"))
        self.assertEqual(mascot.Kip(palettes.Palette("night", "none"), ascii_only=True).tier, "text")

    def test_malformed_assets_are_refused(self):
        manifest = mascot.load_manifest()
        with tempfile.TemporaryDirectory() as folder:
            def write(data):
                (Path(folder) / "kip.json").write_text(json.dumps(data), encoding="utf-8")
            broken = json.loads(json.dumps(manifest))
            broken["sizes"]["full"]["frames"]["night"]["idle"][0][0] = "[2J" + "." * 20
            write(broken)
            self.assertIsNone(mascot.load_sheet(Path(folder), "night"))
            broken = json.loads(json.dumps(manifest))
            broken["themes"]["night"]["full"][0] = "red; evil"
            write(broken)
            self.assertIsNone(mascot.load_sheet(Path(folder), "night"))
            broken = json.loads(json.dumps(manifest))
            broken["format"] = "something-else"
            write(broken)
            self.assertIsNone(mascot.load_sheet(Path(folder), "night"))
            os.environ["KAIROS_KIP_DIR"] = folder
            try:
                write(manifest)
                self.assertEqual(mascot.asset_dir(), Path(folder))
            finally:
                del os.environ["KAIROS_KIP_DIR"]

    def test_text_tiers(self):
        manifest = mascot.load_manifest()
        self.assertEqual(mascot.text_face("idle", manifest), manifest["text_face"]["idle"]["unicode"])
        self.assertEqual(mascot.text_face("needs", manifest, ascii_only=True), manifest["text_face"]["needs-you"]["ascii"])
        self.assertEqual(mascot.status_mark("needs", 0, manifest), "!")
        self.assertEqual([mascot.status_mark("thinking", t, manifest) for t in range(4)], ["◜", "◝", "◞", "◟"])
        self.assertEqual(mascot.text_face("idle", None)[1], "( ▮ ▮ )")
        pal = palettes.Palette("night", "16")
        self.assertEqual(mascot.Kip(pal).tier, "blocks")
        self.assertEqual(mascot.Kip(palettes.Palette("night", "truecolor")).tier, "pixels")
        self.assertEqual(mascot.Kip(pal, enabled=False).tier, "off")


class FakeConnection:
    def __init__(self, gone=False):
        self.posts = []
        self.gone = gone

    async def post(self, path, body=None, **kwargs):
        from kairos_cli.connection import KairosError
        self.posts.append((path, body))
        if self.gone:
            raise KairosError("That request is no longer waiting for an answer.")
        return {"status": "answered"}


REQUEST = {"id": "req1", "tool": "Bash", "title": "Run a command", "target": "pytest scripts",
           "arguments": '{"command": "pytest scripts"}',
           "choices": [{"id": "once", "label": "Allow once", "behavior": "allow"},
                       {"id": "session", "label": "Always in this chat (pytest scripts)", "behavior": "allow"},
                       {"id": "forever", "label": "Always allow pytest scripts", "behavior": "allow"},
                       {"id": "reject", "label": "Reject", "behavior": "deny"}]}


def make_app(conn=None, theme="night", depth="16"):
    from kairos_cli.tui import KairosApp
    pal = palettes.Palette(theme, depth)
    app = KairosApp(conn or FakeConnection(), pal, mascot.Kip(pal, motion=False), motion=False, cwd=str(ROOT))
    app.conn.status = {"instance": "test"}
    return app


def open_view(app, items=(), session=None):
    from kairos_cli.model import SessionView
    view = SessionView(session or {"id": "s1", "title": "A chat", "model_endpoint_id": "m1", "permission_mode": "base"})
    view.items = list(items)
    app.views[view.id] = view
    app.tabs.append(view.id)
    app.active = view.id
    return view


class PermissionRoutingTests(unittest.IsolatedAsyncioTestCase):
    def app(self, conn):
        from kairos_cli.model import ReplyItem
        app = make_app(conn)
        view = open_view(app, [ReplyItem(turn_id="t1", ts=0)])
        app.set_modal(view, dict(REQUEST))
        return app, view

    async def test_each_number_sends_its_own_choice_id(self):
        for index, expected in enumerate(["once", "session", "forever", "reject"]):
            conn = FakeConnection()
            app, view = self.app(conn)
            await app.answer(index)
            self.assertEqual(conn.posts, [("/api/permissions/req1/answer", {"choice": expected})])
            self.assertIsNone(app.modal)

    async def test_escape_rejects_and_a_bad_number_sends_nothing(self):
        conn = FakeConnection()
        app, view = self.app(conn)
        await app.answer(7)
        self.assertEqual(conn.posts, [])
        await app.answer(None)
        self.assertEqual(conn.posts, [("/api/permissions/req1/answer", {"choice": "reject"})])

    async def test_answered_in_the_app_first(self):
        conn = FakeConnection(gone=True)
        app, view = self.app(conn)
        await app.answer(0)
        self.assertIsNone(app.modal)
        self.assertIn("Answered in the app.", view.reply.notes)


class HeadlessDecisionTests(unittest.IsolatedAsyncioTestCase):
    async def test_deny_mode_refuses_without_asking(self):
        conn = FakeConnection()
        out = io.StringIO()
        runner = headless.Headless(conn, "stream-json", "deny", out=out, err=io.StringIO())
        await runner.permission(REQUEST)
        self.assertEqual(conn.posts, [("/api/permissions/req1/answer", {"choice": "reject"})])
        self.assertEqual(len(runner.denied), 1)
        self.assertEqual(json.loads(out.getvalue())["choice"], "reject")

    async def test_ask_without_a_terminal_still_refuses(self):
        conn = FakeConnection()
        stdin = io.StringIO("1\n")
        runner = headless.Headless(conn, "text", "ask", out=io.StringIO(), err=io.StringIO(), stdin=stdin)
        await runner.permission(REQUEST)
        self.assertEqual(conn.posts[0][1], {"choice": "reject"})


class ModelMatchTests(unittest.TestCase):
    def test_match(self):
        choices = [{"id": "a1", "name": "Claude", "model": "claude-sonnet"}, {"id": "b2", "name": "Codex", "model": "gpt"}]
        self.assertEqual(chat.match_model(choices, "codex")["id"], "b2")
        self.assertEqual(chat.match_model(choices, "a1")["id"], "a1")
        self.assertEqual(chat.match_model(choices, "sonnet")["id"], "a1")
        self.assertIsNone(chat.match_model(choices, "zzz"))


class WidgetTests(unittest.TestCase):
    """The full-screen view's pieces (kairos_cli/widgets.py)."""

    def plain(self, fragments):
        return "".join(text for _, text in fragments)

    def test_bars_dither_the_empty_part_and_never_invent(self):
        from kairos_cli import widgets
        s = widgets.Styles(palettes.Palette("night", "truecolor"))
        self.assertEqual(self.plain(widgets.bar(0.5, 10, s)), "█████" + "⡪⢕⡪⢕⡪")
        self.assertEqual(self.plain(widgets.bar(None, 4, s)), "⢕⡪⢕⡪")      # no number: texture only
        self.assertEqual(self.plain(widgets.bar(1.7, 4, s)), "████")
        self.assertEqual(widgets.width_of(widgets.bar(0.33, 17, s)), 17)

    def test_charts_are_solid_columns(self):
        from kairos_cli import widgets
        s = widgets.Styles(palettes.Palette("night", "truecolor"))
        self.assertEqual(self.plain(widgets.sparkline([0, 1, 2, 4], 6, s)), "··" + " ▂▄█")
        rows = [self.plain(r) for r in widgets.histogram([0, 2, 4], 2, s)]
        self.assertEqual(rows, ["  █", " ██", "▔▔▔"])

    def test_the_ring_is_whole_when_idle_and_open_when_working(self):
        from kairos_cli import widgets
        s = widgets.Styles(palettes.Palette("night", "truecolor"))
        idle = self.plain(widgets.ring(None, s))
        working = {self.plain(widgets.ring(t / 8, s)) for t in range(8)}
        self.assertEqual(len(idle), 2)
        self.assertNotIn(idle, working)
        self.assertEqual(len(working), 8)

    def test_styles_use_the_fixed_tables(self):
        from kairos_cli import widgets
        self.assertEqual(widgets.Styles(palettes.Palette("night", "truecolor")).fg("text"), "fg:#F3EADB")
        self.assertEqual(widgets.Styles(palettes.Palette("night", "256")).fg("text"), "fg:#ffd7d7")   # index 224
        self.assertEqual(widgets.Styles(palettes.Palette("night", "16")).fg("danger"), "fg:ansibrightred")
        self.assertEqual(widgets.Styles(palettes.Palette("night", "none")).fg("text"), "")

    def test_halftone_fields(self):
        from kairos_cli import widgets
        s = widgets.Styles(palettes.Palette("night", "truecolor"))
        full = widgets.field(4, 2, lambda x, y: 1.0, s)
        empty = widgets.field(4, 2, lambda x, y: 0.0, s)
        self.assertEqual(self.plain(full[0]), "⣿⣿⣿⣿")
        self.assertEqual(self.plain(empty[0]), "    ")
        dune = "".join(self.plain(r) for r in widgets.field(20, 6, widgets.dune, s))
        self.assertTrue(dune.strip())


class ModelTests(unittest.TestCase):
    """Data for the full-screen view (kairos_cli/model.py): only backend
    fields, and n/a where there are none."""

    def test_metrics_come_from_the_run_and_cost_is_never_invented(self):
        from kairos_cli import model
        run = {"started_at": 100.0, "ended_at": 109.0, "total_tokens": 113000, "cache_read_tokens": 79100,
               "tool_calls": 2, "usage_complete": 1, "outcome": "finished"}
        metrics = model.run_metrics(run)
        self.assertEqual((metrics["seconds"], metrics["tokens"], metrics["cached_percent"], metrics["tools"]),
                         (9.0, 113000, 70, 2))
        self.assertIsNone(metrics["cost"])
        self.assertIsNone(metrics["tok_per_s"])
        self.assertIsNone(model.run_metrics({"started_at": 1, "ended_at": 2, "total_tokens": None,
                                             "cache_read_tokens": None})["cached_percent"])
        self.assertIsNone(model.run_metrics(None))

    def test_a_reply_finds_its_run(self):
        from kairos_cli import model
        runs = [{"id": "a", "started_at": 100, "ended_at": 110}, {"id": "b", "started_at": 200, "ended_at": 230}]
        self.assertEqual(model.match_run(229, runs)["id"], "b")
        self.assertEqual(model.match_run(111, runs)["id"], "a")
        self.assertIsNone(model.match_run(150, runs))

    def test_tokens_per_hour_today(self):
        import datetime
        from kairos_cli import model
        now = datetime.datetime(2026, 10, 22, 15, 0).timestamp()

        def at(hour):
            return datetime.datetime(2026, 10, 22, hour, 5).timestamp()
        runs = [{"started_at": at(9), "total_tokens": 100}, {"started_at": at(9), "total_tokens": 50},
                {"started_at": at(14), "total_tokens": 7}, {"started_at": at(14), "total_tokens": None},
                {"started_at": now - 86400 * 2, "total_tokens": 999}]
        hours = model.tokens_per_hour_today(runs, now)
        self.assertEqual((hours[9], hours[14], sum(hours)), (150, 7, 157))
        self.assertIsNone(model.tokens_per_hour_today([{"started_at": at(9), "total_tokens": None}], now))

    def test_plans_only_for_subscriptions(self):
        from kairos_cli import model
        quotas = {"providers": [{"provider": "claude", "windows": [{"name": "5-hour", "used_percent": 35, "resets_at": 1},
                                                                   {"name": "weekly", "used_percent": 61, "resets_at": 2}]}]}
        self.assertEqual(model.plan_window(quotas, "claude_cli")["name"], "weekly")
        self.assertIsNone(model.plan_window(quotas, "api"))
        self.assertIsNone(model.plan_window(quotas, "codex_cli"))
        self.assertEqual(model.resets_in(1000 + 5 * 86400 + 30, now=1000), "↺5d")

    def test_the_projects_tree(self):
        from kairos_cli import model
        sessions = [{"id": "c1", "title": "Hero copy", "project_id": "p1", "updated_at": 5},
                    {"id": "c2", "title": "Loose chat", "updated_at": 9, "launch_dir": str(ROOT)},
                    {"id": "c3", "title": "Older chat", "updated_at": 1},
                    {"id": "f1", "title": "Fix parser", "is_forge": True, "updated_at": 7}]
        nodes = model.build_tree(sessions, [{"id": "fp", "name": "parser-repo"}],
                                 {"fp": [{"id": "f1", "title": "Fix parser", "forge": {}}]},
                                 [{"id": "p1", "name": "Website launch"}], "c1", {"c1"}, {"f1"}, set(), str(ROOT))
        self.assertEqual([(n.kind, n.label) for n in nodes],
                         [("group", "parser-repo"), ("session", "Fix parser"), ("group", "Website launch"),
                          ("session", "Hero copy"), ("group", "chats"), ("session", "Loose chat"),
                          ("session", "Older chat")])
        self.assertTrue(nodes[1].busy and nodes[3].active and nodes[2].active)
        collapsed = model.build_tree(sessions, [], {}, [{"id": "p1", "name": "Website launch"}], None, set(), set(),
                                     {"project:p1"})
        self.assertEqual([n.label for n in collapsed][:2], ["Website launch", "chats"])

    def test_untrusted_titles_are_plain(self):
        from kairos_cli import model
        nodes = model.build_tree([{"id": "x", "title": "\x1b[2Jevil\x07 title", "updated_at": 1}], [], {}, [], None,
                                 set(), set(), set())
        self.assertEqual(nodes[1].label, "evil title")


class FullScreenRenderTests(unittest.TestCase):
    """What the transcript draws, without a terminal."""

    def text(self, lines):
        return "\n".join("".join(fragment[1] for fragment in line) for line in lines)

    def test_turns_have_headers_actions_and_a_metrics_line(self):
        from kairos_cli.model import ReplyItem, UserItem
        app = make_app()
        reply = ReplyItem(turn_id="t", ts=1_700_000_000)
        reply.feed("Hi. What are we working on?\n")
        reply.steps.append({"phase": "finished", "name": "read_file", "summary": "a.py", "ok": True, "seconds": 0.4})
        reply.finish("done")
        reply.metrics = {"seconds": 9.0, "tokens": 113000, "cached_percent": 70, "tools": 1, "complete": True,
                         "cost": None, "tok_per_s": None}
        open_view(app, [UserItem("hello", 1_700_000_000), reply])
        lines, clicks = app.main_lines(120, 40)
        text = self.text(lines)
        for expected in ("You ·", "hello", "Kairos ·", "1 action ▸", "Hi. What are we working on?",
                         "9.0s · 113k tokens · 70% cached · 1 tool · cost n/a · tok/s n/a", "Fork", "Copy"):
            self.assertIn(expected, text)
        self.assertNotIn("read_file", text)          # collapsed until asked
        row = next(r for r, regions in clicks.items() if len(regions) == 2)
        self.assertIn("Fork", self.text([lines[row]]))
        actions_row = next(r for r, regions in clicks.items() if len(regions) == 1)
        clicks[actions_row][0][2]()                  # click "1 action"
        self.assertIn("read_file", self.text(app.main_lines(120, 40)[0]))

    def test_no_run_means_n_a(self):
        from kairos_cli.model import ReplyItem
        app = make_app()
        reply = ReplyItem(turn_id="t", ts=1)
        reply.feed("ok\n")
        reply.finish("done")
        open_view(app, [reply])
        self.assertIn("tokens n/a · cost n/a · tok/s n/a", self.text(app.main_lines(120, 40)[0]))

    def test_a_running_reply_shows_the_working_line_and_its_tail(self):
        from kairos_cli.model import ReplyItem
        app = make_app()
        reply = ReplyItem(turn_id="t", ts=1)
        reply.feed("first line\nhalf a li")
        open_view(app, [reply])
        text = self.text(app.main_lines(120, 40)[0])
        self.assertIn("first line", text)
        self.assertIn("half a li", text)
        self.assertIn("Writing", text)
        self.assertIn("chars/s", text)

    def test_the_empty_state_and_the_status_line(self):
        app = make_app(depth="truecolor")
        open_view(app, [])
        text = self.text(app.main_lines(130, 40)[0])
        self.assertIn("The right moment, in your terminal.", text)
        self.assertIn("type to start", text)
        status = "".join(fragment[1] for fragment in app.status_line())
        self.assertIn("cost n/a", status)
        self.assertIn("plan ", status)
        self.assertIn("context ", status)

    def test_search_scrolls_to_a_match(self):
        from kairos_cli.model import NoteItem
        app = make_app()
        open_view(app, [NoteItem(f"note {i}") for i in range(80)])
        app.scroll_info = (60, 80, 20)
        app.find("note 3")
        self.assertIsNotNone(app.search_hit)
        self.assertIn("note 3", self.text([app.main_lines(120, 20)[0][app.search_hit]]))
        self.assertGreater(app.view.scroll, 0)


class ScreenEmulatorTests(unittest.TestCase):
    def test_reads_back_what_a_full_screen_app_drew(self):
        sys.path.insert(0, str(ROOT / "scripts"))
        from kairos_cli_vt import Screen
        screen = Screen(20, 4)
        screen.feed("before\r\n\x1b[?1049h\x1b[2J\x1b[2;3Hhello\x1b[1;1H\x1b[31mtop\x1b[0m\x1b]0;title\x07")
        self.assertTrue(screen.ever_alternate)
        self.assertEqual(screen.text().splitlines()[:2], ["top", "  hello"])
        screen.feed("\x1b[?1049l")
        self.assertEqual(screen.text().splitlines()[0], "before")


# -- snapshots --------------------------------------------------------------------------

VARIANTS = [("night", "truecolor"), ("parchment", "truecolor"), ("night", "256"), ("night", "16"), ("parchment", "16")]


def screens(pal):
    """The main screens, built from the same functions the CLI draws with."""
    from rich.console import Group
    from rich.table import Table
    kip = mascot.Kip(pal, motion=False)
    banner = kip.banner("idle", 0)
    grid = Table.grid(padding=(0, 3))
    if banner:
        grid.add_column(no_wrap=True)
    grid.add_column()
    right = render.wordmark(pal) + [Text(render.TAGLINE, pal.style("dim", italic=True))]
    grid.add_row(*( [Text("\n").join(banner)] if banner else []), Group(*right))
    sky = render.halftone_sky(76, 3, pal) if pal.truecolor else []   # no sky below truecolour
    welcome = Group(*[Text("  ").append_text(line) for line in sky], grid)
    committer = render.StreamCommitter()
    blocks = committer.feed("Reading **services/forge_sessions.py** now.\n- one `item`\n```python\ndef f():\n    return 1\n```\n") \
        + committer.finish()
    conversation = Group(
        render.user_turn("Fix the failing test in forge_sessions", pal, 90),
        render.speaker(pal), *[render.render_block(b, pal) for b in blocks],
        render.tool_cell({"phase": "finished", "name": "read_file", "summary": "services/forge_sessions.py",
                          "ok": True, "seconds": 0.4}, pal),
        render.tool_cell({"phase": "started", "name": "bash", "summary": "pytest scripts/test_chat.py -k forge"}, pal),
        render.finished_line("done", 3.2, pal))
    working = Group(Text(" ").append_text(kip.mark("thinking", 0)).append(" ").append_text(
        render.shimmer("Thinking", 0.6, pal)).append("  ").append_text(render.braille_bar(0.4, pal)))
    permission = render.permission_box(REQUEST, pal, 90)
    diff = render.render_diff([{"path": "app.py", "added": 1, "removed": 1, "untracked": False, "patch":
                                "diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\n@@ -1,3 +1,3 @@ def main\n"
                                " import os\n-print('old')\n+print('new')\n keep = 1\n"}], pal, 90)
    footer = Group(render.status_line("scripted-1", "base", "Fix the failing test", True, pal),
                   render.footer([("enter", "send"), ("/", "commands"), ("esc", "stop")], pal))
    return {"welcome": welcome, "conversation": conversation, "working": working, "permission": permission,
            "diff": diff, "footer": footer}


class SnapshotTests(unittest.TestCase):
    def test_main_screens_in_light_dark_256_and_16_colours(self):
        from kairos_cli.tui import COLOR_SYSTEMS
        svg_dir = os.environ.get("KAIROS_CLI_SNAPSHOT_SVG")
        SNAPSHOTS.mkdir(parents=True, exist_ok=True)
        for theme, depth in VARIANTS:
            pal = palettes.Palette(theme, depth)
            for name, renderable in screens(pal).items():
                with self.subTest(theme=theme, depth=depth, screen=name):
                    console = Console(file=io.StringIO(), force_terminal=True, color_system=COLOR_SYSTEMS[depth],
                                      width=100, record=True, theme=pal.theme(), legacy_windows=False)
                    console.print(renderable)
                    ansi = console.file.getvalue()
                    self.assertNotIn("—", console.export_text(clear=False), "no em dashes in UI text")
                    golden = SNAPSHOTS / f"{name}.{theme}.{depth}.ans"
                    if UPDATE or not golden.exists():
                        golden.write_text(ansi, encoding="utf-8", newline="\n")
                    self.assertEqual(ansi, golden.read_text(encoding="utf-8"))
                    if svg_dir:
                        background = "#F3EADB" if theme == "parchment" else "#16120F"
                        foreground = "#3A2A20" if theme == "parchment" else "#F3EADB"
                        from rich.terminal_theme import TerminalTheme
                        term = TerminalTheme(tuple(int(background[i:i + 2], 16) for i in (1, 3, 5)),
                                             tuple(int(foreground[i:i + 2], 16) for i in (1, 3, 5)),
                                             [(0, 0, 0), (205, 49, 49), (13, 188, 121), (229, 229, 16), (36, 114, 200),
                                              (188, 63, 188), (17, 168, 205), (229, 229, 229)],
                                             [(102, 102, 102), (241, 76, 76), (35, 209, 139), (245, 245, 67),
                                              (59, 142, 234), (214, 112, 214), (41, 184, 219), (229, 229, 229)])
                        Path(svg_dir).mkdir(parents=True, exist_ok=True)
                        console.save_svg(str(Path(svg_dir) / f"{name}.{theme}.{depth}.svg"),
                                         title=f"kairos · {name} · {theme} · {depth}", theme=term)


if __name__ == "__main__":
    unittest.main(verbosity=1)
