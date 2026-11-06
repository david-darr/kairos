"""Generic key/value settings store — Phase 5's backing store for onboarding
state, the chosen vault path, and channel config (Discord token/allowlist),
matching Odysseus's own `src.settings` pattern (one JSON file, defaults
merged underneath). Secret-shaped values (tokens, passwords) are expected to
already be encrypted by the caller via core/secret_storage before they reach
here — this module itself does no encryption/masking of its own.
"""
import os
from typing import Any

from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR

SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")

DEFAULTS: dict[str, Any] = {
    "image_daily_limit": 50,
    "forge_root": None,  # None resolves the OS Documents folder on first use.
    "forge_terminal_remote": False,
    "onboarding_complete": False,
    "vault_dir": None,  # None = use core/vault.py's default resolution
    # Library Vault (2026-10-22): pinned notes per user, and where "Today's
    # note" is created from (another user's vault may differ).
    "vault_pins": {},
    "vault_daily_folder": "01 - Daily Notes",
    "vault_daily_template": "01 - Daily Notes/Daily Note Template.md",
    "discord_bot_token_encrypted": None,
    "discord_allowed_user_id": None,
    "disabled_tools": [],  # Settings > Admin > Agent Tools, David's ask 2026-08-31
    # Extra exact MCP tool names to pre-approve for every Claude session
    # (David's ask 2026-09-10, hit live: core/brain.py's hardcoded Canva
    # allowlist didn't cover every tool a real Canva design/export flow
    # reaches for, and an unapproved MCP tool call in a non-interactive
    # session — Discord, a scheduled Task — has no one to answer the
    # permission prompt, so the turn just never resolves. The Claude Agent
    # SDK's allowed_tools only matches exact names, no wildcards (confirmed
    # against its own source, claude_agent_sdk/types.py's
    # _whole_tool_allowed) — there is no "approve all of Canva" one-liner,
    # so this is the escape hatch: an editable list, appended to the
    # hardcoded baseline in core/brain.py, instead of needing a code change
    # every time Canva's own tool set shifts.
    "extra_allowed_tools": [],
    # Compact a local/API chat near a full context window before its next
    # message (roadmap phase 3, 2026-10-05; services/chat_service.py).
    "auto_compact": True,
    # A local/API chat on any window gets the core tools and finds the rest
    # through the tool search (2026-10-28): the whole list resent every turn
    # was about 11,000 tokens. Off restores the full list on a large window.
    "defer_tools": True,
    "computer_use": {"enabled": False, "allow_non_admins": False, "allow_reactions": False, "desktop": False},
    # Days a model's computer steps (core/computer_trajectory.py) are kept; 0 keeps none.
    "computer_steps_days": 7,
    # The connection helpers run on (core/helpers.py, roadmap phase 5,
    # 2026-10-06): None = the first local one, "off", or a local or API
    # connection's id.
    "helper_endpoint_id": None,
    "approved_custom_tab_fingerprints": {},  # Only run user tab source whose current tree hash an admin approved.
    "approved_folder_tab_fingerprints": {},  # Folder tabs approve only their own paths and bytes.
    "disabled_user_tabs": [],  # Non-destructive community revocation; source approval stays separate.
    # Remote access over Tailscale (David's ask 2026-09-03: users should be
    # able to set this up during onboarding the way we run it by hand).
    # See core/remote_access.py.
    "remote_access_enabled": False,
    "remote_access_port": 8422,
    # Turning on real accounts from the UI. AUTH_ENABLED (env) still forces
    # auth on for dev/scripted runs; this is the desktop-app equivalent,
    # since a packaged app has no sensible place for a user to set an env
    # var. Deliberately one-directional in core/auth.py: either source being
    # true enables auth, so this can never be used to switch auth OFF for a
    # deployment that set the env var.
    "auth_enabled": False,
    # Bundled skills already copied into the user's skills folder — tracked
    # per-slug so deleting one doesn't get it resurrected next launch.
    "seeded_skills": [],
    # Last untouched bundled SKILL.md, for updates that preserve user edits.
    "seeded_skill_hashes": {},
    # Premade tabs the user has switched on (David's ask 2026-09-03). The
    # code for these ships with the app but stays unmounted until opted into,
    # so a download doesn't arrive carrying someone else's workflow. See
    # core/custom_tabs.py and tabs/<slug>/tab.json.
    "enabled_tab_templates": [],
    # Built-ins this install has already switched on automatically. Tracked
    # per-action, once ever, so an upgrade can turn on a newly-shipped
    # automation without ever resurrecting one the user deliberately turned
    # off (David's ask 2026-09-06: syncing should happen "so a user doesn't
    # have to press it themselves"). See core/builtin_tasks.py.
    "auto_enabled_builtins": [],
    # The look new designs start in when nobody chose one (Tool Store > Design
    # systems > Use as default). None: models pick a look per brief with
    # creative_direction; a design made by hand starts in Kairos.
    "design_default_look": None,
}


def _other_account():
    """The current account when it is not the first admin's (whose personal settings stay in the install's
    settings.json, as before accounts), else None. Nobody signed in reads the install's file, as before."""
    from core import accounts
    try:
        account_id = accounts.effective_account()
    except accounts.NoAccount:
        return None
    return None if account_id == accounts.local_account() else account_id


def load_settings() -> dict:
    stored = read_json(SETTINGS_FILE, {})
    merged = {**DEFAULTS, **stored}
    other = _other_account()
    if other:
        # "My account" keys come from the account's own file, defaulting fresh, never from the first admin's.
        mine = read_json(_account_file(other), {})
        for key in ACCOUNT_KEYS:
            merged[key] = mine[key] if key in mine else DEFAULTS.get(key)
    return merged


def get_setting(key: str) -> Any:
    return load_settings().get(key)


def update_settings(**fields) -> dict:
    for key in fields:
        if key not in DEFAULTS:
            raise ValueError(f"unknown setting: {key}")
    other = _other_account()
    personal = {k: v for k, v in fields.items() if other and k in ACCOUNT_KEYS}
    install = {k: v for k, v in fields.items() if k not in personal}
    if personal:
        update_account_settings(other, **personal)
    if install or not personal:
        current = {**DEFAULTS, **read_json(SETTINGS_FILE, {})}
        current.update(install)
        write_json_atomic(SETTINGS_FILE, current)
    return load_settings()


# "My account" settings (Multi-Account groups 2 and 8b, 2026-11-06): for every account but the first
# admin's they live in the account's own settings.json, and get_setting/update_settings route them there.
# The first admin keeps them in the install's settings.json, as before. Everything else is "This Kairos".
ACCOUNT_KEYS = {"vault_dir", "auto_enabled_builtins", "seeded_skills", "seeded_skill_hashes",
                "vault_pins", "vault_daily_folder", "vault_daily_template", "forge_root", "design_default_look",
                "onboarding_complete", "auto_compact", "helper_endpoint_id", "computer_steps_days"}


def _account_file(account_id=None) -> str:
    from core import accounts
    return os.path.join(accounts.account_dir(account_id), "settings.json")


def get_account_setting(key: str, account_id=None) -> Any:
    return read_json(_account_file(account_id), {}).get(key)


def update_account_settings(account_id=None, **fields) -> dict:
    path = _account_file(account_id)
    current = read_json(path, {})
    for key, value in fields.items():
        if key not in ACCOUNT_KEYS:
            raise ValueError(f"not an account setting: {key}")
        current[key] = value
    write_json_atomic(path, current)
    return current
