"""The kairos command.

    kairos                         chat here (continues nothing; -c to carry on)
    kairos "fix the tests"         chat, starting with that message
    kairos -c | -r [id or title]   continue this folder's latest chat | resume one
    kairos -p "prompt"             headless: print the reply and exit
    kairos forge "task"            Forge in this folder (in place; --worktree to isolate)
    kairos agents                  agents and their inbox, then exit
    kairos status                  what this terminal is attached to
    kairos login                   sign in when Kairos has accounts on

Dev: python -m kairos_cli --instance dev   (the dev copy on 8430)
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time

from rich.console import Console, Group
from rich.live import Live
from rich.table import Table
from rich.text import Text

from . import __version__, chat, forge as forge_api, render
from .connection import Connection, KairosError, attach
from .mascot import Kip
from .palette import choose
from .sanitize import one_line

SUBCOMMANDS = ("status", "login", "agents", "forge")


VALUE_OPTIONS = {"--instance", "--port", "--theme", "--color", "--model", "--output-format", "--permissions"}


def find_subcommand(argv: list[str]) -> tuple[str | None, int]:
    """The subcommand is the first positional word, wherever the options sit
    (kairos --instance dev status). Anything after -p/-r is a value, so
    `kairos -p status` sends the word "status"."""
    skip = False
    for index, token in enumerate(argv):
        if skip:
            skip = False
            continue
        if token in VALUE_OPTIONS:
            skip = True
            continue
        if token in ("-p", "--print", "-r", "--resume"):
            return None, -1
        if token.startswith("-"):
            continue
        return (token, index) if token in SUBCOMMANDS else (None, -1)
    return None, -1


def build_parser(sub: str | None = None) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog=f"kairos {sub}" if sub else "kairos",
                                     description="Kairos in your terminal.")
    parser.add_argument("--instance", help="a named development copy (dev uses port 8430)")
    parser.add_argument("--port", type=int, help="attach to this local port")
    parser.add_argument("--theme", choices=("auto", "parchment", "night", "light", "dark"), default="auto")
    parser.add_argument("--color", choices=("truecolor", "256", "16", "none"), help="force a colour depth")
    parser.add_argument("--no-motion", action="store_true", help="no animation")
    parser.add_argument("--no-mascot", action="store_true", help="hide Kip")
    parser.add_argument("--no-start", action="store_true", help="do not start the app when it is not running")
    parser.add_argument("--model", help="model for this chat (name, model id or connection id)")
    if sub == "forge":
        parser.add_argument("task", nargs="+")
        parser.add_argument("--worktree", action="store_true", help="work in an isolated Forge worktree")
        parser.add_argument("--plan", action="store_true", help="start in Plan mode")
        return parser
    if sub:
        return parser
    parser.add_argument("prompt", nargs="*", help="a first message")
    parser.add_argument("-p", "--print", dest="headless", metavar="PROMPT", nargs="?", const="-",
                        help="headless: send PROMPT (or stdin), print the reply, exit")
    parser.add_argument("--output-format", choices=("text", "json", "stream-json"), default="text")
    parser.add_argument("--permissions", choices=("deny", "ask"), default="deny",
                        help="headless prompts: deny (default) or ask on this terminal")
    parser.add_argument("-c", "--continue", dest="cont", action="store_true", help="continue this folder's latest chat")
    parser.add_argument("-r", "--resume", nargs="?", const="", metavar="ID_OR_TITLE", help="resume a chat")
    parser.add_argument("--version", action="version", version=f"kairos {__version__}")
    return parser


def stderr_console(palette) -> Console:
    from .repl import COLOR_SYSTEMS
    return Console(file=sys.stderr, color_system=COLOR_SYSTEMS[palette.depth], theme=palette.theme(),
                   highlight=False, markup=False, emoji=False)


def stdout_console(palette) -> Console:
    from .repl import COLOR_SYSTEMS
    return Console(color_system=COLOR_SYSTEMS[palette.depth], theme=palette.theme(), highlight=False,
                   markup=False, emoji=False)


def welcome(palette, kip: Kip, width: int, seconds: float, lines: list[Text], sky: bool = True):
    """The launch screen: a halftone sky over Kip, the wordmark and tagline.
    The sky is drawn only on truecolour terminals with motion on (spec 4.5)."""
    sky = render.halftone_sky(min(width - 4, 76), 3, palette, seconds=seconds) if sky else []
    right = render.wordmark(palette) + [Text(render.TAGLINE, palette.style("dim", italic=True)), Text("")] + lines
    grid = Table.grid(padding=(0, 3))
    banner = kip.banner("idle", seconds)
    if banner:
        grid.add_column(no_wrap=True)
    grid.add_column()
    if banner:
        grid.add_row(Text("\n").join(banner), Group(*right))
    else:
        grid.add_row(Group(*right))
    return Group(*[Text("  ").append_text(line) for line in sky], *([Text("")] if sky else []), grid, Text(""))


def show_welcome(console: Console, palette, kip: Kip, motion: bool, lines: list[Text]) -> None:
    width = console.size.width
    if motion and palette.truecolor and console.is_terminal:
        with Live(welcome(palette, kip, width, 0.0, lines), console=console, refresh_per_second=16,
                  transient=False) as live:
            start = time.monotonic()
            while (elapsed := time.monotonic() - start) < 1.3:
                live.update(welcome(palette, kip, width, elapsed, lines))
                time.sleep(1 / 16)
            live.update(welcome(palette, kip, width, 1.3, lines))
    else:
        console.print(welcome(palette, kip, width, 10.0, lines, sky=motion and palette.truecolor))


async def connect(args, palette, interactive: bool) -> Connection:
    err = stderr_console(palette)
    base_url = await attach(args.port, args.instance, start_app=not args.no_start,
                            say=lambda text: err.print(Text("  " + text, palette.style("meta"))))
    conn = Connection(base_url, say=lambda text: err.print(Text("  " + text, palette.style("warn"))))

    def on_words(words: str) -> None:
        err.print(Text("  Approve this terminal in the Kairos app. It shows:", palette.style("dim")))
        err.print(Text("    " + words, palette.style("accent", bold=True)))
        err.print(Text("  Waiting for your click. Reject or ignore it to cancel.", palette.style("meta")))

    try:
        await conn.sign_in(interactive=interactive, on_words=on_words)
    except BaseException:
        await conn.close()
        raise
    return conn


async def pick_session(conn: Connection, args, interactive: bool, repl=None) -> dict:
    if args.cont:
        found = await chat.latest_here(conn)
        if found:
            return found
    if args.resume:
        found = await chat.find_session(conn, args.resume)
        if not found:
            raise KairosError(f"No chat matches {one_line(args.resume, 60)}.")
        return found
    if args.resume == "" and interactive and repl is not None:
        found = await repl.pick_session()
        if found:
            return found
    if args.resume == "" and not interactive:
        raise KairosError("Name the chat to resume: kairos -p ... -r <id or title>")
    return await chat.new_session(conn)


async def ensure_model(conn: Connection, session: dict, wanted: str | None, choices: list[dict]) -> dict:
    if wanted:
        choice = chat.match_model(choices, wanted)
        if not choice:
            raise KairosError(f"No single model matches {one_line(wanted, 40)}. Names: "
                              + ", ".join(one_line(c.get("name"), 30) for c in choices[:12]))
        await chat.set_model(conn, session["id"], choice)
    return await chat.open_session(conn, session["id"])


async def run_headless(args, palette) -> int:
    from .headless import Headless
    prompt = args.headless
    if prompt in (None, "-"):
        prompt = " ".join(args.prompt) if args.prompt else sys.stdin.read()
    prompt = prompt.strip()
    if not prompt:
        raise KairosError("Nothing to send. Give a prompt: kairos -p \"...\"")
    conn = await connect(args, palette, interactive=False)
    try:
        choices = await chat.model_choices(conn)
        session = await pick_session(conn, args, interactive=False)
        session = await ensure_model(conn, session, args.model, choices)
        if not session.get("model_endpoint_id"):
            raise KairosError("This chat has no model. Pass --model <name>.")
        permissions = args.permissions
        if permissions == "ask" and not (sys.stdin.isatty() and sys.stderr.isatty()):
            permissions = "deny"
        return await Headless(conn, args.output_format, permissions).run(session["id"], prompt)
    finally:
        await conn.close()


async def run_interactive(args, palette, first: str | None = None, forge_task: dict | None = None) -> int:
    from .repl import Repl
    motion = not args.no_motion and palette.truecolor
    kip = Kip(palette, enabled=not args.no_mascot, motion=motion, ascii_only=palette.depth == "none")
    console = stdout_console(palette)
    conn = await connect(args, palette, interactive=True)
    try:
        choices = await chat.model_choices(conn)
        status = conn.status
        where = f"{'Kairos (' + status['instance'] + ')' if status.get('instance') else 'Kairos'} · {conn.base_url}"
        how = "paired in the app" if conn.paired else "signed in" if status.get("auth_enabled") else "open dev server"
        show_welcome(console, palette, kip, motion, [
            Text(where, palette.style("dim")),
            Text(f"{how} · {os.path.basename(os.getcwd()) or os.getcwd()}", palette.style("meta")),
            Text("/help for commands · ctrl+d to leave", palette.style("meta")),
        ])
        repl = Repl(conn, palette, kip, motion=motion, instance=args.instance or "")
        repl.choices = choices
        if forge_task:
            created = await forge_api.start(conn, forge_task["task"], worktree=forge_task["worktree"],
                                            mode=forge_task["mode"])
            session = await ensure_model(conn, created, args.model, choices)
            first = forge_task["task"]
        else:
            session = await pick_session(conn, args, interactive=True, repl=repl)
            session = await ensure_model(conn, session, args.model, choices)
        if not session.get("model_endpoint_id") and choices:
            console.print(Text("  This chat has no model yet. Choose one with /model.", palette.style("warn")))
        return await repl.run(session, choices, first_prompt=first)
    finally:
        await conn.close()


async def run_status(args, palette) -> int:
    console = stdout_console(palette)
    conn = await connect(args, palette, interactive=sys.stdin.isatty())
    try:
        status = conn.status
        snapshot = await conn.get("/api/chat/live/snapshot")
        choices = await chat.model_choices(conn)
        running = [r for r in (snapshot.get("runs") or {}).values() if r.get("status") == "processing"]
        rows = [
            ("attached", conn.base_url + (f"  ({status['instance']})" if status.get("instance") else "")),
            ("access", "paired in the app" + (f", terminal {conn.terminal_id}" if conn.terminal_id else "")
             if conn.paired else "signed in as " + str(status.get("username")) if status.get("auth_enabled")
             else "open dev server"),
            ("models", str(len(choices))),
            ("replies running", str(len(running))),
            ("theme", f"{palette.name}, {palette.depth} colour"),
        ]
        for label, value in rows:
            line = Text(f"  {label:<16}", palette.style("meta"))
            line.append(one_line(value, 120), palette.style("text"))
            console.print(line)
        return 0
    finally:
        await conn.close()


async def run_agents(args, palette) -> int:
    console = stdout_console(palette)
    conn = await connect(args, palette, interactive=sys.stdin.isatty())
    try:
        agents = await conn.get("/api/agents")
        inbox = await conn.get("/api/agents/inbox")
        names = {a["id"]: a.get("name") for a in agents}
        console.print(render.table_of([[a.get("name") or "", a.get("status") or "",
                                        one_line(a.get("status_detail") or "", 50), str(a.get("needs_you") or 0)]
                                       for a in agents], ["agent", "state", "doing", "needs you"], palette))
        for number, item in enumerate(inbox.get("items") or [], start=1):
            line = Text(f"  {number:>3}  ", palette.style("gold"))
            line.append(one_line(names.get(item.get("agent_id"), "agent"), 24) + "  ", palette.style("dim"))
            line.append(one_line(item.get("title"), 90), palette.style("text"))
            console.print(line)
        return 0
    finally:
        await conn.close()


async def run_login(args, palette) -> int:
    from .connection import Connection
    base_url = await attach(args.port, args.instance, start_app=not args.no_start)
    conn = Connection(base_url)
    try:
        status = await conn.refresh_status()
        if not status.get("auth_enabled"):
            print("This Kairos has accounts off; just run kairos and approve the terminal in the app.")
            return 0
        await conn.login()
        print(f"Signed in as {one_line(conn.status.get('username'), 60)} for this run.")
        print("Note: the session stays in this process only; run kairos to chat.")
        return 0
    finally:
        await conn.close()


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    sub, index = find_subcommand(argv)
    if sub:
        argv = argv[:index] + argv[index + 1:]
    args = build_parser(sub).parse_args(argv)
    headless = not sub and args.headless is not None
    palette = choose(None if args.theme == "auto" else args.theme, args.color,
                     probe=not headless and sys.stdout.isatty())
    try:
        if sub == "status":
            return asyncio.run(run_status(args, palette))
        if sub == "agents":
            return asyncio.run(run_agents(args, palette))
        if sub == "login":
            return asyncio.run(run_login(args, palette))
        if sub == "forge":
            task = {"task": " ".join(args.task), "worktree": args.worktree, "mode": "plan" if args.plan else "build"}
            return asyncio.run(run_interactive(args, palette, forge_task=task))
        if headless:
            return asyncio.run(run_headless(args, palette))
        if not (sys.stdin.isatty() and sys.stdout.isatty()):
            print("kairos: the interactive view needs a terminal. Use kairos -p for pipes and scripts.", file=sys.stderr)
            return 1
        return asyncio.run(run_interactive(args, palette, first=" ".join(args.prompt) or None))
    except KairosError as error:
        print(f"kairos: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
