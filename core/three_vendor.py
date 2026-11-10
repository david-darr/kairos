"""The vendored three.js (Pack B, Video Styles unit 5): where it lives, the import map pages use to load it, and the
Content-Security-Policy hash that lets exactly that import map run.

three 0.186.1 (MIT) is copied unchanged into static/vendor/three, with only the example files the 3D stage uses; each
file and its SHA-256 is listed in static/vendor/three/VENDORED.txt, and the tests compare the files on disk with it.
Pages that draw 3D (the video player, the 3D character sheet) carry IMPORT_MAP so `import ... from 'three'` inside the
vendored example files resolves to the vendored module, and their CSP allows /static/vendor/three/ plus this map's hash.
"""
from __future__ import annotations

import base64
import hashlib
import re
from pathlib import Path

from core.constants import STATIC_DIR

FOLDER = Path(STATIC_DIR) / "vendor" / "three"
VERSION = "0.186.1"
IMPORT_MAP = '{"imports":{"three":"/static/vendor/three/three.module.js"}}'
IMPORT_MAP_TAG = '<script type="importmap">' + IMPORT_MAP + '</script>'


def csp_hash() -> str:
    return "'sha256-" + base64.b64encode(hashlib.sha256(IMPORT_MAP.encode("utf-8")).digest()).decode("ascii") + "'"


def script_src(origin: str) -> str:
    """The script-src sources of a page that draws with the motion engine and three.js."""
    return f"{origin}/static/motion/ {origin}/static/vendor/three/ {csp_hash()}"


def listed() -> dict[str, str]:
    """{relative path: sha256} as VENDORED.txt records them."""
    out = {}
    text = (FOLDER / "VENDORED.txt").read_text(encoding="utf-8")
    for match in re.finditer(r"^\s+(\S+)\s+[\d,]+\s+sha256 ([0-9a-f]{64})\s*$", text, re.M):
        out[match.group(1)] = match.group(2)
    return out


def check() -> list[str]:
    """Problems with the vendored copy: a listed file missing or changed, or a file on disk that is not listed."""
    problems, wanted = [], listed()
    for rel, digest in wanted.items():
        path = FOLDER / rel
        if not path.is_file():
            problems.append(f"{rel} is missing.")
        elif hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            problems.append(f"{rel} does not match its recorded hash.")
    for path in FOLDER.rglob("*"):
        rel = path.relative_to(FOLDER).as_posix()
        if path.is_file() and rel != "VENDORED.txt" and rel not in wanted:
            problems.append(f"{rel} is in the vendored folder but not listed in VENDORED.txt.")
    return problems
