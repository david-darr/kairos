"""Settings — the Settings tab. Vault location, Discord channel config, and
onboarding state. The "My account" settings (core/settings.py ACCOUNT_KEYS: vault, helper model, auto-compact,
computer-step days, onboarding) and one's own Discord bots are each signed-in account's own. Settings of the
whole install (computer use, the tool lists) stay admin (specs/auth-security.md).
"""
import os
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from core import accounts, discord_bots_store, permissions, tool_registry, settings as settings_store
from core.channels import discord_channel
from core.middleware import require_admin, require_user
from core.session_manager import session_manager
from core.vault import build_custom_vault, resolve_vault_dir, seed_vault_if_empty
from core import vault as vault_store

router = APIRouter(prefix="/api/settings", tags=["settings"])


class VaultDirRequest(BaseModel):
    path: str


class CreateDiscordBotRequest(BaseModel):
    name: str
    token: str
    allowed_user_id: Optional[str] = None
    model_endpoint_id: Optional[str] = None


class UpdateDiscordBotRequest(BaseModel):
    name: str
    token: Optional[str] = None  # blank/omitted = keep the existing token
    allowed_user_id: Optional[str] = None
    model_endpoint_id: Optional[str] = None


class AddDiscordChannelRequest(BaseModel):
    discord_channel_id: str
    label: str = ""
    mode: str = "normal"  # "normal" | "open" | "silent" — see discord_bots_store.CHANNEL_MODES


class UpdateDiscordChannelRequest(BaseModel):
    label: Optional[str] = None
    mode: Optional[str] = None


class VaultSetupRequest(BaseModel):
    areas: list[str] = []
    profile_note: Optional[str] = None


# Well-known Claude Agent SDK / Claude Code builtin tool names. The SDK
# doesn't export a canonical enum of these, so this list is hand-maintained —
# same trade-off Odysseus takes with its own builtin-tool-toggle list.
AGENT_TOOLS = list(tool_registry.CLAUDE_NATIVE_TOOLS)


class SetDisabledToolsRequest(BaseModel):
    disabled_tools: list[str]


@router.get("")
async def get_settings(user: str = Depends(require_user)) -> dict:
    raw = settings_store.load_settings()
    return {
        "onboarding_complete": raw["onboarding_complete"],
        "vault_dir": resolve_vault_dir(),
        "disabled_tools": raw["disabled_tools"],
        "auto_compact": raw["auto_compact"],
        "computer_use": raw["computer_use"],
        "computer_steps_days": raw.get("computer_steps_days", 7),
        "helper_endpoint_id": raw["helper_endpoint_id"],
        "helper_endpoint": _helper_summary(),
        "ring_preference": raw.get("ring_preference") or "app",
    }


def _helper_summary() -> dict | None:
    from core import helpers
    endpoint = helpers.helper_endpoint()
    return {"id": endpoint["id"], "name": endpoint["name"], "kind": endpoint["kind"]} if endpoint else None


RING_PREFERENCES = ("app", "discord", "phone")


class SetRingPreferenceRequest(BaseModel):
    preference: str


@router.post("/ring-preference")
async def set_ring_preference(body: SetRingPreferenceRequest, user: str = Depends(require_user)) -> dict:
    """How a bot reaching you by call does it: inside Kairos, in a Discord voice channel, or on your phone."""
    if body.preference not in RING_PREFERENCES:
        raise HTTPException(status_code=422, detail=f"preference must be one of {list(RING_PREFERENCES)}")
    settings_store.update_settings(ring_preference=body.preference)
    from core import reach_me
    saved = reach_me.load()
    if saved["saved"]:       # Settings > Reach me holds the call order now; this choice goes first in it
        reach_me.save({"call": [body.preference] + [c for c in saved["call"] if c != body.preference]})
    return {"ok": True, "ring_preference": body.preference}


class SetAutoCompactRequest(BaseModel):
    enabled: bool


class SetComputerUseRequest(BaseModel):
    enabled: bool
    allow_non_admins: bool = False
    allow_reactions: bool = False
    desktop: bool = False


@router.post("/computer-use")
async def set_computer_use(body: SetComputerUseRequest, user: str = Depends(require_admin)) -> dict:
    value = body.model_dump()
    settings_store.update_settings(computer_use=value)
    return {"ok": True, "computer_use": value}


class SetComputerStepsRequest(BaseModel):
    days: int


@router.post("/computer-steps")
async def set_computer_steps(body: SetComputerStepsRequest, user: str = Depends(require_user)) -> dict:
    """Settings > Computer use: how long models' computer steps are kept
    (core/computer_trajectory.py); 0 keeps none and deletes what is kept."""
    if body.days not in (0, 1, 7, 30):
        raise HTTPException(422, "keep computer steps for 0, 1, 7 or 30 days")
    settings_store.update_settings(computer_steps_days=body.days)
    from core import computer_trajectory
    computer_trajectory.sweep()
    return {"ok": True, "computer_steps_days": body.days}


@router.post("/auto-compact")
async def set_auto_compact(body: SetAutoCompactRequest, user: str = Depends(require_user)) -> dict:
    """Settings > Added Models: compact local and API chats near a full
    window (services/chat_service.py _compact_if_nearly_full)."""
    settings_store.update_settings(auto_compact=body.enabled)
    return {"ok": True, "auto_compact": body.enabled}


class SetHelpersRequest(BaseModel):
    endpoint_id: Optional[str] = None  # None: the first local model; "off"; or a local or API model


@router.post("/helpers")
async def set_helpers(body: SetHelpersRequest, user: str = Depends(require_user)) -> dict:
    """Settings > Added Models > Helpers: the model helpers run on
    (core/helpers.py). Never Claude or Codex: their own tools can't be
    limited to reading."""
    from core import helpers, model_endpoints
    choice = body.endpoint_id or None
    if choice not in (None, helpers.OFF):
        endpoint = model_endpoints.get_endpoint(choice)
        if endpoint is None or endpoint.get("kind") not in ("local", "api"):
            raise HTTPException(status_code=400, detail="helpers run on a local or API model")
    settings_store.update_settings(helper_endpoint_id=choice)
    return {"ok": True, "helper_endpoint_id": choice, "helper_endpoint": _helper_summary()}


@router.post("/onboarding-complete")
async def complete_onboarding(user: str = Depends(require_user)) -> dict:
    settings_store.update_settings(onboarding_complete=True)
    return {"ok": True}


@router.post("/vault-dir")
async def set_vault_dir(body: VaultDirRequest, user: str = Depends(require_user)) -> dict:
    # Check the folder and seed it first; only a folder that works is saved.
    # A relative or empty path would resolve against the app's own folder.
    path = body.path
    if not path or "\x00" in path or not os.path.isabs(path):
        raise HTTPException(status_code=400, detail="Choose a full folder path, such as C:\\Users\\you\\Vault.")
    if os.path.exists(path) and not os.path.isdir(path):
        raise HTTPException(status_code=400, detail="That path is a file, not a folder.")
    try:
        vault_store.check_vault_dir(path)  # before anything is written there: an account without machine access keeps its vault in its own folder
    except accounts.MachineAccessDenied as error:
        raise HTTPException(status_code=403, detail=str(error))
    try:
        seed_vault_if_empty(path)
    except OSError as error:
        raise HTTPException(status_code=400, detail=f"That folder cannot be used: {error}")
    vault_store.set_vault_dir(path)  # the signed-in admin's own vault
    # Only affects *new* Brain connections (new sessions, or existing
    # sessions after their next reconnect) — a session with an already-open
    # Claude Agent SDK connection keeps its original cwd until it reconnects.
    # Known limitation, not silently hidden: real "switch vault live" needs
    # tearing down every open Brain, which isn't built this pass.
    return {"ok": True, "note": "Existing open chat sessions keep their old vault until reconnected; new sessions use the new path immediately."}


@router.post("/vault-setup")
async def setup_vault(body: VaultSetupRequest, user: str = Depends(require_user)) -> dict:
    """Onboarding questionnaire (David's ask 2026-08-31) — builds a vault
    structure shaped to the areas the user said they want tracked, replacing
    the generic seed if nothing real has touched it yet (see
    core/vault.py::build_custom_vault's untouched-seed guard)."""
    vault_dir = resolve_vault_dir()
    applied = build_custom_vault(vault_dir, body.areas, body.profile_note or "")
    return {"ok": True, "vault_dir": vault_dir, "applied": applied}


def _own_discord_bot(bot_id: str) -> None:
    """An admin manages their own account's Discord bots (Multi-Account group 6); another account's is 404."""
    bot = discord_bots_store.get_bot(bot_id)
    if bot is None or not discord_bots_store.mine(bot):
        raise HTTPException(status_code=404, detail="no such Discord bot")


@router.get("/discord-bots")
async def list_discord_bots(user: str = Depends(require_user)) -> list[dict]:
    """David's ask 2026-09-01: "you should be able to see all the bots you
    have connected to" — multiple bots, not the original single-token
    design (see core/discord_bots_store.py)."""
    return [b for b in discord_bots_store.list_bots() if discord_bots_store.mine(b)]


@router.post("/discord-bots")
async def create_discord_bot(body: CreateDiscordBotRequest, user: str = Depends(require_user)) -> dict:
    bot = discord_bots_store.create_bot(body.name, body.token, body.allowed_user_id, body.model_endpoint_id)
    await discord_channel.restart()
    return bot


@router.patch("/discord-bots/{bot_id}")
async def update_discord_bot(bot_id: str, body: UpdateDiscordBotRequest, user: str = Depends(require_user)) -> dict:
    _own_discord_bot(bot_id)
    try:
        bot = discord_bots_store.update_bot(
            bot_id, name=body.name, token=body.token,
            allowed_user_id=body.allowed_user_id, model_endpoint_id=body.model_endpoint_id,
        )
    except KeyError:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="bot not found")
    # Real gap found live, 2026-09-01: get_or_create_channel_session() only
    # ever applies model_endpoint_id when a channel session is first
    # created — an already-existing conversation (exactly what David hit:
    # he'd already messaged the bot before a model was ever configured)
    # kept no model forever, silently ignoring this exact Settings change.
    # Push it onto the existing pinned session too, not just future ones.
    existing_session_id = session_manager.get_channel_session_id(f"discord:{bot_id}")
    if existing_session_id:
        session_manager.set_model_endpoint(existing_session_id, body.model_endpoint_id)
    await discord_channel.restart()
    return bot


class SetDiscordVoiceRequest(BaseModel):
    voice_channel_id: Optional[str] = None   # empty turns voice off


@router.put("/discord-bots/{bot_id}/voice")
async def set_discord_voice(bot_id: str, body: SetDiscordVoiceRequest, user: str = Depends(require_user)) -> dict:
    """The one voice channel this bot may join to talk with its allowed user. Off until set."""
    _own_discord_bot(bot_id)
    try:
        bot = discord_bots_store.set_voice_channel(bot_id, body.voice_channel_id)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error))
    if not bot["voice_channel_id"]:
        from services import discord_voice
        await discord_voice.leave(bot_id)
    return bot


@router.delete("/discord-bots/{bot_id}")
async def delete_discord_bot(bot_id: str, user: str = Depends(require_user)) -> dict:
    _own_discord_bot(bot_id)
    discord_bots_store.delete_bot(bot_id)
    await discord_channel.restart()
    return {"ok": True}


# -- Per-bot named channels (David's ask 2026-09-10: open/silent/broadcast
# behavior scoped to a specific Discord channel, not just the whole bot) --

@router.post("/discord-bots/{bot_id}/channels")
async def add_discord_channel(bot_id: str, body: AddDiscordChannelRequest, user: str = Depends(require_user)) -> dict:
    _own_discord_bot(bot_id)
    if not body.discord_channel_id.strip().isdigit():
        raise HTTPException(status_code=400, detail=(
            "That doesn't look like a Discord channel ID (numbers only). "
            "Turn on Developer Mode in Discord (Settings > Advanced), then right-click "
            "the channel and choose Copy Channel ID."
        ))
    try:
        bot = discord_bots_store.add_channel(bot_id, body.discord_channel_id, body.label, body.mode)
    except KeyError:
        raise HTTPException(status_code=404, detail="bot not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await discord_channel.restart()
    return bot


@router.patch("/discord-bots/{bot_id}/channels/{entry_id}")
async def update_discord_channel(bot_id: str, entry_id: str, body: UpdateDiscordChannelRequest, user: str = Depends(require_user)) -> dict:
    _own_discord_bot(bot_id)
    try:
        bot = discord_bots_store.update_channel(bot_id, entry_id, label=body.label, mode=body.mode)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await discord_channel.restart()
    return bot


@router.delete("/discord-bots/{bot_id}/channels/{entry_id}")
async def delete_discord_channel(bot_id: str, entry_id: str, user: str = Depends(require_user)) -> dict:
    _own_discord_bot(bot_id)
    try:
        bot = discord_bots_store.remove_channel(bot_id, entry_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    await discord_channel.restart()
    return bot


@router.get("/agent-tools")
async def list_agent_tools(user: str = Depends(require_admin)) -> dict:
    disabled = settings_store.get_setting("disabled_tools") or []
    extra_allowed = settings_store.get_setting("extra_allowed_tools") or []
    return {"available": AGENT_TOOLS, "disabled": disabled, "extra_allowed": extra_allowed}


@router.post("/agent-tools")
async def set_disabled_tools(body: SetDisabledToolsRequest, user: str = Depends(require_admin)) -> dict:
    """Globally disables the listed tools for every Claude chat (see
    core/brain.py's disallowed_tools wiring). An open chat picks the change
    up on its next message - see Brain.tool_config_changed()."""
    unknown = set(body.disabled_tools) - set(AGENT_TOOLS)
    if unknown:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail=f"unknown tool(s): {', '.join(unknown)}")
    settings_store.update_settings(disabled_tools=body.disabled_tools)
    return {"ok": True}


class SetExtraAllowedToolsRequest(BaseModel):
    extra_allowed_tools: list[str]


@router.post("/extra-allowed-tools")
async def set_extra_allowed_tools(body: SetExtraAllowedToolsRequest, user: str = Depends(require_admin)) -> dict:
    """Escape hatch for MCP tools core/brain.py's hardcoded allowed_tools
    baseline doesn't cover (David's ask 2026-09-10, hit live with Canva's
    real design/export flow reaching for a tool the baseline hadn't
    anticipated) — see core/settings.py's extra_allowed_tools for the full
    story. No validation against a known-tools list here, unlike
    disabled_tools above: this exists specifically to cover MCP tools
    jarvis-app doesn't know about ahead of time (Canva's own surface,
    which isn't enumerated anywhere in this codebase)."""
    cleaned = [t.strip() for t in body.extra_allowed_tools if t.strip()]
    previous = set(settings_store.get_setting("extra_allowed_tools") or [])
    # Adding a tool here is an explicit grant, including one revoked earlier
    # in Settings > Permissions; a tool already listed keeps whatever the
    # permission store says, so a revocation is not undone by re-saving.
    permissions.grant_standing([t for t in cleaned if t not in previous], granted_by=user)
    settings_store.update_settings(extra_allowed_tools=cleaned)
    return {"ok": True}
