"""Contained browsers keep web pages away from the person's desktop.

The host and Docker driver exchange numbered JSON lines on stdin/stdout. This
module enforces safety, never the model: new sites ask; buying, sending and
posting stop for the person; deleting asks; private fields and opaque frames
need the person. At most two computers run, and idle ones close after ten
minutes. Profiles start blank and are kept only for opted-in agents. See the
vault note "Computer Use (Build Spec)".
"""
import asyncio
import base64
import json
import logging
import os
import re
import time
import uuid
import socket
import ipaddress
from types import SimpleNamespace
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

from core import computer_image, computer_trajectory, permissions, sandbox, sandbox_browser, sandbox_egress
from core.computer_driver import SOURCE
from core.untrusted import wrap_untrusted
from core.constants import DATA_DIR

logger = logging.getLogger(__name__)
IDLE_SECONDS = 600
MAX_RUNNING = 2
REPLY_LIMIT = 32 * 1024 * 1024
# Live-view frames a second (David, 2026-10-07): smooth while the person has
# control on this computer, lighter while they only watch, and never more
# than WATCH_FPS for a Remote Access viewer (about 8 Mbit/s at 10).
WATCH_FPS, CONTROL_FPS = 10, 30
RECORDING_LIMIT = 200
PROFILES = Path(DATA_DIR) / "computer" / "profiles"
# These commitments belong to the person even when an agent or chat runs in Auto.
PERSON_ACTION_WORDS = re.compile(
    r"\b(?:buy|pay|purchase|order|place\s+order|checkout|check\s+out|subscribe|donate|transfer|"
    r"send|reply|forward|post|repost|retweet|publish|share|comment|submit|confirm)\b", re.I)
# Public reactions on the person's account (David, 2026-10-07): theirs too by
# default, but an admin may let the computer press them
# (computer_use.allow_reactions). Buying, sending and posting never relax.
REACTION_WORDS = re.compile(
    r"\b(?:like|unlike|follow|unfollow|upvote|downvote|react|favou?rite|star|heart)\b", re.I)
DELETE_WORDS = re.compile(r"\b(?:delete|remove)\b", re.I)
PRIVATE_FIELDS = {"current-password", "new-password", "one-time-code"}
# The driver's source arrives as the first stdin line, not on the command
# line: Windows caps a command line at 32,767 characters, and the driver
# passed that in phase 3 ("The filename or extension is too long").
# Benchmark fixture pages ride along only from a manager built with them
# (scripts/computer_bench.py); Kairos's own manager sends none.
BOOTSTRAP = ("import json, sys; m = json.loads(sys.stdin.readline()); exec(compile(m['driver'], "
             "'<kairos-computer-driver>', 'exec'), {'__name__': '__main__', 'FIXTURES': m.get('fixtures') or {}})")
# The action contract (vault: "Agents - Computer-Use Upgrade from cua (Build
# Spec)" 5.2): a batch of at most MAX_STEPS ordinary actions, each through
# the same checks as a single call.
MAX_STEPS = 16
# Model actions whose step keeps a before image (computer_trajectory).
TRACED_ACTIONS = ("open", "click", "type", "key", "scroll", "back", "launch")
STEP_ACTIONS = ("click", "type", "key", "scroll", "wait")
STEP_KEYS = {"action", "ref", "x", "y", "text", "key", "dx", "dy", "seconds", "desktop"}
EXPECT_KEYS = ("url_contains", "title_contains", "text_present", "text_absent", "element")
# Each refusal keeps its sentence and gains a short code, matched here from
# the sentence so no message changes (the audit classifies by prefix).
REFUSAL_CODES = (
    ("Stopped before pressing", "person_only"),
    ("embedded frame", "opaque_frame"),
    ("passwords, codes and payment details are entered by the person", "private_field"),
    ("only opens web addresses", "not_web_address"),
    ("agent desktop is", "needs_desktop"),
    ("the person has control", "person_in_control"),
    ("the computer was stopped", "computer_stopped"),
    ("That is the browser window", "use_web_actions"),
    ("could not identify the desktop window", "unknown_window"),
    ("unknown computer action", "unknown_action"),
    ("desktop coordinates apply", "bad_arguments"),
    ("choose files, editor", "bad_arguments"),
    ("Not pressed:", "not_approved"),
    ("Not opened:", "site_not_approved"),
)


class ComputerRefusal(ValueError):
    """A driver refusal that carries its code ("[stale_ref] That ref...")."""

    def __init__(self, message: str, code: str | None = None):
        super().__init__(message)
        self.code = code


def refusal_code(text: str) -> str | None:
    if not text.startswith(("Not ", "Stopped")):
        return None
    return next((code for needle, code in REFUSAL_CODES if needle in text), "refused")
DELETE_CHOICES = [{"id": "once", "label": "Allow once", "behavior": "allow", "scope": "once"},
                  {"id": "reject", "label": "Reject", "behavior": "deny", "scope": "once"}]
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}
LOCAL_CHOICES = [{"id": "once", "label": "Allow for this computer", "behavior": "allow", "scope": "once"},
                 {"id": "reject", "label": "Reject", "behavior": "deny", "scope": "once"}]


def _backend_ports() -> set[int]:
    # 2026-10-16: include the actual listener and Electron's instance scheme.
    from core import middleware, settings
    from core.constants import APP_PORT
    ports = {8420, 8421, 8422, 8430, 8431, APP_PORT, sandbox_egress.PROXY_PORT,
             sandbox_egress.CONTROL_PORT, urlsplit(middleware.local_api_base()).port,
             int(settings.get_setting("remote_access_port") or 8422)}
    if os.environ.get("JARVIS_PORT"):
        ports.add(int(os.environ["JARVIS_PORT"]))
    return ports


@dataclass
class Computer:
    owner: str
    proc: object
    name: str
    desktop: bool = False
    url: str = "about:blank"
    title: str = ""
    last_action: float = field(default_factory=time.monotonic)
    last_action_at: float = field(default_factory=time.time)
    screenshot: bytes | None = None
    frame_jpeg: bytes | None = None
    hosts: set[str] = field(default_factory=set)
    local_ports: set[int] = field(default_factory=set)
    local_ip: str | None = None
    local_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    local_revision: int = 0
    sequence: int = 0
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    snapshot_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    stderr_task: asyncio.Task | None = None
    taken_over: bool = False
    lease_id: str | None = None
    waiting_model: bool = False
    handback: asyncio.Event = field(default_factory=asyncio.Event)
    last_snapshot: float = -1.0
    # The driver's stdout carries replies and screencast frames; one reader
    # sorts them (_read), so the live view never waits behind a command.
    pending: dict = field(default_factory=dict)
    reader_task: asyncio.Task | None = None
    frame_seq: int = 0
    frame_changed: asyncio.Event = field(default_factory=asyncio.Event)
    watchers: int = 0
    local_watchers: int = 0
    cast_fps: int = 0
    recording: bool = False
    recording_id: str | None = None
    started_at: float = field(default_factory=time.time)
    steps: list[dict] = field(default_factory=list)


class ComputerManager:
    def __init__(self, process_factory=None, clock=None, fixtures: dict | None = None,
                 approved_hosts: tuple = (), trajectories: Path | None = None, desktop: bool | None = None):
        self.process_factory = process_factory or asyncio.create_subprocess_exec
        self.clock = clock or time.monotonic
        # Only the benchmark harness (scripts/computer_bench.py) passes these:
        # its fixture pages, the fixture host already approved, its own
        # trajectory folder, and whether its computers have the desktop.
        self.fixtures = fixtures or {}
        self.approved_hosts = set(approved_hosts)
        self.trajectories = trajectories  # None: Kairos's own trajectory folder
        self.desktop = desktop  # None: Settings > Computer use decides
        self._computers: dict[str, Computer] = {}
        self._closed: dict[str, tuple[float, dict]] = {}
        self._lock = asyncio.Lock()
        self._idle_task: asyncio.Task | None = None
        self.starting: set[str] = set()
        self.errors: dict[str, str] = {}
        self._waiters: list[str] = []

    def wait_position(self, owner: str) -> int:
        return self._waiters.index(owner) + 1 if owner in self._waiters else 0

    @staticmethod
    def _protected(c: Computer) -> bool:
        return c.taken_over or c.waiting_model or c.recording or c.lock.locked()

    def _place(self, owner, thread_id=None):
        from services.bot_workbench import effective_place
        place = effective_place(owner, thread_id)["effective"]
        if place == "off":
            raise ComputerRefusal("Computer use is off for this bot or conversation", "place_off")
        return place

    def _desktop_wanted(self) -> bool:
        return _desktop_enabled() if self.desktop is None else self.desktop

    def running(self) -> list[dict]:
        return [{"owner": c.owner, "url": c.url, "title": c.title, "last_action": c.last_action_at,
                 "taken_over": c.taken_over, "waiting_model": c.waiting_model, "desktop": c.desktop,
                 "recording": c.recording, "lease_id": c.lease_id, "started_at": c.started_at, "steps": c.steps[-20:]}
                for c in self._computers.values()]

    def screenshot(self, owner: str) -> bytes | None:
        c = self._computers.get(owner)
        return c.screenshot if c else None

    def is_running(self, owner: str) -> bool:
        return owner in self._computers

    def forget(self, owner: str) -> None:
        self._closed.pop(owner, None)

    def last(self, owner: str) -> dict | None:
        self._expire_frames()
        saved = self._closed.get(owner)
        return dict(saved[1]) if saved else None

    def _expire_frames(self):
        for owner, (deadline, _) in list(self._closed.items()):
            if self.clock() >= deadline:
                self._closed.pop(owner, None)

    async def _drain_stderr(self, proc):
        while line := await proc.stderr.readline():
            logger.debug("computer driver: %s", line.decode(errors="replace").rstrip())

    async def _start(self, owner: str, is_admin: bool = True) -> Computer:
        desktop = is_admin and self._desktop_wanted() and self._place(owner) != "browser"
        ok, why = await sandbox.available()
        if not ok:
            raise sandbox.SandboxUnavailable(why)
        try:
            await sandbox_egress.ensure(sandbox_browser.BROWSER_IMAGE)
        except RuntimeError as e:
            raise sandbox.SandboxUnavailable(f"no filtered network: {e}") from e
        image = await computer_image.ensure_image(desktop=desktop)
        profile_args = ["--tmpfs", "/profile:rw,nosuid,nodev,size=256m"]
        if owner.startswith("agent:"):
            from services.agent_service import agent_service
            agent_id = owner.removeprefix("agent:")
            agent = agent_service.get(agent_id)
            from services.bot_browser_profiles import resolve
            profile = resolve(agent) if agent else None
            if profile is not None:
                profile.mkdir(parents=True, exist_ok=True)
                target = profile.resolve()
                if PROFILES.resolve() not in target.parents:
                    raise ValueError("profile path is outside Kairos data")
                profile_args = ["--mount", f"type=bind,src={target},dst=/profile"]
        name = "jarvis-computer-" + uuid.uuid4().hex[:12]
        args = ["docker", "run", "-i", "--rm", "--name", name, "--label", sandbox.LABEL,
                *sandbox.hardening_args("2g" if desktop else "1g", "1", 512, network=True), *profile_args,
                "-e", "HOME=/profile", "-e", "PYTHONDONTWRITEBYTECODE=1",
                "-e", f"KAIROS_COMPUTER_PROXY={sandbox_egress.PROXY_URL}",
                "-e", f"KAIROS_COMPUTER_DESKTOP={int(desktop)}",
                image, "python3", "-u", "-c", BOOTSTRAP]
        try:
            # A reply carries a whole screenshot on one line, far past asyncio's
            # 64 KiB default line limit.
            proc = await self.process_factory(*args, stdin=asyncio.subprocess.PIPE,
                                              stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                                              limit=REPLY_LIMIT)
        except (FileNotFoundError, OSError) as e:
            raise sandbox.SandboxUnavailable(f"Docker did not start: {e}") from e
        proc.stdin.write((json.dumps({"driver": SOURCE, **({"fixtures": self.fixtures} if self.fixtures else {})}) + "\n").encode())
        c = Computer(owner, proc, name, desktop=desktop, last_action=self.clock(), hosts=set(self.approved_hosts))
        c.stderr_task = asyncio.create_task(self._drain_stderr(proc))
        c.reader_task = asyncio.create_task(self._read(c))
        return c

    async def _read(self, c: Computer):
        """Route each stdout line: a frame to the live view, a reply to its command."""
        try:
            while line := await c.proc.stdout.readline():
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                if message.get("event") == "step":
                    if (c.taken_over and c.recording and message.get("recording_id") == c.recording_id
                            and len(c.steps) < RECORDING_LIMIT and isinstance(message.get("step"), dict)):
                        c.steps.append(message["step"])
                    continue
                if message.get("event") == "frame":
                    try:
                        c.frame_jpeg = base64.b64decode(message["data"])
                    except (KeyError, ValueError):
                        continue
                    c.frame_seq += 1
                    changed, c.frame_changed = c.frame_changed, asyncio.Event()
                    changed.set()
                    continue
                waiter = c.pending.pop(message.get("id"), None)
                if waiter and not waiter.done():
                    waiter.set_result(message)
        finally:
            c.recording, c.recording_id = False, None
            c.steps.clear()
            for waiter in c.pending.values():
                if not waiter.done():
                    waiter.set_exception(sandbox.SandboxUnavailable("the contained computer stopped"))
            c.pending.clear()
            c.frame_changed.set()
            # 2026-10-16: an unexpected driver exit also ends its grants.
            if self._computers.get(c.owner) is c:
                asyncio.create_task(self.stop(c.owner))

    async def _get(self, owner: str, is_admin: bool = True, thread_id=None) -> Computer:
        from services.bot_workbench import computer_settings
        # A per-thread pin is scoped to this task, not mutable manager state.
        from core import runs
        token = None
        if thread_id:
            agent_id = owner[6:] if owner.startswith("agent:") else None
            token = runs.CURRENT.set(runs.RunContext(surface="chat", agent_id=agent_id, session_id=thread_id))
        try:
            while True:
                place = self._place(owner, thread_id)
                async with self._lock:
                    await self._close_idle()
                    current = self._computers.get(owner)
                    if current and place == "browser" and current.desktop:
                        if self._protected(current):
                            raise ComputerRefusal("Hand back the computer before changing its place", "person_in_control")
                        await self._stop(owner)
                    if owner in self._computers:
                        return self._computers[owner]
                    cap = computer_settings()["max_running"]
                    turn = not self._waiters or self._waiters[0] == owner
                    if turn and len(self._computers) >= cap:
                        idle = [c for c in self._computers.values() if not self._protected(c)]
                        if idle:
                            await self._stop(min(idle, key=lambda c: c.last_action).owner)
                    if turn and len(self._computers) < cap:
                        if owner in self._waiters:
                            self._waiters.remove(owner)
                        self.starting.add(owner)
                        self.errors.pop(owner, None)
                        try:
                            self._computers[owner] = await self._start(owner, is_admin=is_admin)
                        except Exception as error:
                            self.errors[owner] = str(error)[:280]
                            raise
                        finally:
                            self.starting.discard(owner)
                        self.forget(owner)
                        if self._idle_task is None or self._idle_task.done():
                            self._idle_task = asyncio.create_task(self._idle_loop())
                        return self._computers[owner]
                    if owner not in self._waiters:
                        self._waiters.append(owner)
                # No lock is held while waiting. Stop/hand-back/settings stay usable.
                await asyncio.sleep(0.25)
        finally:
            if owner in self._waiters:
                self._waiters.remove(owner)
            if token is not None:
                runs.CURRENT.reset(token)

    async def _command(self, c: Computer, action: str, **kwargs) -> dict:
        if action.startswith(("watch_", "record_")):
            return await self._send(c, action, **kwargs)
        async with c.lock:
            return await self._send(c, action, **kwargs)

    async def _send(self, c: Computer, action: str, **kwargs) -> dict:
        if c.reader_task is None or c.reader_task.done():
            raise sandbox.SandboxUnavailable("the contained computer stopped")
        c.sequence += 1
        ident = c.sequence
        waiter = asyncio.get_running_loop().create_future()
        c.pending[ident] = waiter
        c.proc.stdin.write((json.dumps({"id": ident, "action": action, **kwargs}) + "\n").encode())
        await c.proc.stdin.drain()
        try:
            reply = await asyncio.wait_for(waiter, 45)
        except asyncio.TimeoutError as e:
            raise sandbox.SandboxUnavailable("the contained computer did not answer") from e
        finally:
            c.pending.pop(ident, None)
        if reply.get("error"):
            coded = re.match(r"\[([a-z_]+)\] (.*)", reply["error"], re.S)
            raise ComputerRefusal(coded.group(2), coded.group(1)) if coded else ValueError(reply["error"])
        return reply

    async def _stop(self, owner: str):
        c = self._computers.pop(owner, None)
        if c is None:
            return
        async with c.local_lock:
            c.local_revision += 1
            c.local_ports.clear()
            if c.local_ip:
                try:
                    await sandbox_egress.set_grants(c.local_ip, set())
                except RuntimeError:
                    logger.exception("could not clear stopped computer's local app grants")
        from core.computer_history import jpeg
        image = jpeg(c.screenshot) if c.screenshot else None
        self._closed[owner] = (self.clock() + IDLE_SECONDS, {
            "owner": owner, "url": c.url, "title": c.title, "last_action": c.last_action_at,
            "closed_at": time.time(), "taken_over": False, "waiting_model": False,
            "desktop": c.desktop, "recording": False,
            "image": base64.b64encode(image).decode() if image else "",
        })
        c.taken_over = False
        self._discard_recording(c)
        c.handback.set()
        try:
            c.proc.stdin.close()
            await asyncio.wait_for(c.proc.wait(), 2)
        except (OSError, asyncio.TimeoutError):
            try:
                c.proc.kill()
                await c.proc.wait()
            except ProcessLookupError:
                pass
        for task in (c.stderr_task, c.reader_task):
            if task:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    async def stop(self, owner: str):
        async with self._lock:
            await self._stop(owner)

    async def close_all(self):
        async with self._lock:
            for owner in list(self._computers):
                await self._stop(owner)
        if self._idle_task:
            self._idle_task.cancel()
            self._idle_task = None
        self._closed.clear()

    async def _close_idle(self):
        from services.bot_workbench import computer_settings
        for c in list(self._computers.values()):
            if not self._protected(c) and self.clock() - c.last_action >= computer_settings()["idle_minutes"] * 60:
                await self._stop(c.owner)

    async def _idle_loop(self):
        try:
            while self._computers or self._closed:
                await asyncio.sleep(30)
                async with self._lock:
                    await self._close_idle()
                    self._expire_frames()
        except asyncio.CancelledError:
            pass

    async def revoke_local_apps(self, owner: str) -> None:
        c = self._computers.get(owner)
        if c is None:
            return
        try:
            async with c.local_lock:
                c.local_revision += 1
                c.local_ports.clear()
                if c.local_ip:
                    await sandbox_egress.set_grants(c.local_ip, set())
        except RuntimeError:
            await self.stop(owner)
            raise

    async def _site(self, c: Computer, host: str, ctx, url: str = "",
                    prompt_local: bool = False) -> tuple[bool, str]:
        if host in LOCAL_HOSTS:
            parsed = urlsplit(url)
            port = parsed.port
            if port is None:
                return False, "local apps need an explicit port in the URL."
            if port in _backend_ports():
                return False, f"port {port} belongs to Kairos's backend or proxy and cannot be granted."
            async with c.local_lock:
                if port in c.local_ports:
                    return True, ""
                if not prompt_local:
                    return False, f"local app at {url} is not approved or was revoked; explicitly open its URL to ask."
                revision = c.local_revision
            decision = await permissions.decide(surface=ctx.permission_surface, tool="computer_local_app",
                arguments={"url": url}, target=f"{host}:{port}",
                title=f"Let the computer open your local app at {url}",
                description="Allow this port for this computer until revoked or the computer closes.",
                choices=LOCAL_CHOICES, is_admin=ctx.is_admin, force_prompt=True)
            if decision.behavior != "allow":
                return False, f"local app at {url} was not approved. {decision.reason}"
            async with c.local_lock:
                if self._computers.get(c.owner) is not c or revision != c.local_revision:
                    return False, "the computer was stopped or local app access was revoked while waiting for approval."
                try:
                    c.local_ip = c.local_ip or await sandbox_egress.container_ip(c.name)
                    await sandbox_egress.set_grants(c.local_ip, c.local_ports | {port})
                except (RuntimeError, ValueError) as error:
                    return False, str(error)
                c.local_ports.add(port)
                return True, ""
        if host in c.hosts:
            return True, ""
        decision = await permissions.decide(surface=ctx.permission_surface, tool="computer_site",
            arguments={"url": f"https://{host}"}, target=host,
            title=f"Let the computer open {host}", description=f"Open {host} in the contained computer.",
            is_admin=ctx.is_admin)
        if decision.behavior != "allow":
            return False, decision.reason
        c.hosts.add(host)
        return True, ""

    async def _retreat(self, c: Computer):
        try:
            previous = await self._command(c, "back")
            url = previous.get("url") or "about:blank"
            host = urlsplit(url).hostname
            if (host and (host.lower() not in c.hosts and not
                    (host.lower() in LOCAL_HOSTS and urlsplit(url).port in c.local_ports))) or (not host and url != "about:blank"):
                await self.stop(c.owner)
                return
            c.url, c.title = url, previous.get("title") or ""
            if previous.get("screenshot"):
                c.screenshot = base64.b64decode(previous["screenshot"])
        except (ValueError, sandbox.SandboxUnavailable):
            await self.stop(c.owner)

    async def act(self, owner: str, action: str, args: dict, ctx) -> dict:
        """One model action, or a batch (`steps`). A refusal's reply gains a
        `code`; a driver refusal raises ComputerRefusal with its code."""
        try:
            place = self._place(owner, getattr(ctx, "session_id", None))
        except ComputerRefusal as error:
            return {"text": f"Not run: {error}", "images": [], "code": error.code}
        if place == "browser" and (args.get("desktop") or action in ("launch", "windows")
                                    or re.fullmatch(r"d\d+:\d+", str(args.get("ref") or ""))):
            return {"text": "Not run: this conversation uses the browser only", "images": [], "code": "needs_desktop"}
        run_id = _trajectory_run(owner, ctx) if action not in ("steps", "done") else None
        before, not_before = (await self._before(owner, action, args)) if run_id and action in TRACED_ACTIONS else (None, "")
        try:
            if action == "steps":
                result = await self._steps(owner, args, ctx)
            else:
                result = await self._act_one(owner, action, args, ctx)
        except ValueError as error:
            if run_id:
                failed = {"text": f"Not run: {error}", "code": getattr(error, "code", None) or "failed"}
                await asyncio.to_thread(computer_trajectory.record, owner, run_id, action, args, failed, before,
                                        not_before, self.trajectories)
            raise
        code = result.get("code") or refusal_code(result["text"])
        if code:
            result["code"] = code
        if run_id:
            await asyncio.to_thread(computer_trajectory.record, owner, run_id, action, args, result, before,
                                    not_before, self.trajectories)
        return result

    async def _before(self, owner: str, action: str, args: dict) -> tuple[bytes | None, str]:
        """The target as it is just before a model action, for its step's
        before image; never while the person has control."""
        c = self._computers.get(owner)
        if c is None:
            return None, "the computer was not running yet"
        if c.taken_over:
            return None, "the person had control of the computer"
        desktop = c.desktop and (args.get("desktop") is True or action == "launch"
                                 or re.fullmatch(r"d\d+:\d+", str(args.get("ref") or "")) is not None)
        try:
            reply = await self._command(c, "capture", desktop=desktop)
            return base64.b64decode(reply.get("screenshot") or ""), ""
        except (ValueError, sandbox.SandboxUnavailable):
            return None, "the before image could not be taken"

    async def _steps(self, owner: str, args: dict, ctx) -> dict:
        """Run up to MAX_STEPS click/type/key/scroll/wait actions with one
        observation at the end. Every step is checked before the first runs
        and then goes through act(), so a batch grants nothing a single call
        lacks. It stops at the first refusal, failure or new host."""
        steps, problem = _check_steps(args.get("steps"))
        if problem:
            return {"text": f"Not run: {problem} Nothing ran.", "images": [], "code": "bad_arguments"}
        lines, stop, code, ran = [], None, None, 0
        for index, step in enumerate(steps, 1):
            action = step["action"]
            step_args = {key: value for key, value in step.items() if key != "action"}
            running = self._computers.get(owner)
            before = urlsplit(running.url).hostname if running else None
            label = _step_label(step)
            try:
                result = await self.act(owner, action, step_args, ctx)
            except ComputerRefusal as error:
                result = {"text": f"Not run: {error}", "images": [], "code": error.code}
            except ValueError as error:
                result = {"text": f"Not run: {error}", "images": [], "code": "step_failed"}
            text = result["text"].split("\n", 1)[0]
            if result.get("code"):
                stop, code = f"{index}. {label}: {text} (code: {result['code']})", result["code"]
                break
            ran = index
            lines.append(f"{index}. {label}: done.")
            running = self._computers.get(owner)
            after = urlsplit(running.url).hostname if running else None
            if after != before and index < len(steps):
                stop = f"Stopped after step {index}: the page moved to {after or 'a blank page'}; look before going on."
                break
        summary = f"Steps: {ran} of {len(steps)} ran."
        if stop and code:
            summary = f"Stopped: at step {ran + 1} of {len(steps)}. " + summary
        if stop:
            lines.append(stop)
        if ran and stop:
            lines.append(f"Step{'s 1 to ' + str(ran) if ran > 1 else ' 1'} already ran and {'were' if ran > 1 else 'was'} not undone.")
        images, observed = [], ""
        running = self._computers.get(owner)
        if running and code not in ("person_in_control", "computer_stopped"):
            try:
                final = await self._act_one(owner, "read", {"since": "latest", "screenshot": True}, ctx)
                images = final["images"]
                observed = "\n\n" + final["text"].split("\n", 1)[-1].lstrip("\n") if "\n" in final["text"] else ""
            except ValueError as error:
                observed = f"\n\nCould not read the page afterwards: {error}"
        running = self._computers.get(owner)
        url = running.url if running else "about:blank"
        head = summary if code else f"URL: {url} | {summary}"
        result = {"text": head + "\n" + "\n".join(lines) + (f"\nURL: {url}" if code else "") + observed, "images": images}
        if code:
            result["code"] = code
        return result

    async def _act_one(self, owner: str, action: str, args: dict, ctx) -> dict:
        existing = self._computers.get(owner)
        if existing and existing.taken_over:
            existing.waiting_model = True
            try:
                deadline = self.clock() + IDLE_SECONDS
                while existing.taken_over and self._computers.get(owner) is existing:
                    remaining = deadline - self.clock()
                    if remaining <= 0:
                        return {"text": "Not run: the person has control of the computer.", "images": []}
                    try:
                        await asyncio.wait_for(existing.handback.wait(), min(remaining, 0.25))
                    except asyncio.TimeoutError:
                        pass
                if self._computers.get(owner) is not existing:
                    return {"text": "Not run: the computer was stopped.", "images": []}
            finally:
                existing.waiting_model = False
        if action == "done":
            previous = self._computers.get(owner)
            url = previous.url if previous else "about:blank"
            await self.stop(owner)
            return {"text": f"URL: {url} | Computer closed.", "images": []}
        wants_desktop = (action in ("launch", "windows") or args.get("desktop") is True
                         or action in ("click", "type") and re.fullmatch(r"d\d+:\d+", str(args.get("ref") or "")) is not None)
        if wants_desktop and not (existing.desktop if existing else self._desktop_wanted() and ctx.is_admin):
            return {"text": "Not run: the agent desktop is off. An admin can switch it on in Settings > Computer use; the change applies at the next start.", "images": []}
        c = await self._get(owner, is_admin=ctx.is_admin, thread_id=getattr(ctx, "session_id", None) if owner.startswith("agent:") else None)
        if c.desktop and not ctx.is_admin:
            return {"text": "Not run: the agent desktop is limited to admins.", "images": []}
        desktop_action = wants_desktop or action == "screenshot" and c.desktop and args.get("desktop") is not False
        if desktop_action and action not in ("launch", "windows", "click", "type", "key", "scroll", "screenshot", "read", "verify"):
            return {"text": "Not run: desktop coordinates apply to click, type, key, scroll or screenshot.", "images": []}
        command, info, note = {}, {}, ""
        if action != "open":
            current = await self._command(c, "state")
            url = current.get("url") or "about:blank"
            host = urlsplit(url).hostname
            if urlsplit(url).scheme not in ("http", "https") and url != "about:blank":
                await self._retreat(c)
                return {"text": f"Not opened: the computer only opens web addresses. URL: {url}", "images": []}
            if host:
                allowed, reason = await self._site(c, host.lower(), ctx, url=url)
                if not allowed:
                    await self._retreat(c)
                    return {"text": f"Not opened: {reason} URL: {url}", "images": []}
            c.url, c.title = url, current.get("title") or ""
            command["expected_url"] = url
        if desktop_action:
            try:
                return await self._desktop_act(c, action, args, ctx)
            except sandbox.SandboxUnavailable:
                await self.stop(owner)
                raise
        if action == "open":
            url = sandbox_browser._check_url(args.get("url") or "")
            if urlsplit(url).username or urlsplit(url).password:
                raise ValueError("addresses with sign-in details are not allowed")
            host = urlsplit(url).hostname.lower()
            allowed, reason = await self._site(c, host, ctx, url=url, prompt_local=True)
            if not allowed:
                return {"text": f"Not opened: {reason}", "images": []}
            command["url"] = url
        elif action in ("click", "type"):
            command.update({k: args[k] for k in ("x", "y", "ref") if k in args})
            inspected = await self._command(c, "inspect", **command)
            info, note = inspected.get("element") or {}, inspected.get("note") or ""
            if action == "type" and not info:
                info = (await self._command(c, "focused", expected_url=c.url)).get("element") or {}
            if info.get("opaque_frame"):
                _needs_frame_person(owner, c.url)
                return {"text": _opaque_frame_message() if action == "click" else
                        f"Not typed: this embedded frame cannot be inspected. Ask the person to take over. URL: {c.url}",
                        "images": []}
            if action == "type" and _private(info):
                _needs_person(owner, c.url)
                return {"text": "Not typed: passwords, codes and payment details are entered by the person. Ask them to take over the computer. "
                        f"URL: {c.url}", "images": []}
            if action == "click":
                stopped = await self._press_guard(c, info, ctx)
                if stopped:
                    return {"text": stopped, "images": []}
            command["expected"] = info
            if action == "type": command["text"] = args.get("text") or ""
        elif action == "key":
            command["key"] = args.get("key") or ""
            info = (await self._command(c, "focused", expected_url=c.url)).get("element") or {}
            if info.get("opaque_frame"):
                _needs_frame_person(owner, c.url)
                return {"text": f"Not pressed: this embedded frame cannot be inspected. Ask the person to take over. URL: {c.url}",
                        "images": []}
            command["expected"] = info
            if _private(info) and command["key"].lower() not in ("tab", "shift+tab", "escape"):
                _needs_person(owner, c.url)
                return {"text": "Not typed: passwords, codes and payment details are entered by the person. Ask them to take over the computer. "
                        f"URL: {c.url}", "images": []}
            key = command["key"].lower().split("+")[-1]
            if key in ("enter", "return", "numpadenter", "space", "spacebar"):
                stopped = await self._press_guard(c, info, ctx, enter=key in ("enter", "return", "numpadenter"))
                if stopped:
                    return {"text": stopped, "images": []}
        elif action == "scroll":
            command.update(dx=args.get("dx", 0), dy=args.get("dy", 0))
        elif action == "wait":
            command["seconds"] = min(10, max(0, float(args.get("seconds", 1))))
        elif action == "read":
            problem = _read_problem(args)
            if problem:
                return {"text": f"Not run: {problem}", "images": [], "code": "bad_arguments"}
            command.update({key: args[key] for key in ("query", "since", "max_elements") if args.get(key) not in (None, "")})
            # A read is text; the driver adds a screenshot only when the caller asks (screenshot: true).
            command["screenshot"] = args.get("screenshot") is True
        elif action == "verify":
            expect, problem = _check_expect(args.get("expect"))
            if problem:
                return {"text": f"Not run: {problem}", "images": [], "code": "bad_arguments"}
            command["expect"] = expect
        elif action not in ("screenshot", "back"):
            return {"text": f"Not run: unknown computer action {action}", "images": []}
        try:
            reply = await self._command(c, action, **command)
        except sandbox.SandboxUnavailable:
            await self.stop(owner)
            raise
        if action == "verify":
            c.last_action = self.clock()
            c.last_action_at = time.time()
            checks = reply.get("checks") or []
            met = bool(checks) and all(check["met"] for check in checks)
            lines = [f"- {check['check']} {json.dumps(check['expected'], ensure_ascii=False)}: "
                     f"{'met' if check['met'] else 'not met'} ({check['found']})" for check in checks]
            if ctx.turn_taint:
                ctx.turn_taint.mark("computer page")
            return {"text": f"URL: {reply.get('url') or c.url} | Verify: {'met' if met else 'not met'}.\n"
                    + wrap_untrusted("what the contained computer's page shows", "\n".join(lines)),
                    "images": [], "met": met}
        c.last_action = self.clock()
        c.last_action_at = time.time()
        new_url = reply.get("url") or c.url
        if urlsplit(new_url).scheme not in ("http", "https") and new_url != "about:blank":
            await self._retreat(c)
            return {"text": f"Not opened: the computer only opens web addresses. URL: {c.url}", "images": []}
        new_host = urlsplit(new_url).hostname
        if new_host:
            allowed, reason = await self._site(c, new_host.lower(), ctx, url=new_url)
            if not allowed:
                await self._retreat(c)
                return {"text": f"Not opened: {reason}", "images": []}
        c.url, c.title = new_url, reply.get("title") or ""
        if reply.get("screenshot"):
            c.screenshot = base64.b64decode(reply["screenshot"])
        detail = f"URL: {c.url} | Title: {c.title} | {action} completed."
        if note:
            detail += " " + note
        if action == "read":
            detail += _read_text(reply)
        if ctx.turn_taint:
            ctx.turn_taint.mark("computer page")
        result = {"text": detail, "images": [c.screenshot] if reply.get("screenshot") else []}
        if reply.get("point"):
            result["point"] = reply["point"]
        if action == "read":
            result["state"] = {key: reply[key] for key in ("snapshot", "elements", "diff", "query") if key in reply}
        if info:
            result["element"] = {key: info[key] for key in ("label", "role", "tag", "type", "autocomplete") if key in info}
        return result

    async def _desktop_act(self, c: Computer, action: str, args: dict, ctx) -> dict:
        if action == "launch" and args.get("app") not in computer_image.DESKTOP_APPS:
            return {"text": "Not run: choose files, editor, pdf, images, writer, calc or impress.", "images": []}
        if action in ("read", "verify"):
            return await self._desktop_read(c, action, args, ctx)
        ref = str(args.get("ref") or "")
        if action in ("click", "type") and ref:
            return await self._desktop_ref(c, action, ref, args, ctx)
        if action in ("type", "key"):
            # The focused control decides, as on the web: a password field is
            # the person's, and Enter or Space presses what it would press.
            focus = await self._command(c, "desktop_focused", expected_url=c.url)
            focused = focus.get("element") or {}
            key = str(args.get("key") or "").lower()
            if focused.get("private") and (action == "type" or key not in ("tab", "shift+tab", "escape")):
                _needs_person(c.owner, c.url)
                return {"text": "Not typed: passwords, codes and payment details are entered by the person. "
                        "Ask them to take over the computer. URL: desktop", "images": []}
            last = key.split("+")[-1]
            if action == "key" and last in ("enter", "return", "kp_enter", "space"):
                pressed = [_desktop_control(focused)] + ([_desktop_control(row) for row in focus.get("defaults") or []]
                                                          if last != "space" else [])
                stopped = await self._press_guard(c, {**pressed[0], "form_submits": pressed[1:]}, ctx, enter=True,
                                                  place=_desktop_place(focused))
                if stopped:
                    return {"text": stopped, "images": []}
        async with c.lock:
            if action in ("click", "type", "key", "scroll"):
                values = {k: args[k] for k in ("x", "y", "text", "key", "dx", "dy") if k in args}
                if action in ("click", "scroll"):
                    info = await self._send(c, "window_at", expected_url=c.url, **{k: values[k] for k in ("x", "y") if k in values})
                else:
                    info = await self._send(c, "focused_window", expected_url=c.url)
                info = {k: (info.get("window") or {}).get(k, "") for k in ("id", "class", "title")}
                if any(word in info["class"].lower() for word in ("chromium", "chrome", "kairos-computer-browser")):
                    return {"text": "Not run: That is the browser window: use the computer's web actions (open, read, click by ref) so its safety checks apply.", "images": []}
                if not info["class"]:
                    return {"text": "Not run: could not identify the desktop window; ask the person to take over.", "images": []}
                if c.taken_over:
                    return {"text": "Not run: the person has control of the computer.", "images": []}
                reply = await self._send(c, "desktop_input", kind=action, expected_window=info, expected_url=c.url, **values)
            else:
                reply = await self._send(c, "desktop_screenshot" if action == "screenshot" else action,
                                         expected_url=c.url, **({"app": args["app"]} if action == "launch" else {}))
        c.last_action = self.clock()
        c.last_action_at = time.time()
        new_url = reply.get("url") or c.url
        if urlsplit(new_url).scheme not in ("http", "https") and new_url != "about:blank":
            await self._retreat(c)
            return {"text": f"Not opened: the computer only opens web addresses. URL: {c.url}", "images": []}
        new_host = urlsplit(new_url).hostname
        if new_host:
            allowed, reason = await self._site(c, new_host.lower(), ctx, url=new_url)
            if not allowed:
                await self._retreat(c)
                return {"text": f"Not opened: {reason}", "images": []}
        c.url, c.title = new_url, reply.get("title") or ""
        c.screenshot = base64.b64decode(reply["screenshot"])
        detail = f"URL: {c.url} | Desktop {action} completed."
        if action == "windows": detail += "\n" + json.dumps(reply.get("windows", []))
        if ctx.turn_taint: ctx.turn_taint.mark("computer desktop")
        result = {"text": detail, "images": [c.screenshot]}
        if action == "click" and "x" in args and "y" in args:
            result["point"] = {"x": args["x"], "y": args["y"]}
        return result

    async def _desktop_read(self, c: Computer, action: str, args: dict, ctx) -> dict:
        """The focused window's controls by AT-SPI, as refs d<n>:<k>; or a
        verify against them. Labels are untrusted text: the turn is tainted."""
        if action == "verify":
            expect, problem = _check_expect(args.get("expect"))
            if problem:
                return {"text": f"Not run: {problem}", "images": [], "code": "bad_arguments"}
            reply = await self._command(c, "desktop_verify", expected_url=c.url, expect=expect)
            checks = reply.get("checks") or []
            met = bool(checks) and all(check["met"] for check in checks)
            lines = [f"- {check['check']} {json.dumps(check['expected'], ensure_ascii=False)}: "
                     f"{'met' if check['met'] else 'not met'} ({check['found']})" for check in checks]
            if ctx.turn_taint: ctx.turn_taint.mark("computer desktop")
            return {"text": f"URL: {c.url} | Desktop verify: {'met' if met else 'not met'}.\n"
                    + wrap_untrusted("what the contained computer's desktop shows", "\n".join(lines)), "images": [], "met": met}
        problem = _read_problem(args)
        if problem:
            return {"text": f"Not run: {problem}", "images": [], "code": "bad_arguments"}
        reply = await self._command(c, "desktop_read", expected_url=c.url,
                                    **{key: args[key] for key in ("query", "since", "max_elements") if args.get(key) not in (None, "")})
        c.last_action = self.clock()
        c.last_action_at = time.time()
        c.screenshot = base64.b64decode(reply["screenshot"])
        if ctx.turn_taint: ctx.turn_taint.mark("computer desktop")
        window = reply.get("window") or {}
        return {"text": f"URL: {c.url} | Desktop read completed: {window.get('title', '')} ({window.get('app', '')})."
                + _read_text(reply).replace("page content from the contained computer", "desktop window content from the contained computer"),
                "images": [c.screenshot],
                "state": {key: reply[key] for key in ("snapshot", "elements", "diff", "query", "window") if key in reply}}

    async def _desktop_ref(self, c: Computer, action: str, ref: str, args: dict, ctx) -> dict:
        """Click or type on a desktop control by its ref: the same guards as
        the web (buying, sending and posting stop; delete asks; password
        fields are the person's), then its accessible action or focus."""
        inspected = await self._command(c, "desktop_inspect", expected_url=c.url, ref=ref)
        info, note = inspected.get("element") or {}, inspected.get("note") or ""
        place = _desktop_place(info)
        if action == "type" and info.get("private"):
            _needs_person(c.owner, c.url)
            return {"text": "Not typed: passwords, codes and payment details are entered by the person. "
                    f"Ask them to take over the computer. URL: {c.url}", "images": []}
        if action == "click":
            stopped = await self._press_guard(c, info, ctx, place=place)
            if stopped:
                return {"text": stopped, "images": []}
        if action == "type" and (not isinstance(args.get("text"), str) or len(args["text"]) > 10000):
            return {"text": "Not run: give text of at most 10000 characters to type.", "images": [], "code": "bad_arguments"}
        async with c.lock:
            if c.taken_over:
                return {"text": "Not run: the person has control of the computer.", "images": []}
            reply = await self._send(c, "desktop_ref_input", expected_url=c.url, ref=ref, kind=action,
                                     expected=info, **({"text": args["text"]} if action == "type" else {}))
        c.last_action = self.clock()
        c.last_action_at = time.time()
        c.screenshot = base64.b64decode(reply["screenshot"])
        if ctx.turn_taint: ctx.turn_taint.mark("computer desktop")
        detail = f"URL: {c.url} | Desktop {action} completed on {info.get('role', 'control')} '{info.get('label', '')}' by {reply.get('how', 'its action')}."
        return {"text": detail + (" " + note if note else ""), "images": [c.screenshot],
                "element": {key: info[key] for key in ("label", "role", "app") if key in info}}

    def takeover(self, owner: str) -> bool:
        c = self._computers.get(owner)
        if not c:
            return False
        c.taken_over = True
        c.lease_id = uuid.uuid4().hex
        c.handback.clear()
        c.last_action = self.clock()
        c.last_action_at = time.time()
        self._rate_soon(c)
        return True

    def _rate_soon(self, c: Computer) -> None:
        """Control changed: re-rate the screencast (takeover and hand_back are sync)."""
        try:
            asyncio.get_running_loop().create_task(self._sync_rate(c))
        except RuntimeError:
            pass

    def hand_back(self, owner: str) -> bool:
        c = self._computers.get(owner)
        if not c:
            return False
        c.taken_over = False
        c.lease_id = None
        self._discard_recording(c)
        c.handback.set()
        c.last_action = self.clock()
        c.last_action_at = time.time()
        self._rate_soon(c)
        return True

    def _discard_recording(self, c: Computer) -> None:
        ident, c.recording_id = c.recording_id, None
        c.recording = False
        c.steps.clear()
        if ident and self._computers.get(c.owner) is c:
            async def discard():
                try:
                    await self._command(c, "record_stop", recording_id=ident)
                except (ValueError, sandbox.SandboxUnavailable):
                    pass
            asyncio.get_running_loop().create_task(discard())

    async def start_recording(self, owner: str) -> None:
        c = self._computers.get(owner)
        if not c or not c.taken_over:
            raise ValueError("take over the computer before recording")
        async with c.lock:
            if not c.taken_over or self._computers.get(owner) is not c:
                raise ValueError("take over the computer before recording")
            if c.recording:
                raise ValueError("recording is already on")
            c.steps.clear()
            c.recording, c.recording_id = True, uuid.uuid4().hex
            try:
                await self._command(c, "record_start", recording_id=c.recording_id)
            except Exception:
                self._discard_recording(c)
                raise

    async def stop_recording(self, owner: str) -> list[dict]:
        c = self._computers.get(owner)
        if not c or not c.taken_over or not c.recording:
            raise ValueError("there is no recording to review")
        async with c.lock:
            if not c.taken_over or not c.recording:
                raise ValueError("there is no recording to review")
            await self._command(c, "record_stop", recording_id=c.recording_id)
            steps = c.steps[:]
            c.recording, c.recording_id = False, None
            c.steps.clear()
            return steps

    async def person_input(self, owner: str, kind: str, values: dict, ctx=None) -> None:
        """Forward human input without model inspection, tool output or audit."""
        c = self._computers.get(owner)
        if not c or not c.taken_over:
            raise ValueError("take over the computer first")
        browser_action = kind in ("navigate", "back", "forward", "reload")
        if browser_action:
            ctx = ctx or SimpleNamespace(permission_surface=owner, is_admin=owner.startswith("agent:"))
            if kind == "navigate":
                url = await _person_url(values.get("url", ""))
                allowed, reason = await self._site(c, urlsplit(url).hostname.lower(), ctx, url=url)
                if not allowed:
                    raise ValueError(reason)
                values = {"url": url}
        async with c.lock:
            if not c.taken_over or self._computers.get(owner) is not c:
                raise ValueError("take over the computer first")
            reply = await self._send(c, "desktop_input", kind=kind, person=True, recording_id=c.recording_id, **values) if c.desktop and not browser_action else await self._send(c, "person_" + kind, recording_id=c.recording_id, **values)
        if browser_action and reply.get("url") and reply["url"] != "about:blank":
            try:
                url = await _person_url(reply["url"])
                allowed, reason = await self._site(c, urlsplit(url).hostname.lower(), ctx, url=url)
                if not allowed:
                    raise ValueError(reason)
            except ValueError:
                await self._retreat(c)
                raise
        c.url, c.title = reply.get("url") or c.url, reply.get("title") or c.title
        if reply.get("screenshot"):
            c.screenshot = base64.b64decode(reply["screenshot"])
        c.last_action = self.clock()
        c.last_action_at = time.time()

    async def frame(self, owner: str) -> dict | None:
        """Refresh a watched page at most twice a second."""
        c = self._computers.get(owner)
        if not c:
            return None
        async with c.snapshot_lock:
            if self.clock() - c.last_snapshot >= 0.5:
                reply = await self._command(c, "snapshot")
                c.last_snapshot = self.clock()
                c.url, c.title = reply.get("url") or c.url, reply.get("title") or c.title
                c.frame_jpeg = base64.b64decode(reply["screenshot"])
                c.screenshot = c.frame_jpeg
        if self._computers.get(owner) is not c:
            return None
        return {"owner": owner, "url": c.url, "title": c.title, "last_action": c.last_action_at,
                "desktop": c.desktop, "recording": c.recording,
                "taken_over": c.taken_over, "waiting_model": c.waiting_model,
                "image": base64.b64encode(c.frame_jpeg).decode() if c.frame_jpeg else ""}

    def _wanted_fps(self, c: Computer) -> int:
        return CONTROL_FPS if c.taken_over and c.local_watchers else WATCH_FPS

    async def _sync_rate(self, c: Computer) -> None:
        """Tell the driver the screencast rate the viewers and control call for."""
        want = self._wanted_fps(c)
        if c.watchers and want != c.cast_fps and self._computers.get(c.owner) is c:
            try:
                await self._command(c, "watch_rate", fps=want)
                c.cast_fps = want
            except (ValueError, sandbox.SandboxUnavailable):
                pass

    async def watch(self, owner: str, heartbeat: float = 1.0, local: bool = False):
        """The live view: every screencast frame as it arrives, and the state
        (control, URL) at least once a `heartbeat`, without an image when the
        page has not changed. The screencast runs only while someone watches.
        A `local` viewer (this computer, not Remote Access) gets CONTROL_FPS
        while the person has control; everyone else is capped at WATCH_FPS."""
        c = self._computers.get(owner)
        if not c:
            return
        c.watchers += 1
        c.local_watchers += local
        last_image = 0.0
        try:
            if c.watchers == 1:
                try:
                    c.cast_fps = self._wanted_fps(c)
                    await self._command(c, "watch_start", fps=c.cast_fps)
                except (ValueError, sandbox.SandboxUnavailable):
                    pass
            else:
                await self._sync_rate(c)
            if c.frame_jpeg is None:
                await self.frame(owner)  # a still page sends no screencast frame: take one
            # Whatever is on screen now goes first, even if it arrived before
            # this viewer did; after that, only new frames carry an image.
            sent = c.frame_seq
            if c.frame_jpeg and self._computers.get(owner) is c:
                last_image = time.monotonic()
                yield {"owner": owner, "url": c.url, "title": c.title, "last_action": c.last_action_at,
                       "desktop": c.desktop, "recording": c.recording,
                       "taken_over": c.taken_over, "waiting_model": c.waiting_model,
                       "image": base64.b64encode(c.frame_jpeg).decode()}
            while self._computers.get(owner) is c:
                changed = c.frame_changed
                try:
                    await asyncio.wait_for(changed.wait(), heartbeat)
                except asyncio.TimeoutError:
                    pass
                if self._computers.get(owner) is not c:
                    return
                if c.frame_seq != sent and c.frame_jpeg:
                    # This viewer's own cap: a Remote Access viewer stays at
                    # WATCH_FPS even while a local one gets CONTROL_FPS.
                    fps = CONTROL_FPS if local and c.taken_over else WATCH_FPS
                    wait = 1 / fps - (time.monotonic() - last_image)
                    if wait > 0:
                        await asyncio.sleep(wait)
                        if self._computers.get(owner) is not c:
                            return
                state = {"owner": owner, "url": c.url, "title": c.title, "last_action": c.last_action_at,
                         "desktop": c.desktop, "recording": c.recording,
                         "taken_over": c.taken_over, "waiting_model": c.waiting_model}
                if c.frame_seq != sent and c.frame_jpeg:
                    sent = c.frame_seq
                    last_image = time.monotonic()
                    state["image"] = base64.b64encode(c.frame_jpeg).decode()
                yield state
        finally:
            c.watchers -= 1
            c.local_watchers -= local
            if self._computers.get(owner) is c:
                if c.watchers == 0:
                    try:
                        await self._command(c, "watch_stop")
                    except (ValueError, sandbox.SandboxUnavailable):
                        pass
                    c.cast_fps = 0
                else:
                    await self._sync_rate(c)

    async def _press_guard(self, c: Computer, info: dict, ctx, enter: bool = False, place: str | None = None) -> str | None:
        controls = [info, *((info.get("form_submits") or []) if enter else [])]
        host = place or urlsplit(c.url).hostname or "this page"

        def hand_over(shown: str, why: str) -> str:
            if c.owner.startswith("agent:"):
                from services.agent_service import agent_service
                agent_service.add_item(c.owner.removeprefix("agent:"), kind="question",
                    title=f"Ready for you: press '{shown}' at {host}", body=f"The computer is ready at {c.url}. Take over and press it.")
            return (f"Stopped before pressing '{shown}' on {host}: {why} "
                    "Everything up to it is ready; ask them to take over and press it.")

        for control in controls:
            for label in _labels(control):
                if PERSON_ACTION_WORDS.search(label):
                    return hand_over(label[:160], "buying, sending and posting are done by the person.")
        if not _reactions_allowed():
            for control in controls:
                for label in _labels(control):
                    if REACTION_WORDS.search(label):
                        return hand_over(label[:160], "likes, follows and reactions are done by the person unless "
                                                      "an admin allows them in Settings > Computer use.")
        for control in controls:
            for label in _labels(control):
                if DELETE_WORDS.search(label):
                    shown = label[:160]
                    decision = await permissions.decide(surface=ctx.permission_surface, tool="computer_delete",
                        target=None, arguments={"url": c.url, "label": shown},
                        title=f"Let the computer press '{shown}' on {host}",
                        description=f"Press '{shown}' on {c.url}", choices=DELETE_CHOICES, is_admin=ctx.is_admin)
                    return None if decision.behavior == "allow" else f"Not pressed: {decision.reason} URL: {c.url}"
        return None


def _desktop_enabled() -> bool:
    from core import settings
    return bool((settings.get_setting("computer_use") or {}).get("desktop"))


def _reactions_allowed() -> bool:
    from core import settings
    return bool((settings.get_setting("computer_use") or {}).get("allow_reactions"))


def _labels(info: dict) -> list[str]:
    labels = info.get("signals") or [info.get("label") or ""]
    return [str(label).strip() for label in labels if str(label).strip()]


def _private(info: dict) -> bool:
    autocomplete = info.get("autocomplete") or ""
    return (info.get("tag") == "input" and info.get("type") == "password") or autocomplete in PRIVATE_FIELDS or autocomplete.startswith("cc-")


def _trajectory_run(owner: str, ctx) -> str | None:
    """The run a step belongs to: the run in progress, else one per owner
    and day. None when steps are not kept."""
    if computer_trajectory.retention_days() <= 0:
        return None
    from core import runs
    context = runs.current_for(getattr(ctx, "session_id", None))
    if context is not None:
        return context.run_id
    import hashlib
    return "adhoc-" + hashlib.sha256(owner.encode()).hexdigest()[:10] + time.strftime("-%Y%m%d")


def _desktop_control(row: dict) -> dict:
    """A desktop control as the press guard reads it."""
    return {"label": row.get("label") or "", "signals": [value for value in (row.get("label"), row.get("value")) if value]}


def _desktop_place(info: dict) -> str:
    return f"the desktop ({info['app']})" if info.get("app") else "the desktop"


def _step_label(step: dict) -> str:
    target = step.get("ref") or (f"({step['x']}, {step['y']})" if "x" in step and "y" in step else "")
    detail = {"type": "", "key": step.get("key") or "", "scroll": f"dx {step.get('dx', 0)} dy {step.get('dy', 0)}",
              "wait": f"{step.get('seconds', 1)}s"}.get(step["action"], "")
    return " ".join(part for part in (step["action"], str(target), str(detail)) if part)


def _check_steps(steps) -> tuple[list, str]:
    """Every step, checked before the first runs: (steps, problem)."""
    if not isinstance(steps, list) or not steps:
        return [], "give steps as a list of actions, such as [{\"action\": \"click\", \"ref\": \"r3:2\"}]."
    if len(steps) > MAX_STEPS:
        return [], f"give at most {MAX_STEPS} steps."
    integer = lambda value: isinstance(value, int) and not isinstance(value, bool)
    for index, step in enumerate(steps, 1):
        if not isinstance(step, dict):
            return [], f"step {index} is not an action."
        action = step.get("action")
        if action not in STEP_ACTIONS:
            return [], f"step {index}: steps can click, type, key, scroll or wait."
        unknown = set(step) - STEP_KEYS
        if unknown:
            return [], f"step {index}: unknown argument {sorted(unknown)[0]}."
        if "ref" in step and not isinstance(step["ref"], (str, int)):
            return [], f"step {index}: ref must be text, such as r3:2."
        if any(key in step and not integer(step[key]) for key in ("x", "y", "dx", "dy")):
            return [], f"step {index}: x, y, dx and dy are whole numbers."
        if action == "click" and not (step.get("ref") or ("x" in step and "y" in step)):
            return [], f"step {index}: a click needs a ref or x and y."
        if action == "type" and (not isinstance(step.get("text"), str) or len(step["text"]) > 10000):
            return [], f"step {index}: type needs text of at most 10000 characters."
        if action == "key" and (not isinstance(step.get("key"), str) or not 0 < len(step["key"]) <= 80):
            return [], f"step {index}: key needs one key or combination."
        if action == "wait" and not isinstance(step.get("seconds", 1), (int, float)):
            return [], f"step {index}: seconds is a number."
        if "desktop" in step and not isinstance(step["desktop"], bool):
            return [], f"step {index}: desktop is true or false."
    return steps, ""


def _check_expect(expect) -> tuple[dict, str]:
    if not isinstance(expect, dict) or not expect:
        return {}, "verify needs expect, with any of " + ", ".join(EXPECT_KEYS) + "."
    unknown = set(expect) - set(EXPECT_KEYS)
    if unknown:
        return {}, f"verify does not know {sorted(unknown)[0]}; use " + ", ".join(EXPECT_KEYS) + "."
    for key in EXPECT_KEYS[:4]:
        if key in expect and (not isinstance(expect[key], str) or not 0 < len(expect[key]) <= 500):
            return {}, f"{key} needs text of at most 500 characters."
    if "element" in expect:
        element = expect["element"]
        if (not isinstance(element, dict) or set(element) - {"role", "name"} or not isinstance(element.get("role"), str)
                or not 0 < len(element["role"]) <= 40 or not isinstance(element.get("name", ""), str)
                or len(element.get("name", "")) > 200):
            return {}, "element needs a role, such as button, and optionally a name."
    return dict(expect), ""


def _read_problem(args: dict) -> str:
    if args.get("since") not in (None, "", "latest"):
        return "since takes \"latest\"."
    if args.get("query") is not None and not isinstance(args["query"], str):
        return "query is text."
    limit = args.get("max_elements")
    if limit is not None and (isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 200):
        return "max_elements is a whole number from 1 to 200."
    return ""


def _row(row: dict, removed: bool = False) -> str:
    ref = f"({row['ref']})" if removed else f"[{row['ref']}]"
    tag = row.get("tag", "")
    if row.get("role") and row["role"] != tag:
        tag += f"[{row['role']}]"
    parts = [ref, tag, str(row.get("label") or "")[:120], row.get("href") or ""]
    if row.get("value"):
        parts.append(f"={json.dumps(row['value'], ensure_ascii=False)}")
    if row.get("checked") is not None:
        parts.append("(checked)" if row["checked"] else "(not checked)")
    if row.get("disabled"):
        parts.append("(disabled)")
    return " ".join(part for part in parts if part)


def _rows(rows: list, headings: bool) -> list[str]:
    lines, heading = [], None
    for row in rows:
        if headings and row.get("heading") and row["heading"] != heading:
            heading = row["heading"]
            lines.append(f"## {heading}")
        lines.append(_row(row))
    return lines


def _read_text(reply: dict) -> str:
    """A read's reply for the model: page text and refs, a query's matches,
    or the changes since the last read, fenced as untrusted page content."""
    snapshot = reply.get("snapshot")
    diff = reply.get("diff")
    if diff:
        counts = diff.get("counts") or [len(diff.get(key) or []) for key in ("added", "changed", "removed", "text_added", "text_removed")]
        body = [f"Changes since {diff['since']} (now {snapshot}): {counts[0]} added, {counts[1]} changed, {counts[2]} removed; "
                f"{counts[3]} text lines appeared, {counts[4]} went."]
        for title, key, removed in (("Added", "added", False), ("Changed", "changed", False), ("Removed", "removed", True)):
            if diff.get(key):
                body += [f"{title}:"] + [_row(row, removed) for row in diff[key]]
        if diff.get("text_added"):
            body += ["Text appeared:"] + [f"+ {line[:300]}" for line in diff["text_added"]]
        if diff.get("text_removed"):
            body += ["Text went:"] + [f"- {line[:300]}" for line in diff["text_removed"]]
        if not any(counts):
            body.append("Nothing changed.")
        return " Snapshot " + snapshot + ".\n\n" + wrap_untrusted("page content from the contained computer", "\n".join(body))
    head = ""
    if reply.get("full_reason"):
        head = f" Full read: {reply['full_reason']}."
    elements = reply.get("elements", [])
    total = reply.get("total_elements", len(elements))
    if reply.get("query") is not None:
        body = (f"Matching \"{reply['query']}\": {reply.get('matched', len(elements))} of {total} elements, "
                f"{reply.get('text_lines', 0)} text lines.\n\nText:\n{reply.get('text') or '(none)'}\n\nElements:\n"
                + ("\n".join(_rows(elements, True)) or "(none)"))
    else:
        shown = f" ({len(elements)} of {total} shown; use query or max_elements for others)" if total > len(elements) else ""
        body = reply.get("text", "") + f"\n\nElements{shown}:\n" + ("\n".join(_rows(elements, False)) or "(none)")
    if reply.get("scan_capped"):
        body += "\n(The page has more controls than one read scans; use query to narrow it.)"
    return (f" Snapshot {snapshot}." if snapshot else "") + head + "\n\n" + wrap_untrusted(
        "page content from the contained computer", body)


async def _person_url(url):
    url = sandbox_browser._check_url(url)
    parsed = urlsplit(url)
    if len(url) > 2048 or parsed.username or parsed.password:
        raise ValueError("Use a web address without sign-in details")
    host = parsed.hostname.lower()
    if host in LOCAL_HOSTS or host.endswith((".localhost", ".local", ".internal")):
        raise ValueError("Private and local sites are not available here")
    try:
        addresses = await asyncio.get_running_loop().getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)
    except (OSError, ValueError) as error:
        raise ValueError("This site could not be found") from error
    def public(raw):
        address = ipaddress.ip_address(raw.split('%')[0])
        if address.version == 6 and address.ipv4_mapped:
            address = address.ipv4_mapped
        return address.is_global and not address.is_multicast
    if not addresses or any(not public(row[4][0]) for row in addresses):
        raise ValueError("Private and local sites are not available here")
    return url


def _help(owner, reason, site=None):
    if owner.startswith("agent:"):
        from core import runs
        from services import bot_help
        run = runs.CURRENT.get()
        thread_id = run.session_id if run and run.agent_id == owner[6:] else None
        bot_help.raise_help(owner[6:], reason, site, thread_id)


def _needs_person(owner: str, url: str):
    if owner.startswith("agent:"):
        from services.agent_service import agent_service
        host = urlsplit(url).hostname or "this site"
        _help(owner, f"Sign in at {host}", host)
        agent_service.add_item(owner.removeprefix("agent:"), kind="question",
            title=f"Needs you: sign in at {host}", body=f"The contained computer is waiting at {url}. Take over to enter private details.")


def _opaque_frame_message() -> str:
    return "Stopped: this part of the page is an embedded frame Kairos can't inspect (often a payment form). Ask the person to take over."


def _needs_frame_person(owner: str, url: str):
    if owner.startswith("agent:"):
        from services.agent_service import agent_service
        host = urlsplit(url).hostname or "this site"
        _help(owner, f"Use the embedded frame at {host}")
        agent_service.add_item(owner.removeprefix("agent:"), kind="question",
            title=f"Needs you: embedded frame at {host}", body=f"The contained computer is waiting at {url}. Take over to use this frame.")


manager = ComputerManager()


async def stop(owner: str):
    await manager.stop(owner)


def running() -> list[dict]:
    return manager.running()
