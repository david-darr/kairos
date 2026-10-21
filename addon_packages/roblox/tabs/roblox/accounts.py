"""Roblox OAuth with PKCE and per-Kairos-user encrypted credentials."""
import asyncio
import base64
import hashlib
import json
import re
import secrets
import threading
import time
from urllib.parse import urlencode, urlsplit

import httpx

from core import tab_api

api = tab_api.for_tab(__package__)
_lock = threading.RLock()
_pending = {}
_refresh_locks = {}
_epochs = {}
_config_epoch = 0
AUTH = "https://apis.roblox.com/oauth/v1/"


def key(user):
    return hashlib.sha256(user.encode()).hexdigest()


def config():
    return api.read_json("oauth-config.json", {})


def configure(client_id, redirect_uri, client_secret=None):
    global _config_epoch
    uri = urlsplit(redirect_uri)
    if not valid_client_id(client_id):
        raise ValueError("Enter the Client ID issued by Roblox Creator Dashboard, not a GitHub URL, game ID or client secret")
    if (uri.username or uri.password or uri.query or uri.fragment
            or uri.path != "/api/tab-roblox/oauth/callback"
            or (uri.scheme != "https" and not (uri.scheme == "http" and uri.hostname in {"localhost", "127.0.0.1"}))):
        raise ValueError("Use a Roblox client ID and a registered HTTPS callback, or localhost HTTP callback, ending in /api/tab-roblox/oauth/callback")
    saved = dict(client_id=client_id.strip(), redirect_uri=redirect_uri)
    if client_secret:
        saved["secret"] = api.encrypt(client_secret)
    elif config().get("client_id") == client_id.strip():
        saved["secret"] = config().get("secret")
    with _lock:
        api.write_json("oauth-config.json", saved)
        _pending.clear()
        _config_epoch += 1
        # A client change invalidates tokens issued for the old app.
    return safe_config()


def safe_config():
    cfg = config()
    return {"client_id": cfg.get("client_id", ""), "redirect_uri": cfg.get("redirect_uri", ""),
            "configured": valid_client_id(cfg.get("client_id", "")) and bool(cfg.get("redirect_uri")), "has_client_secret": bool(cfg.get("secret"))}


def valid_client_id(value):
    return isinstance(value, str) and bool(re.fullmatch(r"[A-Za-z0-9_-]{1,200}", value.strip()))


def load(user):
    return api.read_json("account-" + key(user) + ".json", {})


def status(user):
    row = load(user)
    return {"connected": bool(row.get("tokens") and row.get("client_id") == config().get("client_id")),
            "profile": row.get("profile"), "oauth_configured": safe_config()["configured"]}


def start(user):
    cfg = config()
    if not safe_config()["configured"]:
        raise ValueError("An administrator must register and configure the Roblox OAuth app first")
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    with _lock:
        epoch = _epochs[user] = _epochs.get(user, 0) + 1
        for old in list(_pending):
            if _pending[old]["expires"] < time.time() or _pending[old]["user"] == user:
                _pending.pop(old)
        _pending[state] = {"user": user, "verifier": verifier, "expires": time.time() + 600,
                           "config": cfg, "epoch": epoch, "config_epoch": _config_epoch}
    return AUTH + "authorize?" + urlencode(dict(client_id=cfg["client_id"], redirect_uri=cfg["redirect_uri"],
        response_type="code", scope="openid profile universe:read", state=state,
        code_challenge=challenge, code_challenge_method="S256"))


async def request(method, url, **kwargs):
    async with httpx.AsyncClient(timeout=25, follow_redirects=False) as client:
        try:
            response = await client.request(method, url, **kwargs)
        except httpx.HTTPError:
            raise ValueError("Roblox could not be reached. Try again.")
    if response.status_code >= 400:
        # Never return OAuth request/response bodies containing tokens or codes.
        raise ValueError(f"Roblox returned HTTP {response.status_code}; check the connection and app permissions")
    if not response.content:
        return {}
    try:
        return response.json()
    except ValueError:
        raise ValueError("Roblox returned an invalid response")


def credentials(cfg):
    return {"client_id": cfg["client_id"], **({"client_secret": api.decrypt(cfg["secret"])} if cfg.get("secret") else {})}


async def finish(user, state, code, error=None):
    with _lock:
        pending = _pending.get(state)
        if not pending or pending["user"] != user:
            raise ValueError("This sign-in belongs to another user or has expired. Start again.")
        _pending.pop(state)
    if pending["expires"] < time.time() or pending["config"] != config():
        raise ValueError("Sign-in expired or app settings changed. Start again.")
    if error or not code:
        raise ValueError("Roblox sign-in was cancelled or refused")
    cfg = pending["config"]
    tokens = await request("POST", AUTH + "token", data={**credentials(cfg), "grant_type": "authorization_code",
        "code": code, "code_verifier": pending["verifier"], "redirect_uri": cfg["redirect_uri"]})
    if not tokens.get("access_token") or not tokens.get("refresh_token"):
        raise ValueError("Roblox did not issue the required account tokens")
    profile = await request("GET", AUTH + "userinfo", headers={"Authorization": "Bearer " + tokens["access_token"]})
    if not str(profile.get("sub", "")).isdigit():
        raise ValueError("Roblox did not return a valid account ID")
    with _lock:
        if (cfg != config() or pending["epoch"] != _epochs.get(user)
                or pending["config_epoch"] != _config_epoch):
            raise ValueError("OAuth settings changed. Start sign-in again.")
        api.write_json("account-" + key(user) + ".json", {"client_id": cfg["client_id"],
            "profile": {k: profile.get(k) for k in ("sub", "name", "preferred_username")},
            "tokens": api.encrypt(json.dumps(tokens)),
            "expires": time.time() + int(tokens.get("expires_in", 900))})
    return status(user)


async def callback(state, code, error=None):
    # The external browser need not carry Kairos's session cookie. This
    # single-use nonce was created by an authenticated user and owns PKCE.
    with _lock:
        pending = _pending.get(state)
        if not pending:
            raise ValueError("This sign-in has expired. Start again in Kairos.")
        user = pending["user"]
    return await finish(user, state, code, error)


async def access(user):
    with _lock:
        lock = _refresh_locks.setdefault(key(user), asyncio.Lock())
    async with lock:
        row, cfg = load(user), config()
        if not row.get("tokens") or row.get("client_id") != cfg.get("client_id"):
            raise ValueError("Connect your Roblox account first")
        tokens = json.loads(api.decrypt(row["tokens"]))
        if row.get("expires", 0) < time.time() + 60:
            refreshed = await request("POST", AUTH + "token", data={**credentials(cfg),
                "grant_type": "refresh_token", "refresh_token": tokens["refresh_token"]})
            tokens = {**tokens, **refreshed}
            if not tokens.get("access_token"):
                raise ValueError("Reconnect your Roblox account")
            with _lock:
                if load(user).get("tokens") != row["tokens"] or config() != cfg:
                    raise ValueError("The Roblox connection changed")
                row.update(tokens=api.encrypt(json.dumps(tokens)),
                           expires=time.time() + int(tokens.get("expires_in", 900)))
                api.write_json("account-" + key(user) + ".json", row)
        return tokens["access_token"]


async def disconnect(user):
    row = load(user)
    with _lock:
        _epochs[user] = _epochs.get(user, 0) + 1
        api.write_json("account-" + key(user) + ".json", {})
        for state in list(_pending):
            if _pending[state]["user"] == user:
                _pending.pop(state)
    if row.get("tokens") and row.get("client_id") == config().get("client_id"):
        tokens = json.loads(api.decrypt(row["tokens"]))
        try:
            await request("POST", AUTH + "token/revoke", data={**credentials(config()), "token": tokens.get("refresh_token", "")})
        except ValueError:
            return {"connected": False, "warning": "Local tokens removed. Revoke Kairos in Roblox's connected apps to finish server-side revocation."}
    return {"connected": False}


async def library(user):
    token = await access(user)
    uid = load(user)["profile"]["sub"]
    games, warnings, ids = {}, [], set()
    cursor = None
    for _ in range(20):
        page = await request("GET", f"https://games.roblox.com/v2/users/{uid}/games",
                             params={"limit": 50, "accessFilter": 2, **({"cursor": cursor} if cursor else {})})
        for item in page.get("data", []):
            universe_id = str(item["id"])
            games[universe_id] = {"universe_id": universe_id, "place_id": str((item.get("rootPlace") or {}).get("id", "")),
                                  "name": item.get("name", "Roblox game"), "source": "Public creation"}
        cursor = page.get("nextPageCursor")
        if not cursor:
            break
    if cursor:
        warnings.append("Showing the first 1,000 public creations; link additional places by ID.")
    try:
        resources = await request("POST", AUTH + "token/resources", data={**credentials(config()), "token": token})
        for info in resources.get("resource_infos", []):
            for value in info.get("resources", {}).get("universe", {}).get("ids", []):
                if str(value).isdigit():
                    ids.add(str(value))
        for universe_id in sorted(ids)[:200]:
            try:
                item = await request("GET", f"https://apis.roblox.com/cloud/v2/universes/{universe_id}",
                                     headers={"Authorization": "Bearer " + token})
                games[universe_id] = {"universe_id": universe_id, "place_id": str(item.get("rootPlace", "")).split("/")[-1],
                                      "name": item.get("displayName", item.get("name", "Roblox game")), "source": "Authorized experience"}
            except ValueError:
                warnings.append("An authorized experience could not be loaded. Check its Roblox permissions.")
    except ValueError:
        warnings.append("Roblox did not expose the authorized-resource list for this app. Link private places by their universe and place IDs.")
    return {"games": list(games.values()), "warnings": list(dict.fromkeys(warnings)),
            "coverage": "Public creations and explicitly authorized experiences. Local files, unpublished experiments, archived games and group projects may need to be linked separately."}
