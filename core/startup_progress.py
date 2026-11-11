"""What the backend is doing before it can answer, said from the first second (2026-11-10, 2.3.0 upgrade
rehearsal: the first start on David's 8 GB profile ran 33 minutes with the port closed, and the desktop app
gave up after 2).

app.py restores a staged backup and moves data into account folders before it imports anything else, and
uvicorn only opens the port once app.py has been imported. When either has work to do and the desktop app
said which port to use (APP_PORT), serve_if_needed() opens that port first with a tiny server of its own:

- GET /api/health answers 503 {"status": "updating", "phase", "detail", "done", "total", ...}. Anything that
  waits for a 200 (the desktop app, scripts) keeps waiting, and the desktop app shows the progress.
- GET /api/startup answers 200 with the same, for anything that only wants the progress.
- Every other path answers 503 with a short page that reloads itself, for a browser pointed at Kairos.

stop() closes it when app.py's start-up is done (the end of its lifespan start), and uvicorn opens the same
port at once. Loopback only; it says nothing but the phase and the counts.
"""
import json
import logging
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional

log = logging.getLogger(__name__)

_lock = threading.Lock()
_state = {"status": "updating", "phase": "starting", "detail": "", "done": 0, "total": 0,
          "started_at": time.time(), "updated_at": time.time()}
_server: Optional[ThreadingHTTPServer] = None

PAGE = ("<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=5><title>Kairos</title>"
        "<body style='font-family:system-ui;background:#F3EADB;color:#3A2A20;padding:48px'>"
        "<p>Updating your data for this version. This can take a few minutes. Don't close Kairos.</p>")


def update(phase: str, detail: str = "", done: int = 0, total: int = 0) -> None:
    """Record the current phase and how far it has come (done of total, both 0 when not counted)."""
    with _lock:
        _state.update(phase=phase, detail=detail, done=int(done), total=int(total), updated_at=time.time())


def snapshot() -> dict:
    with _lock:
        return dict(_state)


class _Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: bytes, kind: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Retry-After", "1")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/api/health", "/api/startup"):
            self._send(200 if path == "/api/startup" else 503, json.dumps(snapshot()).encode(), "application/json")
        else:
            self._send(503, PAGE.encode(), "text/html; charset=utf-8")

    do_HEAD = do_GET

    def log_message(self, *args):  # no request log: logging isn't set up yet, and stderr goes to the desktop log
        pass


def serve(port: int, host: str = "127.0.0.1") -> bool:
    """Open the port and answer until stop(). False when the port can't be opened (uvicorn will say why)."""
    global _server
    if _server is not None:
        return True
    try:
        server = ThreadingHTTPServer((host, port), _Handler)
    except OSError as error:
        log.warning("Start-up progress: could not open port %s (%s)", port, error)
        return False
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.2}, name="startup-progress",
                     daemon=True).start()
    _server = server
    return True


def stop() -> None:
    """Close the port so uvicorn can open it."""
    global _server
    server, _server = _server, None
    if server is not None:
        server.shutdown()
        server.server_close()


def serve_if_needed(restore_pending: bool, migration_pending: bool) -> bool:
    """Open APP_PORT for progress when there is slow work before the app can start. The desktop app sets
    APP_PORT for the backend it starts; a backend started by hand, or a test, gets no server."""
    port = os.getenv("APP_PORT")
    if not port or not (restore_pending or migration_pending):
        return False
    update("restoring" if restore_pending else "checking",
           "Restoring your backup" if restore_pending else "Checking your data")
    try:
        return serve(int(port))
    except ValueError:
        return False
