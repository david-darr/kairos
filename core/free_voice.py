"""Free realtime voice: a Gemini API key from Google AI Studio, checked and connected in one step.

Realtime speech-to-speech (build spec 6b, Track A) needs a provider key. Google's Gemini API has a free tier that
includes Live voice models, so a person with a Google account can get the "best" voice mode without paying. The
person creates the key themselves (Kairos never signs up for anything); this module only:
1. checks the pasted key against Google's model list (one request, the key in a header, never in a URL), and finds a
   model that supports Live sessions (bidiGenerateContent);
2. saves it as an ordinary API connection (sealed like every other key), marked for Gemini realtime voice and as a free
   key, so calls show "free tier" instead of a per-minute estimate. It also works as a chat model.

Honest limits, shown to the person: Google sets and changes the free tier's limits; past them, realtime calls fail
until they reset (Local mode keeps working); free-tier prompts and audio may be used by Google to improve its products;
it is not offered in every country; a key from a project with billing turned on is billed.
"""
from typing import Optional

import httpx

from core import model_endpoints, realtime_voice

TRANSPORT: Optional[httpx.AsyncBaseTransport] = None     # tests: a mock of Google's API
MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models"
BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai"
CHAT_MODEL = "gemini-2.5-flash"
NAME = "Gemini (free key)"
KEY_PAGE = "https://aistudio.google.com/apikey"


class FreeVoiceError(ValueError):
    """Shown to the person as-is."""


def _clean_key(key) -> str:
    key = "".join(str(key or "").split())
    if not 20 <= len(key) <= 200 or not all(c.isalnum() or c in "-_" for c in key):
        raise FreeVoiceError("That does not look like a Gemini API key. Copy the whole key from Google AI Studio.")
    return key


def _live_models(listing: dict) -> list:
    found = []
    for model in listing.get("models") or []:
        methods = model.get("supportedGenerationMethods") or []
        name = str(model.get("name") or "").removeprefix("models/")
        if name and "bidiGenerateContent" in methods:
            found.append(name)
    return found


def pick_model(live: list) -> str:
    """The default Live model when the key can use it, else the best-looking one it offers."""
    default = realtime_voice.adapter("gemini").default_model
    if default in live:
        return default
    ranked = sorted(live, key=lambda n: (("native-audio" not in n and "live" not in n), "preview" in n, n))
    return ranked[0]


async def check(key) -> dict:
    """{'model', 'live_models'} for a working key with a Live model, else FreeVoiceError saying what is wrong."""
    key = _clean_key(key)
    listing, page = {"models": []}, ""
    try:
        async with httpx.AsyncClient(transport=TRANSPORT, timeout=httpx.Timeout(15.0, connect=8.0), trust_env=False,
                                     follow_redirects=False) as client:
            for _ in range(5):
                response = await client.get(MODELS_URL, params={"pageSize": 1000, **({"pageToken": page} if page else {})},
                                            headers={"x-goog-api-key": key})
                if response.status_code in (400, 401, 403):
                    raise FreeVoiceError("Google did not accept that key. Check you copied all of it, or make a new one.")
                if response.status_code == 429:
                    raise FreeVoiceError("The key works, but it is over Google's free limit right now. Try again later.")
                if response.status_code >= 400:
                    raise FreeVoiceError(f"Google answered with an error ({response.status_code}). Try again in a minute.")
                data = response.json()
                listing["models"] += data.get("models") or []
                page = data.get("nextPageToken") or ""
                if not page:
                    break
    except httpx.HTTPError:
        raise FreeVoiceError("Could not reach Google. Check this computer is online, then try again.") from None
    except ValueError as error:
        if isinstance(error, FreeVoiceError):
            raise
        raise FreeVoiceError("Google's answer could not be read. Try again in a minute.") from None
    live = _live_models(listing)
    if not live:
        raise FreeVoiceError("The key works, but Google offers it no Live voice model. This can depend on your country or account.")
    return {"model": pick_model(live), "live_models": live}


def current() -> Optional[dict]:
    """The account's free Gemini voice connection, as the API shows it (no key), or None."""
    for listed in model_endpoints.list_endpoints():
        if listed.get("free_tier") and listed.get("realtime_provider") == "gemini" and not listed.get("shared"):
            return listed
    return None


def status() -> dict:
    found = current()
    return {"configured": bool(found), "endpoint_id": (found or {}).get("id"), "model": (found or {}).get("realtime_model"),
            "key_page": KEY_PAGE}


async def connect(key) -> dict:
    """Check the key, then save it as this account's free Gemini voice connection (replacing an older one)."""
    checked = await check(key)
    old = current()
    endpoint = model_endpoints.create_endpoint(NAME, BASE_URL, CHAT_MODEL, _clean_key(key), "api")
    model_endpoints.set_realtime(endpoint["id"], "gemini", checked["model"])
    model_endpoints.set_free_tier(endpoint["id"], True)
    if old:
        model_endpoints.delete_endpoint(old["id"])
    return {**status(), "live_models": checked["live_models"]}
