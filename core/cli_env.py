"""Which Claude and Codex sign-in a piece of work uses (Multi-Account phase 3, 2026-11-06).

The first admin keeps the machine default (~/.claude, ~/.codex), so the sign-in that already works keeps
working unchanged. Every other account gets its own folders, <account folder>/cli/claude and
<account folder>/cli/codex, handed to the CLI through CLAUDE_CONFIG_DIR and CODEX_HOME, so each account signs
in to its own Claude and Codex.

Turns run concurrently, so this never touches os.environ: a spawn site asks env_for() for a copy of the
environment (or homes() for just the overrides) and gives that to the child process. A turn on a shared model
connection runs with the OWNER's homes: pass account_for_endpoint(endpoint) as the account.
"""
import os
from pathlib import Path
from typing import Optional

from core import accounts

CLAUDE_VAR = "CLAUDE_CONFIG_DIR"
CODEX_VAR = "CODEX_HOME"
# Codex keeps its login in the OS keyring by default, which is one slot per machine, not per folder.
CODEX_CONFIG = 'cli_auth_credentials_store = "file"\n'


def _account(account_id: Optional[str]) -> Optional[str]:
    """The account whose sign-in this is, or None when it is the machine default's (the first admin's, accounts
    off, nobody signed in)."""
    try:
        account = account_id or accounts.effective_account()
        return None if account == accounts.local_account() else account
    except accounts.NoAccount:
        return None


def account_for_endpoint(endpoint: Optional[dict]) -> Optional[str]:
    """The account a CLI turn on this connection signs in as: the owner's when the connection is shared with
    the current account, else None (the current account)."""
    if endpoint and endpoint.get("shared") and endpoint.get("owner_account"):
        return endpoint["owner_account"]
    return None


def _ensure_codex_config(folder: str) -> None:
    config = os.path.join(folder, "config.toml")
    try:
        existing = Path(config).read_text(encoding="utf-8") if os.path.exists(config) else ""
        if "cli_auth_credentials_store" in existing:
            return
        # A top-level key has to come before any [table].
        with open(config, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(CODEX_CONFIG + existing)
    except OSError:
        pass


def homes(account_id: Optional[str] = None) -> dict:
    """The environment overrides that point the CLIs at an account's own sign-in; {} for the machine default."""
    account = _account(account_id)
    if not account:
        return {}
    root = os.path.join(accounts.account_dir(account), "cli")
    claude, codex = os.path.join(root, "claude"), os.path.join(root, "codex")
    os.makedirs(claude, exist_ok=True)
    os.makedirs(codex, exist_ok=True)
    _ensure_codex_config(codex)
    return {CLAUDE_VAR: claude, CODEX_VAR: codex}


def env_for(account_id: Optional[str] = None, base: Optional[dict] = None) -> dict:
    """A copy of base (default: the process environment) with the account's homes applied."""
    env = dict(os.environ if base is None else base)
    env.update(homes(account_id))
    return env


def claude_dir(account_id: Optional[str] = None) -> str:
    """The folder the account's Claude keeps its login and settings in."""
    return homes(account_id).get(CLAUDE_VAR) or os.environ.get(CLAUDE_VAR) or os.path.join(os.path.expanduser("~"), ".claude")


def codex_dir(account_id: Optional[str] = None) -> str:
    """The folder the account's Codex keeps its login and config in."""
    return homes(account_id).get(CODEX_VAR) or os.environ.get(CODEX_VAR) or os.path.join(os.path.expanduser("~"), ".codex")


def claude_json(account_id: Optional[str] = None) -> str:
    """Claude Code's user settings file (MCP servers): inside the account's folder, or ~/.claude.json."""
    override = homes(account_id).get(CLAUDE_VAR)
    return os.path.join(override, ".claude.json") if override else os.path.join(os.path.expanduser("~"), ".claude.json")


def import_root(account_id: Optional[str] = None) -> Optional[str]:
    """The folder holding an account's own Claude and Codex folders, or None for the machine default. What a
    setup import may read from: another account can never reach the first admin's ~/.claude.json or config.toml."""
    homes_ = homes(account_id)
    return os.path.dirname(homes_[CLAUDE_VAR]) if homes_ else None
