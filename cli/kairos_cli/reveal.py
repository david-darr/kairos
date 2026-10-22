"""Showing a chat's file in the computer's own file manager.

The path always comes from the backend (POST /api/cli/local-path), which
hands out only files the chat owns, inside the generated-files folders or the
chat's workspace, and only to a paired terminal on this computer. Here the
file manager is started directly, never through a shell, with the path as
one argument:

- Windows: explorer /select,<path>
- macOS:   open -R <path>
- Linux:   xdg-open <folder>

KAIROS_CLI_REVEAL_LOG (tests only) writes the command to that file instead
of starting anything, so a test run never opens windows.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


def command_for(path: str, platform: str | None = None) -> list[str]:
    platform = platform or sys.platform
    if platform == "win32":
        return ["explorer.exe", f"/select,{path}"]
    if platform == "darwin":
        return ["open", "-R", path]
    return ["xdg-open", str(Path(path).parent)]


def file_uri(path: str) -> str:
    """For an OSC 8 hyperlink, so terminals that support it can open it."""
    return Path(path).as_uri()


def reveal(path: str) -> list[str]:
    if not Path(path).is_absolute():
        raise ValueError("expected an absolute path from the backend")
    command = command_for(path)
    log = os.environ.get("KAIROS_CLI_REVEAL_LOG")
    if log:
        with open(log, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(command) + "\n")
        return command
    subprocess.Popen(command, shell=False, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, close_fds=True)
    return command
