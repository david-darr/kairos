"""Fake-driver checks for the contained computer, safety gates and image paths.

No Docker or real subprocess is needed. Live containment lives in
scripts/test_sandbox.py and is run separately when Docker is available.
"""
import asyncio
import ast
import base64
from dataclasses import replace
import json
import io
import os
import re
import shutil
import sys
import unittest
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
environment = Path(__file__).resolve().parents[1] / (".computer-test-" + uuid.uuid4().hex[:12])
environment.mkdir()
os.environ["JARVIS_DATA_DIR"] = str(environment)

from core import computer, computer_image, permissions, sandbox_browser, tool_access, tool_registry  # noqa: E402
from core.computer_driver import SOURCE  # noqa: E402
from core.providers import native_api, openai_compatible  # noqa: E402
from core.turn_taint import TurnTaint  # noqa: E402
from routes import computer_routes, settings_routes, tool_routes  # noqa: E402
from services.agent_service import agent_service  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402

PNG = b"\x89PNG\r\n\x1a\nsmall"


class FakeInput:
    def __init__(self, proc):
        self.proc = proc
        self.buffer = b""

    def write(self, data):
        self.buffer += data

    async def drain(self):
        for line in self.buffer.splitlines():
            cmd = json.loads(line)
            if "driver" in cmd:  # the driver's source, sent before any command
                self.proc.driver_source = cmd["driver"]
                continue
            self.proc.calls.append(cmd)
            reply = self.proc.reply(cmd)
            self.proc.stdout.feed_data((json.dumps(reply) + "\n").encode())
        self.buffer = b""

    def close(self):
        self.proc.returncode = 0


class FakeProc:
    def __init__(self):
        self.stdin = FakeInput(self)
        self.stdout = asyncio.StreamReader()
        self.stderr = asyncio.StreamReader()
        self.stderr.feed_eof()
        self.returncode = None
        self.calls = []
        self.url = "about:blank"
        self.element = {}
        self.next_url = None
        self.mouse_clicks = []
        self.window = {"id": "123", "class": "Mousepad", "title": "Untitled"}

    def reply(self, cmd):
        action = cmd["action"]
        result = {"id": cmd["id"]}
        if action in ("inspect", "focused"):
            result["element"] = self.element
        elif action in ("window_at", "focused_window"):
            result["window"] = self.window
        elif action == "done":
            result["done"] = True
        else:
            if action == "open": self.url = cmd["url"]
            elif action == "click":
                if "x" in cmd and "y" in cmd: self.mouse_clicks.append((cmd["x"], cmd["y"]))
                if self.next_url: self.url = self.next_url
            elif action == "desktop_input" and self.next_url: self.url = self.next_url
            elif action == "back": self.url = "https://example.com/"
            result.update(url=self.url, title="Example", screenshot=base64.b64encode(PNG).decode())
            if action == "read":
                result.update(text="Example Domain", elements=[{"ref": "1", "tag": "a", "label": "More", "href": "https://other.com/"}])
            if action == "windows": result["windows"] = [{**self.window, "geometry": {"x": 0, "y": 0, "width": 800, "height": 600}}]
        return result

    async def wait(self):
        return self.returncode or 0

    def kill(self):
        self.returncode = -9


class DriverDesktopTests(unittest.IsolatedAsyncioTestCase):
    def driver(self, names):
        module = ast.parse(SOURCE)
        functions = [node for node in module.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
        namespace = {"asyncio": asyncio, "re": re}
        exec(compile(ast.Module(body=functions, type_ignores=[]), "desktop driver functions", "exec"), namespace)
        return namespace

    def test_driver_recording_redacts_private_fields_and_opaque_frames(self):
        driver = self.driver({"recorded_input"})
        for info in ({"tag": "input", "type": "password"}, {"autocomplete": "current-password"},
                     {"autocomplete": "new-password"}, {"autocomplete": "one-time-code"},
                     {"autocomplete": "cc-number"}, {"opaque_frame": True}):
            for kind, values in (("type", {"text": "secret-value"}), ("key", {"key": "secret-value"})):
                result = driver["recorded_input"](kind, values, {**info, "label": "secret-value", "signals": ["secret-value"]},
                    "https://example.com/", {"class": "Chromium", "title": "Example"})
                self.assertTrue(result["private"])
                self.assertNotIn("text", result)
                self.assertNotIn("key", result)
                self.assertNotIn("secret-value", json.dumps(result))
                self.assertEqual(result["label"], "(private field: entered by the person)")

    def test_driver_records_labels_and_window_relative_coordinates(self):
        driver = self.driver({"recorded_input", "desktop_app"})
        labeled = driver["recorded_input"]("click", {"x": 14, "y": 22},
            {"label": "More information", "tag": "a", "role": "link", "type": ""}, "https://example.com/")
        self.assertEqual(labeled["element"]["label"], "More information")
        self.assertNotIn("x", labeled)
        native = driver["recorded_input"]("click", {"x": 14, "y": 22}, {}, "https://example.com/",
            {"class": "Mousepad", "title": "Untitled"})
        self.assertEqual((native["x"], native["y"]), (14, 22))
        self.assertEqual(driver["desktop_app"](native["window"]), "editor")
        self.assertIsNone(driver["desktop_app"]({"class": "Terminal", "title": "sh"}))

    async def test_person_recording_inspects_and_emits_before_typing(self):
        for opaque in (False, True):
            driver = self.driver({"main", "browser_launch_options", "recorded_input"})
            timeline = []
            info = {"tag": "input", "type": "password", "label": "Password"}
            class Handle:
                def as_element(self): return self
                async def evaluate(self, script):
                    return ("iframe" if opaque else "input") if "tagName" in script else info
                async def content_frame(self): return None
            frame = SimpleNamespace(evaluate_handle=AsyncMock(return_value=Handle()))
            keyboard = SimpleNamespace(insert_text=AsyncMock(side_effect=lambda text: timeline.append({"typed": text})))
            page = SimpleNamespace(url="https://example.com/", title=AsyncMock(return_value="Example"), on=Mock(),
                main_frame=frame, keyboard=keyboard)
            context = SimpleNamespace(pages=[page], add_init_script=AsyncMock(), close=AsyncMock(), on=Mock())
            class Playwright:
                async def __aenter__(self):
                    return SimpleNamespace(chromium=SimpleNamespace(launch_persistent_context=AsyncMock(return_value=context)))
                async def __aexit__(self, *args): pass
            commands = [{"id": 1, "action": "record_start", "recording_id": "record"},
                        {"id": 2, "action": "person_type", "text": "never-leave-container", "recording_id": "record"},
                        {"id": 3, "action": "done"}]
            driver.update(DESKTOP=False, PROXY="proxy", DOTS="private script", ELEMENT="inspect",
                MAX_FRAME_DEPTH=5, MAX_FPS=30, time=__import__("time"), json=json,
                sys=SimpleNamespace(stdin=io.StringIO("".join(json.dumps(cmd) + "\n" for cmd in commands))),
                async_playwright=Playwright, emit=timeline.append)
            await driver["main"]()
            steps = [event["step"] for event in timeline if event.get("event") == "step"]
            self.assertEqual(steps[0]["kind"], "open")
            self.assertTrue(steps[1]["private"])
            self.assertNotIn("never-leave-container", json.dumps(steps))
            entered = next(index for index, event in enumerate(timeline) if "typed" in event)
            recorded = next(index for index, event in enumerate(timeline) if event.get("step", {}).get("private"))
            self.assertLess(recorded, entered)

    def test_libreoffice_seed_uses_installed_product_version(self):
        driver = self.driver({"seed_libreoffice"})
        driver.update(Path=Path, ET=ET)
        home = environment / "office-new"
        registry = environment / "office-registry"
        registry.mkdir()
        (registry / "main.xcd").write_text('<oor:data xmlns:oor="http://openoffice.org/2001/registry">'
            '<oor:component-schema oor:name="Setup" oor:package="org.openoffice"><component>'
            '<group oor:name="Product"><prop oor:name="ooSetupVersion"><value/></prop></group>'
            '</component></oor:component-schema></oor:data>', encoding="utf-8")
        (registry / "brand.xcd").write_text('<oor:data xmlns:oor="http://openoffice.org/2001/registry">'
            '<oor:component-data oor:name="Setup" oor:package="org.openoffice"><node oor:name="Product">'
            '<prop oor:name="ooSetupVersionAboutBox"><value>24.2.7.2</value></prop>'
            '<prop oor:name="ooSetupVersion"><value>24.2</value></prop></node></oor:component-data></oor:data>',
            encoding="utf-8")
        with patch.dict(os.environ, {"HOME": str(home), "USERPROFILE": str(home)}):
            driver["seed_libreoffice"](registry=registry)
        config = home / ".config/libreoffice/4/user/registrymodifications.xcu"
        name = "{http://openoffice.org/2001/registry}"
        settings = {(item.get(name + "path"), prop.get(name + "name")): prop.findtext("value")
                    for item in ET.parse(config).getroot() for prop in item}
        self.assertEqual(settings, {
            ("/org.openoffice.Office.Common/Misc", "ShowTipOfTheDay"): "false",
            ("/org.openoffice.Office.Common/Misc", "FirstRun"): "false",
            ("/org.openoffice.Setup/Product", "ooSetupLastVersion"): "24.2"})

    def test_libreoffice_seed_preserves_existing_profile(self):
        driver = self.driver({"seed_libreoffice"})
        driver.update(Path=Path, ET=ET)
        home = environment / "office-kept"
        config = home / ".config/libreoffice/4/user/registrymodifications.xcu"
        config.parent.mkdir(parents=True)
        original = b'<person-settings>keep my tips</person-settings>\n'
        config.write_bytes(original)
        with patch.object(ET, "parse", side_effect=AssertionError("existing profiles need no version lookup")):
            driver["seed_libreoffice"](home=home, registry=environment / "absent-registry")
        self.assertEqual(config.read_bytes(), original)

    def test_browser_launch_options_for_desktop_and_headless(self):
        driver = self.driver({"browser_launch_options"})
        driver["PROXY"] = "http://proxy:8080"
        desktop = driver["browser_launch_options"](True)
        self.assertFalse(desktop["headless"])
        self.assertTrue(desktop["no_viewport"])
        self.assertNotIn("viewport", desktop)
        self.assertIn("--window-position=0,0", desktop["args"])
        self.assertIn("--window-size=1280,800", desktop["args"])
        headless = driver["browser_launch_options"](False)
        self.assertTrue(headless["headless"])
        self.assertEqual(headless["viewport"], {"width": 1280, "height": 800})
        self.assertNotIn("no_viewport", headless)
        self.assertFalse(any(arg.startswith("--window-") for arg in headless["args"]))
        for options in (desktop, headless):
            self.assertEqual(options["proxy"], {"server": "http://proxy:8080", "bypass": ""})
            self.assertIn("--proxy-bypass-list=<-loopback>", options["args"])
            self.assertFalse(options["accept_downloads"])

    async def test_driver_rechecks_browser_and_changed_window_before_input(self):
        driver = self.driver({"desktop_input", "browser_window", "point"})
        window = {"id": "123", "class": "Chromium", "title": "Browser"}
        driver.update(window_at=AsyncMock(return_value=window), focused_window=AsyncMock(return_value=window),
                      xdo=AsyncMock(), BROWSER_REFUSAL="That is the browser window")
        for kind in ("click", "type", "key", "scroll"):
            with self.assertRaisesRegex(ValueError, "browser window"):
                await driver["desktop_input"]({"kind": kind, "x": 10, "y": 20, "text": "secret", "key": "Enter"})
        driver["xdo"].assert_not_awaited()
        window["class"] = "Mousepad"
        with self.assertRaisesRegex(ValueError, "window changed"):
            await driver["desktop_input"]({"kind": "type", "text": "secret", "expected_window": {**window, "id": "456"}})
        driver["xdo"].assert_not_awaited()
        window["class"] = ""
        with self.assertRaisesRegex(ValueError, "could not identify"):
            await driver["desktop_input"]({"kind": "click", "x": 10, "y": 20, "expected_window": window})

    async def test_driver_person_input_and_key_translation(self):
        driver = self.driver({"desktop_input", "browser_window", "point"})
        window = {"id": "123", "class": "Chromium", "title": "Browser"}
        driver.update(window_at=AsyncMock(return_value=window), focused_window=AsyncMock(return_value=window),
                      xdo=AsyncMock(), BROWSER_REFUSAL="browser window")
        for kind, values in (("click", {"x": 10, "y": 20}), ("type", {"text": "--private"}),
                             ("key", {"key": "Control+Enter"}), ("scroll", {"dy": 200})):
            await driver["desktop_input"]({"kind": kind, "person": True, **values})
        calls = [call.args for call in driver["xdo"].await_args_list]
        self.assertIn(('type', '--clearmodifiers', '--delay', '0', '--', '--private'), calls)
        self.assertIn(('key', '--clearmodifiers', 'ctrl+Return'), calls)
        for key in ("exec", "exec sh", "--window 123", "a\nexec"):
            with self.assertRaises(ValueError):
                await driver["desktop_input"]({"kind": "key", "person": True, "key": key})

    async def test_driver_launch_allowlist_and_window_reply_preserve_protocol_id(self):
        driver = self.driver({"main", "browser_launch_options"})
        class Playwright:
            async def __aenter__(self): return SimpleNamespace(chromium=SimpleNamespace(launch_persistent_context=launch))
            async def __aexit__(self, *args): pass
        page = SimpleNamespace(url="about:blank", title=AsyncMock(return_value=""), on=Mock())
        context = SimpleNamespace(pages=[page], add_init_script=AsyncMock(), close=AsyncMock(), on=Mock())
        launch = AsyncMock(return_value=context)
        commands = [{"id": 1, "action": "launch", "app": "sh"}, {"id": 2, "action": "window_at", "x": 10, "y": 20},
                    {"id": 3, "action": "done"}]
        replies = []
        driver.update(DESKTOP=True, PROXY="proxy", DOTS="private script", APPS=computer_image.DESKTOP_APPS,
                      MAX_FPS=30, time=__import__("time"), json=json, sys=SimpleNamespace(stdin=io.StringIO(
                          "".join(json.dumps(cmd) + "\n" for cmd in commands))),
                      async_playwright=Playwright, start_desktop=AsyncMock(), emit=replies.append,
                      window_at=AsyncMock(return_value={"id": "123", "class": "Mousepad", "title": "Editor"}))
        with patch.object(asyncio, "create_subprocess_exec", new=AsyncMock()) as spawn:
            await driver["main"]()
        spawn.assert_not_awaited()
        self.assertIn("choose files", replies[0]["error"])
        self.assertEqual(replies[1]["id"], 2)
        self.assertEqual(replies[1]["window"]["id"], "123")
        self.assertFalse(launch.await_args.kwargs["headless"])
        self.assertIn('--class=kairos-computer-browser', launch.await_args.kwargs["args"])
        context.add_init_script.assert_awaited_once_with(script="private script")


class ImageTests(unittest.IsolatedAsyncioTestCase):
    async def test_desktop_recipe_pins_and_separate_tag(self):
        recipe = computer_image.desktop_dockerfile()
        self.assertTrue(recipe.startswith(f"FROM {sandbox_browser.BROWSER_IMAGE}\n"))
        for value in ("https://snapshot.ubuntu.com/ubuntu/20261007T000000Z", "noble noble-updates noble-security",
                      "openbox xdotool pcmanfm mousepad atril ristretto",
                      "libreoffice-writer libreoffice-calc libreoffice-impress fonts-dejavu-core",
                      "--no-install-recommends", "--require-hashes", "--only-binary=:all:", "pillow==12.3.0",
                      "78cb2c6865a35ab8ff8b75fd122f6033b92a62c82801110e48ddd6c936a45d91",
                      "d9c7f76c0673154f044e9d78c8655fb4213f6ca31a836df48b40fe5d187717b9"):
            self.assertIn(value, recipe)
        for requirement in computer_image.REQUIREMENTS: self.assertIn(requirement, recipe)
        self.assertNotIn("pillow", computer_image.DOCKERFILE)
        self.assertTrue(computer_image.image_tag(desktop=True).startswith("kairos-computer-desktop:"))
        self.assertNotEqual(computer_image.image_tag(desktop=True), computer_image.image_tag())
        self.assertIsNot(computer_image._lock, computer_image._desktop_lock)

    async def test_desktop_build_uses_its_recipe_and_timeout(self):
        proc = AsyncMock(returncode=0)
        proc.communicate.return_value = (b"", b"")
        with patch.object(computer_image.asyncio, "create_subprocess_exec", new=AsyncMock(return_value=proc)), \
             patch.object(computer_image.asyncio, "wait_for", wraps=asyncio.wait_for) as wait:
            await computer_image._build(computer_image.image_tag(desktop=True), desktop=True)
        proc.communicate.assert_awaited_once_with(computer_image.desktop_dockerfile().encode())
        self.assertEqual(wait.call_args.args[1], 900)
        with patch.object(computer_image, "image_ready", new=AsyncMock(return_value=False)) as ready, \
             patch.object(computer_image, "_build", new=AsyncMock()) as build:
            self.assertEqual(await computer_image.ensure_image(desktop=True), computer_image.image_tag(desktop=True))
        ready.assert_awaited_once_with(desktop=True)
        build.assert_awaited_once_with(computer_image.image_tag(desktop=True), desktop=True)

    async def test_dockerfile_is_pinned_and_hash_checked(self):
        recipe = computer_image.DOCKERFILE
        self.assertTrue(recipe.startswith(f"FROM {sandbox_browser.BROWSER_IMAGE}\n"))
        self.assertIn("--require-hashes", recipe)
        self.assertIn("--only-binary=:all:", recipe)
        for digest in (
            "ad21bc07516b187965a7521c5cf0df0bd657b17482eaad74335272d35a2b07de",
            "354e15b29503565fc598b89f16fbe070459343bef9d7498a93e304864000c6a7",
            "975736b002ed080d124cf81a79cb7e05cb26d6b3f5c7a7b651c0fcce70353aa1",
            "e85880b538e59a59f55117b81f208a6660ad5ac328aad9305f812d9b8bc67a0f",
            "af2f8fede4171ef667dfded53f96e2ed0d6e6bd7ee3bb46437f77e3b57689228",
            "481caa481374e813c1b176ada14e97f1f67a4539ce9cfeb3f350d78d6370c2e8",
        ):
            self.assertIn("sha256:" + digest, recipe)
        self.assertNotEqual(computer_image.image_tag(recipe), computer_image.image_tag(recipe + "# changed\n"))

    async def test_existing_image_is_not_rebuilt(self):
        with patch.object(computer_image.sandbox, "_docker", new=AsyncMock(return_value=(0, "[]", ""))) as docker, \
             patch.object(computer_image, "_build", new=AsyncMock()) as build:
            self.assertEqual(await computer_image.ensure_image(), computer_image.image_tag())
        docker.assert_awaited_once_with("image", "inspect", computer_image.image_tag())
        build.assert_not_awaited()

    async def test_two_first_uses_build_once(self):
        ready = False
        async def inspect(*args):
            self.assertEqual(args, ("image", "inspect", computer_image.image_tag()))
            return (0, "[]", "") if ready else (1, "", "missing")
        async def build(tag):
            nonlocal ready
            self.assertEqual(tag, computer_image.image_tag())
            await asyncio.sleep(0)
            ready = True
        with patch.object(computer_image.sandbox, "_docker", side_effect=inspect), \
             patch.object(computer_image, "_build", side_effect=build) as builder:
            tags = await asyncio.gather(computer_image.ensure_image(), computer_image.ensure_image())
        self.assertEqual(tags, [computer_image.image_tag()] * 2)
        builder.assert_awaited_once()

    async def test_build_streams_dockerfile_and_reports_failure(self):
        class BuildProc:
            returncode = 1
            payload = None

            async def communicate(self, payload):
                self.payload = payload
                return b"", b"pip could not install the wheel\n"

        proc = BuildProc()
        with patch.object(computer_image.sandbox, "_docker", new=AsyncMock(return_value=(1, "", "missing"))), \
             patch.object(computer_image.asyncio, "create_subprocess_exec", new=AsyncMock(return_value=proc)) as spawn:
            with self.assertRaisesRegex(computer.sandbox.SandboxUnavailable,
                                        "couldn't prepare the contained computer: pip could not install the wheel"):
                await computer_image.ensure_image()
        self.assertEqual(spawn.await_args.args, ("docker", "build", "-t", computer_image.image_tag(), "-"))
        self.assertEqual(proc.payload, computer_image.DOCKERFILE.encode())


class LocalPreviewPermissionTests(unittest.IsolatedAsyncioTestCase):
    async def test_auto_chat_and_agent_still_prompt(self):
        for surface in ("chat:preview-auto", "agent:preview-auto"):
            queue = permissions.open_channel(surface)
            try:
                with patch("core.session_manager.session_manager.get_session", return_value={"permission_mode": "auto"}):
                    task = asyncio.create_task(permissions.decide(surface=surface, tool="computer_local_app",
                        arguments={"url": "http://localhost:8082"}, target="localhost:8082", is_admin=True,
                        force_prompt=True, choices=computer.LOCAL_CHOICES))
                    payload = await asyncio.wait_for(queue.get(), 2)
                    self.assertFalse(task.done())
                    self.assertFalse(permissions.answer(payload["id"], "forever", "david"))
                    self.assertTrue(permissions.answer(payload["id"], "reject", "david"))
                    self.assertEqual((await task).behavior, "deny")
            finally:
                permissions.close_channel(surface)


class EngineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.now = 100.0
        self.procs = []
        self.argv = []

        async def factory(*args, **kwargs):
            self.argv.append(args)
            proc = FakeProc()
            self.procs.append(proc)
            return proc

        self.manager = computer.ComputerManager(factory, clock=lambda: self.now)
        self.available = patch("core.computer.sandbox.available", new=AsyncMock(return_value=(True, "")))
        self.egress = patch("core.computer.sandbox_egress.ensure", new=AsyncMock())
        self.image = patch("core.computer.computer_image.ensure_image", new=AsyncMock(return_value="kairos-computer:fake"))
        self.decide = patch("core.computer.permissions.decide", new=AsyncMock(return_value=permissions.Decision("allow")))
        self.available.start(); self.egress.start(); self.image.start(); self.ask = self.decide.start()
        self.ctx = tool_registry.ToolContext(session_id="s1", is_admin=True, turn_taint=TurnTaint())

    async def asyncTearDown(self):
        await self.manager.close_all()
        self.available.stop(); self.egress.stop(); self.image.stop(); self.decide.stop()

    async def open(self, owner="chat:s1", ctx=None):
        return await self.manager.act(owner, "open", {"url": "https://example.com/"}, ctx or self.ctx)

    async def desktop(self):
        with patch("core.computer._desktop_enabled", return_value=True):
            await self.open()
        return self.manager._computers["chat:s1"]

    async def test_local_preview_approval_revoke_and_stop(self):
        with patch.object(computer.sandbox_egress, "container_ip", AsyncMock(return_value="172.22.0.7")), \
             patch.object(computer.sandbox_egress, "set_grants", AsyncMock()) as grants:
            result = await self.manager.act("chat:s1", "open", {"url": "http://127.0.0.1:8082/"}, self.ctx)
            self.assertIn("open completed", result["text"])
            self.assertEqual(self.ask.call_args.kwargs["tool"], "computer_local_app")
            self.assertTrue(self.ask.call_args.kwargs["force_prompt"])
            self.assertEqual({c["scope"] for c in self.ask.call_args.kwargs["choices"]}, {"once"})
            grants.assert_awaited_with("172.22.0.7", {8082})
            await self.manager.revoke_local_apps("chat:s1")
            grants.assert_awaited_with("172.22.0.7", set())
            result = await self.manager.act("chat:s1", "read", {}, self.ctx)
            self.assertIn("revoked", result["text"])
            await self.manager.act("chat:s1", "open", {"url": "http://localhost:8082/"}, self.ctx)
            await self.manager.stop("chat:s1")
            grants.assert_awaited_with("172.22.0.7", set())

    async def test_local_preview_denied_and_backend_ports(self):
        self.ask.return_value = permissions.Decision("deny", "No")
        result = await self.manager.act("chat:s1", "open", {"url": "http://localhost:8082/"}, self.ctx)
        self.assertIn("not approved", result["text"])
        self.assertFalse(self.procs[0].calls)
        self.ask.reset_mock()
        with patch("core.middleware.local_api_base", return_value="http://127.0.0.1:9991/api"), \
             patch("core.settings.get_setting", return_value=9992), \
             patch.dict(os.environ, {"JARVIS_PORT": "9993"}):
            for port in (8420, 8421, 8422, 8430, 8431, 8888, 8889, 9991, 9992, 9993):
                result = await self.manager.act("chat:s1", "open", {"url": f"http://localhost:{port}/"}, self.ctx)
                self.assertIn("cannot be granted", result["text"])
        self.ask.assert_not_called()

    async def test_local_redirect_does_not_prompt_or_grant_another_port(self):
        await self.open()
        self.procs[0].next_url = "http://localhost:8083/"
        self.ask.reset_mock()
        result = await self.manager.act("chat:s1", "click", {"ref": "1"}, self.ctx)
        self.assertIn("not approved", result["text"])
        self.ask.assert_not_called()

    async def test_stop_and_revoke_invalidate_pending_local_approval(self):
        for stop in (False, True):
            await self.open()
            waiting, answer = asyncio.Event(), asyncio.Event()
            async def decide(**kwargs):
                waiting.set()
                await answer.wait()
                return permissions.Decision("allow")
            with patch.object(computer.permissions, "decide", AsyncMock(side_effect=decide)), \
                 patch.object(computer.sandbox_egress, "set_grants", AsyncMock()) as grants:
                request = asyncio.create_task(self.manager.act("chat:s1", "open", {"url": "http://localhost:8082"}, self.ctx))
                await waiting.wait()
                if stop:
                    await asyncio.wait_for(self.manager.stop("chat:s1"), 1)
                else:
                    await asyncio.wait_for(self.manager.revoke_local_apps("chat:s1"), 1)
                answer.set()
                self.assertIn("while waiting", (await request)["text"])
                grants.assert_not_awaited()

    async def test_revoke_route_checks_owner_and_clears_grants(self):
        with patch.object(computer_routes, "_access") as access, \
             patch.object(computer_routes, "_running"), \
             patch.object(computer.manager, "revoke_local_apps", AsyncMock()) as revoke:
            self.assertEqual(await computer_routes.revoke_local_apps("chat:s1", "david"), {"ok": True})
            access.assert_called_once_with("chat:s1", "david")
            revoke.assert_awaited_once_with("chat:s1")

    async def push_steps(self, steps, ident=None):
        c = self.manager._computers["chat:s1"]
        for step in steps:
            self.procs[-1].stdout.feed_data((json.dumps({"event": "step", "recording_id": ident or c.recording_id,
                "step": step}) + "\n").encode())
        await self.manager._command(c, "state")

    async def test_recording_requires_takeover_and_explicit_start(self):
        await self.open()
        with self.assertRaisesRegex(ValueError, "take over"):
            await self.manager.start_recording("chat:s1")
        self.manager.takeover("chat:s1")
        await self.push_steps([{"kind": "click"}], "not-started")
        self.assertEqual(self.manager._computers["chat:s1"].steps, [])
        await self.manager.start_recording("chat:s1")
        self.assertTrue(self.manager.running()[0]["recording"])
        self.assertTrue((await self.manager.frame("chat:s1"))["recording"])
        await self.manager.person_input("chat:s1", "type", {"text": "kairos"})
        self.assertEqual(self.procs[-1].calls[-1]["recording_id"], self.manager._computers["chat:s1"].recording_id)
        await self.push_steps([{"kind": "type", "text": "kairos"}])
        self.assertEqual(await self.manager.stop_recording("chat:s1"), [{"kind": "type", "text": "kairos"}])
        self.assertFalse(self.manager.running()[0]["recording"])
        self.assertEqual(self.manager._computers["chat:s1"].steps, [])
        with self.assertRaisesRegex(ValueError, "no recording"):
            await self.manager.stop_recording("chat:s1")

    async def test_recording_cap_and_late_events_are_ignored(self):
        await self.open()
        self.manager.takeover("chat:s1")
        await self.manager.start_recording("chat:s1")
        ident = self.manager._computers["chat:s1"].recording_id
        await self.push_steps([{"kind": "key", "key": str(i)} for i in range(250)])
        self.assertEqual(len(await self.manager.stop_recording("chat:s1")), 200)
        await self.manager.start_recording("chat:s1")
        await self.push_steps([{"kind": "type", "text": "from an old recording"}], ident)
        self.assertEqual(await self.manager.stop_recording("chat:s1"), [])

    async def test_recording_discarded_on_handback_stop_and_close(self):
        for end in ("handback", "stop", "close"):
            await self.open()
            c = self.manager._computers["chat:s1"]
            self.manager.takeover("chat:s1")
            await self.manager.start_recording("chat:s1")
            await self.push_steps([{"kind": "type", "text": "discard me"}])
            if end == "handback": self.manager.hand_back("chat:s1")
            elif end == "stop": await self.manager.stop("chat:s1")
            else: await self.manager.close_all()
            self.assertFalse(c.recording)
            self.assertEqual(c.steps, [])
            self.assertIsNone(c.recording_id)
            if end == "handback": await self.manager.stop("chat:s1")

    async def test_desktop_mode_is_fixed_at_start_and_reports_hardening(self):
        await self.desktop()
        self.assertTrue(self.manager.running()[0]["desktop"])
        self.assertIn("KAIROS_COMPUTER_DESKTOP=1", self.argv[0])
        self.assertEqual(self.argv[0][self.argv[0].index("--memory") + 1], "2g")
        self.assertIn("--read-only", self.argv[0])
        self.assertNotIn("--mount", self.argv[0])
        with patch("core.computer._desktop_enabled", return_value=False):
            result = await self.manager.act("chat:s1", "screenshot", {}, self.ctx)
            self.assertIn("Desktop screenshot", result["text"])
            self.assertEqual(self.procs[0].calls[-1]["action"], "desktop_screenshot")
            await self.manager.stop("chat:s1")
            await self.open()
        self.assertFalse(self.manager.running()[0]["desktop"])
        self.assertEqual(self.argv[1][self.argv[1].index("--memory") + 1], "1g")
        with patch("core.computer._desktop_enabled", return_value=True):
            self.assertIn("desktop is off", (await self.manager.act("chat:s1", "launch", {"app": "editor"}, self.ctx))["text"])

    async def test_desktop_launch_allowlist_and_windows(self):
        await self.desktop()
        for app in ("terminal", "mail", "chat", "sh", "mousepad; sh", "../../bin/sh", ""):
            count = len(self.procs[0].calls)
            result = await self.manager.act("chat:s1", "launch", {"app": app}, self.ctx)
            self.assertIn("Not run", result["text"])
            self.assertFalse(any(c["action"] == "launch" for c in self.procs[0].calls[count:]))
        for app in computer_image.DESKTOP_APPS:
            await self.manager.act("chat:s1", "launch", {"app": app}, self.ctx)
            self.assertEqual(self.procs[0].calls[-1]["app"], app)
        result = await self.manager.act("chat:s1", "windows", {}, self.ctx)
        self.assertIn('"class": "Mousepad"', result["text"])
        self.assertIn('"geometry"', result["text"])

    async def test_model_desktop_input_refuses_browser_and_unknown_windows(self):
        await self.desktop()
        proc = self.procs[0]
        for cls in ("Chromium", "Google-chrome", "kairos-computer-browser", ""):
            proc.window["class"] = cls
            for action, values in (("click", {"x": 20, "y": 30}), ("type", {"text": "private"}),
                                   ("key", {"key": "Enter"}), ("scroll", {"dy": 100})):
                count = len(proc.calls)
                result = await self.manager.act("chat:s1", action, {"desktop": True, **values}, self.ctx)
                self.assertTrue(result["text"].startswith("Not run:"))
                self.assertFalse(any(c["action"] == "desktop_input" for c in proc.calls[count:]))
                self.assertEqual(proc.calls[-1]["action"], "window_at" if action in ("click", "scroll") else "focused_window")
                if cls: self.assertIn("That is the browser window: use the computer's web actions", result["text"])
        proc.window["class"] = "Mousepad"
        await self.manager.act("chat:s1", "click", {"desktop": True, "x": 20, "y": 30}, self.ctx)
        self.assertEqual(proc.calls[-1]["action"], "desktop_input")
        self.assertEqual(proc.calls[-1]["expected_window"], proc.window)
        self.assertNotIn("person", proc.calls[-1])

    async def test_person_desktop_input_goes_to_browser_and_desktop(self):
        await self.desktop()
        self.manager.takeover("chat:s1")
        for cls in ("Chromium", "Mousepad", ""):
            self.procs[0].window["class"] = cls
            for kind, values in (("click", {"x": 10, "y": 20}), ("type", {"text": "private"}),
                                 ("key", {"key": "Enter"}), ("scroll", {"dy": 100})):
                await self.manager.person_input("chat:s1", kind, values)
                command = self.procs[0].calls[-1]
                self.assertEqual(command["action"], "desktop_input")
                self.assertEqual(command["kind"], kind)
                self.assertTrue(command["person"])
                self.assertNotIn("expected_window", command)

    async def test_desktop_off_refuses_without_starting_and_non_admin_stays_browser(self):
        with patch("core.computer._desktop_enabled", return_value=False):
            for action, values in (("launch", {"app": "editor"}), ("windows", {}), ("click", {"desktop": True}),
                                   ("screenshot", {"desktop": True})):
                self.assertIn("desktop is off", (await self.manager.act("chat:s1", action, values, self.ctx))["text"])
        self.assertEqual(self.argv, [])
        ctx = tool_registry.ToolContext(session_id="s1", is_admin=False)
        with patch("core.computer._desktop_enabled", return_value=True):
            self.assertIn("desktop is off", (await self.manager.act("chat:s1", "windows", {}, ctx))["text"])
            await self.open(ctx=ctx)
        self.assertFalse(self.manager.running()[0]["desktop"])

    async def test_web_guards_and_browser_screenshot_still_apply_with_desktop(self):
        await self.desktop()
        self.procs[0].element = {"tag": "button", "signals": ["Place order"], "label": "Place order"}
        result = await self.manager.act("chat:s1", "click", {"ref": "1"}, self.ctx)
        self.assertIn("Stopped before pressing 'Place order'", result["text"])
        self.assertFalse(any(c["action"] in ("click", "desktop_input") for c in self.procs[0].calls))
        await self.manager.act("chat:s1", "screenshot", {"desktop": False}, self.ctx)
        self.assertEqual(self.procs[0].calls[-1]["action"], "screenshot")

    async def test_desktop_keeps_site_checks_before_and_after_input(self):
        await self.desktop()
        self.procs[0].next_url = "https://other.com/"
        self.ask.return_value = permissions.Decision("deny", "No")
        result = await self.manager.act("chat:s1", "click", {"desktop": True, "x": 20, "y": 30}, self.ctx)
        self.assertIn("Not opened", result["text"])
        self.assertEqual(result["images"], [])
        self.assertEqual(self.procs[0].calls[-1]["action"], "back")
        sent = next(cmd for cmd in self.procs[0].calls if cmd["action"] == "desktop_input")
        self.assertEqual(sent["expected_url"], "https://example.com/")
        self.procs[0].url = "https://third.com/"
        count = len(self.procs[0].calls)
        result = await self.manager.act("chat:s1", "screenshot", {}, self.ctx)
        self.assertIn("Not opened", result["text"])
        self.assertFalse(any(cmd["action"] == "desktop_screenshot" for cmd in self.procs[0].calls[count:]))

    async def test_driver_source_goes_over_stdin_not_the_command_line(self):
        # Windows caps a command line at 32,767 characters; the driver passed that.
        await self.open()
        self.assertLess(sum(len(str(part)) + 1 for part in self.argv[0]), 4000)
        self.assertEqual(self.procs[0].driver_source, computer.SOURCE)
        self.assertNotIn(computer.SOURCE, self.argv[0])

    async def test_protocol_taint_read_and_done(self):
        result = await self.open()
        self.assertEqual(result["images"], [PNG])
        self.assertTrue(self.ctx.turn_taint.tainted)
        read = await self.manager.act("chat:s1", "read", {}, self.ctx)
        self.assertIn("[1] a More", read["text"])
        self.assertEqual([c["id"] for c in self.procs[0].calls], [1, 2, 3])
        self.assertEqual(self.procs[0].calls[0]["action"], "open")
        self.assertEqual((await self.manager.act("chat:s1", "done", {}, self.ctx))["images"], [])
        self.assertEqual(self.manager.running(), [])

    async def test_closed_frame_is_retained_expires_and_chat_delete_forgets_it(self):
        from core.session_manager import session_manager
        await self.open()
        self.manager._computers["chat:s1"].screenshot = (Path(__file__).resolve().parents[1] / "static/img/computer-fixture.jpg").read_bytes()
        await self.manager.act("chat:s1", "done", {}, self.ctx)
        saved = self.manager.last("chat:s1")
        self.assertEqual(saved["url"], "https://example.com/")
        self.assertTrue(saved["closed_at"])
        self.assertTrue(base64.b64decode(saved["image"]).startswith(b"\xff\xd8"))
        self.now += 601
        self.assertIsNone(self.manager.last("chat:s1"))
        await self.open()
        await self.manager.stop("chat:s1")
        self.assertIsNotNone(self.manager.last("chat:s1"))
        with patch.object(computer, "manager", self.manager), patch("core.session_manager.store.delete_session"):
            session_manager.delete_session("s1")
        self.assertIsNone(self.manager.last("chat:s1"))

    async def test_new_host_asked_once_and_denial_goes_back(self):
        await self.open()
        self.procs[0].next_url = "https://other.com/"
        self.ask.return_value = permissions.Decision("deny", "No")
        result = await self.manager.act("chat:s1", "click", {"ref": "1"}, self.ctx)
        self.assertIn("Not opened", result["text"])
        self.assertEqual(self.procs[0].calls[-1]["action"], "back")
        self.assertEqual([c.kwargs["target"] for c in self.ask.call_args_list], ["example.com", "other.com"])

    async def test_idle_redirect_is_checked_before_reading(self):
        await self.open()
        self.procs[0].url = "https://other.com/"
        self.ask.return_value = permissions.Decision("deny", "No")
        result = await self.manager.act("chat:s1", "read", {}, self.ctx)
        self.assertIn("Not opened", result["text"])
        self.assertNotIn("read", [c["action"] for c in self.procs[0].calls])

    async def test_buy_send_post_categories_hard_stop_without_decision(self):
        await self.open()
        # The whole-word rule leaves "Postcode" alone; repost and retweet are posting.
        labels = ("Buy now", "Pay", "Purchase", "Order", "Place order", "Checkout", "Check out",
                  "Subscribe", "Donate", "Transfer", "Send", "Reply", "Forward", "Post", "Repost",
                  "Retweet", "Publish", "Share", "Comment", "Submit", "Confirm")
        for label in labels:
            self.ask.reset_mock()
            self.procs[0].element = {"tag": "button", "label": label, "signals": [label], "submit": True}
            result = await self.manager.act("chat:s1", "click", {"ref": "1"}, self.ctx)
            self.assertEqual(result["text"],
                f"Stopped before pressing '{label}' on example.com: buying, sending and posting are done by the person. "
                "Everything up to it is ready; ask them to take over and press it.")
            self.ask.assert_not_called()
        self.assertNotIn("click", [c["action"] for c in self.procs[0].calls])

    async def test_all_element_signals_are_checked(self):
        await self.open()
        self.ask.reset_mock()
        self.procs[0].element = {"tag": "button", "label": "Continue", "signals": ["Continue", "Pay now"]}
        result = await self.manager.act("chat:s1", "click", {"ref": "1"}, self.ctx)
        self.assertIn("pressing 'Pay now'", result["text"])
        self.ask.assert_not_called()
        long_label = "Continue " + ("x" * 200) + " send"
        self.procs[0].element = {"tag": "button", "label": "Continue", "signals": [long_label]}
        result = await self.manager.act("chat:s1", "click", {"ref": "1"}, self.ctx)
        self.assertIn("Stopped before pressing", result["text"])
        self.ask.assert_not_called()

    async def test_enter_checks_form_submit_but_search_proceeds(self):
        await self.open()
        self.ask.reset_mock()
        self.procs[0].element = {"tag": "input", "label": "Search", "form": True,
                                 "form_submits": [{"label": "Place order", "signals": ["Place order"]}]}
        stopped = await self.manager.act("chat:s1", "key", {"key": "Control+Enter"}, self.ctx)
        self.assertIn("pressing 'Place order'", stopped["text"])
        self.assertNotIn("key", [c["action"] for c in self.procs[0].calls])
        self.ask.assert_not_called()
        self.procs[0].element["form_submits"] = [{"label": "Go", "signals": ["Go"]}]
        await self.manager.act("chat:s1", "key", {"key": "Enter"}, self.ctx)
        self.assertEqual(self.procs[0].calls[-1]["action"], "key")
        self.ask.assert_not_called()

    async def test_search_and_whole_word_nonmatches_proceed(self):
        await self.open()
        self.ask.reset_mock()
        for label in ("Search", "Postcode", "Likely matches", "Followers", "Starred items"):
            self.procs[0].element = {"tag": "button", "label": label, "signals": [label], "submit": True}
            await self.manager.act("chat:s1", "click", {"ref": "1"}, self.ctx)
            self.assertEqual(self.procs[0].calls[-1]["action"], "click", label)
        self.ask.assert_not_called()

    async def test_reactions_stop_by_default_and_an_admin_can_allow_them(self):
        await self.open()
        self.ask.reset_mock()
        labels = ("like this video along with 1,234 other people", "Unlike", "Follow", "Unfollow",
                  "Upvote", "Downvote", "React", "Favourite", "Favorite", "Star", "Heart")
        with patch("core.computer._reactions_allowed", return_value=False):
            for label in labels:
                self.procs[0].element = {"tag": "button", "label": label, "signals": [label]}
                result = await self.manager.act("chat:s1", "click", {"ref": "1"}, self.ctx)
                self.assertTrue(result["text"].startswith(f"Stopped before pressing '{label}' on example.com: "
                                                          "likes, follows and reactions are done by the person"), label)
        self.assertNotIn("click", [c["action"] for c in self.procs[0].calls])
        with patch("core.computer._reactions_allowed", return_value=True):
            for label in ("Like", "Follow"):
                self.procs[0].element = {"tag": "button", "label": label, "signals": [label]}
                await self.manager.act("chat:s1", "click", {"ref": "1"}, self.ctx)
                self.assertEqual(self.procs[0].calls[-1]["action"], "click", label)
            # Allowing reactions never relaxes posting.
            self.procs[0].element = {"tag": "button", "label": "Repost", "signals": ["Repost"]}
            result = await self.manager.act("chat:s1", "click", {"ref": "1"}, self.ctx)
            self.assertIn("buying, sending and posting are done by the person", result["text"])
        self.ask.assert_not_called()

    async def test_reaction_stop_reaches_an_agents_inbox(self):
        from services.agent_service import agent_service
        agent = agent_service.create("Reaction check")
        try:
            owner = "agent:" + agent["id"]
            ctx = tool_registry.ToolContext(agent_id=agent["id"], is_admin=True, turn_taint=TurnTaint())
            await self.open(owner, ctx)
            self.procs[-1].element = {"tag": "button", "label": "Like", "signals": ["Like"]}
            with patch("core.computer._reactions_allowed", return_value=False):
                await self.manager.act(owner, "click", {"ref": "1"}, ctx)
            self.assertEqual(agent_service.inbox(agent["id"])[0]["title"], "Ready for you: press 'Like' at example.com")
        finally:
            agent_service.delete(agent["id"])

    async def test_delete_asks_once_or_reject_and_auto_allows(self):
        await self.open()
        self.ask.reset_mock()
        self.ask.return_value = permissions.Decision("allow", "Allowed by Auto")
        for label in ("Delete item", "Remove item"):
            self.procs[0].element = {"tag": "button", "label": label, "signals": [label]}
            result = await self.manager.act("chat:s1", "click", {"ref": "1"}, self.ctx)
            self.assertIn("click completed", result["text"])
            self.assertEqual(self.ask.call_args.kwargs["tool"], "computer_delete")
            self.assertEqual([choice["id"] for choice in self.ask.call_args.kwargs["choices"]], ["once", "reject"])
            self.assertEqual(self.procs[0].calls[-1]["action"], "click")

    async def test_agent_ready_to_press_inbox(self):
        agent = agent_service.create("Ready Agent")
        ctx = tool_registry.ToolContext(agent_id=agent["id"], is_admin=True)
        owner = "agent:" + agent["id"]
        await self.open(owner, ctx)
        self.ask.reset_mock()
        self.procs[0].element = {"tag": "button", "label": "Send message", "signals": ["Send message"]}
        result = await self.manager.act(owner, "click", {"ref": "1"}, ctx)
        self.assertIn("Stopped before pressing", result["text"])
        self.ask.assert_not_called()
        item = agent_service.inbox(agent["id"])[0]
        self.assertEqual(item["title"], "Ready for you: press 'Send message' at example.com")
        self.assertIn("https://example.com/", item["body"])
        await self.manager.stop(owner)
        agent_service.delete(agent["id"])

    async def test_private_fields_refused_for_agents_even_in_auto(self):
        agent = agent_service.create("Computer Agent")
        ctx = tool_registry.ToolContext(agent_id=agent["id"], is_admin=True)
        owner = "agent:" + agent["id"]
        await self.open(owner, ctx)
        for info in ({"tag": "input", "type": "password"}, {"tag": "input", "autocomplete": "current-password"},
                     {"tag": "input", "autocomplete": "new-password"},
                     {"tag": "input", "autocomplete": "one-time-code"},
                     {"tag": "input", "autocomplete": "cc-number"}):
            self.procs[0].element = info
            result = await self.manager.act(owner, "type", {"text": "secret", "ref": "1"}, ctx)
            self.assertIn("Not typed", result["text"])
        self.assertEqual(len([c for c in self.procs[0].calls if c["action"] == "type"]), 0)
        self.procs[0].element = {"tag": "input", "type": "password"}
        keyed = await self.manager.act(owner, "key", {"key": "A"}, ctx)
        self.assertIn("Not typed", keyed["text"])
        self.assertEqual(len([c for c in self.procs[0].calls if c["action"] == "key"]), 0)
        self.assertEqual(agent_service.inbox(agent["id"])[0]["kind"], "question")
        self.assertIn("example.com", agent_service.inbox(agent["id"])[0]["title"])
        await self.manager.stop(owner)
        agent_service.delete(agent["id"])

    async def test_opaque_frame_stops_input_and_notifies_agent(self):
        agent = agent_service.create("Frame Agent")
        owner = "agent:" + agent["id"]
        ctx = tool_registry.ToolContext(agent_id=agent["id"], is_admin=True)
        await self.open(owner, ctx)
        self.ask.reset_mock()
        self.procs[0].element = {"opaque_frame": True, "tag": "iframe"}
        typed = await self.manager.act(owner, "type", {"x": 20, "y": 30, "text": "secret"}, ctx)
        keyed = await self.manager.act(owner, "key", {"key": "Enter"}, ctx)
        clicked = await self.manager.act(owner, "click", {"x": 20, "y": 30}, ctx)
        self.assertIn("Ask the person to take over", typed["text"])
        self.assertIn("Ask the person to take over", keyed["text"])
        self.assertEqual(clicked["text"], computer._opaque_frame_message())
        self.ask.assert_not_called()
        self.assertFalse(any(c["action"] in ("type", "key", "click") for c in self.procs[0].calls))
        self.assertIn("embedded frame", agent_service.inbox(agent["id"])[0]["title"])
        self.assertIn("https://example.com/", agent_service.inbox(agent["id"])[0]["body"])
        await self.manager.stop(owner)
        agent_service.delete(agent["id"])

    async def test_frame_resolved_payment_field_and_pay_button_stop(self):
        await self.open()
        self.ask.reset_mock()
        self.procs[0].element = {"tag": "input", "autocomplete": "cc-number", "frame_depth": 1}
        typed = await self.manager.act("chat:s1", "type", {"x": 80, "y": 90, "text": "4111"}, self.ctx)
        self.assertIn("Not typed", typed["text"])
        self.procs[0].element = {"tag": "button", "label": "Pay", "signals": ["Pay"], "frame_depth": 1}
        clicked = await self.manager.act("chat:s1", "click", {"x": 80, "y": 90}, self.ctx)
        self.assertIn("Stopped before pressing 'Pay'", clicked["text"])
        self.ask.assert_not_called()
        self.assertFalse(any(c["action"] in ("type", "click") for c in self.procs[0].calls))

    async def test_coordinate_click_keeps_inspected_point(self):
        await self.open()
        self.procs[0].element = {"tag": "button", "label": "Search", "signals": ["Search"]}
        await self.manager.act("chat:s1", "click", {"x": 97, "y": 238}, self.ctx)
        inspect = next(c for c in self.procs[0].calls if c["action"] == "inspect")
        clicked = self.procs[0].calls[-1]
        self.assertEqual((inspect["x"], inspect["y"]), (97, 238))
        self.assertEqual((clicked["x"], clicked["y"]), (97, 238))
        self.assertEqual(self.procs[0].mouse_clicks, [(97, 238)])

    async def test_proxy_address_passed_to_driver(self):
        await self.open()
        self.assertIn(f"KAIROS_COMPUTER_PROXY={computer.sandbox_egress.PROXY_URL}", self.argv[0])
        self.assertIn("kairos-computer:fake", self.argv[0])

    async def test_takeover_waits_for_handback_and_times_out(self):
        await self.open()
        self.assertTrue(self.manager.takeover("chat:s1"))
        waiting = asyncio.create_task(self.manager.act("chat:s1", "read", {}, self.ctx))
        await asyncio.sleep(0)
        self.assertFalse(waiting.done())
        self.assertTrue(self.manager.running()[0]["waiting_model"])
        self.manager.hand_back("chat:s1")
        self.assertIn("read completed", (await waiting)["text"])
        self.manager.takeover("chat:s1")
        waiting = asyncio.create_task(self.manager.act("chat:s1", "read", {}, self.ctx))
        await asyncio.sleep(0)
        self.now += 601
        self.assertEqual((await asyncio.wait_for(waiting, 1))["text"],
                         "Not run: the person has control of the computer.")

    async def test_person_input_requires_takeover_and_skips_model_checks(self):
        await self.open()
        with self.assertRaises(ValueError):
            await self.manager.person_input("chat:s1", "type", {"text": "private value"})
        self.manager.takeover("chat:s1")
        self.procs[0].element = {"opaque_frame": True, "tag": "iframe"}
        await self.manager.person_input("chat:s1", "type", {"text": "private value"})
        command = self.procs[0].calls[-1]
        self.assertEqual(command["action"], "person_type")
        self.assertNotIn("expected", command)
        self.assertNotIn("private value", str(self.manager.running()))

    async def test_watched_frames_are_throttled(self):
        await self.open()
        first, second = await asyncio.gather(self.manager.frame("chat:s1"), self.manager.frame("chat:s1"))
        self.assertEqual(first["image"], second["image"])
        self.assertEqual(len([c for c in self.procs[0].calls if c["action"] == "snapshot"]), 1)
        self.now += 0.5
        await self.manager.frame("chat:s1")
        self.assertEqual(len([c for c in self.procs[0].calls if c["action"] == "snapshot"]), 2)


    async def test_idle_and_lru_cap(self):
        await self.open()
        self.now += 1
        await self.open("chat:s2")
        self.now += 1
        await self.open("chat:s3")
        self.assertEqual({r["owner"] for r in self.manager.running()}, {"chat:s2", "chat:s3"})
        self.assertEqual(self.procs[0].returncode, 0)
        self.now += computer.IDLE_SECONDS
        await self.manager._close_idle()
        self.assertEqual(self.manager.running(), [])

    async def test_profile_mount_only_for_opted_in_agent(self):
        await self.open()
        self.assertNotIn("--mount", self.argv[0])
        agent = agent_service.create("Profile Agent")
        ctx = tool_registry.ToolContext(agent_id=agent["id"], is_admin=True)
        await self.open("agent:" + agent["id"], ctx)
        self.assertNotIn("--mount", self.argv[1])
        await self.manager.stop("agent:" + agent["id"])
        agent_service.update(agent["id"], keep_signed_in=True)
        await self.open("agent:" + agent["id"], ctx)
        mounted = self.argv[2]
        self.assertEqual(mounted.count("--mount"), 1)
        self.assertIn(str(computer.PROFILES / agent["id"]), " ".join(mounted))
        with patch.object(computer, "manager", self.manager):
            with self.assertRaises(ValueError): agent_service.forget_logins(agent["id"])
            await self.manager.stop("agent:" + agent["id"])
            agent_service.forget_logins(agent["id"])
            self.assertFalse((computer.PROFILES / agent["id"]).exists())
            agent_service.delete(agent["id"])


class RouteTests(unittest.TestCase):
    def test_desktop_setting_round_trips_and_defaults_off(self):
        from core import settings
        self.app.include_router(settings_routes.router)
        self.app.dependency_overrides[settings_routes.require_admin] = lambda: "alice"
        saved = settings.get_setting("computer_use")
        try:
            self.assertFalse(settings.DEFAULTS["computer_use"]["desktop"])
            for desktop in (True, False):
                value = {"enabled": True, "allow_non_admins": False, "allow_reactions": False, "desktop": desktop}
                response = self.client.post("/api/settings/computer-use", json=value)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["computer_use"], value)
                self.assertEqual(self.client.get("/api/settings").json()["computer_use"], value)
            self.assertFalse(self.client.post("/api/settings/computer-use", json={"enabled": True}).json()["computer_use"]["desktop"])
        finally:
            settings.update_settings(computer_use=saved)

    def test_status_checks_desktop_image_without_building(self):
        with patch.object(computer_routes.sandbox, "available", new=AsyncMock(return_value=(True, ""))), \
             patch.object(computer_routes.computer_image, "image_ready", new=AsyncMock(side_effect=[True, False])) as ready, \
             patch.object(computer_routes.computer_image, "ensure_image", new=AsyncMock()) as build, \
             patch.object(computer_routes.agent_service, "list_agents", return_value=[]):
            response = self.client.get("/api/computer/status")
        self.assertTrue(response.json()["image_ready"])
        self.assertFalse(response.json()["desktop_image_ready"])
        self.assertEqual(ready.await_args_list[-1].kwargs, {"desktop": True})
        build.assert_not_called()

    def setUp(self):
        app = FastAPI(); app.include_router(computer_routes.router)
        app.dependency_overrides[computer_routes.require_user] = lambda: "alice"
        app.dependency_overrides[computer_routes.require_admin] = lambda: "alice"
        self.client = TestClient(app)
        self.app = app
        self.rows = [{"owner": owner, "url": "https://example.com/", "title": "Example",
                      "last_action": 1, "taken_over": False, "waiting_model": False}
                     for owner in ("chat:a", "chat:b", "agent:c")]
        self.admin = patch.object(computer_routes.auth_manager, "is_admin", return_value=False)
        self.header = patch.object(computer_routes, "get_session_header",
                                   side_effect=lambda ident: ({"owner_user": "alice" if ident == "a" else "bob"}, 0))
        self.agent = patch.object(computer_routes.agent_service, "get", return_value={"id": "c"})
        self.running = patch.object(computer_routes.computer, "running", return_value=self.rows)
        self.is_running = patch.object(computer_routes.computer.manager, "is_running", return_value=True)
        for item in (self.admin, self.header, self.agent, self.running, self.is_running): item.start()

    def tearDown(self):
        for item in (self.admin, self.header, self.agent, self.running, self.is_running): item.stop()
        self.client.close()

    def test_non_admin_sees_and_controls_only_own_chat(self):
        self.assertEqual([item["owner"] for item in self.client.get("/api/computer").json()], ["chat:a"])
        for owner in ("chat:b", "agent:c"):
            self.assertEqual(self.client.post(f"/api/computer/{owner}/stop").status_code, 403)
            self.assertEqual(self.client.post(f"/api/computer/{owner}/takeover").status_code, 403)
            self.assertEqual(self.client.get(f"/api/computer/{owner}/frames").status_code, 403)
            self.assertEqual(self.client.post(f"/api/computer/{owner}/input", json={"kind": "type", "text": "secret"}).status_code, 403)
        with patch.object(computer_routes.auth_manager, "is_admin", return_value=True):
            self.assertEqual(len(self.client.get("/api/computer").json()), 3)

    def test_input_refused_before_takeover_and_text_is_not_audited_or_logged(self):
        secret = "private value 1234"
        with patch.object(computer_routes.computer.manager, "person_input", new=AsyncMock(
                side_effect=ValueError("take over the computer first"))):
            self.assertEqual(self.client.post("/api/computer/chat:a/input",
                              json={"kind": "type", "text": secret}).status_code, 409)
        with patch.object(computer_routes.computer.manager, "person_input", new=AsyncMock()) as sent, \
             patch("core.permissions.record_tool_use") as audit, \
             patch("logging.Logger._log") as logs:
            response = self.client.post("/api/computer/chat:a/input", json={"kind": "type", "text": secret})
        self.assertEqual(response.json(), {"ok": True})
        self.assertEqual(sent.await_args.args, ("chat:a", "type", {"text": secret}))
        audit.assert_not_called()
        self.assertNotIn(secret, str(response.json()))
        self.assertNotIn(secret, str(logs.mock_calls))

    def test_record_routes_share_takeover_access_and_require_control(self):
        with patch.object(computer.manager, "start_recording", new=AsyncMock()) as start, \
             patch.object(computer.manager, "stop_recording", new=AsyncMock(return_value=[{"kind": "click"}])):
            for action in ("start", "stop"):
                for owner in ("chat:b", "agent:c"):
                    self.assertEqual(self.client.post(f"/api/computer/{owner}/record/{action}").status_code, 403)
            start.assert_not_awaited()
            self.assertEqual(self.client.post("/api/computer/chat:a/record/start").status_code, 200)
            self.assertEqual(self.client.post("/api/computer/chat:a/record/stop").json(),
                             {"steps": [{"kind": "click"}], "owner": "chat:a"})
            with patch.object(computer_routes.auth_manager, "is_admin", return_value=True), \
                 patch.object(agent_service, "get", return_value={"id": "c", "name": "Scout"}):
                result = self.client.post("/api/computer/agent:c/record/stop").json()
                self.assertEqual(result["agent_id"], "c")
                self.assertEqual(result["agent_name"], "Scout")
        with patch.object(computer.manager, "start_recording", new=AsyncMock(side_effect=ValueError("take over first"))):
            self.assertEqual(self.client.post("/api/computer/chat:a/record/start").status_code, 409)
        with patch.object(computer.manager, "is_running", return_value=False):
            self.assertEqual(self.client.post("/api/computer/chat:a/record/start").status_code, 404)

    def test_last_frame_access_and_absence(self):
        with patch.object(computer_routes.computer.manager, "last", return_value={"owner": "chat:a", "image": "jpeg", "closed_at": 1}):
            result = self.client.get("/api/computer/chat:a/last")
            self.assertEqual(result.json()["image"], "jpeg")
            self.assertEqual(result.headers["cache-control"], "no-store")
            for owner in ("chat:b", "agent:c"):
                self.assertEqual(self.client.get(f"/api/computer/{owner}/last").status_code, 403)
            with patch.object(computer_routes.auth_manager, "is_admin", return_value=True):
                self.assertEqual(self.client.get("/api/computer/agent:c/last").status_code, 200)
        with patch.object(computer_routes.computer.manager, "last", return_value=None):
            self.assertEqual(self.client.get("/api/computer/chat:a/last").status_code, 404)

    def test_history_cannot_read_another_chats_run(self):
        with patch.object(computer_routes.store, "get_run", return_value={"session_id": "b"}):
            self.assertEqual(self.client.get("/api/computer/chat:a/history?run_id=r").status_code, 404)
        with patch.object(computer_routes.store, "get_run", return_value={"session_id": "a"}), \
             patch.object(computer_routes.store, "run_events", return_value=[{"name": "computer", "detail": "frame"}, {"name": "Bash"}]):
            self.assertEqual(self.client.get("/api/computer/chat:a/history?run_id=r").json()["steps"], [{"name": "computer", "detail": "frame"}])

    def test_frames_end_when_computer_closes(self):
        frame = {"owner": "chat:a", "url": "https://example.com/", "title": "Example",
                 "last_action": 1, "taken_over": False, "waiting_model": False, "image": "jpeg"}
        class Connected:
            scope = {"scheme": "http", "server": ("127.0.0.1", 8420)}
            async def is_disconnected(self):
                return False
        async def collect():
            response = await computer_routes.frames("chat:a", Connected(), user="alice")
            return "".join([part async for part in response.body_iterator])
        seen = {}
        async def watch(owner, local=False):
            seen["local"] = local
            yield frame  # one pushed frame, then the computer closes
        with patch.object(computer_routes.computer.manager, "is_running", return_value=True), \
             patch.object(computer_routes.computer.manager, "watch", new=watch), \
             patch.object(computer_routes, "get_current_user", return_value="alice"):
            result = asyncio.run(collect())
        self.assertEqual(result.count('event: frame'), 1)
        self.assertTrue(result.endswith('event: closed\ndata: {}\n\n'))
        self.assertTrue(seen["local"], "plain http on loopback is this computer")
        Connected.scope = {"scheme": "https", "server": ("100.64.1.2", 8443)}
        with patch.object(computer_routes.computer.manager, "is_running", return_value=True), \
             patch.object(computer_routes.computer.manager, "watch", new=watch), \
             patch.object(computer_routes, "get_current_user", return_value="alice"):
            asyncio.run(collect())
        self.assertFalse(seen["local"], "Remote Access (HTTPS on the tailnet) is not local")

class WatchTests(unittest.IsolatedAsyncioTestCase):
    """The live view: pushed screencast frames, never queued behind a command."""

    async def asyncSetUp(self):
        self.procs = []

        async def factory(*args, **kwargs):
            proc = FakeProc()
            self.procs.append(proc)
            return proc

        self.manager = computer.ComputerManager(factory)
        self.patches = [patch("core.computer.sandbox.available", new=AsyncMock(return_value=(True, ""))),
                        patch("core.computer.sandbox_egress.ensure", new=AsyncMock()),
                        patch("core.computer.computer_image.ensure_image", new=AsyncMock(return_value="kairos-computer:fake"))]
        for p in self.patches:
            p.start()
        self.c = await self.manager._get("chat:w")

    async def asyncTearDown(self):
        await self.manager.close_all()
        for p in self.patches:
            p.stop()

    def push(self, data: bytes):
        self.procs[0].stdout.feed_data((json.dumps({"event": "frame", "data": base64.b64encode(data).decode()}) + "\n").encode())

    async def test_frames_are_pushed_and_the_screencast_runs_only_while_watched(self):
        watch = self.manager.watch("chat:w", heartbeat=0.05)
        self.push(b"\xff\xd8one")
        first = await anext(watch)
        self.assertEqual(base64.b64decode(first["image"]), b"\xff\xd8one")
        self.assertEqual([c["action"] for c in self.procs[0].calls], ["watch_start"])
        idle = await anext(watch)  # no new frame: state only, no image re-sent
        self.assertNotIn("image", idle)
        self.push(b"\xff\xd8two")
        self.assertEqual(base64.b64decode((await anext(watch))["image"]), b"\xff\xd8two")
        await watch.aclose()
        self.assertEqual(self.procs[0].calls[-1]["action"], "watch_stop")

    async def test_a_frame_between_replies_does_not_confuse_a_command(self):
        self.push(b"\xff\xd8frame")
        reply = await self.manager._command(self.c, "state")
        self.assertEqual(reply["id"], self.procs[0].calls[-1]["id"])
        self.assertEqual(self.c.frame_jpeg, b"\xff\xd8frame")

    def rates(self):
        return [(c["action"], c.get("fps")) for c in self.procs[0].calls if c["action"].startswith("watch_")]

    async def test_local_control_gets_30_fps_and_watching_gets_10(self):
        watch = self.manager.watch("chat:w", heartbeat=0.05, local=True)
        self.push(b"\xff\xd8one")
        await anext(watch)
        self.assertEqual(self.rates(), [("watch_start", 10)])
        self.manager.takeover("chat:w")
        await asyncio.sleep(0.05)
        self.assertEqual(self.rates()[-1], ("watch_rate", 30))
        self.manager.hand_back("chat:w")
        await asyncio.sleep(0.05)
        self.assertEqual(self.rates()[-1], ("watch_rate", 10))
        await watch.aclose()
        self.assertEqual(self.rates()[-1], ("watch_stop", None))

    async def test_remote_viewer_stays_at_10_fps_even_in_control(self):
        watch = self.manager.watch("chat:w", heartbeat=0.05, local=False)
        self.push(b"\xff\xd8one")
        await anext(watch)
        self.manager.takeover("chat:w")
        await asyncio.sleep(0.05)
        self.assertEqual(self.rates(), [("watch_start", 10)], "no 30 fps for a Remote Access viewer")
        # Frames arriving faster than 10 a second reach this viewer at most every 0.1 s.
        started = asyncio.get_running_loop().time()
        images = 0
        while images < 3:
            self.push(b"\xff\xd8" + bytes([images]))
            if "image" in await anext(watch):
                images += 1
        self.assertGreaterEqual(asyncio.get_running_loop().time() - started, 0.18)
        await watch.aclose()

    async def test_watch_ends_when_the_computer_stops(self):
        watch = self.manager.watch("chat:w", heartbeat=0.05)
        self.push(b"\xff\xd8one")
        await anext(watch)
        await self.manager.stop("chat:w")
        with self.assertRaises(StopAsyncIteration):
            await anext(watch)


class RenderingTests(unittest.IsolatedAsyncioTestCase):
    async def test_desktop_prompt_sentence_only_for_enabled_admin_desktop(self):
        from core import system_prompt
        for enabled, desktop, admin in ((True, True, True), (True, False, True), (False, True, True), (True, True, False)):
            with patch("core.settings.get_setting", return_value={"enabled": enabled, "desktop": desktop, "allow_non_admins": True}):
                for prompt in (system_prompt.for_claude(admin), system_prompt.for_external(admin), system_prompt.for_codex("python", "cli", admin)):
                    self.assertEqual("files stay in its Documents folder" in prompt, enabled and desktop and admin)
                self.assertNotIn("files stay in its Documents folder", system_prompt.for_external(admin, computer_available=False))

    async def test_computer_guidance_is_gated_on_every_surface(self):
        from core import system_prompt
        instruction = "To open, visit, search or operate a website, use the computer tool."
        for enabled, allow, admin, expected in ((False, False, True, False), (True, False, False, False),
                                                (True, False, True, True), (True, True, False, True)):
            with self.subTest(enabled=enabled, allow=allow, admin=admin), \
                 patch("core.settings.get_setting", return_value={"enabled": enabled, "allow_non_admins": allow}):
                for prompt in (system_prompt.for_claude(admin), system_prompt.for_external(admin),
                               system_prompt.for_codex("python", "cli", admin)):
                    self.assertEqual(instruction in prompt, expected)
                self.assertNotIn(instruction, system_prompt.for_external(admin, computer_available=False))

    async def test_claude_only_computer_is_loaded_upfront_when_allowed(self):
        from core.hive_mind_server import get_hive_mind_server
        from mcp import types
        with patch("core.settings.get_setting", return_value={"enabled": True}):
            config = get_hive_mind_server("s1", True)
        handler = config["instance"]._request_handlers["tools/list"].handler
        listed = await handler(None, types.PaginatedRequestParams())
        eager = [tool.name for tool in listed.tools if (tool.meta or {}).get("anthropic/alwaysLoad")]
        self.assertEqual(eager, ["computer"])

    async def test_model_thumbnail_is_downscaled_capped_and_saved_in_run_event(self):
        from core import runs, session_manager_store as store
        from core.computer_history import THUMBNAIL_LIMIT
        source = Image.frombytes("RGB", (1280, 800), os.urandom(1280 * 800 * 3))
        output = io.BytesIO(); source.save(output, "PNG")
        ctx = tool_registry.ToolContext(session_id="s1", is_admin=True)
        context = runs.RunContext("chat", session_id="s1")
        runs.enter(context)
        try:
            with patch("core.settings.get_setting", return_value={"enabled": True}), \
                 patch("core.computer.manager.act", new=AsyncMock(return_value={
                    "text": "URL: https://example.com/ | open completed.", "images": [output.getvalue()]})):
                await tool_registry.call("computer", {"action": "open", "url": "https://example.com/", "text": "never kept"}, ctx, "claude")
            runs.record(context, runs.Tally(), "finished")
            steps = store.run_events(context.run_id)
            detail = json.loads(steps[-1]["detail"])
            data = base64.b64decode(detail["image"])
            self.assertLessEqual(len(data), THUMBNAIL_LIMIT)
            self.assertEqual(detail["action"], "open")
            with Image.open(io.BytesIO(data)) as thumbnail:
                self.assertEqual(thumbnail.format, "JPEG")
                self.assertLess(thumbnail.width, 1280)
            self.assertNotIn("never kept", str(steps))
            self.assertEqual(context.computer_queue.qsize(), 2)
        finally:
            runs.leave(context)
            runs.CURRENT.set(None)

    async def test_container_driver_source_compiles(self):
        compile(SOURCE, "computer_driver container source", "exec")

    async def test_settings_and_plain_tool(self):
        ctx = tool_registry.ToolContext(session_id="s1", is_admin=True)
        with patch("core.settings.get_setting", return_value={"enabled": False}):
            self.assertIn("computer use is off", await tool_registry.call("computer", {"action": "open"}, ctx, "openai"))
        with patch("core.settings.get_setting", return_value={"enabled": True, "allow_non_admins": False}):
            refused = await tool_registry.call("computer", {"action": "open"},
                tool_registry.ToolContext(session_id="s1"), "openai")
            self.assertIn("limited to admins", refused)
        plain = await tool_registry.call("list_notes", {}, ctx, "openai")
        self.assertIsInstance(plain, str)
        self.assertIn("computer", [s.name for s in tool_registry.specs("codex")])
        self.assertNotIn("computer", [s.name for s in tool_registry.specs("openai", helper=True)])

    async def test_claude_blocks_and_provider_image_messages(self):
        from core.hive_mind_server import _handler
        image = tool_registry.ToolResult("seen", [PNG])
        with patch("core.tool_registry.call", new=AsyncMock(return_value=image)):
            result = await _handler("computer", tool_registry.ToolContext())({})
        self.assertEqual(result["content"][1]["mimeType"], "image/png")
        self.assertEqual(base64.b64decode(result["content"][1]["data"]), PNG)
        text, messages = openai_compatible._tool_messages(image, True, None)
        self.assertEqual(text, "seen")
        self.assertEqual(messages[0]["content"][0]["type"], "image_url")
        _, native = openai_compatible._tool_messages(image, True, "openai")
        self.assertEqual(native_api._responses_input(native)[0]["content"][0]["type"], "input_image")
        _, anthropic = openai_compatible._tool_messages(image, True, "anthropic")
        self.assertEqual(native_api._anthropic_messages(anthropic)[1][0]["content"][0]["type"], "image")
        self.assertIn("use computer read", openai_compatible._tool_messages(image, False, None)[0])

    async def test_codex_saved_file_text_and_cleanup(self):
        app = FastAPI(); app.include_router(tool_routes.router)
        token = tool_access.issue("s1", True)
        with patch("core.tool_registry.dispatch", new=AsyncMock(return_value=tool_registry.ToolResult("seen", [PNG]))):
            response = TestClient(app, client=("127.0.0.1", 50000)).post("/api/tools/computer",
                json={"arguments": {"action": "screenshot"}}, headers={"X-JARVIS-Tool-Token": token})
        path = Path(response.json()["result"].split("Screenshot saved: ")[1].split(". Look at it")[0])
        self.assertEqual(path.parent.parent.resolve(), tool_access.SCREEN_ROOT.resolve())
        self.assertEqual(path.read_bytes(), PNG)
        grant = tool_access.resolve(token)
        outside = environment / "outside" / path.parent.name
        self.assertIsNone(tool_access.safe_screenshot_dir(replace(grant, screenshot_dir=str(outside))))
        tool_access.revoke(token)
        self.assertFalse(path.exists())

    async def test_screenshot_startup_sweep(self):
        old = tool_access.SCREEN_ROOT / "0123456789abcdef"
        fresh = tool_access.SCREEN_ROOT / "fedcba9876543210"
        old.mkdir(parents=True)
        fresh.mkdir(parents=True)
        (old / "image.png").write_bytes(PNG)
        os.utime(old, (0, 0))
        tool_access.sweep_screens()
        self.assertFalse(old.exists())
        self.assertTrue(fresh.exists())

    async def test_registry_audit_omits_typed_text(self):
        ctx = tool_registry.ToolContext(session_id="s1", is_admin=True)
        answer = {"text": "URL: https://example.com/ | Title: Example | type completed.", "images": [PNG]}
        with patch("core.settings.get_setting", return_value={"enabled": True}), \
             patch("core.computer.manager.act", new=AsyncMock(return_value=answer)), \
             patch("core.permissions.record_tool_use") as audit:
            result = await tool_registry.call("computer", {"action": "type", "text": "secret"}, ctx, "openai")
        self.assertIsInstance(result, tool_registry.ToolResult)
        self.assertEqual(audit.call_args.args[3], {"action": "type", "url": "https://example.com/"})

    async def test_click_audit_uses_current_url_without_typed_text(self):
        ctx = tool_registry.ToolContext(session_id="s1", is_admin=True)
        answer = {"text": computer._opaque_frame_message(), "images": []}
        with patch("core.settings.get_setting", return_value={"enabled": True}), \
             patch("core.computer.manager.act", new=AsyncMock(return_value=answer)), \
             patch("core.computer.manager.running", return_value=[{"owner": "chat:s1", "url": "https://example.com/checkout"}]), \
             patch("core.permissions.record_tool_use") as audit:
            await tool_registry.call("computer", {"action": "click", "x": 4, "y": 5, "text": "secret"}, ctx, "openai")
        self.assertEqual(audit.call_args.args[3], {"action": "click", "url": "https://example.com/checkout"})
        self.assertEqual(audit.call_args.args[0], "tool refused")

    async def test_unavailable_sandbox_has_no_host_fallback(self):
        from core.sandbox import SandboxUnavailable
        ctx = tool_registry.ToolContext(session_id="s1", is_admin=True)
        with patch("core.settings.get_setting", return_value={"enabled": True}), \
             patch("core.computer.manager.act", new=AsyncMock(side_effect=SandboxUnavailable("Docker is off"))):
            answer = await tool_registry.call("computer", {"action": "open", "url": "https://example.com"},
                                              ctx, "openai")
        self.assertIn("sandbox is unavailable", answer)

    async def test_provider_round_adds_image_after_tool_result(self):
        call = {"id": "c1", "function": {"name": "computer", "arguments": '{"action":"screenshot"}'}}
        replies = [{"choices": [{"message": {"role": "assistant", "content": "", "tool_calls": [call]}}]},
                   {"choices": [{"message": {"role": "assistant", "content": "done"}}]}]
        rounds = []
        with patch("core.providers.openai_compatible._post_chat", new=AsyncMock(side_effect=replies)) as post:
            events = [item async for item in openai_compatible.turn_events("https://local", "m", None,
                [{"role": "user", "content": "look"}], tools=[{"type": "function", "function": {"name": "computer"}}],
                tool_executor=AsyncMock(return_value=tool_registry.ToolResult("seen", [PNG])),
                rounds=rounds, supports_images=True, stream=False)]
        sent = post.call_args_list[1].args[3]["messages"]
        self.assertEqual(sent[-2]["role"], "tool")
        self.assertEqual(sent[-2]["content"], "seen")
        self.assertEqual(sent[-1]["content"][0]["type"], "image_url")
        self.assertEqual(rounds[-1]["role"], "user")


class SteppedProc(FakeProc):
    """A fake driver whose inspected element, URL and errors change per call."""

    def __init__(self):
        super().__init__()
        self.elements, self.errors, self.urls = [], {}, {}

    def reply(self, cmd):
        action = cmd["action"]
        if action in self.errors:
            return {"id": cmd["id"], "error": self.errors.pop(action)}
        if action == "inspect" and self.elements:
            self.element = self.elements.pop(0)
        if action in self.urls:
            self.next_url = self.urls.pop(action)
        if action == "verify":
            checks = [{"check": key, "expected": value, "met": key != "text_absent", "found": "seen"}
                      for key, value in cmd["expect"].items()]
            return {"id": cmd["id"], "url": self.url, "title": "Example", "checks": checks}
        result = super().reply(cmd)
        if action == "click" and cmd.get("ref"):
            result["point"] = {"x": 40, "y": 50}
        if action == "read":
            result.update(snapshot="r2", total_elements=1)
            if cmd.get("since"):
                result.pop("elements"); result.pop("text")
                result["diff"] = {"since": "r1", "added": [{"ref": "r2:1", "tag": "a", "label": "New"}], "changed": [],
                                  "removed": [], "text_added": ["Saved"], "text_removed": [], "counts": [1, 0, 0, 1, 0]}
        return result


class ContractTests(unittest.IsolatedAsyncioTestCase):
    """The action contract (vault: Agents - Computer-Use Upgrade from cua, 5.2)
    against the real guards in core/computer.py, with a fake driver."""

    async def asyncSetUp(self):
        self.procs = []

        async def factory(*args, **kwargs):
            proc = SteppedProc()
            self.procs.append(proc)
            return proc

        self.manager = computer.ComputerManager(factory)
        self.patches = [patch("core.computer.sandbox.available", new=AsyncMock(return_value=(True, ""))),
                        patch("core.computer.sandbox_egress.ensure", new=AsyncMock()),
                        patch("core.computer.computer_image.ensure_image", new=AsyncMock(return_value="kairos-computer:fake"))]
        self.decide = patch("core.computer.permissions.decide", new=AsyncMock(return_value=permissions.Decision("allow")))
        for item in self.patches: item.start()
        self.ask = self.decide.start()
        self.ctx = tool_registry.ToolContext(session_id="s1", is_admin=True, turn_taint=TurnTaint())
        await self.manager.act("chat:s1", "open", {"url": "https://example.com/"}, self.ctx)
        self.proc = self.procs[0]

    async def asyncTearDown(self):
        await self.manager.close_all()
        for item in self.patches: item.stop()
        self.decide.stop()

    def ran(self, *actions):
        return [c for c in self.proc.calls if c["action"] in actions]

    async def steps(self, steps):
        return await self.manager.act("chat:s1", "steps", {"steps": steps}, self.ctx)

    async def test_every_step_is_checked_before_the_first_runs(self):
        count = len(self.proc.calls)
        cases = ([{"action": "type", "ref": "r1:1", "text": "x"}] * 17,
                 [{"action": "type", "ref": "r1:1", "text": "x"}, {"action": "open", "url": "https://other.com/"}],
                 [{"action": "type", "ref": "r1:1", "text": "x"}, {"action": "click"}],
                 [{"action": "type", "ref": "r1:1", "text": "x"}, {"action": "steps", "steps": []}],
                 [{"action": "type", "ref": "r1:1", "text": "x"}, {"action": "key", "key": "Enter", "url": "x"}],
                 [{"action": "type", "ref": "r1:1", "text": 5}], [{"action": "scroll", "dy": "down"}], [], "click")
        for steps in cases:
            result = await self.steps(steps)
            self.assertTrue(result["text"].startswith("Not run:"), result["text"])
            self.assertIn("Nothing ran.", result["text"])
            self.assertEqual(result["code"], "bad_arguments")
        self.assertEqual(len(self.proc.calls), count, "an invalid batch sends nothing to the computer")

    async def test_a_guard_in_step_two_stops_the_batch_and_step_one_stays_done(self):
        typed = {"tag": "input", "label": "Name"}
        cases = (
            ("person_only", {"tag": "button", "label": "Place order", "signals": ["Place order"]}, None, None),
            ("private_field", {"tag": "input", "type": "password", "label": "Password"}, None, None),
            ("opaque_frame", {"opaque_frame": True, "tag": "iframe"}, None, None),
            ("not_approved", {"tag": "button", "label": "Delete item", "signals": ["Delete item"]}, "deny", None),
            ("stale_ref", None, None, "[stale_ref] That ref is from an older read (r1). Read again."),
            ("site_not_approved", {"tag": "a", "label": "Elsewhere"}, "deny-host", None),
        )
        for code, second, decision, error in cases:
            with self.subTest(code):
                self.proc.calls.clear()
                self.proc.url = "https://example.com/"
                self.proc.elements = [typed] + ([second] if second else [])
                original = self.proc.reply
                if error:  # the second inspect is refused by the driver
                    seen = {"n": 0}
                    def reply(cmd, original=original, seen=seen):
                        if cmd["action"] == "inspect":
                            seen["n"] += 1
                            if seen["n"] == 2:
                                return {"id": cmd["id"], "error": error}
                        return original(cmd)
                    self.proc.reply = reply
                if decision == "deny":
                    self.ask.return_value = permissions.Decision("deny", "No")
                if decision == "deny-host":
                    self.proc.urls["click"] = "https://other.com/"
                    self.ask.return_value = permissions.Decision("deny", "No")
                result = await self.steps([{"action": "type", "ref": "r1:1", "text": "Ada"},
                                           {"action": "type" if code == "private_field" else "click", "ref": "r1:2",
                                            "text": "secret"},
                                           {"action": "type", "ref": "r1:3", "text": "never"}])
                self.ask.return_value = permissions.Decision("allow")
                if error:
                    self.proc.reply = original
                self.assertEqual(result["code"], code, result["text"])
                self.assertTrue(result["text"].startswith("Stopped: at step 2 of 3. Steps: 1 of 3 ran."), result["text"])
                self.assertIn("Step 1 already ran and was not undone.", result["text"])
                self.assertIn(f"(code: {code})", result["text"])
                typed_calls = [c for c in self.ran("type")]
                self.assertEqual([c["text"] for c in typed_calls], ["Ada"], "only step 1 typed")
                self.assertNotIn("never", json.dumps(self.proc.calls))
                if code not in ("site_not_approved",):
                    self.assertFalse(self.ran("click"), "the guarded control was not pressed")

    async def test_a_new_host_ends_the_batch_after_that_step(self):
        self.proc.urls["click"] = "https://other.com/"
        result = await self.steps([{"action": "click", "ref": "r1:1"}, {"action": "type", "ref": "r1:2", "text": "no"}])
        self.assertNotIn("code", result)
        self.assertTrue(result["text"].startswith("URL: https://other.com/ | Steps: 1 of 2 ran."), result["text"])
        self.assertIn("the page moved to other.com", result["text"])
        self.assertFalse(self.ran("type"))

    async def test_a_batch_ends_with_one_observation(self):
        result = await self.steps([{"action": "type", "ref": "r1:1", "text": "Ada"}, {"action": "key", "key": "Tab"},
                                   {"action": "scroll", "dy": 200}, {"action": "wait", "seconds": 0}])
        self.assertTrue(result["text"].startswith("URL: https://example.com/ | Steps: 4 of 4 ran."))
        self.assertEqual(len(result["images"]), 1)
        reads = self.ran("read")
        self.assertEqual(len(reads), 1)
        self.assertEqual(reads[0]["since"], "latest")
        self.assertIn("Changes since r1 (now r2): 1 added", result["text"])
        self.assertIn("UNTRUSTED", result["text"])

    async def test_read_arguments_and_verify(self):
        result = await self.manager.act("chat:s1", "read", {"query": "email", "max_elements": 5}, self.ctx)
        self.assertEqual({k: self.ran("read")[-1][k] for k in ("query", "max_elements")}, {"query": "email", "max_elements": 5})
        self.assertIn("Snapshot r2.", result["text"])
        for bad in ({"since": "yesterday"}, {"max_elements": 0}, {"max_elements": 500}, {"query": ["x"]}):
            refused = await self.manager.act("chat:s1", "read", bad, self.ctx)
            self.assertEqual(refused["code"], "bad_arguments")
        met = await self.manager.act("chat:s1", "verify", {"expect": {"url_contains": "example", "text_present": "Hi"}}, self.ctx)
        self.assertTrue(met["met"])
        self.assertIn("Verify: met.", met["text"])
        self.assertEqual(met["images"], [])
        missed = await self.manager.act("chat:s1", "verify", {"expect": {"text_absent": "Error"}}, self.ctx)
        self.assertFalse(missed["met"])
        self.assertIn('text_absent "Error": not met (seen)', missed["text"])
        for bad in (None, {}, {"colour": "red"}, {"element": {"name": "x"}}, {"text_present": ""}):
            refused = await self.manager.act("chat:s1", "verify", {"expect": bad}, self.ctx)
            self.assertEqual(refused["code"], "bad_arguments", bad)

    async def test_refusal_codes_and_the_registry_shows_them(self):
        self.proc.elements = [{"tag": "button", "label": "Buy now", "signals": ["Buy now"]}]
        stopped = await self.manager.act("chat:s1", "click", {"ref": "r1:1"}, self.ctx)
        self.assertEqual(stopped["code"], "person_only")
        self.assertTrue(stopped["text"].startswith("Stopped before pressing 'Buy now'"))
        for text, code in (("Not opened: No URL: x", "site_not_approved"), ("Not run: the agent desktop is off.", "needs_desktop"),
                           (computer._opaque_frame_message(), "opaque_frame"), ("URL: x | click completed.", None),
                           ("Not run: the person has control of the computer.", "person_in_control")):
            self.assertEqual(computer.refusal_code(text), code, text)
        with patch("core.settings.get_setting", return_value={"enabled": True}), \
             patch("core.computer.manager.act", new=AsyncMock(side_effect=computer.ComputerRefusal("That ref is old.", "stale_ref"))):
            text = await tool_registry.call("computer", {"action": "click", "ref": "r1:1"}, self.ctx, "openai")
        self.assertEqual(text, "Not run: That ref is old. (code: stale_ref)")
        with patch("core.settings.get_setting", return_value={"enabled": True}), \
             patch("core.computer.manager.act", new=AsyncMock(return_value={"text": "Stopped before pressing 'Pay'", "images": [], "code": "person_only"})), \
             patch("core.permissions.record_tool_use") as audit:
            result = await tool_registry.call("computer", {"action": "click", "ref": "r1:1"}, self.ctx, "openai")
        self.assertTrue(result.text.endswith("\n(code: person_only)"))
        self.assertEqual(audit.call_args.args[0], "tool refused")

    async def test_a_coded_driver_error_becomes_a_refusal_with_its_code(self):
        self.proc.errors["inspect"] = "[stale_ref] That ref is from an older read (r6). Use r7:12 or read again."
        with self.assertRaises(computer.ComputerRefusal) as raised:
            await self.manager.act("chat:s1", "click", {"ref": "r6:12"}, self.ctx)
        self.assertEqual(raised.exception.code, "stale_ref")
        self.assertEqual(str(raised.exception), "That ref is from an older read (r6). Use r7:12 or read again.")
        self.assertFalse(self.ran("click"))


class DesktopContractTests(unittest.IsolatedAsyncioTestCase):
    """Desktop refs (cua upgrade 5.3) through the same guards, fake driver."""

    async def asyncSetUp(self):
        self.desktop = patch("core.computer._desktop_enabled", return_value=True)
        self.desktop.start()
        await ContractTests.asyncSetUp(self)
        self.control = {}
        self.focused = {"element": {}, "defaults": []}
        original = self.proc.reply

        def reply(cmd):
            if cmd["action"] == "desktop_inspect":
                return {"id": cmd["id"], "element": self.control, "note": ""}
            if cmd["action"] == "desktop_focused":
                return {"id": cmd["id"], **self.focused}
            if cmd["action"] == "desktop_ref_input":
                return {"id": cmd["id"], "how": "action click", "url": self.proc.url, "title": "", "screenshot": base64.b64encode(PNG).decode()}
            if cmd["action"] == "desktop_read":
                return {"id": cmd["id"], "snapshot": "d1", "url": self.proc.url, "title": "", "total_elements": 1,
                        "window": {"title": "Untitled 1", "app": "soffice"}, "text": "Window: Untitled 1 (soffice)",
                        "elements": [{"ref": "d1:1", "tag": "push button", "label": "Save"}],
                        "screenshot": base64.b64encode(PNG).decode()}
            return original(cmd)
        self.proc.reply = reply

    async def asyncTearDown(self):
        await ContractTests.asyncTearDown(self)
        self.desktop.stop()

    ran = ContractTests.ran

    async def test_desktop_refs_read_act_and_route_without_a_desktop_flag(self):
        read = await self.manager.act("chat:s1", "read", {"desktop": True}, self.ctx)
        self.assertIn("[d1:1] push button Save", read["text"])
        self.assertIn("desktop window content", read["text"])
        self.assertTrue(self.ctx.turn_taint.tainted)
        self.control = {"tag": "push button", "role": "push button", "label": "Save", "app": "soffice", "signals": ["Save"]}
        clicked = await self.manager.act("chat:s1", "click", {"ref": "d1:1"}, self.ctx)
        self.assertIn("by action click", clicked["text"])
        sent = self.ran("desktop_ref_input")[-1]
        self.assertEqual((sent["ref"], sent["kind"], sent["expected"]), ("d1:1", "click", self.control))

    async def test_desktop_labels_go_through_the_press_guard(self):
        for label, code in (("Send", "person_only"), ("Buy now", "person_only"), ("Delete Sheet", "not_approved")):
            self.ask.return_value = permissions.Decision("deny", "No")
            self.control = {"tag": "menu item", "role": "menu item", "label": label, "app": "soffice", "signals": [label]}
            result = await self.manager.act("chat:s1", "click", {"ref": "d1:1"}, self.ctx)
            self.assertEqual(result["code"], code, result["text"])
            if code == "person_only":
                self.assertIn(f"Stopped before pressing '{label}' on the desktop (soffice)", result["text"])
        self.assertFalse(self.ran("desktop_ref_input"), "no guarded control was pressed")
        self.ask.return_value = permissions.Decision("allow")

    async def test_desktop_password_fields_and_enter_on_a_default_button(self):
        self.control = {"tag": "password text", "role": "password text", "label": "Password", "app": "soffice", "private": True, "signals": []}
        refused = await self.manager.act("chat:s1", "type", {"ref": "d1:1", "text": "secret"}, self.ctx)
        self.assertEqual(refused["code"], "private_field")
        self.focused = {"element": {"tag": "password text", "label": "Password", "private": True}, "defaults": []}
        for action, args in (("type", {"text": "secret"}), ("key", {"key": "a"})):
            result = await self.manager.act("chat:s1", action, {"desktop": True, **args}, self.ctx)
            self.assertEqual(result["code"], "private_field", action)
        tabbed = await self.manager.act("chat:s1", "key", {"desktop": True, "key": "Tab"}, self.ctx)
        self.assertNotIn("code", tabbed)
        self.focused = {"element": {"tag": "text", "label": "To"}, "defaults": [{"tag": "push button", "label": "Send now"}]}
        stopped = await self.manager.act("chat:s1", "key", {"desktop": True, "key": "Return"}, self.ctx)
        self.assertEqual(stopped["code"], "person_only")
        self.assertIn("'Send now'", stopped["text"])
        self.assertNotIn("secret", json.dumps([c for c in self.proc.calls if c["action"] == "desktop_input"]))


def real_png(color=(40, 90, 160)):
    output = io.BytesIO()
    Image.new("RGB", (1280, 800), color).save(output, "PNG")
    return output.getvalue()


class TrajectoryTests(unittest.TestCase):
    """Kept computer steps (cua upgrade 5.4): what is kept, for how long, for whom."""

    def setUp(self):
        from core import computer_trajectory
        self.t = computer_trajectory
        self.root = environment / ("trajectories-" + uuid.uuid4().hex[:6])
        self.days = patch("core.settings.get_setting", side_effect=lambda key: {"computer_steps_days": 7}.get(key))
        self.days.start()

    def tearDown(self):
        self.days.stop()
        shutil.rmtree(self.root, ignore_errors=True)

    def keep(self, run_id="run1", owner="chat:a", action="click", args=None, result=None, before=None):
        result = result or {"text": "URL: https://example.com/ | Title: x | click completed.", "images": [real_png()],
                            "point": {"x": 100, "y": 120}, "element": {"label": "More", "tag": "a"}}
        return self.t.record(owner, run_id, action, args or {"action": action, "ref": "r1:1"}, result,
                             before or real_png((200, 200, 200)), root=self.root)

    def test_a_step_keeps_action_images_marker_and_evidence(self):
        self.assertEqual(self.keep(), 1)
        step = self.t.steps("run1", self.root)[0]
        self.assertEqual(step["images"], ["before.jpg", "after.jpg", "marker.jpg"])
        self.assertEqual(step["url"], "https://example.com/")
        self.assertEqual(step["point"], {"x": 100, "y": 120})
        self.assertTrue(step["ok"])
        self.assertEqual(step["evidence"]["kept"], ["action.json", "before.jpg", "after.jpg", "marker.jpg"])
        with Image.open(self.t.image("run1", 1, "marker.jpg", self.root)) as marker:
            self.assertGreater(marker.convert("RGB").getpixel((100, 120))[0], 150)
        self.assertNotIn("action", step["arguments"])

    def test_private_fields_keep_no_text_and_no_image(self):
        for result in ({"text": "Not typed: passwords, codes and payment details are entered by the person.", "code": "private_field"},
                       {"text": "URL: x | type completed.", "images": [real_png()], "element": {"tag": "input", "type": "password"}},
                       {"text": "URL: x | Desktop type completed.", "images": [real_png()], "element": {"role": "password text"}}):
            number = self.keep(action="type", args={"ref": "r1:2", "text": "hunter2"}, result=result)
            step = self.t.steps("run1", self.root)[number - 1]
            self.assertEqual(step["arguments"]["text"], "(private field)")
            self.assertEqual(step["images"], [])
            self.assertEqual(step["evidence"]["not_kept"], {"before.jpg": "private field", "after.jpg": "private field"})
        self.assertNotIn("hunter2", self.t.export("run1", self.root).decode("latin-1"))

    def test_bounds_owner_and_off(self):
        with patch.object(self.t, "STEP_LIMIT", 3):
            numbers = [self.keep() for _ in range(5)]
        self.assertEqual(numbers, [1, 2, 3, None, None])
        self.assertIsNone(self.keep(owner="chat:b"), "a run belongs to one owner")
        with patch.object(self.t, "RUN_BYTES", 1):
            self.keep(run_id="run2")
            number = self.keep(run_id="run2")
        self.assertEqual(self.t.steps("run2", self.root)[number - 1]["evidence"]["not_kept"]["after.jpg"], "this run reached its size limit")
        for bad in ("../x", "a/b", "", "x" * 65):
            self.assertIsNone(self.keep(run_id=bad))
        with patch("core.settings.get_setting", return_value=0):
            self.assertIsNone(self.keep(run_id="run3"))
        self.assertFalse((self.root / "run3").exists())

    def test_retention_deletes_old_runs_and_off_deletes_all(self):
        self.keep(run_id="old")
        self.keep(run_id="new")
        meta = json.loads((self.root / "old" / "meta.json").read_text())
        meta["updated"] -= 8 * 86400
        (self.root / "old" / "meta.json").write_text(json.dumps(meta))
        self.assertEqual(self.t.sweep(root=self.root), 1)
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ["new"])
        with patch("core.settings.get_setting", return_value=0):
            self.assertEqual(self.t.sweep(root=self.root), 1)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_skill_steps_take_only_successful_actions(self):
        self.keep(action="open", args={"url": "https://example.com/?token=abc"}, result={"text": "URL: https://example.com/ | open completed."})
        self.keep(action="read", args={}, result={"text": "URL: https://example.com/ | read completed.", "state": {"snapshot": "r1"}})
        self.keep()
        self.keep(action="click", result={"text": "Stopped before pressing 'Buy now'", "code": "person_only"})
        self.keep(action="type", args={"ref": "r1:2", "text": "Ada"}, result={"text": "URL: x | type completed.", "element": {"label": "Name"}})
        self.keep(action="type", args={"ref": "r1:3", "text": "hunter2"}, result={"text": "Not typed", "code": "private_field"})
        shaped = self.t.skill_steps("run1", self.root)
        self.assertEqual([s["kind"] for s in shaped], ["open", "click", "type"])
        self.assertEqual(shaped[2]["text"], "Ada")
        self.assertEqual(shaped[1]["element"]["label"], "More")

    def test_routes_check_the_runs_owner_and_never_cache(self):
        self.keep(run_id="chatrun", owner="chat:a")
        self.keep(run_id="agentrun", owner="agent:c")
        app = FastAPI(); app.include_router(computer_routes.router)
        app.dependency_overrides[computer_routes.require_user] = lambda: "alice"
        client = TestClient(app)
        with patch.object(computer_routes.computer_trajectory, "ROOT", self.root), \
             patch.object(computer_routes.auth_manager, "is_admin", return_value=False), \
             patch.object(computer_routes, "get_session_header",
                          side_effect=lambda ident: ({"owner_user": "alice" if ident == "a" else "bob"}, 0)), \
             patch.object(computer_routes.agent_service, "get", return_value={"id": "c", "name": "Scout"}):
            steps = client.get("/api/computer/steps/chatrun")
            self.assertEqual(steps.status_code, 200)
            self.assertEqual(steps.headers["cache-control"], "no-store")
            self.assertEqual(len(steps.json()["steps"]), 1)
            image = client.get("/api/computer/steps/chatrun/1/marker.jpg")
            self.assertEqual((image.status_code, image.headers["content-type"], image.headers["cache-control"]),
                             (200, "image/jpeg", "no-store"))
            self.assertEqual(client.get("/api/computer/steps/chatrun/1/action.json").status_code, 404)
            self.assertEqual(client.get("/api/computer/steps/chatrun/9/after.jpg").status_code, 404)
            exported = client.get("/api/computer/steps/chatrun/export")
            import zipfile
            names = zipfile.ZipFile(io.BytesIO(exported.content)).namelist()
            self.assertIn("chatrun/step-0001/action.json", names)
            self.assertEqual(client.get("/api/computer/steps/chatrun/skill").json()["steps"][0]["kind"], "click")
            for path in ("/api/computer/steps/agentrun", "/api/computer/steps/agentrun/1/after.jpg",
                         "/api/computer/steps/agentrun/export", "/api/computer/steps/agentrun/skill", "/api/computer/agent:c/steps"):
                self.assertEqual(client.get(path).status_code, 403, path)
            self.assertEqual(client.get("/api/computer/steps/nothing").status_code, 404)
            self.assertEqual(client.get("/api/computer/steps/..%2Fx").status_code, 404)
            self.assertEqual([r["run_id"] for r in client.get("/api/computer/chat:a/steps").json()], ["chatrun"])
            with patch.object(computer_routes.auth_manager, "is_admin", return_value=True):
                detail = client.get("/api/computer/steps/agentrun").json()
                self.assertEqual((detail["agent_id"], detail["agent_name"]), ("c", "Scout"))
        client.close()

    def test_chat_delete_and_settings_route(self):
        from core.session_manager import session_manager
        self.keep(run_id="gone", owner="chat:s9")
        with patch.object(self.t, "ROOT", self.root), patch("core.session_manager.store.delete_session"):
            session_manager.delete_session("s9")
        self.assertFalse((self.root / "gone").exists())
        app = FastAPI(); app.include_router(settings_routes.router)
        app.dependency_overrides[settings_routes.require_admin] = lambda: "alice"
        client = TestClient(app)
        self.days.stop()
        try:
            from core import settings
            saved = settings.get_setting("computer_steps_days")
            self.assertEqual(settings.DEFAULTS["computer_steps_days"], 7)
            self.assertEqual(client.post("/api/settings/computer-steps", json={"days": 3}).status_code, 422)
            self.assertEqual(client.post("/api/settings/computer-steps", json={"days": 30}).json()["computer_steps_days"], 30)
            self.assertEqual(client.get("/api/settings").json()["computer_steps_days"], 30)
            settings.update_settings(computer_steps_days=saved)
        finally:
            self.days.start()
            client.close()


class DriverContractTests(unittest.TestCase):
    """The driver's own ref, diff and verify rules, run from its source."""

    def setUp(self):
        module = ast.parse(SOURCE)
        names = {"row_key", "row_state", "suggest_ref", "resolve_ref", "diff_rows", "diff_lines", "query_rows", "verify_checks"}
        functions = [node for node in module.body if isinstance(node, ast.FunctionDef) and node.name in names]
        self.d = {"re": re}
        exec(compile(ast.Module(body=functions, type_ignores=[]), "driver contract", "exec"), self.d)

    def test_refs_resolve_only_in_the_live_snapshot(self):
        rows = [{"ref": "r7:1", "tag": "button", "label": "Delete item"}, {"ref": "r7:2", "tag": "button", "label": "Archive"}]
        snap = {"id": "r7", "stale": "", "rows": rows}
        history = {"r6": {"1": {"ref": "r6:1", "tag": "button", "label": "Archive"}}}
        resolve = self.d["resolve_ref"]
        self.assertEqual(resolve("r7:2", snap, history), ("2", ""))
        self.assertEqual(resolve("2", snap, history), ("2", "Ref 2 was taken from the current read, r7."))
        with self.assertRaisesRegex(ValueError, r"^\[stale_ref\] That ref is from an older read \(r6\)\. Use r7:2 or read again\.$"):
            resolve("r6:1", snap, history)
        with self.assertRaisesRegex(ValueError, r"^\[stale_ref\] That ref is from an older read \(r5\)\. Read again\.$"):
            resolve("r5:1", snap, history)
        stale = {**snap, "stale": "the page navigated"}
        for ref in ("r7:1", "1", "r6:1"):
            with self.assertRaisesRegex(ValueError, r"^\[stale_ref\]"):
                resolve(ref, stale, history)
        for ref in ("1", "r1:1"):
            with self.assertRaisesRegex(ValueError, r"^\[stale_ref\]"):
                resolve(ref, {"id": None, "stale": "", "rows": []}, {})
        for ref in ("seven", "r7:", "7:1", "button"):
            with self.assertRaisesRegex(ValueError, r"^\[bad_arguments\]"):
                resolve(ref, snap, history)

    def test_diffs_and_queries(self):
        old = [{"ref": "r1:1", "tag": "input", "label": "Email", "value": ""}, {"ref": "r1:2", "tag": "a", "label": "Gone"},
               {"ref": "r1:3", "tag": "button", "label": "Save"}]
        new = [{"ref": "r2:1", "tag": "input", "label": "Email", "value": "a@b.c"}, {"ref": "r2:2", "tag": "button", "label": "Save"},
               {"ref": "r2:3", "tag": "a", "label": "New"}]
        added, changed, removed = self.d["diff_rows"](old, new)
        self.assertEqual([r["label"] for r in added], ["New"])
        self.assertEqual([r["ref"] for r in changed], ["r2:1"])
        self.assertEqual([r["ref"] for r in removed], ["r1:2"])
        self.assertEqual(self.d["diff_lines"]("a\nb\nb\nc", "a\nb\nc\nd\n"), (["d"], ["b"]))
        self.assertEqual([r["ref"] for r in self.d["query_rows"](new, "EMAIL")], ["r2:1"])

    def test_verify_reports_what_it_found(self):
        checks = self.d["verify_checks"]({"url_contains": "done", "title_contains": "Order", "text_present": "Thanks",
                                          "text_absent": "Error", "element": {"role": "button", "name": "Pay"}},
                                         {"url": "https://x/done", "title": "Home", "text": "Thanks for waiting\nError 5",
                                          "element_count": 0})
        self.assertEqual([c["met"] for c in checks], [True, False, True, False, False])
        self.assertEqual(checks[1]["found"], "title is Home")
        self.assertIn("Thanks for waiting", checks[2]["found"])
        self.assertEqual(checks[4]["found"], "0 matching elements")


class ScreenshotHistoryTests(unittest.TestCase):
    def test_only_the_newest_three_screenshots_are_kept(self):
        attachment = {"role": "user", "content": [{"type": "text", "text": "look"}, {"type": "image_url", "image_url": {"url": "x"}}]}
        shots = [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": f"data:{i}"}}]} for i in range(5)]
        native = {"role": "user", "content": [{"type": "image", "source": {}}]}
        messages = [attachment, *shots[:2], {"role": "tool", "content": "seen"}, native, *shots[2:]]
        self.assertEqual(openai_compatible._trim_screenshots(messages), 3)
        self.assertEqual([m["content"] for m in shots[:2]], [openai_compatible.SCREENSHOT_REMOVED] * 2)
        self.assertEqual(native["content"], openai_compatible.SCREENSHOT_REMOVED)
        self.assertTrue(all(isinstance(m["content"], list) for m in shots[2:]))
        self.assertIsInstance(attachment["content"], list, "a person's attachment is never trimmed")
        self.assertEqual(openai_compatible._trim_screenshots(messages), 0)

    def test_a_long_tool_loop_sends_at_most_three_screenshots(self):
        call = {"id": "c1", "function": {"name": "computer", "arguments": '{"action":"screenshot"}'}}
        replies = [{"choices": [{"message": {"role": "assistant", "content": "", "tool_calls": [dict(call, id=f"c{i}")]}}]}
                   for i in range(openai_compatible.MAX_TOOL_ROUNDS)] + [{"choices": [{"message": {"role": "assistant", "content": "done"}}]}]
        history = [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": f"old{i}"}}]} for i in range(4)]
        sent = []
        async def post(client, url, key, body):
            sent.append(sum(1 for m in body["messages"] if openai_compatible._is_screenshot(m)))
            return replies[len(sent) - 1]
        async def run():
            with patch("core.providers.openai_compatible._post_chat", new=post):
                return [item async for item in openai_compatible.turn_events("https://local", "m", None,
                    [{"role": "user", "content": "look"}, *history], tools=[{"type": "function", "function": {"name": "computer"}}],
                    tool_executor=AsyncMock(return_value=tool_registry.ToolResult("seen", [PNG])), supports_images=True, stream=False)]
        asyncio.run(run())
        self.assertTrue(sent and max(sent) <= 3, sent)


def tearDownModule():
    from core import session_manager_store
    session_manager_store.close()
    assert Path(__file__).resolve().parents[1] in environment.resolve().parents
    shutil.rmtree(environment)


if __name__ == "__main__":
    unittest.main()
