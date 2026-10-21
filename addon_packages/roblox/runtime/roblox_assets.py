"""Project-scoped, explicitly reported asset provenance and import state."""
import copy
import re
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from core import roblox_workspace as workspace, roblox_style


def listing(user, pid):
    return copy.deepcopy(workspace.project(user, pid).get("assets", []))


def record(user, pid, *, name, source, reference="", local_file="", license="", author="", specifications="",
           import_status="reference", target_asset_id="", asset_id=None):
    workspace.project(user, pid)
    if source not in {"reference", "blender", "higgsfield", "roblox", "user"}:
        raise ValueError("Choose an asset source")
    if import_status not in {"reference", "generated", "exported", "imported", "verified"}:
        raise ValueError("Choose reference, generated, exported, imported or verified")
    values = dict(name=name, source=source, reference=reference, local_file=local_file, license=license, author=author,
                  specifications=specifications, import_status=import_status, target_asset_id=target_asset_id)
    if not isinstance(name, str) or not name.strip() or len(name) > 120:
        raise ValueError("Give the asset a name of 1 to 120 characters")
    if any(not isinstance(v, str) or len(v) > 1500 for v in values.values()):
        raise ValueError("Asset fields must be text of up to 1500 characters")
    if target_asset_id and not re.fullmatch(r"[1-9][0-9]{0,19}", target_asset_id):
        raise ValueError("Use the actual Roblox asset ID")
    if reference.startswith(("https://", "http://")):
        url = urlsplit(reference)
        if url.username or url.password: raise ValueError("Do not store credentials in asset references")
        # Never retain signed download query strings or bearer fragments.
        values["reference"] = urlunsplit((url.scheme, url.netloc, url.path, "", ""))
    if local_file:
        rel = Path(local_file)
        if rel.is_absolute() or ".." in rel.parts or ":" in local_file or "\\" in local_file:
            raise ValueError("Use a relative file inside this project")
        path = workspace._safe(workspace.folder(pid) / rel)
        if not path.is_file(): raise ValueError("The exported project file does not exist")
    with workspace._store_lock:
        rows = listing(user, pid)
        previous = next((a for a in rows if a["id"] == asset_id), None) if asset_id else None
        if asset_id and previous is None: raise ValueError("Asset not found")
        if not previous and len(rows) >= 200: raise ValueError("Project asset list is full")
        row = {**values, "id": asset_id or uuid.uuid4().hex, "at": time.time(),
               "reported": True, "revision": (previous or {}).get("revision", 0) + 1,
               "history": ((previous.get("history", []) + [{k: v for k, v in previous.items() if k != "history"}])[-20:] if previous else [])}
        workspace.update(user, pid, assets=[a for a in rows if a["id"] != asset_id] + [row])
    return row


def model_tool(sid, action, **kwargs):
    project = roblox_style.for_session(sid)
    if not project: raise ValueError("Open this project's Roblox chat")
    if action == "list": return listing(project["owner"], project["id"])
    if action != "record": raise ValueError("Choose list or record")
    return record(project["owner"], project["id"], **kwargs)
