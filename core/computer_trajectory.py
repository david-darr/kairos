"""Evidence of what a model did on its contained computer (vault: "Agents -
Computer-Use Upgrade from cua (Build Spec)" 5.4).

Every model `computer` action becomes a step folder under
DATA_DIR/computer/trajectories/<run_id>/step-NNNN/:

- action.json: the action, its arguments (typed text into a private field
  is "(private field)"), the resolved element, the click point in image
  coordinates, the result and its code, the URL and the time;
- before.jpg and after.jpg: what the target looked like either side, with
  private fields masked as in every screenshot;
- marker.jpg for a click with a point: the before image, marked there;
- state.json: the bounded rows of a read;
- evidence.json: what was kept, what was not, and why.

Never kept: the person's own input, screencast frames, anything while the
person has control, and any image of a step that touched a private field.
Bounded by runs.TIMELINE_LIMIT steps and RUN_BYTES per run, deleted after
the retention setting (Settings > Computer use, 7 days by default), with
the agent, with Forget logins, and with the chat. Never sent to a model.
"""
import io
import json
import logging
import re
import shutil
import threading
import time
import zipfile
from pathlib import Path

from core.constants import DATA_DIR

logger = logging.getLogger(__name__)
ROOT = Path(DATA_DIR) / "computer" / "trajectories"
STEP_LIMIT = 200  # runs.TIMELINE_LIMIT, the run timeline's own bound
RUN_BYTES = 40 * 1024 * 1024
DEFAULT_DAYS = 7
SWEEP_EVERY = 3600
RUN_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
IMAGES = ("before.jpg", "after.jpg", "marker.jpg")
PRIVATE_TEXT = "(private field)"
PRIVATE_REASON = "private field"
# Only these arguments are kept; anything else a model sends is dropped.
KEPT_ARGS = ("url", "ref", "x", "y", "text", "key", "dx", "dy", "seconds", "desktop", "app", "query", "since",
             "max_elements", "expect")
_lock = threading.Lock()
_last_sweep = [0.0]


def retention_days() -> int:
    from core import settings
    value = settings.get_setting("computer_steps_days")
    return max(0, value) if isinstance(value, int) and not isinstance(value, bool) else DEFAULT_DAYS


def _run_dir(run_id: str, root: Path | None = None) -> Path:
    if not RUN_ID.fullmatch(run_id or ""):
        raise ValueError("bad run id")
    base = (root or ROOT).resolve()
    target = (base / run_id).resolve()
    if target.parent != base:
        raise ValueError("bad run id")
    return target


def _private_step(action: str, args: dict, result: dict) -> bool:
    element = result.get("element") or {}
    return (result.get("code") == "private_field" or bool(element.get("private"))
            or (element.get("tag") == "input" and element.get("type") == "password")
            or str(element.get("autocomplete") or "").startswith(("cc-", "current-password", "new-password", "one-time-code"))
            or element.get("role") == "password text")


def _arguments(action: str, args: dict, private: bool) -> dict:
    kept = {key: args[key] for key in KEPT_ARGS if key in args}
    if private:
        for key in ("text", "key"):
            if key in kept:
                kept[key] = PRIVATE_TEXT
    return kept


def _marked(before: bytes, point: dict) -> bytes | None:
    from PIL import Image, ImageDraw
    try:
        with Image.open(io.BytesIO(before)) as source:
            image = source.convert("RGB")
        x, y = int(point["x"]), int(point["y"])
        if not (0 <= x < image.width and 0 <= y < image.height):
            return None
        draw = ImageDraw.Draw(image)
        for radius, width in ((16, 4), (4, 0)):
            box = (x - radius, y - radius, x + radius, y + radius)
            draw.ellipse(box, outline=(220, 30, 30), width=width) if width else draw.ellipse(box, fill=(220, 30, 30))
        output = io.BytesIO()
        image.save(output, "JPEG", quality=65, optimize=True)
        return output.getvalue()
    except (OSError, ValueError, KeyError, TypeError):
        return None


def _size(folder: Path) -> int:
    return sum(path.stat().st_size for path in folder.rglob("*") if path.is_file())


def record(owner: str, run_id: str, action: str, args: dict, result: dict, before: bytes | None,
           not_before: str = "", root: Path | None = None) -> int | None:
    """Write one step. Returns its number, or None when nothing was kept
    (steps are off, the run is full, or the run belongs to another owner).
    Never raises: evidence must not fail the action it describes."""
    try:
        if retention_days() <= 0:
            return None
        from core.computer_history import jpeg
        try:
            folder = _run_dir(run_id, root)
        except ValueError:
            return None
        with _lock:
            folder.mkdir(parents=True, exist_ok=True)
            meta_path = folder / "meta.json"
            meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {
                "run_id": run_id, "owner": owner, "started": time.time(), "steps": 0, "bytes": 0}
            if meta.get("owner") != owner or meta["steps"] >= STEP_LIMIT:
                return None
            number = meta["steps"] + 1
            step = folder / f"step-{number:04d}"
            step.mkdir()
            meta["steps"] = number
            meta["updated"] = time.time()
            meta_path.write_text(json.dumps(meta), encoding="utf-8")
        private = _private_step(action, args, result)
        text = result.get("text") or ""
        point = result.get("point")
        record_ = {"step": number, "action": action, "arguments": _arguments(action, args, private),
                   "element": result.get("element") or None, "point": point if isinstance(point, dict) else None,
                   "result": text.split("\n", 1)[0][:500], "code": result.get("code"), "ok": not result.get("code"),
                   "url": (re.match(r"URL: (\S+)", text) or [None, None])[1], "time": time.time(), "run_id": run_id,
                   "owner": owner}
        if private and record_["element"]:
            record_["element"] = {key: value for key, value in record_["element"].items() if key != "value"}
        (step / "action.json").write_text(json.dumps(record_, ensure_ascii=False, indent=1), encoding="utf-8")
        kept, missing = ["action.json"], {}
        images = {"before.jpg": before, "after.jpg": (result.get("images") or [None])[0]}
        full = meta["bytes"] >= RUN_BYTES
        for name, data in images.items():
            if private:
                missing[name] = PRIVATE_REASON
            elif full:
                missing[name] = "this run reached its size limit"
            elif not data:
                missing[name] = not_before if name == "before.jpg" and not_before else "this action returned no screenshot"
            else:
                image = jpeg(data)
                if image:
                    (step / name).write_bytes(image)
                    kept.append(name)
                else:
                    missing[name] = "the screenshot could not be read"
        if action in ("click",) and "before.jpg" in kept:
            if point:
                marker = _marked((step / "before.jpg").read_bytes(), point)
                if marker:
                    (step / "marker.jpg").write_bytes(marker)
                    kept.append("marker.jpg")
                else:
                    missing["marker.jpg"] = "the click point is outside the before image"
            else:
                missing["marker.jpg"] = "pressed by the control's own action, so there is no click point"
        state = result.get("state")
        if state and not private:
            (step / "state.json").write_text(json.dumps(state, ensure_ascii=False)[:200_000], encoding="utf-8")
            kept.append("state.json")
        (step / "evidence.json").write_text(json.dumps({"kept": kept, "not_kept": missing}, indent=1), encoding="utf-8")
        with _lock:
            meta = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
            meta["bytes"] = _size(folder)
            (folder / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
        sweep_soon(root)
        return number
    except Exception:
        logger.exception("could not keep a computer step for run %s", run_id)
        return None


def runs_for(owner: str, root: Path | None = None) -> list[dict]:
    base = root or ROOT
    found = []
    if base.is_dir():
        for meta_path in base.glob("*/meta.json"):
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if meta.get("owner") == owner:
                found.append(meta)
    return sorted(found, key=lambda meta: meta.get("updated") or 0, reverse=True)


def meta(run_id: str, root: Path | None = None) -> dict | None:
    try:
        path = _run_dir(run_id, root) / "meta.json"
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
    except (OSError, ValueError):
        return None


def steps(run_id: str, root: Path | None = None) -> list[dict]:
    folder = _run_dir(run_id, root)
    result = []
    for step in sorted(folder.glob("step-*")):
        try:
            action = json.loads((step / "action.json").read_text(encoding="utf-8"))
            evidence = json.loads((step / "evidence.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        state = None
        if (step / "state.json").exists():
            state = json.loads((step / "state.json").read_text(encoding="utf-8"))
        result.append({**action, "images": [name for name in IMAGES if (step / name).exists()],
                       "evidence": evidence, "state": state})
    return result


def image(run_id: str, number: int, name: str, root: Path | None = None) -> Path | None:
    if name not in IMAGES or not 0 < number <= STEP_LIMIT:
        return None
    path = _run_dir(run_id, root) / f"step-{number:04d}" / name
    return path if path.is_file() else None


def export(run_id: str, root: Path | None = None) -> bytes:
    """The run's folder as a zip, for the benchmark and for debugging."""
    folder = _run_dir(run_id, root)
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(folder.rglob("*")):
            if path.is_file():
                archive.write(path, f"{run_id}/{path.relative_to(folder).as_posix()}")
    return output.getvalue()


def skill_steps(run_id: str, root: Path | None = None) -> list[dict]:
    """The run's successful actions as recorded steps
    (services/skill_recorder.py), for Make a skill from this run."""
    shaped = []
    for step in steps(run_id, root):
        if not step.get("ok"):
            continue
        args, element = step.get("arguments") or {}, step.get("element") or {}
        kind = step["action"]
        url = step.get("url") or ""
        if kind == "open":
            shaped.append({"kind": "open", "url": args.get("url") or url})
        elif kind == "launch":
            shaped.append({"kind": "launch", "app": args.get("app")})
        elif kind in ("click", "type", "key", "scroll"):
            item = {"kind": kind, "url": url}
            if element.get("label"):
                item["element"] = {key: element[key] for key in ("label", "role", "tag") if key in element}
            elif kind == "click" and "x" in args:
                item.update(x=args["x"], y=args["y"])
            if kind in ("type", "key"):
                value = args.get("text" if kind == "type" else "key")
                if value == PRIVATE_TEXT:
                    item.update(private=True, field="private field")
                elif value is not None:
                    item["text" if kind == "type" else "key"] = value
            if kind == "scroll":
                item.update(dx=args.get("dx", 0), dy=args.get("dy", 0))
            shaped.append(item)
    return shaped[:STEP_LIMIT]


def delete_run(run_id: str, root: Path | None = None) -> None:
    shutil.rmtree(_run_dir(run_id, root), ignore_errors=True)


def delete_owner(owner: str, root: Path | None = None) -> int:
    gone = 0
    for item in runs_for(owner, root):
        delete_run(item["run_id"], root)
        gone += 1
    return gone


def sweep(now: float | None = None, root: Path | None = None) -> int:
    """Delete runs older than the retention setting (all of them when steps
    are off). Returns how many went."""
    base = root or ROOT
    if not base.is_dir():
        return 0
    days = retention_days()
    cutoff = (now or time.time()) - days * 86400
    gone = 0
    for meta_path in base.glob("*/meta.json"):
        try:
            item = json.loads(meta_path.read_text(encoding="utf-8"))
            if days <= 0 or (item.get("updated") or item.get("started") or 0) < cutoff:
                delete_run(meta_path.parent.name, root)
                gone += 1
        except (OSError, ValueError):
            continue
    return gone


def sweep_soon(root: Path | None = None) -> None:
    if time.time() - _last_sweep[0] >= SWEEP_EVERY:
        _last_sweep[0] = time.time()
        sweep(root=root)
