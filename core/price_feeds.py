"""Live list prices from the model lists that publish them (Session Usage and Model Tracking, unit 4,
2026-11-07; decision 3: the bundled snapshot plus OpenRouter's and the endpoint's own /models pricing).

Two sources, both public price lists, read at most once a day by a background loop that starts with the app:
- each API connection's own `GET {base_url}/models`, when its entries carry `pricing` (OpenRouter and
  servers that copy its format do; most do not, and then nothing is kept);
- OpenRouter's public list (https://openrouter.ai/api/v1/models, no key), only while at least one API
  connection exists, so a person who uses only subscriptions or local models makes no price request at all.

Nothing about the person is sent: a request for a public list, with the connection's own key only to its own
server, as any model list request. What comes back is kept in one machine-wide file (prices are public, not
personal), each source with the time it was read, so every figure priced from it can say where and when.
Never on the request path: a missing or stale list just means the bundled snapshot or "unknown".
"""
import asyncio
import logging
import os
import time
from typing import Optional

from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR

logger = logging.getLogger(__name__)

CACHE_FILE: Optional[str] = None  # a test can point it at its own file
OPENROUTER_URL = "https://openrouter.ai/api/v1/models"
OPENROUTER = "openrouter"
REFRESH_SECONDS = 24 * 3600
FIRST_DELAY_SECONDS = 120  # after start-up, so a start (or a test run) never waits on it
TIMEOUT_SECONDS = 20

_task: Optional[asyncio.Task] = None


def cache_file() -> str:
    return CACHE_FILE or os.path.join(DATA_DIR, "model_price_feeds.json")


def _per_million(value) -> Optional[float]:
    """OpenRouter's pricing is USD per token as a string; "-1" or anything unparsable is unknown."""
    try:
        rate = float(value)
    except (TypeError, ValueError):
        return None
    return round(rate * 1_000_000, 6) if rate >= 0 else None


def parse_models(payload) -> dict:
    """{model id: {input, output, cache_read?, cache_write?}} per million tokens, from a /models reply whose
    entries carry `pricing`. An entry without input and output prices is left out."""
    items = payload.get("data") if isinstance(payload, dict) else payload
    found = {}
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict) or not isinstance(item.get("pricing"), dict) or not item.get("id"):
            continue
        pricing = item["pricing"]
        rates = {"input": _per_million(pricing.get("prompt")), "output": _per_million(pricing.get("completion"))}
        if rates["input"] is None or rates["output"] is None:
            continue
        for key, field in (("cache_read", "input_cache_read"), ("cache_write", "input_cache_write")):
            rate = _per_million(pricing.get(field))
            if rate is not None:
                rates[key] = rate
        found[str(item["id"])] = rates
    return found


def read() -> dict:
    """{source: {"fetched_at", "models"}}; source is "openrouter" or a connection's base URL."""
    data = read_json(cache_file(), {})
    return data if isinstance(data, dict) else {}


def _save(source: str, models: dict) -> None:
    data = read()
    data[source] = {"fetched_at": time.time(), "models": models}
    write_json_atomic(cache_file(), data)


def stale(source: str, now: Optional[float] = None) -> bool:
    entry = read().get(source) or {}
    return (now or time.time()) - float(entry.get("fetched_at") or 0) >= REFRESH_SECONDS


def _api_connections() -> list[dict]:
    """Every account's API connections (base URL and key), for the daily read."""
    from core import accounts, model_endpoints
    found = {}
    for account in accounts.all_accounts():
        try:
            with accounts.as_account(account):
                for endpoint in model_endpoints.list_endpoints():
                    if endpoint.get("kind") == "api" and endpoint.get("base_url") and not endpoint.get("shared"):
                        base, _, key, _ = model_endpoints.resolve_runtime(endpoint["id"])
                        found.setdefault(base.rstrip("/"), key)
        except Exception:
            logger.exception("price feeds: could not list an account's connections")
    return [{"base_url": base, "api_key": key} for base, key in found.items()]


async def refresh(client=None, connections: Optional[list] = None, now: Optional[float] = None) -> dict:
    """Read every stale list once. Returns {source: models found, or an error}. `client` is an httpx-like
    async client (a test passes a fake one); `connections` defaults to every account's API connections."""
    import httpx
    connections = _api_connections() if connections is None else connections
    if not connections:
        return {}
    results = {}
    owned = client is None
    client = client or httpx.AsyncClient(timeout=TIMEOUT_SECONDS)
    try:
        wanted = [(OPENROUTER, OPENROUTER_URL, None)] + [
            (c["base_url"], c["base_url"].rstrip("/") + "/models", c.get("api_key")) for c in connections]
        for source, url, key in wanted:
            if not stale(source, now):
                continue
            try:
                response = await client.get(url, headers={"Authorization": f"Bearer {key}"} if key else {})
                response.raise_for_status()
                models = parse_models(response.json())
            except Exception as error:
                results[source] = f"{type(error).__name__}"
                logger.info("price feeds: %s could not be read (%s)", source, type(error).__name__)
                continue
            # A list without prices is remembered as read, so it is not asked again until tomorrow.
            _save(source, models)
            results[source] = len(models)
    finally:
        if owned:
            await client.aclose()
    return results


async def _loop() -> None:
    await asyncio.sleep(FIRST_DELAY_SECONDS)
    while True:
        try:
            await refresh()
        except Exception:
            logger.exception("price feeds: refresh failed")
        await asyncio.sleep(REFRESH_SECONDS / 4)


def start() -> None:
    global _task
    if _task is None or _task.done():
        _task = asyncio.get_running_loop().create_task(_loop())


async def stop() -> None:
    global _task
    if _task is not None:
        _task.cancel()
        try:
            await _task
        except (asyncio.CancelledError, Exception):
            pass
        _task = None
