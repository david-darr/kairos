"""Find the person's own Blender, the way core/ffmpeg_tools.py finds FFmpeg (Pack B's optional renderer).

Blender is never bundled, downloaded or required: Pack B renders with three.js, built in, and uses Blender only when the
person has installed it and picked it for a pack or channel. This module looks in the settings path the person gave
(`blender_path`), then PATH, then the usual install folders (Windows: Program Files\\Blender Foundation\\Blender <x.y>
and the Steam copy; macOS: /Applications/Blender.app; Linux: /usr/bin, /snap/bin, /opt), runs `blender --version` and
keeps only a version Kairos's Blender script supports (4.2 or newer: the Eevee renamed in 4.2 and the Principled BSDF
inputs the script sets).

Licence: Blender is GPL, and is run here as a separate program. The script Kairos gives it (blender/kairos_stage.py)
uses Blender's Python API and ships as its own file under the MIT licence, which is GPL-compatible (blender/LICENSE.txt).
What a person renders with Blender is theirs (blender.org: "What you create with Blender is your sole property").
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

MIN_VERSION = (4, 2)
MISSING = ("Blender isn't installed, so Pack B renders with three.js (built in). To use Blender, install it yourself from "
           "blender.org (Kairos never installs or downloads it), then pick Blender again. Blender 4.2 or newer.")
SCRIPT = Path(__file__).resolve().parents[1] / "blender" / "kairos_stage.py"
_cache: dict = {}
CACHE_SECONDS = 60


def _flags():
    return getattr(subprocess, "CREATE_NO_WINDOW", 0)


def version_of(path) -> tuple[int, int, int] | None:
    """(major, minor, patch) from `blender --version`, or None when it does not run as Blender."""
    try:
        result = subprocess.run([str(path), "--version"], capture_output=True, timeout=30, creationflags=_flags())
    except (OSError, subprocess.TimeoutExpired):
        return None
    match = re.search(r"Blender (\d+)\.(\d+)(?:\.(\d+))?", result.stdout.decode("utf-8", "replace"))
    if result.returncode != 0 or not match:
        return None
    return int(match.group(1)), int(match.group(2)), int(match.group(3) or 0)


def candidates() -> list[Path]:
    """Where Blender usually is, newest version folder first. Nothing here runs anything."""
    out = []
    if sys.platform == "win32":
        for root in filter(None, (os.environ.get("ProgramFiles"), os.environ.get("ProgramW6432"), r"C:\Program Files")):
            folder = Path(root) / "Blender Foundation"
            if folder.is_dir():
                def key(p):
                    numbers = re.findall(r"\d+", p.name)
                    return tuple(int(n) for n in numbers) if numbers else (0,)
                for sub in sorted(folder.glob("Blender*"), key=key, reverse=True):
                    out.append(sub / "blender.exe")
        for root in filter(None, (os.environ.get("ProgramFiles(x86)"),)):
            out.append(Path(root) / "Steam" / "steamapps" / "common" / "Blender" / "blender.exe")
    elif sys.platform == "darwin":
        out.append(Path("/Applications/Blender.app/Contents/MacOS/Blender"))
        out.append(Path.home() / "Applications" / "Blender.app" / "Contents" / "MacOS" / "Blender")
    else:
        out += [Path("/usr/bin/blender"), Path("/usr/local/bin/blender"), Path("/snap/bin/blender")]
        out += sorted(Path("/opt").glob("blender*/blender"), reverse=True) if Path("/opt").is_dir() else []
    return list(dict.fromkeys(out))


def detect(refresh: bool = False) -> dict:
    """{found, path, version, supported, message}. Cached for a minute (running Blender to ask its version takes a second)."""
    now = time.monotonic()
    if not refresh and _cache.get("at") and now - _cache["at"] < CACHE_SECONDS:
        return dict(_cache["result"])
    tried = []
    try:
        from core import settings
        configured = settings.get_setting("blender_path")
    except Exception:
        configured = None
    if configured:
        tried.append(Path(configured))
    which = shutil.which("blender")
    if which:
        tried.append(Path(which))
    tried += candidates()
    result = {"found": False, "path": None, "version": None, "supported": False, "message": MISSING}
    older = None
    for path in dict.fromkeys(tried):
        if not path.is_file():
            continue
        version = version_of(path)
        if not version:
            continue
        if version[:2] >= MIN_VERSION:
            result = {"found": True, "path": str(path), "version": ".".join(map(str, version)), "supported": True,
                      "message": f"Blender {'.'.join(map(str, version))} is installed and can render Pack B."}
            break
        older = older or (path, version)
    if not result["found"] and older:
        v = ".".join(map(str, older[1]))
        result = {"found": True, "path": str(older[0]), "version": v, "supported": False,
                  "message": f"Blender {v} is installed, but Pack B needs Blender 4.2 or newer, so it renders with three.js. "
                             "Update Blender from blender.org to use it."}
    _cache.update(at=now, result=result)
    return dict(result)


def find() -> str | None:
    """The path of a supported Blender, or None."""
    found = detect()
    return found["path"] if found["supported"] else None


def status() -> dict:
    """What Studio shows beside the renderer choice."""
    found = detect()
    return {"blender": found, "renderers": [
        {"id": "threejs", "name": "three.js (built in)", "available": True,
         "note": "Fast, nothing to install. Glossy studio look with soft light, ambient occlusion and contact shadows."},
        {"id": "blender", "name": "Blender", "available": found["supported"],
         "note": ("Softer, more realistic light (Eevee), much slower. " + found["message"]) if found["supported"] else found["message"]},
    ]}
