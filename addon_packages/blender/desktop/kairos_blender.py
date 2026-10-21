bl_info = {"name": "Kairos Creative Connection", "author": "Kairos", "version": (1, 0, 0),
           "blender": (4, 0, 0), "location": "3D View > Sidebar > Kairos", "category": "Interface"}

import base64
import concurrent.futures
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import queue
import secrets
import tempfile
import threading
import time

import bpy

_server = None
_token = ""
_queue = queue.Queue()


def _perform(action, arguments):
    current = str(Path(bpy.data.filepath).resolve()) if bpy.data.filepath else ""
    expected = arguments.get("expected_file")
    if expected and current != str(Path(expected).resolve()):
        raise ValueError("A different .blend file is open. Check the connection in Kairos before proceeding")
    if action == "inspect":
        return {"file": current, "objects": [{"name": o.name, "type": o.type,
                "dimensions": list(o.dimensions)} for o in list(bpy.context.scene.objects)[:200]]}
    if not current or not expected:
        raise ValueError("Save the .blend file and check the connection in Kairos first")
    if action == "execute":
        code = arguments.get("code", "")
        if not isinstance(code, str) or not code.strip() or len(code) > 50000:
            raise ValueError("Provide Blender Python code of 1 to 50,000 characters")
        checkpoint = str(Path(current).with_name(Path(current).stem + ".kairos-" + str(time.time_ns()) + ".blend"))
        saved = bpy.ops.wm.save_as_mainfile(filepath=checkpoint, copy=True)
        if "FINISHED" not in saved:
            raise ValueError("The Blender checkpoint could not be saved; Python was not run")
        # This is authorized native Python, not a Python sandbox.
        output = io.StringIO()
        from contextlib import redirect_stdout
        with redirect_stdout(output):
            exec(compile(code, "<Kairos approved Blender code>", "exec"), {"bpy": bpy, "__name__": "__kairos__"})
        return {"file": current, "checkpoint": checkpoint, "output": output.getvalue()[-16000:]}
    if action == "viewport":
        scene = bpy.context.scene
        old_path, old_format = scene.render.filepath, scene.render.image_settings.file_format
        try:
            with tempfile.TemporaryDirectory(prefix="kairos-viewport-") as folder:
                dest = Path(folder) / "viewport.png"
                scene.render.filepath = str(dest); scene.render.image_settings.file_format = "PNG"
                window = bpy.context.window_manager.windows[0]
                area = next((a for a in window.screen.areas if a.type == "VIEW_3D"), None)
                if not area: raise ValueError("Open a 3D View in Blender first")
                region = next(r for r in area.regions if r.type == "WINDOW")
                with bpy.context.temp_override(window=window, area=area, region=region):
                    bpy.ops.render.opengl(write_still=True, view_context=True)
                blob = dest.read_bytes()
                if len(blob) > 10 * 1024 * 1024: raise ValueError("Viewport exceeds 10 MB; reduce render resolution")
                return {"file": current, "image": base64.b64encode(blob).decode()}
        finally:
            scene.render.filepath = old_path; scene.render.image_settings.file_format = old_format
    raise ValueError("Unknown Kairos operation")


def _drain():
    for _ in range(4):
        try: future, payload = _queue.get_nowait()
        except queue.Empty: break
        if not future.set_running_or_notify_cancel(): continue
        try: future.set_result(_perform(payload.get("action"), payload.get("arguments") or {}))
        except Exception as error: future.set_result({"error": str(error)[:2000]})
    return 0.1 if _server else None


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        token = self.headers.get("Authorization", "").removeprefix("Bearer ")
        if self.path != "/kairos" or not _token or not secrets.compare_digest(token, _token):
            self.send_error(403); return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 100000: raise ValueError("Request exceeds 100 KB")
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict): raise ValueError("Expected a JSON object")
            if _queue.qsize() >= 4: raise ValueError("Blender is busy")
            future = concurrent.futures.Future(); _queue.put((future, payload))
            try: result = future.result(timeout=115)
            except concurrent.futures.TimeoutError:
                future.cancel(); raise ValueError("Blender operation timed out; check Blender before retrying")
            raw = json.dumps(result).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)
        except Exception:
            self.send_error(400, "Kairos operation failed; check Blender")

    def log_message(self, *_): pass


def _stop():
    global _server, _token
    server, _server = _server, None; _token = ""
    if server:
        threading.Thread(target=lambda: (server.shutdown(), server.server_close()), daemon=True).start()
    while not _queue.empty():
        try: _queue.get_nowait()[0].cancel()
        except queue.Empty: break


class KAIROS_OT_connect(bpy.types.Operator):
    bl_idname = "kairos.connect"
    bl_label = "Start local connection"

    def execute(self, context):
        global _server, _token
        _stop()
        try:
            _server = ThreadingHTTPServer(("127.0.0.1", context.scene.kairos_port), Handler)
            _server.daemon_threads = True; _token = secrets.token_urlsafe(32)
            threading.Thread(target=_server.serve_forever, daemon=True).start()
            if not bpy.app.timers.is_registered(_drain): bpy.app.timers.register(_drain, first_interval=0.1)
        except OSError as error:
            self.report({"ERROR"}, str(error)); _stop(); return {"CANCELLED"}
        return {"FINISHED"}


class KAIROS_OT_disconnect(bpy.types.Operator):
    bl_idname = "kairos.disconnect"
    bl_label = "Stop connection"
    def execute(self, context): _stop(); return {"FINISHED"}


class KAIROS_OT_copy(bpy.types.Operator):
    bl_idname = "kairos.copy_pairing"
    bl_label = "Copy pairing token"
    def execute(self, context): context.window_manager.clipboard = _token; return {"FINISHED"}


class KAIROS_PT_panel(bpy.types.Panel):
    bl_label = "Kairos"
    bl_idname = "KAIROS_PT_connection"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Kairos"
    def draw(self, context):
        layout = self.layout
        layout.label(text="Local connection on 127.0.0.1")
        layout.label(text="Python requests run only after approval in Kairos.")
        if _server:
            layout.operator("kairos.copy_pairing"); layout.operator("kairos.disconnect")
        else:
            layout.prop(context.scene, "kairos_port"); layout.operator("kairos.connect")


_classes = (KAIROS_OT_connect, KAIROS_OT_disconnect, KAIROS_OT_copy, KAIROS_PT_panel)


def register():
    for cls in _classes: bpy.utils.register_class(cls)
    bpy.types.Scene.kairos_port = bpy.props.IntProperty(name="Port", default=9876, min=1024, max=65535)


def unregister():
    _stop()
    if bpy.app.timers.is_registered(_drain): bpy.app.timers.unregister(_drain)
    del bpy.types.Scene.kairos_port
    for cls in reversed(_classes): bpy.utils.unregister_class(cls)
