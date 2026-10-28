"""Part 2, group g6, area A13 (Cookbook, local models): the built-in llama.cpp
engine (core/llamacpp_engine.py) and Ollama's client (core/ollama_client.py,
services/cookbook_service.py) through /api/cookbook/*. No real download, no
real server: httpx and subprocess are stand-ins, so nothing leaves loopback.

Tests named test_BUG_* assert what the checklist asks for ("download/cancel/
delete/load/start/stop/setup recover from missing runtimes, disk shortages and
interrupted downloads"). They FAIL today; the failure is the bug report.

Run: python -B -X utf8 scripts/test_g6_local_models.py
"""
import asyncio
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

_DATA = tempfile.TemporaryDirectory(prefix="jarvis-g6-local-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402
from fastapi import FastAPI  # noqa: E402

from core import llamacpp_engine as engine, model_endpoints, ollama_client  # noqa: E402
from core.middleware import require_admin  # noqa: E402
from routes import cookbook_routes  # noqa: E402
from services import cookbook_service  # noqa: E402

NAME = engine.CATALOG[0]["name"]


def app():
    web = FastAPI()
    web.include_router(cookbook_routes.router)
    web.dependency_overrides[require_admin] = lambda: "admin"
    return web


def real_client(handler):
    """httpx.AsyncClient bound to a stand-in server, whatever the code asks for."""
    real = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs.pop("follow_redirects", None)
        return real(transport=httpx.MockTransport(handler), **{k: v for k, v in kwargs.items() if k != "transport"})
    return factory


class Stream(httpx.AsyncByteStream):
    def __init__(self, chunks, gate=None, fail_after=None):
        self.chunks, self.gate, self.fail_after = chunks, gate, fail_after

    async def __aiter__(self):
        for i, chunk in enumerate(self.chunks):
            if self.gate is not None and i == 1:
                await self.gate.wait()
            if self.fail_after is not None and i == self.fail_after:
                raise httpx.ReadError("connection lost")
            yield chunk


class Base(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        for folder, _, files in os.walk(engine.GGUF_DIR):
            for f in files:
                os.remove(os.path.join(folder, f))
        engine._download_progress.clear()
        engine._process, engine._running_model = None, None
        cookbook_service._pull_progress.clear()
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app()), base_url="http://t")
        self.addAsyncCleanup(self.http.aclose)

    async def settle(self, name=NAME, limit=300):
        for _ in range(limit):
            if engine.get_download_progress(name).get("done"):
                return engine.get_download_progress(name)
            await asyncio.sleep(0.01)
        raise AssertionError("download never finished")


class EngineDownloads(Base):
    async def test_download_lists_deletes_and_leaves_no_partial_file(self):
        body = [b"x" * 1024, b"y" * 1024]
        handler = lambda request: httpx.Response(200, headers={"content-length": "2048"}, stream=Stream(body))  # noqa: E731
        with patch.object(engine.httpx, "AsyncClient", real_client(handler)):
            self.assertEqual((await self.http.post(f"/api/cookbook/engine/download/{NAME}")).json(), {"ok": True})
            done = await self.settle()
        self.assertEqual((done["status"], done["completed"], done["total"]), ("success", 2048, 2048))
        self.assertEqual((await self.http.get("/api/cookbook/engine/downloaded")).json(), [{"name": NAME, "size": 2048}])
        self.assertEqual([f for f in os.listdir(engine.GGUF_DIR) if f.endswith(".part")], [])
        self.assertEqual((await self.http.delete(f"/api/cookbook/engine/models/{NAME}")).json(), {"ok": True})
        self.assertEqual((await self.http.get("/api/cookbook/engine/downloaded")).json(), [])
        self.assertEqual((await self.http.get(f"/api/cookbook/engine/download/{NAME}/status")).json(), {"status": "not_started"})
        self.assertEqual((await self.http.post("/api/cookbook/engine/download/not-in-catalog")).status_code, 400)

    async def test_http_error_disk_full_and_a_cut_connection_each_end_clean(self):
        cases = {
            "http 503": (lambda request: httpx.Response(503), None),
            "connection lost mid-file": (lambda request: httpx.Response(200, headers={"content-length": "3000"},
                                                                          stream=Stream([b"a" * 1000, b"b" * 1000, b"c" * 1000], fail_after=2)), None),
        }
        for label, (handler, _) in cases.items():
            engine._download_progress.clear()
            with patch.object(engine.httpx, "AsyncClient", real_client(handler)):
                await self.http.post(f"/api/cookbook/engine/download/{NAME}")
                done = await self.settle()
            self.assertEqual(done["status"], "error", label)
            self.assertTrue(done["error"], label)
            self.assertEqual(os.listdir(engine.GGUF_DIR), [], f"{label}: no partial or fake model is left behind")
            self.assertEqual((await self.http.get("/api/cookbook/engine/downloaded")).json(), [], label)
        # Disk full: the write itself fails.
        engine._download_progress.clear()
        handler = lambda request: httpx.Response(200, headers={"content-length": "2048"}, stream=Stream([b"x" * 1024, b"y" * 1024]))  # noqa: E731
        real_open = open

        def full_disk(path, mode="r", *a, **k):
            if str(path).endswith(".part") and "w" in mode:
                raise OSError(28, "No space left on device")
            return real_open(path, mode, *a, **k)
        with patch.object(engine.httpx, "AsyncClient", real_client(handler)), patch("builtins.open", full_disk):
            await self.http.post(f"/api/cookbook/engine/download/{NAME}")
            done = await self.settle()
        self.assertEqual(done["status"], "error")
        self.assertIn("No space left", done["error"])
        self.assertEqual(os.listdir(engine.GGUF_DIR), [])
        # And a retry afterwards works.
        engine._download_progress.clear()
        with patch.object(engine.httpx, "AsyncClient", real_client(handler)):
            await self.http.post(f"/api/cookbook/engine/download/{NAME}")
            self.assertEqual((await self.settle())["status"], "success")

    async def test_a_second_click_while_downloading_starts_nothing_new(self):
        gate = asyncio.Event()
        opened = []

        def handler(request):
            opened.append(1)
            return httpx.Response(200, headers={"content-length": "2048"}, stream=Stream([b"x" * 1024, b"y" * 1024], gate=gate))
        with patch.object(engine.httpx, "AsyncClient", real_client(handler)):
            await self.http.post(f"/api/cookbook/engine/download/{NAME}")
            await asyncio.sleep(0.1)
            await self.http.post(f"/api/cookbook/engine/download/{NAME}")
            await asyncio.sleep(0.1)
            gate.set()
            await self.settle()
        self.assertEqual(len(opened), 1)

    async def test_deleting_a_model_that_is_still_downloading_does_not_bring_it_back(self):
        # Holds only by accident: Delete pops the progress entry, and the next chunk's
        # progress update raises KeyError, which the download's except clause treats
        # as an error and cleans up. The progress then reads status=error, error="'<name>'".
        gate = asyncio.Event()
        handler = lambda request: httpx.Response(200, headers={"content-length": "2048"}, stream=Stream([b"x" * 1024, b"y" * 1024], gate=gate))  # noqa: E731
        with patch.object(engine.httpx, "AsyncClient", real_client(handler)):
            await self.http.post(f"/api/cookbook/engine/download/{NAME}")
            await asyncio.sleep(0.1)
            await self.http.delete(f"/api/cookbook/engine/models/{NAME}")
            gate.set()
            for _ in range(50):
                await asyncio.sleep(0.02)
        self.assertEqual(engine.list_downloaded(), [], "the download finished after Delete and re-created the file")
        self.assertEqual(os.listdir(engine.GGUF_DIR), [], "and no .part is left")
        print("  [note] progress after delete-mid-download:", engine.get_download_progress(NAME))

    async def test_BUG_a_download_can_be_cancelled(self):
        paths = (await self.http.get("/openapi.json")).json()["paths"]
        cancels = [p for p in paths if "cancel" in p.lower() and "/cookbook" in p]
        self.assertTrue(cancels, "the checklist says download/cancel; neither Cookbook backend has a cancel route")

    async def test_BUG_setup_is_refused_up_front_when_the_disk_cannot_hold_the_model(self):
        free = MagicMock(free=50_000_000)
        with patch.object(cookbook_service.shutil, "disk_usage", return_value=free), patch.object(engine, "start_download") as started:
            recommendation = (await self.http.get("/api/cookbook/engine/recommendation")).json()
            response = await self.http.post(f"/api/cookbook/engine/setup/{NAME}")
            await asyncio.sleep(0.05)
        self.assertEqual(recommendation["disk_free_bytes"], 50_000_000)
        self.assertLess(recommendation["disk_free_bytes"], recommendation["estimated_download_bytes"])
        self.assertTrue(response.status_code >= 400 or not started.called,
                        "the API reports the shortage but still starts a 400 MB download; only the UI could stop it")

    async def test_BUG_deleting_a_model_name_with_a_backslash_cannot_leave_the_models_folder(self):
        outside = Path(engine.GGUF_DIR).parent / "outside.gguf"
        outside.write_bytes(b"not a cookbook model")
        os.makedirs(engine.GGUF_DIR, exist_ok=True)
        await self.http.delete("/api/cookbook/engine/models/..%5Coutside")
        self.assertTrue(outside.exists(), "a model name of '..\\outside' removed a .gguf outside gguf_models (Windows separator)")
        outside.unlink(missing_ok=True)


class EngineServer(Base):
    async def test_start_stop_status_and_one_model_at_a_time(self):
        os.makedirs(engine.GGUF_DIR, exist_ok=True)
        for n in ("a", "b"):
            Path(engine._model_path(n)).write_bytes(b"gguf")
        procs = []

        def popen(argv, **kw):
            p = MagicMock()
            p.poll.return_value = None
            p.argv = argv
            procs.append(p)
            return p

        async def healthy(timeout_seconds=60):
            return True
        with patch.object(engine.subprocess, "Popen", popen), patch.object(engine, "_wait_healthy", healthy):
            self.assertEqual((await self.http.post("/api/cookbook/engine/start/missing")).status_code, 404, "not downloaded")
            first = (await self.http.post("/api/cookbook/engine/start/a")).json()
            self.assertEqual((first["running"], first["model"], first["base_url"]), (True, "a", "http://127.0.0.1:8600/v1"))
            self.assertEqual((await self.http.post("/api/cookbook/engine/register", json={"name": "b"})).status_code, 400, "only the running model registers")
            second = (await self.http.post("/api/cookbook/engine/start/b")).json()
            self.assertEqual(second["model"], "b")
            procs[0].terminate.assert_called_once()
            registered = (await self.http.post("/api/cookbook/engine/register", json={"name": "b", "display_name": "Mine"})).json()
            self.addCleanup(model_endpoints.delete_endpoint, registered["id"])
            self.assertEqual((registered["name"], registered["kind"], registered["model"]), ("Mine", "local", "b"))
            await self.http.delete("/api/cookbook/engine/models/b")
            procs[1].terminate.assert_called_once()
            self.assertEqual((await self.http.get("/api/cookbook/engine/status")).json()["running"], False, "deleting the running model stops it")
            self.assertEqual((await self.http.post("/api/cookbook/engine/stop")).json(), {"ok": True}, "stop is safe when nothing runs")

    async def test_a_server_that_never_comes_up_is_stopped_and_reported_503(self):
        os.makedirs(engine.GGUF_DIR, exist_ok=True)
        Path(engine._model_path("slow")).write_bytes(b"gguf")
        proc = MagicMock()
        proc.poll.return_value = None

        async def never(timeout_seconds=60):
            return False
        with patch.object(engine.subprocess, "Popen", return_value=proc), patch.object(engine, "_wait_healthy", never):
            response = await self.http.post("/api/cookbook/engine/start/slow")
        self.assertEqual(response.status_code, 503)
        self.assertFalse(engine.status()["running"])
        proc.terminate.assert_called()

    async def test_BUG_a_missing_runtime_is_reported_at_once_not_after_a_minute_of_polling_a_dead_process(self):
        """llama_cpp is not installed: the child exits immediately, but
        _wait_healthy keeps probing the port (sleep 1 s, 60 s deadline)."""
        os.makedirs(engine.GGUF_DIR, exist_ok=True)
        Path(engine._model_path("norun")).write_bytes(b"gguf")
        proc = MagicMock()
        proc.poll.return_value = 1  # exited with "No module named llama_cpp"
        probes = []

        class Probe:
            def __init__(self, *a, **k): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *a): return False

            async def get(self, url):
                probes.append(time.monotonic())
                raise httpx.ConnectError("refused")
        real_wait = engine._wait_healthy
        with patch.object(engine.subprocess, "Popen", return_value=proc), patch.object(engine.httpx, "AsyncClient", Probe), \
                patch.object(engine, "_wait_healthy", lambda timeout_seconds=60: real_wait(2.5)):
            with self.assertRaises(RuntimeError):
                await engine.start("norun")
        self.assertLessEqual(len(probes), 1, f"{len(probes)} probes were sent to a port after its process had already exited")


class OllamaClient(Base):
    def stand_in(self, handler):
        return patch.object(ollama_client.httpx, "AsyncClient", real_client(handler))

    async def test_unreachable_is_a_clear_503_and_status_false_not_an_exception(self):
        def refused(request):
            raise httpx.ConnectError("refused")
        with self.stand_in(refused):
            self.assertEqual((await self.http.get("/api/cookbook/status")).json(), {"reachable": False})
            for method, path in (("get", "/api/cookbook/installed"), ("get", "/api/cookbook/running"), ("delete", "/api/cookbook/models/llama3.2")):
                response = await getattr(self.http, method)(path)
                self.assertEqual(response.status_code, 503, path)
                self.assertIn("Ollama unreachable", response.json()["detail"])

    async def test_installed_running_delete_and_register(self):
        seen = []

        def server(request):
            seen.append((request.method, request.url.path))
            if request.url.path == "/api/tags":
                return httpx.Response(200, json={"models": [{"name": "llama3.2:latest"}]})
            if request.url.path == "/api/ps":
                return httpx.Response(200, json={"models": [{"name": "llama3.2:latest", "size_vram": 2}]})
            return httpx.Response(200, json={})
        with self.stand_in(server):
            self.assertEqual((await self.http.get("/api/cookbook/installed")).json()[0]["name"], "llama3.2:latest")
            self.assertEqual((await self.http.get("/api/cookbook/running")).json()[0]["size_vram"], 2)
            self.assertEqual((await self.http.delete("/api/cookbook/models/llama3.2")).json(), {"ok": True})
        self.assertIn(("DELETE", "/api/delete"), seen)
        endpoint = (await self.http.post("/api/cookbook/register", json={"name": "llama3.2"})).json()
        self.addCleanup(model_endpoints.delete_endpoint, endpoint["id"])
        self.assertEqual((endpoint["kind"], endpoint["base_url"], endpoint["model"]), ("local", "http://localhost:11434/v1", "llama3.2"))

    async def test_a_failed_pull_says_why_and_can_be_started_again(self):
        def broken(request):
            return httpx.Response(500, text="boom")
        with self.stand_in(broken):
            await self.http.post("/api/cookbook/pull/llama3.2")
            for _ in range(100):
                if cookbook_service.get_pull_progress("llama3.2").get("done"):
                    break
                await asyncio.sleep(0.01)
        progress = (await self.http.get("/api/cookbook/pull/llama3.2/status")).json()
        self.assertEqual(progress["status"], "error")
        self.assertTrue(progress["error"])

    async def test_BUG_a_second_pull_click_does_not_start_a_duplicate_pull(self):
        """start_pull's guard is status == 'pulling', but _run_pull replaces
        status with Ollama's own text ('pulling manifest', 'downloading')
        on the first chunk, so the guard stops working."""
        gate = asyncio.Event()
        opened = []

        def server(request):
            opened.append(1)
            lines = b'{"status": "pulling manifest"}\n{"status": "downloading", "completed": 5, "total": 10}\n'
            return httpx.Response(200, stream=Stream([lines, b'{"status": "success"}\n'], gate=gate))
        with self.stand_in(server):
            await self.http.post("/api/cookbook/pull/llama3.2")
            await asyncio.sleep(0.15)
            await self.http.post("/api/cookbook/pull/llama3.2")
            await asyncio.sleep(0.15)
            gate.set()
            await asyncio.sleep(0.1)
        self.assertEqual(len(opened), 1, f"{len(opened)} pulls were opened for one model")

    async def test_every_cookbook_route_is_admin_only(self):
        for route in cookbook_routes.router.routes:
            self.assertTrue(any(d.call is require_admin for d in route.dependant.dependencies), f"{route.methods} {route.path}")


def tearDownModule():
    from core import session_manager_store
    session_manager_store.close()


if __name__ == "__main__":
    unittest.main()
