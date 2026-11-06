"""Owner-scoped creative connections. No tokens enter shared MCP catalogs.

All model kinds use this bridge, including approval and uncertain-job guards.
Blender uses the authenticated Kairos add-on; Higgsfield uses official MCP.
"""
import asyncio
import base64
import hashlib
import json
from pathlib import Path
import re
import threading
import time
import uuid

import httpx

from core import accounts, addons, atomic_io, mcp_client, mcp_oauth, permissions
from core.constants import DATA_DIR
from core.secret_storage import encrypt, decrypt
from core.session_manager import session_manager


def file():
    return accounts.path("creative-connections.json")


HIGGSFIELD = "https://mcp.higgsfield.ai/mcp"
_lock = threading.RLock()
_pending = {}
_busy = set()
_refresh_locks = {}


def _load():
    return atomic_io.read_json(file(), {"accounts": {}, "bindings": {}, "jobs": []})


def _save(data):
    atomic_io.write_json_atomic(file(), data)


def _key(user, provider):
    if not user or provider not in {"blender", "higgsfield"}:
        raise ValueError("Choose Blender or Higgsfield")
    return hashlib.sha256((user + "\0" + provider).encode()).hexdigest()


def _account(user, provider):
    return _load()["accounts"].get(_key(user, provider), {})


def _update(user, provider, *, expected_epoch=None, **fields):
    with _lock:
        data = _load(); k = _key(user, provider)
        if expected_epoch and data["accounts"].get(k, {}).get("epoch") != expected_epoch:
            raise ValueError("This connection was revoked")
        row = data["accounts"].setdefault(k, {"epoch": uuid.uuid4().hex})
        row.update(fields); _save(data)
        return row


def catalog(user):
    result = []
    for provider, name, description in [("blender", "Blender", "Model, refine, materialize and export in your native Blender app."),
        ("higgsfield", "Higgsfield", "Create visual assets with your connected Higgsfield account.")]:
        if not addons.enabled(provider): continue
        row = _account(user, provider)
        result.append({"id": provider, "name": name, "description": description, "transport": "managed-creative",
                       "added": bool(row), "connected": bool(row.get("token") if provider == "blender" else (row.get("oauth") or {}).get("tokens")),
                       "status": row.get("status"), "held_tools": row.get("held_tools", []), "pins": row.get("pins", {}),
                       "file": row.get("blend_file", ""), "port": row.get("port", 9876),
                       "pending": any(v["key"] == _key(user, provider) for v in _pending.values())})
    return result


def session_owner(sid):
    session = session_manager.get_session(sid) if sid else None
    if not session:
        raise ValueError("Open a chat first")
    owner = session.get("owner_user")
    if owner:
        return owner
    from core.auth import auth_enabled, SINGLE_USER
    if not auth_enabled():
        return SINGLE_USER
    raise ValueError("This shared legacy chat needs an owned conversation before connecting private accounts")


def binding_key(sid=None, agent_id=None):
    return "agent:" + agent_id if agent_id else "chat:" + str(sid or "")


def choices(user, sid=None, agent_id=None):
    if agent_id:
        from services.agent_service import agent_service
        if not agent_service.get(agent_id): raise ValueError("Bot not found")
    elif session_owner(sid) != user:
        raise ValueError("Private creative accounts can only be connected to their owner's chat")
    current = _load()["bindings"].get(binding_key(sid, agent_id), {})
    return {"connections": catalog(user), "selected": [p for p in current.get("providers", []) if addons.enabled(p)] if current.get("owner") == user else []}


def select(user, providers, sid=None, agent_id=None):
    for provider in providers: addons.require(provider)
    choices(user, sid, agent_id)
    if not isinstance(providers, list) or len(providers) > 2 or any(p not in {"blender", "higgsfield"} for p in providers):
        raise ValueError("Choose Blender and/or Higgsfield")
    if sid:
        from services import chat_service
        if chat_service.is_busy(sid): raise ValueError("Wait for the current reply before changing creative connections")
    with _lock:
        data = _load(); data["bindings"][binding_key(sid, agent_id)] = {"owner": user, "providers": list(dict.fromkeys(providers))}; _save(data)
    return choices(user, sid, agent_id)


def principal(sid=None, agent_id=None):
    if sid:
        session = session_manager.get_session(sid) or {}
        # A platform-bound bot may use its explicit owner binding in its own
        # ownerless admin-only chat. Never infer a private owner for other chats.
        if agent_id and session.get("agent_id") == agent_id and not session.get("owner_user"):
            current = _load()["bindings"].get(binding_key(agent_id=agent_id), {})
            return current.get("owner"), [p for p in current.get("providers", []) if addons.enabled(p)]
        user = session_owner(sid)
        current = _load()["bindings"].get(binding_key(sid), {})
        # A bot chat may inherit only the explicitly assigned bot connection.
        session = session_manager.get_session(sid)
        if not current and session.get("agent_id"):
            current = _load()["bindings"].get(binding_key(agent_id=session["agent_id"]), {})
    else:
        current = _load()["bindings"].get(binding_key(agent_id=agent_id), {})
        user = current.get("owner")
    if not user or current.get("owner") != user:
        return user, []
    return user, [p for p in current.get("providers", []) if addons.enabled(p)]


def connect_blender(user, port, token):
    addons.require('blender')
    if not 1024 <= port <= 65535 or not 20 <= len(token) <= 200:
        raise ValueError("Enter the loopback port and pairing token shown in Blender's Kairos panel")
    return _update(user, "blender", port=port, token=encrypt(token), status="Saved; check the connection", epoch=uuid.uuid4().hex)


def disconnect(user, provider):
    with _lock:
        data = _load(); k = _key(user, provider); data["accounts"].pop(k, None)
        for row in data["bindings"].values():
            if row.get("owner") == user: row["providers"] = [p for p in row["providers"] if p != provider]
        for state, pending in list(_pending.items()):
            if pending["key"] == k:
                pending["task"].cancel(); _pending.pop(state, None)
        _save(data)


class TokenStorage:
    def __init__(self, user, redirect_uri, epoch):
        self.user, self.redirect_uri, self.epoch = user, redirect_uri, epoch

    def row(self):
        addons.require('higgsfield')
        row = _account(self.user, "higgsfield")
        if row.get("epoch") != self.epoch: raise ValueError("This connection was revoked")
        return row

    async def get_tokens(self):
        from mcp.shared.auth import OAuthToken
        raw = self.row().get("oauth", {}).get("tokens")
        return OAuthToken.model_validate_json(decrypt(raw)) if raw else None

    async def set_tokens(self, tokens):
        row = self.row(); oauth = dict(row.get("oauth") or {})
        oauth.update(tokens=encrypt(tokens.model_dump_json(exclude_none=True)),
                     expires_at=time.time() + (tokens.expires_in or 900))
        _update(self.user, "higgsfield", expected_epoch=self.epoch, oauth=oauth, status="Connected")

    async def get_client_info(self):
        from mcp.shared.auth import OAuthClientInformationFull
        oauth = self.row().get("oauth") or {}
        raw = oauth.get("client") if oauth.get("redirect_uri") == self.redirect_uri else None
        return OAuthClientInformationFull.model_validate_json(decrypt(raw)) if raw else None

    async def set_client_info(self, client):
        oauth = dict(self.row().get("oauth") or {})
        oauth.update(client=encrypt(client.model_dump_json(exclude_none=True)), redirect_uri=self.redirect_uri)
        _update(self.user, "higgsfield", expected_epoch=self.epoch, oauth=oauth)


async def sign_in(user, redirect_uri):
    addons.require('higgsfield')
    from mcp.client.auth import OAuthClientProvider
    disconnect(user, "higgsfield")
    epoch = uuid.uuid4().hex
    _update(user, "higgsfield", epoch=epoch, status="Signing in")
    loop = asyncio.get_running_loop(); ready = loop.create_future(); code = loop.create_future()
    async def redirect(url):
        if not ready.done(): ready.set_result(url)
    async def callback(): return await code
    storage = TokenStorage(user, redirect_uri, epoch)
    provider = OAuthClientProvider(server_url=HIGGSFIELD, client_metadata=mcp_oauth._client_metadata(redirect_uri),
        storage=storage, redirect_handler=redirect, callback_handler=callback)
    async def run():
        try:
            await asyncio.wait_for(mcp_oauth._connect_signed_in(HIGGSFIELD, provider), 300)
            oauth = dict(storage.row().get("oauth") or {})
            context = provider.context
            if context.oauth_metadata: oauth["token_endpoint"] = str(context.oauth_metadata.token_endpoint)
            oauth["resource"] = context.get_resource_url() if context.should_include_resource_param(context.protocol_version) else None
            _update(user, "higgsfield", expected_epoch=epoch, oauth=oauth, status="Connected; check tools")
        except asyncio.CancelledError: raise
        except Exception:
            if _account(user, "higgsfield").get("epoch") == epoch:
                _update(user, "higgsfield", status="Sign-in failed; reconnect")
            raise
        finally:
            for state, pending in list(_pending.items()):
                if pending["epoch"] == epoch: _pending.pop(state, None)
    task = asyncio.create_task(run())
    # Consume failures even if no browser returns.
    task.add_done_callback(lambda done: done.exception() if not done.cancelled() else None)
    done, _ = await asyncio.wait({ready, task}, timeout=30, return_when=asyncio.FIRST_COMPLETED)
    if ready in done:
        from urllib.parse import parse_qs, urlsplit
        state = (parse_qs(urlsplit(ready.result()).query).get("state") or [""])[0]
        if not state: task.cancel(); raise ValueError("Higgsfield returned no authorization state")
        _pending[state] = {"key": _key(user, "higgsfield"), "task": task, "code": code, "epoch": epoch}
        return {"url": ready.result()}
    if task in done and not task.exception(): return {"signed_in": True}
    task.cancel(); raise ValueError("Higgsfield sign-in could not start; check the service and retry")


async def callback(state, code, iss=None, error=None):
    addons.require('higgsfield')
    from mcp.shared.auth import AuthorizationCodeResult
    pending = _pending.pop(state, None)
    if not pending: raise ValueError("This sign-in has expired. Start again from the Tool Store")
    if error or not code: pending["task"].cancel(); raise ValueError("Higgsfield sign-in was cancelled")
    pending["code"].set_result(AuthorizationCodeResult(code=code, state=state, iss=iss))
    try: await asyncio.wait_for(asyncio.shield(pending["task"]), 60)
    except Exception: raise ValueError("Higgsfield sign-in failed. Reconnect from the Tool Store")


async def _config(user):
    addons.require('higgsfield')
    guard = _refresh_locks.setdefault(user, asyncio.Lock())
    async with guard:
        return await _config_locked(user)


async def _config_locked(user):
    row = _account(user, "higgsfield"); oauth = row.get("oauth") or {}
    if not oauth.get("tokens"): raise ValueError("Connect Higgsfield in the Tool Store first")
    tokens = json.loads(decrypt(oauth["tokens"]))
    if oauth.get("expires_at", 0) < time.time() + 60:
        if not tokens.get("refresh_token") or not oauth.get("token_endpoint"):
            raise ValueError("Higgsfield sign-in expired; reconnect")
        data, headers = mcp_oauth._token_request(oauth, tokens)
        import httpx2
        async with httpx2.AsyncClient(timeout=25) as http:
            response = await http.post(oauth["token_endpoint"], data=data, headers=headers)
        if response.status_code >= 400: raise ValueError("Higgsfield token expired; reconnect")
        tokens.update(response.json())
        if _account(user, "higgsfield").get("epoch") != row.get("epoch"): raise ValueError("Connection revoked")
        oauth.update(tokens=encrypt(json.dumps(tokens)), expires_at=time.time() + tokens.get("expires_in", 900))
        _update(user, "higgsfield", expected_epoch=row["epoch"], oauth=oauth)
    return {"type": "http", "url": HIGGSFIELD, "headers": {"Authorization": "Bearer " + tokens["access_token"]}}


async def _blender(user, action, arguments=None):
    addons.require('blender')
    row = _account(user, "blender")
    if not row.get("token"): raise ValueError("Pair Blender in the Tool Store first")
    async with httpx.AsyncClient(timeout=120, follow_redirects=False, trust_env=False) as http:
        response = await http.post(f"http://127.0.0.1:{row['port']}/kairos", headers={"Authorization": "Bearer " + decrypt(row["token"])},
            json={"action": action, "arguments": arguments or {}})
    if response.status_code != 200: raise ValueError("Blender refused the connection; check its Kairos panel")
    result = response.json()
    if result.get("error"): raise ValueError(str(result["error"])[:800])
    return result


async def check(user, provider, accept=False):
    addons.require(provider)
    epoch = _account(user, provider).get("epoch")
    if not epoch: raise ValueError("Connect this provider first")
    if provider == "blender":
        state = await _blender(user, "inspect")
        if not state.get("file"): raise ValueError("Save the Blender project as a .blend file before connecting")
        _update(user, provider, expected_epoch=epoch, blend_file=state["file"], status="Connected to " + Path(state["file"]).name)
        return catalog(user)
    if provider != "higgsfield": raise ValueError("Unknown creative provider")
    async with mcp_client._client(await _config(user), 25) as client:
        result = await client.list_tools()
    tools = [{"name": t.name, "description": t.description or "", "schema": t.input_schema or {},
              "read_only": bool(t.annotations and t.annotations.read_only_hint)} for t in result.tools]
    row = _account(user, provider); pins = row.get("pins")
    current = {t["name"]: hashlib.sha256(json.dumps(t, sort_keys=True).encode()).hexdigest() for t in tools}
    held = [t["name"] for t in tools if pins is not None and pins.get(t["name"]) != current[t["name"]]]
    if pins is None or accept: pins = current; held = []
    _update(user, provider, expected_epoch=epoch, tools=tools, pins=pins, held_tools=held, status="Tools need review" if held else "Connected")
    return catalog(user)


def jobs(user):
    return [j for j in _load()["jobs"] if j["owner"] == user][-50:]


def _job(user, provider, name, args, state, job_id=None):
    digest = hashlib.sha256(json.dumps([provider, name, args], sort_keys=True).encode()).hexdigest()
    with _lock:
        data = _load()
        if not job_id and any(j["owner"] == user and j["digest"] == digest and j["state"] in {"pending", "uncertain"} for j in data["jobs"]):
            raise ValueError("This request may already be running. Check its result before clearing the uncertain request in the Tool Store")
        if job_id:
            row = next(j for j in data["jobs"] if j["id"] == job_id and j["owner"] == user)
            row["state"] = state
        else:
            row = dict(id=uuid.uuid4().hex, owner=user, provider=provider, name=name, digest=digest, state=state, at=time.time())
            data["jobs"].append(row)
        # Keep uncertain records until the owner resolves them.
        terminal = [j for j in data["jobs"] if j["state"] not in {"pending", "uncertain"}][-200:]
        data["jobs"] = terminal + [j for j in data["jobs"] if j["state"] in {"pending", "uncertain"}]
        _save(data); return row["id"]


def resolve_job(user, job_id):
    with _lock:
        data = _load(); row = next((j for j in data["jobs"] if j["owner"] == user and j["id"] == job_id), None)
        if not row or row["state"] not in {"pending", "uncertain"}: raise ValueError("Uncertain request not found")
        if (user, row["provider"]) in _busy: raise ValueError("The request is still executing")
        row["state"] = "reviewed"; _save(data)


async def tool(ctx, action, provider="", name="", arguments=None):
    user, selected = principal(ctx.session_id, ctx.agent_id)
    if action == "connections": return {"text": json.dumps({"selected": selected, "connections": catalog(user) if user else []}), "images": []}
    addons.require(provider)
    if provider not in selected: raise ValueError("Select this creative connection for this chat or bot first")
    row = _account(user, provider); epoch = row.get("epoch")
    if not row: raise ValueError("This creative connection was removed")
    if action == "tools":
        if provider == "blender":
            return {"text": json.dumps([{"name": "inspect", "arguments": {}}, {"name": "viewport", "arguments": {}},
                {"name": "execute", "arguments": {"code": "Blender Python; shown for approval before execution"}}]), "images": []}
        await check(user, provider)
        current = _account(user, provider)
        return {"text": json.dumps([t for t in current.get("tools", []) if t["name"] not in current.get("held_tools", [])]), "images": []}
    if action != "call": raise ValueError("Choose connections, tools or call")
    args = dict(arguments or {})
    if len(json.dumps(args, ensure_ascii=False)) > 80000:
        raise ValueError("Creative request exceeds 80,000 characters. Use a smaller, reviewable step")
    if provider == "blender":
        if not ctx.is_admin: raise ValueError("Native Blender execution requires an administrator")
        if name not in {"inspect", "viewport", "execute"}: raise ValueError("Unknown Blender tool")
        read_only = name != "execute"
    else:
        await check(user, provider)
        current = _account(user, provider)
        spec = next((t for t in current.get("tools", []) if t["name"] == name and name not in current.get("held_tools", [])), None)
        if not spec: raise ValueError("Review the current Higgsfield tool in the Tool Store first")
        read_only = spec["read_only"] and bool(re.match(r"^(get|list|search|check|describe|fetch|read)[_.-]", name))
    lock_key = (user, provider)
    with _lock:
        if lock_key in _busy: raise ValueError("This creative connection is busy")
        _busy.add(lock_key)
    job_id = None
    try:
        if not read_only:
            decision = await permissions.decide(surface=ctx.permission_surface, tool="creative_tools", arguments={"account_owner": user, "provider": provider, "name": name, "arguments": args},
                title=("Run Blender Python" if provider == "blender" else "Higgsfield request (may spend credits)"),
                description=("Runs Python on the Kairos host in " + row.get("blend_file", "the selected .blend file")
                    if provider == "blender" else "Review the model, references and credit cost before submitting. This request will not be retried automatically."),
                is_admin=ctx.is_admin, force_prompt=True, choices=[{"id": "once", "label": "Allow once", "behavior": "allow", "scope": "once"},
                    {"id": "deny", "label": "Reject", "behavior": "deny", "scope": "once"}])
            if decision.behavior != "allow": return {"text": "Not run: " + decision.reason, "images": []}
        current_user, current_selected = principal(ctx.session_id, ctx.agent_id)
        addons.require(provider)
        if current_user != user or provider not in current_selected or _account(user, provider).get("epoch") != epoch:
            raise ValueError("The creative connection was revoked or changed")
        if provider == "higgsfield":
            latest = _account(user, provider)
            if latest.get("pins", {}).get(name) != current.get("pins", {}).get(name) or name in latest.get("held_tools", []):
                raise ValueError("The tool changed during approval. Review it before proceeding")
        if not read_only: job_id = _job(user, provider, name, args, "pending")
        if provider == "blender":
            result = await _blender(user, name, {**args, "expected_file": row.get("blend_file", "")})
            answer = {"text": json.dumps({k:v for k,v in result.items() if k != "image"}, ensure_ascii=False),
                      "images": [base64.b64decode(result["image"], validate=True)] if result.get("image") else []}
        else:
            async with mcp_client._client(await _config(user), 120) as client:
                result = await client.call_tool(name, args)
            answer = {"text": mcp_client._tool_text(result), "images": [base64.b64decode(b.data, validate=True) for b in result.content if getattr(b,"type","") == "image"]}
        if job_id: _job(user, provider, name, args, "completed", job_id)
        return answer
    except BaseException:
        if job_id: _job(user, provider, name, args, "uncertain", job_id)
        raise
    finally:
        with _lock: _busy.discard(lock_key)
