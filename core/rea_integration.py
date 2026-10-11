"""Opt-in local REA MCP connection. No package is fetched before Add is approved."""
import os
import re
import shutil
import subprocess

from core import integrations


REA_VERSION = "6.4.0"
REA_PACKAGE = f"rea-agents@{REA_VERSION}"
REA_NAME = "REA"


def _version(command: str) -> str | None:
    executable = shutil.which(command)
    if not executable:
        return None
    try:
        result = subprocess.run([executable, "--version"], capture_output=True, text=True,
                                timeout=5, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def status() -> dict:
    """Read-only prerequisite check; it never runs npx or installs a package."""
    node = _version("node")
    npm = _version("npm")
    npx = shutil.which("npx")
    node_path = shutil.which("node")
    npm_path = shutil.which("npm")
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?", node or "")
    ready_node = False
    if match:
        major, minor, patch = map(int, match.groups())
        ready_node = ((major == 22 and (minor, patch) >= (19, 0)) or
                      (major == 24 and (minor, patch) >= (11, 0)) or major >= 26)
    if not node:
        reason = "Install Node.js 22.19+, 24.11+, or 26+ to use REA."
    elif not ready_node:
        reason = f"Node.js {node} is unsupported by REA. Use 22.19+, 24.11+, or 26+."
    elif not npm or not npx or not npm_path or not node_path:
        reason = "REA needs npm and npx from the supported Node.js installation."
    elif os.name == "nt" and (os.path.dirname(node_path).lower() != os.path.dirname(npx).lower()
                              or os.path.dirname(node_path).lower() != os.path.dirname(npm_path).lower()):
        reason = "Node.js, npm and npx must come from the same supported installation."
    else:
        reason = None
    return {"ready": reason is None, "reason": reason, "node": node, "npm": npm,
            "package": REA_PACKAGE}


def command() -> tuple[str, list[str]]:
    """REA's documented Windows shim launch, or direct npx elsewhere."""
    if os.name == "nt":
        return "cmd.exe", ["/d", "/c", "npx", "-y", REA_PACKAGE, "mcp"]
    return "npx", ["-y", REA_PACKAGE, "mcp"]


def download() -> str:
    """Fetch the pinned package after the user accepts the Tool Store prompt."""
    if os.name == "nt":
        argv = ["cmd.exe", "/d", "/c", "npx", "-y", REA_PACKAGE, "--version"]
    else:
        argv = ["npx", "-y", REA_PACKAGE, "--version"]
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=180, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ValueError(f"Could not download REA {REA_VERSION}: {exc}") from exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "no output").strip()[-300:]
        raise ValueError(f"Could not download REA {REA_VERSION}: {detail}")
    return result.stdout.strip()


def existing() -> dict | None:
    for item in integrations.list_integrations():
        if is_rea(item):
            return item
    return None


def is_rea(item: dict) -> bool:
    selected_command, selected_args = command()
    return (item.get("kind") == "mcp_server" and item.get("mcp_type") == "stdio"
            and item.get("name") == REA_NAME and item.get("command") == selected_command
            and item.get("args") == selected_args)
