"""X research tools for bots (Phase 2, unit U5): read-only search and lookup with the person's own X key.

Five tools: search recent posts, count recent posts, look up a profile, read a profile's recent posts and
read one post. Nothing here posts, follows, likes or sends. Requests are built from the table below with
validated arguments; results are cut to bounds (25 posts, 600 characters a post, 12,000 in all), fenced as
untrusted data, and the key never appears in a result or an error. A local limit of 60 calls in 15 minutes
keeps a loop from using up the person's X allowance.
"""
import collections
import json
import re
import time
from typing import Callable, Optional

BASE = "https://api.x.com/2"
MAX_POSTS = 25
POST_CHARS = 600
MAX_RESULT = 12_000
QUERY_CHARS = 512
RATE_CALLS, RATE_SECONDS = 60, 15 * 60.0
TIMEOUT = 20
HANDLE = re.compile(r"@?[A-Za-z0-9_]{1,15}")
POST_ID = re.compile(r"\d{1,25}")
USER_FIELDS = "id,name,username,description,public_metrics,verified,created_at"
POST_FIELDS = "id,text,author_id,created_at,public_metrics,lang"

TOOLS = {
    "x_search_recent": {"effect": "read", "description": "Search posts from the last seven days."},
    "x_count_recent": {"effect": "read", "description": "Count posts about a topic over the last seven days."},
    "x_user": {"effect": "read", "description": "Look up a profile by handle."},
    "x_user_posts": {"effect": "read", "description": "Read a profile's recent posts."},
    "x_post": {"effect": "read", "description": "Read one post by id."},
}


class XError(ValueError):
    pass


class _Limiter:
    def __init__(self, clock: Callable[[], float] = time.monotonic):
        self.clock, self._stamps = clock, collections.deque()

    def take(self) -> bool:
        now = self.clock()
        while self._stamps and now - self._stamps[0] >= RATE_SECONDS:
            self._stamps.popleft()
        if len(self._stamps) >= RATE_CALLS:
            return False
        self._stamps.append(now)
        return True


limiter = _Limiter()


def describe_tools() -> list[dict]:
    return [{"name": n, **t} for n, t in TOOLS.items()]


def _query(value) -> str:
    text = str(value or "").strip()
    if not text or len(text) > QUERY_CHARS or any(ord(c) < 32 for c in text):
        raise XError(f"A search is 1 to {QUERY_CHARS} characters on one line.")
    return text


def _count(value, default: int = 10) -> int:
    try:
        n = int(value if value not in (None, "") else default)
    except (TypeError, ValueError) as error:
        raise XError("max_results is a whole number.") from error
    return max(1, min(n, MAX_POSTS))


def _handle(value) -> str:
    text = str(value or "").strip()
    if not HANDLE.fullmatch(text):
        raise XError("A handle is up to 15 letters, digits or underscores.")
    return text.lstrip("@")


def _request(tool: str, args: dict) -> tuple[str, dict]:
    allowed = {"x_search_recent": {"query", "max_results"}, "x_count_recent": {"query", "granularity"}, "x_user": {"username"},
               "x_user_posts": {"username", "max_results"}, "x_post": {"id"}}
    if tool not in allowed:
        raise XError("That is not an X tool Kairos offers.")
    extra = set(args) - allowed[tool]
    if extra:
        raise XError(f"{tool} does not take: {', '.join(sorted(extra))}.")
    if tool == "x_search_recent":
        return "/tweets/search/recent", {"query": _query(args.get("query")), "max_results": max(10, _count(args.get("max_results"))), "tweet.fields": POST_FIELDS}
    if tool == "x_count_recent":
        granularity = args.get("granularity") or "day"
        if granularity not in ("minute", "hour", "day"):
            raise XError("granularity is minute, hour or day.")
        return "/tweets/counts/recent", {"query": _query(args.get("query")), "granularity": granularity}
    if tool == "x_user":
        return f"/users/by/username/{_handle(args.get('username'))}", {"user.fields": USER_FIELDS}
    if tool == "x_post":
        post = str(args.get("id") or "")
        if not POST_ID.fullmatch(post):
            raise XError("A post id is a number.")
        return f"/tweets/{post}", {"tweet.fields": POST_FIELDS}
    return f"/users/by/username/{_handle(args.get('username'))}", {"user.fields": "id"}  # x_user_posts resolves the id first


def _trim(payload) -> str:
    def cut(node):
        if isinstance(node, dict):
            return {k: (v[:POST_CHARS] if k == "text" and isinstance(v, str) else cut(v)) for k, v in node.items()}
        if isinstance(node, list):
            return [cut(v) for v in node[:MAX_POSTS * 2 if node and isinstance(node[0], dict) and "count" in node[0] else MAX_POSTS]]
        return node
    text = json.dumps(cut(payload), ensure_ascii=False, separators=(",", ":"))
    return text if len(text) <= MAX_RESULT else text[:MAX_RESULT] + f"... [cut at {MAX_RESULT} of {len(text)} characters]"


async def call(tool: str, args: dict, *, allowed_tools: Optional[set] = None, token: Optional[str] = None, client_factory=None,
               limiter_: Optional[_Limiter] = None) -> str:
    from core.untrusted import wrap_untrusted
    if allowed_tools is not None and tool not in allowed_tools:
        return "This bot's tool selection does not include that X tool."
    from services import bot_keys
    token = token or bot_keys.get_key("x")
    if not token:
        return "X research is not connected. Add your X bearer token under Keys."
    try:
        path, params = _request(tool, args or {})
    except XError as error:
        return str(error)
    if not (limiter_ or limiter).take():
        return f"X calls are limited to {RATE_CALLS} every 15 minutes here. Try again later."
    import httpx2
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    try:
        async with (client_factory or (lambda: httpx2.AsyncClient(timeout=TIMEOUT, follow_redirects=False)))() as client:
            response = await client.get(BASE + path, params=params, headers=headers)
            if response.status_code < 300 and tool == "x_user_posts":
                user_id = (response.json().get("data") or {}).get("id")
                if not user_id or not POST_ID.fullmatch(str(user_id)):
                    return "That profile was not found."
                response = await client.get(f"{BASE}/users/{user_id}/tweets", headers=headers, params={
                    "max_results": max(5, _count(args.get("max_results"))), "tweet.fields": POST_FIELDS, "exclude": "retweets,replies"})
        if response.status_code == 429:
            return "X is limiting this key right now. Try again later."
        if response.status_code >= 300:
            return f"X did not complete {tool} ({response.status_code}). Check the bearer token and its access level."
        return wrap_untrusted("posts from X", _trim(response.json()))
    except Exception:
        return "X could not be reached."
