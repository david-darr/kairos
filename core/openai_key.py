"""GPT-Live in one step: an OpenAI API key pasted in Settings > Speech, checked and saved as an ordinary API connection.

A connection at api.openai.com with a key is offered as GPT-Live by services/realtime_session.choices() (live_capable),
so saving it here is all GPT-Live needs. The person creates the key themselves (Kairos never signs up for anything);
this module checks it against OpenAI's model list (one request, the key in a header, nothing spoken or billed) and
saves it sealed like every other key. It also works as a chat model.
"""
from typing import Optional

import httpx

from core import model_endpoints

TRANSPORT: Optional[httpx.AsyncBaseTransport] = None     # tests: a mock of OpenAI's API
BASE_URL = "https://api.openai.com/v1"
NAME = "OpenAI"
KEY_PAGE = "https://platform.openai.com/api-keys"
CHAT_MODELS = ("gpt-5-mini", "gpt-4.1-mini", "gpt-4o-mini")


class OpenAIKeyError(ValueError):
    """Shown to the person as-is."""


def clean(key) -> str:
    key = "".join(str(key or "").split())
    if not 20 <= len(key) <= 300 or not key.startswith("sk-") or not all(c.isalnum() or c in "-_" for c in key):
        raise OpenAIKeyError("That does not look like an OpenAI API key. Copy the whole key, starting with sk-.")
    return key


async def check(key) -> str:
    """The chat model the new connection uses, for a key OpenAI accepts; else OpenAIKeyError saying what is wrong."""
    key = clean(key)
    try:
        async with httpx.AsyncClient(transport=TRANSPORT, timeout=httpx.Timeout(15.0, connect=8.0), trust_env=False,
                                     follow_redirects=False) as client:
            response = await client.get(f"{BASE_URL}/models", headers={"Authorization": f"Bearer {key}"})
    except httpx.HTTPError:
        raise OpenAIKeyError("Could not reach OpenAI. Check this computer is online, then try again.") from None
    if response.status_code in (401, 403):
        raise OpenAIKeyError("OpenAI did not accept that key. Check you copied all of it, or make a new one.")
    if response.status_code >= 400:
        raise OpenAIKeyError(f"OpenAI answered with an error ({response.status_code}). Try again in a minute.")
    try:
        offered = {str(m.get("id")) for m in response.json().get("data") or [] if isinstance(m, dict)}
    except (ValueError, AttributeError):
        raise OpenAIKeyError("OpenAI's answer could not be read. Try again in a minute.") from None
    return next((m for m in CHAT_MODELS if m in offered), CHAT_MODELS[0])


def current() -> Optional[dict]:
    """This account's own connection to api.openai.com with a key, as the API lists it (no key), or None."""
    for listed in model_endpoints.list_endpoints():
        if listed.get("shared") or listed.get("kind") != "api":
            continue
        if str(listed.get("base_url") or "").rstrip("/") == BASE_URL and listed.get("has_api_key"):
            return listed
    return None


async def connect(key) -> dict:
    """Check the key, then save it as an OpenAI connection (an existing one is kept, not duplicated)."""
    model = await check(key)
    found = current()
    if found:
        return found
    return model_endpoints.create_endpoint(NAME, BASE_URL, model, clean(key), "api")
