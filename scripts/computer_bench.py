"""Measure the contained computer (vault: "Agents - Computer-Use Upgrade from
cua (Build Spec)" 5.5). Started by hand, by an admin, on this computer;
nothing schedules it, and the app never runs it.

    python scripts/computer_bench.py --oracle            # every task's reference solution
    python scripts/computer_bench.py --noop              # every task with nothing done
    python scripts/computer_bench.py --model ID --yes    # a model connection (uses its usage)

A task is a folder in scripts/computer_bench/tasks/: task.json (instruction,
start URL, desktop or not, variants, fixture pages) and task.py with
setup(env), oracle(env) and evaluate(env) -> 0..1. Pages are answered inside
the contained computer by its driver (FIXTURE_ORIGIN), so no public site,
account or purchase is involved, nothing crosses the filtered network, and
the local-app grant is untouched. A model run first runs the oracle: a
failing oracle is a broken task, not a weak model.

Each attempt records its score, steps, tokens (model runs), time and
trajectory. Results go to <Kairos data>/computer/bench/<time>/: results.json
and summary.md, with the trajectories beside them.
"""
from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import re
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TASKS = Path(__file__).resolve().parent / "computer_bench" / "tasks"
sys.path.insert(0, str(ROOT))

FIXTURE_HOST = "bench.kairos.test"
ORIGIN = "https://" + FIXTURE_HOST


@dataclass
class Task:
    name: str
    folder: Path
    spec: dict
    module: object

    @property
    def desktop(self) -> bool:
        return bool(self.spec.get("desktop"))

    @property
    def variants(self) -> list[dict]:
        return self.spec.get("variants") or [{}]

    def instruction(self, variant: dict) -> str:
        return self.spec["instruction"].format(origin=ORIGIN, **variant)

    def pages(self) -> dict:
        found = {}
        for path, file in (self.spec.get("pages") or {}).items():
            found[path] = {"body": (self.folder / file).read_text(encoding="utf-8"),
                           "type": "text/html" if file.endswith(".html") else "text/plain"}
        return found


def load_tasks(names: list[str] | None = None, root: Path = TASKS) -> list[Task]:
    tasks = []
    for folder in sorted(path for path in root.iterdir() if (path / "task.json").is_file()):
        spec = json.loads((folder / "task.json").read_text(encoding="utf-8"))
        if names and spec["name"] not in names:
            continue
        loader = importlib.util.spec_from_file_location(f"computer_bench_task_{folder.name}", folder / "task.py")
        module = importlib.util.module_from_spec(loader)
        loader.loader.exec_module(module)
        for hook in ("setup", "oracle", "evaluate"):
            if not callable(getattr(module, hook, None)):
                raise ValueError(f"task {spec['name']} has no {hook}()")
        tasks.append(Task(spec["name"], folder, spec, module))
    if names and len(tasks) != len(set(names)):
        missing = sorted(set(names) - {task.name for task in tasks})
        raise ValueError(f"unknown task(s): {', '.join(missing)}")
    return tasks


@dataclass
class Env:
    """What a task's setup, oracle and evaluate see: the same act() a model
    gets, with every refusal code noted, and direct driver commands for
    setting up and checking state (never offered to a model)."""
    manager: object
    owner: str
    ctx: object
    variant: dict
    origin: str = ORIGIN
    codes: list = field(default_factory=list)
    actions: int = 0
    notes: dict = field(default_factory=dict)

    async def act(self, action: str, **args) -> dict:
        try:
            result = await self.manager.act(self.owner, action, args, self.ctx)
        except ValueError as error:
            code = getattr(error, "code", None) or "failed"
            self.codes.append(code)
            return {"text": f"Not run: {error}", "images": [], "code": code}
        if result.get("code"):
            self.codes.append(result["code"])
        return result

    @staticmethod
    def ref(text: str, pattern: str) -> str:
        """The ref of the first row matching `pattern` in a read's reply."""
        found = re.search(r"\[((?:r|d)\d+:\d+)\] " + pattern, text)
        if not found:
            raise AssertionError(f"no row matching {pattern!r}")
        return found.group(1)

    async def wait_for(self, check, seconds: float = 30, every: float = 0.5):
        """Poll an async check until it returns something truthy."""
        deadline = time.monotonic() + seconds
        while True:
            try:
                value = await check()
                if value:
                    return value
            except (ValueError, KeyError, AssertionError):
                pass
            if time.monotonic() > deadline:
                raise AssertionError("timed out waiting for the computer")
            await asyncio.sleep(every)

    async def command(self, name: str, **args) -> dict:
        computer = await self.computer()
        return await self.manager._command(computer, name, **args)

    async def computer(self):
        computer = await self.manager._get(self.owner, is_admin=True)
        # `docker run` returns before the container exists; its driver's
        # first answer proves it is up.
        await self.manager._command(computer, "state")
        return computer

    async def page_has(self, text: str) -> bool:
        reply = await self.command("verify", expect={"text_present": text})
        return bool(reply["checks"][0]["met"])

    async def exec(self, *argv: str, data: bytes | None = None) -> subprocess.CompletedProcess:
        computer = await self.computer()
        return await asyncio.to_thread(subprocess.run, ["docker", "exec", "-i", computer.name, *argv],
                                       input=data, capture_output=True, timeout=30)

    async def file_text(self, path: str) -> str | None:
        done = await self.exec("cat", path)
        return done.stdout.decode(errors="replace") if done.returncode == 0 else None

    async def put_file(self, path: str, data: bytes) -> None:
        done = await self.exec("sh", "-c", 'cat > "$0"', path, data=data)
        if done.returncode:
            raise RuntimeError(f"could not place {path}: {done.stderr.decode(errors='replace')[:200]}")


class BenchManager:
    """A ComputerManager that also notes the codes of every action, so a
    model's refusals reach evaluate() the same way the oracle's do."""

    def __new__(cls, root: Path, desktop: bool, pages: dict):
        from core import computer

        class Noting(computer.ComputerManager):
            noted: list = []

            async def act(self, owner, action, args, ctx):
                try:
                    result = await super().act(owner, action, args, ctx)
                except ValueError as error:
                    self.noted.append(getattr(error, "code", None) or "failed")
                    raise
                self.noted.append(result.get("code"))
                return result

        manager = Noting(fixtures=pages, approved_hosts=(FIXTURE_HOST,), trajectories=root / "trajectories",
                         desktop=desktop)
        manager.noted = []
        return manager


def _context(session_id: str):
    from core import tool_registry
    from core.turn_taint import TurnTaint
    return tool_registry.ToolContext(session_id=session_id, is_admin=True, turn_taint=TurnTaint())


async def attempt(task: Task, variant: dict, mode: str, root: Path, endpoint: dict | None = None) -> dict:
    """One attempt: a fresh computer, setup, the mode's solver, evaluate."""
    from core import runs
    session_id = "bench-" + uuid.uuid4().hex[:12]
    manager = BenchManager(root, task.desktop, task.pages())
    env = Env(manager, "chat:" + session_id, _context(session_id), variant)
    context = runs.RunContext("bench", session_id=session_id, model=mode)
    token = runs.CURRENT.set(context)
    started, tokens, error, score = time.time(), None, None, 0.0
    try:
        await task.module.setup(env)
        if mode == "oracle":
            await task.module.oracle(env)
        elif mode != "noop":
            tokens = await model_solve(task, variant, env, endpoint, context)
        env.codes += [code for code in manager.noted if code and code not in env.codes]
        env.actions = len(manager.noted)
        score = float(await task.module.evaluate(env))
    except Exception as problem:  # a crash is a score of 0, with the reason
        error = f"{type(problem).__name__}: {problem}"[:500]
    finally:
        runs.CURRENT.reset(token)
        await manager.close_all()
    return {"task": task.name, "variant": variant, "mode": mode, "score": max(0.0, min(1.0, score)),
            "passed": score >= 1.0, "steps": len(manager.noted), "codes": sorted({c for c in manager.noted if c}),
            "tokens": tokens, "seconds": round(time.time() - started, 1), "trajectory": context.run_id, "error": error}


async def model_solve(task: Task, variant: dict, env: Env, endpoint: dict, context) -> int | None:
    """Give the instruction to a model connection with the computer tool,
    in this process: its computer calls reach this attempt's manager. Not
    run by any test; David starts the one approved run by hand."""
    from core import computer, runs, settings
    original_manager, original_setting = computer.manager, settings.get_setting
    computer.manager = env.manager
    settings.get_setting = lambda key: ({"enabled": True, "allow_non_admins": False, "allow_reactions": False,
                                         "desktop": task.desktop} if key == "computer_use" else original_setting(key))
    brain = None
    try:
        brain = build_brain(endpoint, env.ctx.session_id)
        if callable(getattr(brain, "connect", None)):
            await brain.connect()
        if isinstance(getattr(brain, "tools", None), list):
            # An API or local model sees only the computer tool here. Claude
            # Code keeps its own tool set: its brain has no narrower mode.
            brain.tools = [tool for tool in brain.tools if tool.get("function", {}).get("name") == "computer"]
        prompt = (task.instruction(variant) + "\n\nUse the computer tool. Call done when the task is finished, "
                  "or when the rest is for the person.")
        tally = runs.Tally()
        async for item in brain.events(prompt, stream=False):
            tally.add(item)
        return tally.usage.total_tokens if tally.usage else None
    finally:
        if brain is not None and callable(getattr(brain, "disconnect", None)):
            await brain.disconnect()
        computer.manager, settings.get_setting = original_manager, original_setting


def build_brain(endpoint: dict, session_id: str):
    """A brain for a connection, detached from any saved chat."""
    if endpoint["kind"] == "claude_cli":
        from core.brain import Brain
        import tempfile
        return Brain(session_id=session_id, is_admin=True, model=endpoint.get("model") or None,
                     cwd_override=tempfile.mkdtemp(prefix="kairos-" + session_id + "-"))
    if endpoint["kind"] == "codex_cli":
        raise ValueError("Codex runs its own computer use; benchmark Claude or an API or local connection")
    from core import model_endpoints
    from core.external_brain import ExternalBrain
    base_url, model, api_key, num_ctx = model_endpoints.resolve_runtime(endpoint["id"])
    return ExternalBrain(base_url, model, api_key, history=[], session_id=session_id, num_ctx=num_ctx, is_admin=True,
                         endpoint_id=endpoint["id"], supports_images=bool(endpoint.get("supports_images")))


def summarize(results: list[dict]) -> str:
    """The Markdown table: per task and mode, pass@k over its attempts."""
    rows, order = {}, []
    for result in results:
        key = (result["task"], result["mode"])
        if key not in rows:
            rows[key] = []
            order.append(key)
        rows[key].append(result)
    lines = ["| Task | Run | Attempts | Pass@k | Mean score | Steps | Tokens | Seconds |", "|---|---|---|---|---|---|---|---|"]
    for key in order:
        items = rows[key]
        tokens = [item["tokens"] for item in items if item["tokens"] is not None]
        lines.append(f"| {key[0]} | {key[1]} | {len(items)} | {'yes' if any(i['passed'] for i in items) else 'no'} | "
                     f"{sum(i['score'] for i in items) / len(items):.2f} | {sum(i['steps'] for i in items) / len(items):.1f} | "
                     f"{sum(tokens) if tokens else '-'} | {sum(i['seconds'] for i in items):.0f} |")
    errors = [f"- {r['task']} ({r['mode']}): {r['error']}" for r in results if r["error"]]
    return "\n".join(lines) + ("\n\nErrors:\n" + "\n".join(errors) if errors else "") + "\n"


async def run(modes: list[str], tasks: list[Task], attempts: int, out: Path, endpoints: dict | None = None,
              progress=print) -> list[dict]:
    out.mkdir(parents=True, exist_ok=True)
    results = []
    for task in tasks:
        broken = False
        for mode in modes:
            if mode not in ("oracle", "noop") and broken:
                results.append({"task": task.name, "variant": {}, "mode": mode, "score": 0.0, "passed": False, "steps": 0,
                                "codes": [], "tokens": None, "seconds": 0, "trajectory": None,
                                "error": "skipped: this task's oracle failed, so the task is broken"})
                continue
            count = len(task.variants) if mode in ("oracle", "noop") else attempts
            for index in range(count):
                variant = task.variants[index % len(task.variants)]
                result = await attempt(task, variant, mode, out, (endpoints or {}).get(mode))
                results.append(result)
                progress(f"{task.name:<16} {mode:<12} score {result['score']:.2f}"
                         + (f"  ({result['error']})" if result["error"] else ""))
                if mode == "oracle" and not result["passed"]:
                    broken = True
        (out / "results.json").write_text(json.dumps(results, indent=1), encoding="utf-8")
    (out / "summary.md").write_text(summarize(results), encoding="utf-8")
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Measure the contained computer on fixture tasks.")
    parser.add_argument("--oracle", action="store_true", help="run every task's reference solution")
    parser.add_argument("--noop", action="store_true", help="run every task with nothing done (must score 0)")
    parser.add_argument("--model", action="append", default=[], help="a model connection id; runs the oracle first")
    parser.add_argument("--yes", action="store_true", help="confirm that model runs use that connection's usage")
    parser.add_argument("--tasks", default="", help="comma-separated task names (default: all)")
    parser.add_argument("--attempts", type=int, default=1, help="attempts per task for model runs (pass@k)")
    parser.add_argument("--out", default="", help="results folder (default: <Kairos data>/computer/bench/<time>)")
    args = parser.parse_args(argv)
    from core import sandbox
    from core.constants import DATA_DIR
    if not (args.oracle or args.noop or args.model):
        parser.error("choose --oracle, --noop or --model")
    if args.model and not args.yes:
        parser.error("a model run uses that connection's usage; add --yes to confirm")
    if not 1 <= args.attempts <= 10:
        parser.error("--attempts is 1 to 10")
    ok, why = asyncio.run(sandbox.available())
    if not ok:
        print(f"Docker is not available: {why}")
        return 2
    endpoints = {}
    if args.model:
        from core import model_endpoints
        known = {item["id"]: item for item in model_endpoints.list_endpoints()}
        for ident in args.model:
            if ident not in known:
                parser.error(f"no model connection {ident}")
            endpoints[f"model:{ident}"] = known[ident]
    modes = (["oracle"] if args.oracle or args.model else []) + (["noop"] if args.noop else []) + list(endpoints)
    tasks = load_tasks([name for name in args.tasks.split(",") if name] or None)
    out = Path(args.out) if args.out else Path(DATA_DIR) / "computer" / "bench" / time.strftime("%Y%m%d-%H%M%S")
    results = asyncio.run(run(modes, tasks, args.attempts, out, endpoints))
    print("\n" + summarize(results) + f"\nResults: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
