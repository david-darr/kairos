"""HighLevel CRM tools for bots (Phase 2, unit U5): a restricted surface of twenty tools.

Four groups a bot can be given, five tools each: contacts, notes and tasks, calendar, pipelines.
Every request is built from the tool table below, never from model text, and then checked against a
list of forbidden areas as a second lock: nothing here can send a message or email, start a
campaign or workflow, or touch payments, invoices, orders or subscriptions, whatever a model asks.

- Calls are limited to 90 in any 10 seconds (a sliding window); the 91st waits for the caller to retry.
- Every write adds an activity row (`activity()`), with the tool, the bot and a short summary of ids.
- The private token (`pit-...`) and location id come from the saved keys (services/bot_keys.py) and
  never appear in a result or an error.
- Results are cut to 8,000 characters and fenced as untrusted data.
"""
import collections
import json
import os
import re
import time
from typing import Any, Callable, Optional

BASE = "https://services.leadconnectorhq.com"
VERSION = "2021-07-28"
RATE_CALLS, RATE_SECONDS = 90, 10.0
MAX_RESULT = 8_000
TIMEOUT = 20

FORBIDDEN = re.compile(r"(?i)/(conversations/messages|messages|campaigns?|workflows?|payments?|invoices?|orders?|transactions?|"
                       r"subscriptions?|emails?|sms|funnels?|forms/submissions|snapshots|saas|stripe|coupons?|products?/purchase)(/|\?|$)")

GROUPS = {"contacts": "Contacts", "notes": "Notes and tasks", "calendar": "Calendar", "pipelines": "Pipelines"}

# name -> (group, effect, method, path template, query/body fields). {id} and {contact_id} come from arguments.
TOOLS: dict[str, dict] = {
    "highlevel_search_contacts": {"group": "contacts", "effect": "read", "method": "GET", "path": "/contacts/", "query": ["query", "limit"], "location": "locationId"},
    "highlevel_get_contact": {"group": "contacts", "effect": "read", "method": "GET", "path": "/contacts/{contact_id}"},
    "highlevel_create_contact": {"group": "contacts", "effect": "write", "method": "POST", "path": "/contacts/", "body": ["firstName", "lastName", "email", "phone", "tags"], "location": "locationId"},
    "highlevel_update_contact": {"group": "contacts", "effect": "write", "method": "PUT", "path": "/contacts/{contact_id}", "body": ["firstName", "lastName", "email", "phone"]},
    "highlevel_add_contact_tags": {"group": "contacts", "effect": "write", "method": "POST", "path": "/contacts/{contact_id}/tags", "body": ["tags"]},
    "highlevel_get_contact_notes": {"group": "notes", "effect": "read", "method": "GET", "path": "/contacts/{contact_id}/notes"},
    "highlevel_add_contact_note": {"group": "notes", "effect": "write", "method": "POST", "path": "/contacts/{contact_id}/notes", "body": ["body"]},
    "highlevel_list_contact_tasks": {"group": "notes", "effect": "read", "method": "GET", "path": "/contacts/{contact_id}/tasks"},
    "highlevel_create_contact_task": {"group": "notes", "effect": "write", "method": "POST", "path": "/contacts/{contact_id}/tasks", "body": ["title", "body", "dueDate", "completed"]},
    "highlevel_complete_contact_task": {"group": "notes", "effect": "write", "method": "PUT", "path": "/contacts/{contact_id}/tasks/{task_id}/completed", "body": ["completed"]},
    "highlevel_list_calendars": {"group": "calendar", "effect": "read", "method": "GET", "path": "/calendars/", "query": [], "location": "locationId"},
    "highlevel_get_free_slots": {"group": "calendar", "effect": "read", "method": "GET", "path": "/calendars/{calendar_id}/free-slots", "query": ["startDate", "endDate", "timezone"]},
    "highlevel_get_contact_appointments": {"group": "calendar", "effect": "read", "method": "GET", "path": "/contacts/{contact_id}/appointments"},
    "highlevel_book_appointment": {"group": "calendar", "effect": "write", "method": "POST", "path": "/calendars/events/appointments", "body": ["calendarId", "contactId", "startTime", "endTime", "title"], "location": "locationId"},
    "highlevel_update_appointment": {"group": "calendar", "effect": "write", "method": "PUT", "path": "/calendars/events/appointments/{event_id}", "body": ["startTime", "endTime", "title", "appointmentStatus"]},
    "highlevel_list_pipelines": {"group": "pipelines", "effect": "read", "method": "GET", "path": "/opportunities/pipelines", "query": [], "location": "locationId"},
    "highlevel_search_opportunities": {"group": "pipelines", "effect": "read", "method": "GET", "path": "/opportunities/search", "query": ["q", "pipeline_id", "status", "limit"], "location": "location_id"},
    "highlevel_get_opportunity": {"group": "pipelines", "effect": "read", "method": "GET", "path": "/opportunities/{opportunity_id}"},
    "highlevel_create_opportunity": {"group": "pipelines", "effect": "write", "method": "POST", "path": "/opportunities/", "body": ["pipelineId", "pipelineStageId", "contactId", "name", "status", "monetaryValue"], "location": "locationId"},
    "highlevel_update_opportunity": {"group": "pipelines", "effect": "write", "method": "PUT", "path": "/opportunities/{opportunity_id}", "body": ["name", "pipelineStageId", "status", "monetaryValue"]},
}
assert len(TOOLS) == 20 and all(sum(1 for t in TOOLS.values() if t["group"] == g) == 5 for g in GROUPS)
ID_FIELDS = ("contact_id", "task_id", "calendar_id", "event_id", "opportunity_id")
ID = re.compile(r"[A-Za-z0-9_-]{1,64}")


class HighLevelError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class RateLimited(HighLevelError):
    def __init__(self, retry_after: float):
        super().__init__(f"HighLevel calls are limited to {RATE_CALLS} every {int(RATE_SECONDS)} seconds. Try again in {max(1, round(retry_after))} seconds.", 429)
        self.retry_after = retry_after


class Limiter:
    def __init__(self, calls: int = RATE_CALLS, seconds: float = RATE_SECONDS, clock: Callable[[], float] = time.monotonic):
        self.calls, self.seconds, self.clock, self._stamps = calls, seconds, clock, collections.deque()

    def take(self) -> None:
        now = self.clock()
        while self._stamps and now - self._stamps[0] >= self.seconds:
            self._stamps.popleft()
        if len(self._stamps) >= self.calls:
            raise RateLimited(self.seconds - (now - self._stamps[0]))
        self._stamps.append(now)


limiter = Limiter()


def describe_tools() -> list[dict]:
    """The tool list for the grant catalogue: name, group and effect."""
    return [{"name": n, "group": t["group"], "group_label": GROUPS[t["group"]], "effect": t["effect"]} for n, t in TOOLS.items()]


def guard_path(path: str) -> str:
    if FORBIDDEN.search(path if path.endswith("/") else path + "/"):
        raise HighLevelError("That part of HighLevel is off limits to bots: no messages, campaigns, workflows or payments.", 403)
    return path


def _activity_path() -> str:
    from core import accounts
    return accounts.path("bot-activity", "highlevel.jsonl")


def record_activity(bot_id: str, tool: str, summary: str, ok: bool) -> None:
    os.makedirs(os.path.dirname(_activity_path()), exist_ok=True)
    row = {"time": time.time(), "bot_id": bot_id, "tool": tool, "summary": summary[:300], "ok": ok}
    with open(_activity_path(), "a", encoding="utf-8") as f:
        f.write(json.dumps(row) + "\n")


def activity(limit: int = 50) -> list[dict]:
    try:
        with open(_activity_path(), encoding="utf-8") as f:
            rows = [json.loads(line) for line in f.readlines()[-max(1, min(limit, 500)):]]
    except (OSError, ValueError):
        return []
    return list(reversed(rows))


def _value(name: str, value):
    if isinstance(value, bool) or isinstance(value, (int, float)):
        return value
    if isinstance(value, str) and len(value) <= 2000:
        return value
    if isinstance(value, list) and len(value) <= 20 and all(isinstance(v, str) and len(v) <= 100 for v in value):
        return value
    raise HighLevelError(f"{name} is not a usable value.")


def _build(tool: str, args: dict, location: str) -> dict:
    spec = TOOLS.get(tool)
    if spec is None:
        raise HighLevelError("That is not a HighLevel tool Kairos offers.", 404)
    unknown = set(args) - set(spec.get("query", [])) - set(spec.get("body", [])) - set(ID_FIELDS)
    if unknown:
        raise HighLevelError(f"{tool} does not take: {', '.join(sorted(unknown))}.")
    path = spec["path"]
    for field in re.findall(r"\{(\w+)\}", path):
        value = str(args.get(field, ""))
        if not ID.fullmatch(value):
            raise HighLevelError(f"{tool} needs a valid {field}.")
        path = path.replace("{" + field + "}", value)
    query = {k: _value(k, args[k]) for k in spec.get("query", []) if args.get(k) not in (None, "")}
    body = {k: _value(k, args[k]) for k in spec.get("body", []) if k in args}
    if spec.get("location"):
        (body if spec["method"] in ("POST", "PUT") else query)[spec["location"]] = location
    if "limit" in query:
        query["limit"] = max(1, min(int(query["limit"]), 50))
    return {"method": spec["method"], "path": guard_path(path), "query": query, "body": body or None, "effect": spec["effect"]}


def _shorten(data: Any) -> str:
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return text if len(text) <= MAX_RESULT else text[:MAX_RESULT] + f"... [cut at {MAX_RESULT} of {len(text)} characters]"


async def call(tool: str, args: dict, *, bot_id: str, allowed_tools: Optional[set] = None, token: Optional[str] = None,
               location: Optional[str] = None, client_factory=None, limiter_: Optional[Limiter] = None) -> str:
    """Run one HighLevel tool for a bot. The answer is fenced text; a refusal or failure is a plain sentence."""
    from core.untrusted import wrap_untrusted
    if allowed_tools is not None and tool not in allowed_tools:
        return "This bot's tool selection does not include that HighLevel tool."
    from services import bot_keys
    token, location = token or bot_keys.get_key("highlevel"), location or bot_keys.get_key("highlevel-location")
    if not token or not location:
        return "HighLevel is not connected. Add the private token and location id under Keys."
    try:
        request = _build(tool, args or {}, location)
        (limiter_ or limiter).take()
    except RateLimited as error:
        return str(error)
    except HighLevelError as error:
        return str(error)
    import httpx2
    try:
        async with (client_factory or (lambda: httpx2.AsyncClient(timeout=TIMEOUT, follow_redirects=False)))() as client:
            response = await client.request(request["method"], BASE + request["path"], params=request["query"] or None, json=request["body"],
                                            headers={"Authorization": f"Bearer {token}", "Version": VERSION, "Accept": "application/json"})
        ok = response.status_code < 300
        data = response.json() if ok else {"status": response.status_code}
    except Exception:
        ok, data = False, {"status": "unreachable"}
    if request["effect"] == "write":
        record_activity(bot_id, tool, " ".join(f"{k}={v}" for k, v in (args or {}).items() if k in ID_FIELDS) or tool, ok)
    if not ok:
        return f"HighLevel did not complete {tool} ({data.get('status')}). Check the token and its access."
    return wrap_untrusted("HighLevel data", _shorten(data))
