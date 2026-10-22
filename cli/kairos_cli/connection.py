"""Finding the Kairos backend, starting the app when none runs, and signing in.

v1 attaches only (spec decision 1): the backend belongs to the desktop app.
When nothing answers, the CLI starts the app with --background, which brings
up the backend and the tray without a window, and waits for it.

Signing in (spec section 4.3, decision 2):
- accounts off, app running normally: pair. The app window shows a prompt
  with a word pair; one click there gives this process a token. The token is
  kept in this object's memory only. It is never written anywhere, never put
  in an environment variable and never handed to anything this process
  starts (the only thing it starts is the app, before pairing).
- accounts on: `kairos login` signs in with the existing login route and
  keeps the session cookie in memory for the run.
- a backend started without a UI secret (a dev server): already open.
"""
from __future__ import annotations

import asyncio
import getpass
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import httpx

from .sanitize import one_line

REAL_PORT = 8420
DEV_PORT = 8430
TOKEN_HEADER = "X-Kairos-CLI-Token"
HEARTBEAT_SECONDS = 60


class KairosError(Exception):
    """Something to say to the person, in plain words, then stop."""


def detail(response: httpx.Response) -> str:
    try:
        body = response.json()
        text = body.get("detail") if isinstance(body, dict) else None
    except ValueError:
        text = None
    return one_line(text or f"Kairos answered {response.status_code}.", 300)


def port_for(port: int | None, instance: str | None) -> int:
    if port:
        return port
    env_port = os.environ.get("KAIROS_PORT")
    if env_port and env_port.isdigit():
        return int(env_port)
    return DEV_PORT if instance else REAL_PORT


def terminal_name() -> str:
    env = os.environ
    if env.get("WT_SESSION"):
        name = "Windows Terminal"
    elif env.get("TERM_PROGRAM"):
        name = env["TERM_PROGRAM"]
    elif env.get("ConEmuPID"):
        name = "ConEmu"
    else:
        name = "A terminal"
    folder = Path.cwd().name or str(Path.cwd())
    return f"{name} in {folder}"[:60]


@dataclass
class Health:
    up: bool
    instance: str = ""
    version: str = ""


async def health(base_url: str, timeout: float = 2.0) -> Health:
    try:
        async with httpx.AsyncClient(timeout=timeout) as probe:
            response = await probe.get(f"{base_url}/api/health")
        if response.status_code != 200:
            return Health(False)
        body = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
        return Health(True, str(body.get("instance") or ""), str(body.get("version") or ""))
    except (httpx.HTTPError, ValueError):
        return Health(False)


def app_command(instance: str | None, background: bool = True) -> list[str] | None:
    """How to start the desktop app: the installed app (kairos.cmd sets
    KAIROS_APP_EXE), or Electron from a source checkout. With background,
    to the tray and no window (--background); without it, a running app
    just shows its window (Electron's single-instance hand-off)."""
    flags = (["--background"] if background else []) + ([f"--instance={instance}"] if instance else [])
    # Development and tests only: extra Electron flags, such as an isolated
    # --user-data-dir, for a throwaway instance.
    flags += [flag for flag in os.environ.get("KAIROS_APP_FLAGS", "").split() if flag.startswith("--user-data-dir=")]
    exe = os.environ.get("KAIROS_APP_EXE")
    if exe and Path(exe).is_file():
        return [exe, *flags]
    repo = Path(__file__).resolve().parents[2]
    electron_dir = repo / "electron"
    binary = electron_dir / "node_modules" / "electron" / "dist" / ("electron.exe" if sys.platform == "win32" else "electron")
    if binary.is_file():
        return [str(binary), str(electron_dir), *flags]
    return None


def launch_app(instance: str | None, background: bool = True) -> bool:
    command = app_command(instance, background)
    if not command:
        return False
    # The child gets this process's environment as it was at start: there is
    # no token in it, because pairing happens after the app is up.
    environment = {k: v for k, v in os.environ.items() if not k.upper().startswith("KAIROS_CLI_")}
    options = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   env=environment, close_fds=True)
    if sys.platform == "win32":
        options["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        options["start_new_session"] = True
    subprocess.Popen(command, **options)
    return True


class Connection:
    """One attached backend. Holds the credential in memory for the run."""

    def __init__(self, base_url: str, say=None):
        self.base_url = base_url.rstrip("/")
        self.say = say or (lambda text: print(text, file=sys.stderr))
        self._token: str | None = None
        self.client = httpx.AsyncClient(base_url=self.base_url, timeout=httpx.Timeout(30.0, read=60.0))
        self.status: dict = {}
        self.terminal_id: str | None = None
        self._heartbeat: asyncio.Task | None = None

    # -- the credential ---------------------------------------------------

    @property
    def paired(self) -> bool:
        return self._token is not None

    def _set_token(self, token: str | None) -> None:
        self._token = token
        if token:
            self.client.headers[TOKEN_HEADER] = token
        else:
            self.client.headers.pop(TOKEN_HEADER, None)

    def stream_headers(self) -> dict:
        return {TOKEN_HEADER: self._token} if self._token else {}

    def __repr__(self):  # never print the token by accident
        return f"Connection({self.base_url!r}, paired={self.paired})"

    # -- signing in -------------------------------------------------------

    async def refresh_status(self) -> dict:
        response = await self.client.get("/api/auth/status")
        response.raise_for_status()
        self.status = response.json()
        return self.status

    async def sign_in(self, interactive: bool, on_words=None) -> None:
        status = await self.refresh_status()
        if status.get("username"):
            return
        if status.get("auth_enabled"):
            if not interactive:
                raise KairosError("This Kairos has accounts on. Run kairos login in a terminal first.")
            await self.login()
            return
        await self.pair(on_words=on_words)

    async def login(self, username: str | None = None, password: str | None = None) -> None:
        try:
            username = username or input("Kairos username: ").strip()
            password = password if password is not None else getpass.getpass("Password: ")
        except EOFError:
            raise KairosError("This Kairos has accounts on. Run kairos login in a terminal.") from None
        body = {"username": username, "password": password}
        response = await self.client.post("/api/auth/login", json=body)
        if response.status_code == 401 and "2FA" in response.text:
            body["totp_code"] = input("Two-factor code: ").strip()
            response = await self.client.post("/api/auth/login", json=body)
        if response.status_code != 200:
            raise KairosError(detail(response))
        await self.refresh_status()

    async def pair(self, on_words=None, timeout: float = 150.0) -> None:
        response = await self.client.post("/api/auth/cli-pair", json={"pid": os.getpid(), "terminal": terminal_name()})
        if response.status_code != 200:
            raise KairosError(detail(response))
        started = response.json()
        words = one_line(started["words"], 40)
        if on_words:
            on_words(words)
        else:
            self.say(f"Approve this terminal in the Kairos app. It shows: {words}")
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while loop.time() < deadline:
            reply = await self.client.post(f"/api/auth/cli-pair/{started['request_id']}/claim",
                                           json={"claim": started["claim"], "wait": 25})
            if reply.status_code != 200:
                raise KairosError(detail(reply))
            result = reply.json()
            if result["status"] == "pending":
                continue
            if result["status"] == "allowed":
                self._set_token(result["token"])
                self.terminal_id = result.get("terminal_id")
                await self.refresh_status()
                self._heartbeat = asyncio.create_task(self._beat())
                return
            if result["status"] == "expired":
                raise KairosError("Nobody approved this terminal in the Kairos app in time, so it was not paired.")
            raise KairosError("The Kairos app rejected this terminal.")
        raise KairosError("Nobody approved this terminal in the Kairos app in time, so it was not paired.")

    async def _beat(self) -> None:
        while True:
            await asyncio.sleep(HEARTBEAT_SECONDS)
            try:
                response = await self.client.post("/api/auth/cli/heartbeat")
                if response.status_code == 401:
                    self._set_token(None)
                    self.say("This terminal's pairing ended (revoked in the app, or it expired). Run kairos again to pair.")
                    return
            except httpx.HTTPError:
                pass

    async def close(self) -> None:
        if self._heartbeat:
            self._heartbeat.cancel()
        if self._token:
            try:
                await self.client.delete("/api/auth/cli/session", timeout=3.0)
            except httpx.HTTPError:
                pass
            self._set_token(None)
        await self.client.aclose()

    # -- requests -----------------------------------------------------------

    async def call(self, method: str, path: str, **kwargs):
        response = await self.client.request(method, path, **kwargs)
        if response.status_code == 401:
            raise KairosError("Kairos no longer accepts this terminal. Run kairos again to pair it.")
        if response.status_code >= 400:
            raise KairosError(detail(response))
        if not response.content:
            return None
        return response.json()

    async def get(self, path: str, **kwargs):
        return await self.call("GET", path, **kwargs)

    async def post(self, path: str, body=None, **kwargs):
        return await self.call("POST", path, json=body if body is not None else {}, **kwargs)

    async def delete(self, path: str, **kwargs):
        return await self.call("DELETE", path, **kwargs)


async def attach(port: int | None = None, instance: str | None = None, start_app: bool = True,
                 say=None, wait_seconds: float = 120.0) -> str:
    """The base URL of a running backend, starting the app if needed."""
    say = say or (lambda text: print(text, file=sys.stderr))
    base_url = f"http://127.0.0.1:{port_for(port, instance)}"
    if (await health(base_url)).up:
        return base_url
    if not start_app:
        raise KairosError(f"Kairos is not running on {base_url}.")
    if not launch_app(instance):
        raise KairosError("Kairos is not running, and this terminal could not find the app to start it. "
                          "Open Kairos, then run kairos again.")
    say("Starting Kairos in the background…")
    loop = asyncio.get_running_loop()
    deadline = loop.time() + wait_seconds
    while loop.time() < deadline:
        await asyncio.sleep(0.5)
        if (await health(base_url, timeout=1.0)).up:
            return base_url
    raise KairosError("Kairos did not start in time. Open it from the Start menu and try again.")
