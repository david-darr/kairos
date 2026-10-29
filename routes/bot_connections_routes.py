"""Bot connections, MCP servers, keys, logins, setup import and resource settings (Phase 2, unit U5).

Mounted beneath /api/bots by the Phase 2 aggregate router. Admin only. Every path here starts with a
fixed word (connections, mcp, keys, logins, setup-import, resource-settings), declared before any
bot-id route, so a bot id is never read as one of them. Bodies are bounded and refuse unknown fields.
Nothing returned ever holds a saved secret: servers show header and variable names, keys show
"saved" and the last four characters, logins show the site and username.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from core import integrations, mcp_oauth
from core.middleware import local_api_base, require_admin
from services import (bot_connections, bot_highlevel, bot_keys, bot_logins, bot_mcp_config, bot_onepassword,
                      bot_setup_import)
from services.bot_connections import ConnectionError_
from services.bot_keys import KeyError_
from services.bot_logins import LoginError
from services.bot_mcp_config import McpConfigError

router = APIRouter(prefix="/api/bots", tags=["bot-connections"], dependencies=[Depends(require_admin)])


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AuthorizeBody(Body):
    alias: Optional[str] = Field(None, max_length=200)
    account: Optional[str] = Field(None, max_length=256)


class AliasBody(Body):
    alias: str = Field(max_length=200)


class McpBody(Body):
    name: Optional[str] = Field(None, max_length=64)
    transport: Optional[str] = Field(None, max_length=8)
    url: Optional[str] = Field(None, max_length=2048)
    command: Optional[str] = Field(None, max_length=600)
    args: Optional[list[str]] = Field(None, max_length=64)
    headers: Optional[dict[str, str | bool]] = Field(None, max_length=20)
    env: Optional[dict[str, str | bool]] = Field(None, max_length=40)
    oauth: Optional[dict] = None
    call_timeout_minutes: Optional[int] = None
    result_budget: Optional[int] = None
    enabled: Optional[bool] = None


class KeyBody(Body):
    value: str = Field(max_length=bot_keys.MAX_KEY)


class KeyTestBody(Body):
    value: Optional[str] = Field(None, max_length=bot_keys.MAX_KEY)


class LoginBody(Body):
    site: Optional[str] = Field(None, max_length=2048)
    username: Optional[str] = Field(None, max_length=300)
    password: Optional[str] = Field(None, max_length=1100)
    totp: Optional[str | dict] = "keep"
    exact_host: Optional[bool] = None
    bots: Optional[str | list[str]] = "keep"


class OnePasswordBody(Body):
    token: str = Field(max_length=4200)


class VaultBody(Body):
    bots: str | list[str]


class ImportBody(Body):
    mcp: list[dict] = Field(default_factory=list, max_length=100)
    skills: list[dict] = Field(default_factory=list, max_length=100)
    bot_id: Optional[str] = Field(None, max_length=32)


class SettingsBody(Body):
    helper_model: Optional[str] = Field(None, max_length=100)
    tidy_time: Optional[str] = Field(None, max_length=5)
    capture_quiet_minutes: Optional[int] = None
    room_capture: Optional[str] = Field(None, max_length=8)
    timezone: Optional[str] = Field(None, max_length=64)
    skill_review: Optional[dict] = None
    expected_revision: Optional[int] = None


def fail(error) -> HTTPException:
    return HTTPException(status_code=getattr(error, "status", 400), detail=str(error))


def guarded(call):
    try:
        return call()
    except (McpConfigError, LoginError, KeyError_, ConnectionError_) as error:
        raise fail(error)


async def guarded_async(call):
    try:
        return await call()
    except (McpConfigError, LoginError, KeyError_, ConnectionError_) as error:
        raise fail(error)


# -- connected apps ------------------------------------------------------------------------------

@router.get("/connections")
async def connections(user: str = Depends(require_admin), q: str = Query("", max_length=100), category: str = Query("", max_length=40),
                      mcp_only: bool = False, connected_only: bool = False):
    return guarded(lambda: bot_connections.inventory(user, query=q, category=category, mcp_only=mcp_only, connected_only=connected_only))


@router.post("/connections/{service}/authorize")
async def authorize(service: str, body: AuthorizeBody, user: str = Depends(require_admin)):
    return await guarded_async(lambda: bot_connections.authorize(service, user, local_api_base(), body.alias, account=body.account))


@router.put("/connections/{service}/accounts/{account}/alias")
async def set_alias(service: str, account: str, body: AliasBody, user: str = Depends(require_admin)):
    return guarded(lambda: bot_connections.set_alias(service, account, body.alias, user))


@router.delete("/connections/{service}/accounts/{account}")
async def disconnect(service: str, account: str, user: str = Depends(require_admin)):
    return guarded(lambda: bot_connections.disconnect(service, account, user))


# -- MCP servers ---------------------------------------------------------------------------------

def _servers() -> list[dict]:
    return [i for i in integrations.list_integrations() if i["kind"] == "mcp_server"]


@router.get("/mcp")
async def list_mcp():
    return {"servers": _servers(), "limit": integrations.MAX_MCP_SERVERS,
            "defaults": {"call_timeout_minutes": integrations.DEFAULT_CALL_MINUTES, "result_budget": integrations.DEFAULT_RESULT_BUDGET}}


@router.post("/mcp")
async def add_mcp(body: McpBody):
    return guarded(lambda: bot_mcp_config.save(body.model_dump(exclude_unset=True)))


@router.patch("/mcp/{item_id}")
async def edit_mcp(item_id: str, body: McpBody):
    fields = body.model_dump(exclude_unset=True)
    # A switch alone must not need the rest of the form.
    if set(fields) == {"enabled"} and isinstance(fields["enabled"], bool):
        return guarded(lambda: bot_mcp_config.set_enabled(item_id, fields["enabled"]))
    return guarded(lambda: bot_mcp_config.save(fields, item_id))


@router.delete("/mcp/{item_id}")
async def remove_mcp(item_id: str):
    guarded(lambda: bot_mcp_config.remove(item_id))
    return {"ok": True}


@router.post("/mcp/{item_id}/test")
async def test_mcp(item_id: str):
    return await guarded_async(lambda: bot_mcp_config.test(item_id))


@router.post("/mcp/{item_id}/sign-in")
async def sign_in_mcp(item_id: str):
    try:
        result = await mcp_oauth.start_sign_in(item_id, local_api_base() + mcp_oauth.CALLBACK_PATH)
    except KeyError:
        raise HTTPException(status_code=404, detail="MCP server not found")
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    return result if result.get("signed_in") else {"url": result["url"], "expires_in": mcp_oauth.SIGN_IN_TIMEOUT_SECONDS}


@router.post("/mcp/{item_id}/sign-out")
async def sign_out_mcp(item_id: str):
    try:
        mcp_oauth.sign_out(item_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="MCP server not found")
    return {"ok": True}


# -- keys ----------------------------------------------------------------------------------------

@router.get("/keys")
async def list_keys():
    return {"groups": bot_keys.GROUPS, "keys": bot_keys.list_slots()}


def _one_key(slot: str) -> dict:
    if slot.startswith(("model:", "helper")):
        found = next((r for r in bot_keys.list_slots() if r["id"] == slot), None)
        if found is None:
            raise KeyError_("That key slot does not exist.", 404)
        return found
    return bot_keys.get_slot(slot)


@router.get("/keys/{slot}")
async def get_key(slot: str):
    return guarded(lambda: _one_key(slot))


@router.put("/keys/{slot}")
async def put_key(slot: str, body: KeyBody):
    return guarded(lambda: bot_keys.set_slot(slot, body.value))


@router.delete("/keys/{slot}")
async def delete_key(slot: str):
    return guarded(lambda: bot_keys.clear_slot(slot))


@router.post("/keys/{slot}/test")
async def test_key(slot: str, body: Optional[KeyTestBody] = None):
    if slot.startswith("model:"):
        return await guarded_async(lambda: bot_keys.test_model_connection(slot.split(":", 1)[1]))
    return await guarded_async(lambda: bot_keys.test_slot(slot, body.value if body else None))


# -- saved logins and 1Password ------------------------------------------------------------------

@router.get("/logins")
async def list_logins():
    return guarded(lambda: {"logins": bot_logins.list_logins(), "onepassword": bot_onepassword.status()})


@router.post("/logins")
async def add_login(body: LoginBody):
    return guarded(lambda: bot_logins.create(body.site or "", body.username or "", body.password or "", totp=None if body.totp == "keep" else body.totp,
                                             exact_host=bool(body.exact_host), bots="all" if body.bots == "keep" else body.bots))


@router.get("/logins/onepassword")
async def onepassword_status():
    return guarded(bot_onepassword.status)


@router.post("/logins/onepassword")
async def onepassword_connect(body: OnePasswordBody):
    return guarded(lambda: bot_onepassword.connect(body.token))


@router.post("/logins/onepassword/refresh")
async def onepassword_refresh():
    return guarded(bot_onepassword.refresh)


@router.delete("/logins/onepassword")
async def onepassword_disconnect():
    return guarded(bot_onepassword.disconnect)


@router.put("/logins/onepassword/vaults/{vault_id}")
async def onepassword_vault(vault_id: str, body: VaultBody):
    return guarded(lambda: bot_onepassword.set_vault_bots(vault_id, body.bots))


@router.patch("/logins/{login_id}")
async def edit_login(login_id: str, body: LoginBody):
    fields = body.model_dump(exclude_unset=True)
    return guarded(lambda: bot_logins.update(login_id, site=fields.get("site"), username=fields.get("username"), password=fields.get("password"),
                                             totp=fields.get("totp", "keep"), exact_host=fields.get("exact_host"), bots=fields.get("bots", "keep")))


@router.delete("/logins/{login_id}")
async def remove_login(login_id: str):
    guarded(lambda: bot_logins.delete(login_id))
    return {"ok": True}


# -- setup import and settings -------------------------------------------------------------------

@router.get("/setup-import")
async def preview_import():
    return await _off_thread(bot_setup_import.scan)


@router.post("/setup-import")
async def apply_import(body: ImportBody):
    return await _off_thread(lambda: bot_setup_import.apply({"mcp": body.mcp, "skills": body.skills}, bot_id=body.bot_id))


async def _off_thread(call):
    import asyncio
    try:
        return await asyncio.to_thread(call)
    except (McpConfigError, LoginError, KeyError_) as error:
        raise fail(error)
    except Exception as error:  # another unit's importer: a clear refusal, never a stack trace
        status = getattr(error, "status", None)
        if status:
            raise HTTPException(status_code=status, detail=str(error))
        raise


@router.get("/resource-settings")
async def get_resource_settings(user: str = Depends(require_admin)):
    return bot_keys.resource_settings(user)


@router.patch("/resource-settings")
async def patch_resource_settings(body: SettingsBody, user: str = Depends(require_admin)):
    fields = body.model_dump(exclude_unset=True)
    expected = fields.pop("expected_revision", None)
    return guarded(lambda: bot_keys.update_resource_settings(user, fields, expected))


@router.get("/highlevel/activity")
async def highlevel_activity(limit: int = Query(50, ge=1, le=500)):
    return {"rows": bot_highlevel.activity(limit)}
