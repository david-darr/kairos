"""Openverse photo discovery and bounded downloads, with license details kept beside each photo."""
import ipaddress
import socket
from urllib.parse import urljoin, urlparse, quote

import httpx

BASE = "https://api.openverse.org/v1/images/"
MAX_BYTES = 15 * 1024 * 1024
_transport = None
_resolve = socket.getaddrinfo  # Tests swap in a fixed public address.
# Photo hosts (Flickr among them) refuse anonymous clients; Kairos says who it is, and never pretends to be a browser.
HEADERS = {"User-Agent": "Kairos/2.2 (open-source design app; Openverse photo fetch)"}
TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}


class ImageSearchError(ValueError):
    """A search or download the person can retry or replace."""


def _candidate(item):
    return {key: item.get(key, "") for key in (
        "id", "title", "creator", "license", "license_version", "license_url", "url", "width", "height", "attribution")} | {
        "landing": item.get("foreign_landing_url") or ""}


def _safe(url):
    try:
        parsed = urlparse(url)
        host = (parsed.hostname or "").rstrip(".").lower()
        parsed.port  # Reject malformed ports before handing the address to HTTPX.
        if parsed.scheme != "https" or not host or host == "localhost" or host.endswith(".localhost") or parsed.username or parsed.password:
            raise ValueError()
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            raise ValueError()
        # A public name that resolves to this machine or a private network is refused too.
        for *_, sockaddr in _resolve(host, parsed.port or 443, type=socket.SOCK_STREAM):
            address = ipaddress.ip_address(sockaddr[0])
            if not address.is_global:
                raise ValueError()
        return url
    except socket.gaierror as error:
        raise ImageSearchError("That photo's host could not be found. Choose another photo.") from error
    except (ValueError, TypeError) as error:
        raise ImageSearchError("That photo address is not allowed. Choose an HTTPS photo on a public host, not localhost or an IP address.") from error


def _client(transport):
    return httpx.AsyncClient(timeout=20, follow_redirects=False, trust_env=False, headers=HEADERS,
                             transport=transport if transport is not None else _transport)


async def _get(client, url, **kwargs):
    """Openverse answers 5xx now and then (Phase 3 benchmark); one retry."""
    response = await client.get(url, **kwargs)
    if response.status_code >= 500:
        response = await client.get(url, **kwargs)
    response.raise_for_status()
    return response


async def search(query, count=6, orientation=None, *, transport=None) -> list[dict]:
    if not isinstance(query, str) or not query.strip() or len(query) > 1000:
        raise ImageSearchError("Give a short description of the photo to find.")
    if type(count) is not int or not 1 <= count <= 8 or orientation not in (None, "landscape", "portrait", "square"):
        raise ImageSearchError("Choose 1 to 8 photos and landscape, portrait or square.")
    try:
        async with _client(transport) as client:
            response = await _get(client, BASE, params={"q": query.strip(), "page_size": min(20, count * 2),
                                                        "license_type": "commercial,modification", "mature": "false"})
            items = response.json()["results"]
            if not isinstance(items, list):
                raise ValueError()
            out = []
            for item in items:
                if not isinstance(item, dict) or item.get("mature") or not item.get("url"):
                    continue
                w, h = item.get("width"), item.get("height")
                if not isinstance(w, (int, float)) or not isinstance(h, (int, float)) or w < 800 or h <= 0:
                    continue
                ratio = w / h
                if orientation == "landscape" and ratio <= 1.1 or orientation == "portrait" and ratio >= 0.9 or orientation == "square" and not 0.9 <= ratio <= 1.1:
                    continue
                out.append(_candidate(item))
            return out[:count]
    except (httpx.HTTPError, httpx.InvalidURL, ValueError, KeyError, TypeError) as error:
        raise ImageSearchError("Openverse could not be reached or returned an unreadable photo list. Try another search.") from error


async def _download(client, url) -> tuple[bytes, str]:
    url = _safe(url)
    for hop in range(4):
        async with client.stream("GET", url) as response:
            if response.status_code in (301, 302, 303, 307, 308):
                if hop == 3 or not response.headers.get("location"):
                    raise ImageSearchError("That photo redirects too many times. Choose another photo.")
                url = _safe(urljoin(url, response.headers["location"]))
                continue
            response.raise_for_status()
            ext = TYPES.get(response.headers.get("content-type", "").split(";")[0].strip().lower())
            if not ext:
                raise ImageSearchError("That photo is not a PNG, JPEG, WebP or GIF. Choose another photo.")
            if int(response.headers.get("content-length", "0")) > MAX_BYTES:
                raise ImageSearchError("That photo is larger than 15 MB. Choose a smaller photo.")
            raw = bytearray()
            async for chunk in response.aiter_bytes(chunk_size=65536):
                if len(raw) + len(chunk) > MAX_BYTES:
                    raise ImageSearchError("That photo is larger than 15 MB. Choose a smaller photo.")
                raw.extend(chunk)
            if not raw:
                raise ImageSearchError("That photo is empty. Choose another photo.")
            return bytes(raw), ext
    raise ImageSearchError("That photo redirects too many times. Choose another photo.")


async def fetch(image_id, *, transport=None) -> tuple[bytes, str, dict]:
    if not isinstance(image_id, str) or not image_id or len(image_id) > 100:
        raise ImageSearchError("Choose a photo id from image_search.")
    try:
        async with _client(transport) as client:
            detail = await _get(client, BASE + quote(image_id, safe="") + "/")
            item = detail.json()
            if not isinstance(item, dict) or item.get("mature"):
                raise ImageSearchError("Choose a photo without mature content.")
            candidate = _candidate(item)
            try:
                raw, ext = await _download(client, candidate["url"])
            except (httpx.HTTPStatusError, httpx.TransportError):
                # The photo's own host refused or failed: Openverse serves the same photo full size.
                raw, ext = await _download(client, BASE + quote(image_id, safe="") + "/thumb/?full_size=true")
            return raw, ext, candidate
    except ImageSearchError:
        raise
    except (httpx.HTTPError, httpx.InvalidURL, ValueError, KeyError, TypeError) as error:
        raise ImageSearchError("That photo could not be downloaded. Choose another photo or try again.") from error