"""App-wide approval: ask before doing, once or always, and remember.

David's ask 2026-09-18. Until now a tool that was not pre-approved in code
simply hung on a prompt nothing could answer, or failed with a message saying
permission was missing. This is the missing half: a request that reaches the
person, inside whatever feature is asking.

Three rules shape everything here.

Fail closed. An unanswered request denies, and says it timed out rather than
implying the owner refused. Silence, a closed tab, or a surface with nobody
watching are all denials.

A person's "always" grant is scoped to a command prefix, path root or host.
The built-in admin Bash and PowerShell grants are the deliberate exception:
David restored automatic admin shell commands on 2026-09-22. They remain visible
and revocable in Settings.

A grant you cannot find is a trap. Rules are listed and revocable in
Settings, and every decision is written to an audit trail.
"""
import asyncio
import json
import os
import time
import uuid
from dataclasses import dataclass, field

from core.constants import DATA_DIR
from core.atomic_io import write_json_atomic

PERMISSIONS_FILE = os.path.join(DATA_DIR, "permissions.json")
DEFAULT_TIMEOUT_SECONDS = 120
QUESTION_TIMEOUT_SECONDS = 1800
AUDIT_LIMIT = 500

_lock = asyncio.Lock()
_channels: dict[str, asyncio.Queue] = {}
_pending: dict[str, "Request"] = {}
_session_rules: dict[str, list[dict]] = {}


@dataclass
class Request:
    id: str
    surface: str
    tool: str
    target: str | None
    arguments: dict
    title: str
    description: str
    choices: list[dict]
    kind: str = "permission"
    questions: list | None = None
    expires_at: float = field(default_factory=lambda: time.time() + DEFAULT_TIMEOUT_SECONDS)
    answer: asyncio.Future = field(default_factory=asyncio.Future)

    def payload(self) -> dict:
        """What the surface shows. Text only - never markup, never executed."""
        if self.kind == "question":
            return {"id": self.id, "kind": self.kind, "tool": self.tool,
                    "title": "Waiting for your response", "questions": self.questions,
                    "choices": [], "arguments": {}, "expires_at": self.expires_at}
        return {"kind": self.kind, "id": self.id, "tool": self.tool, "target": self.target,
                "title": self.title, "description": self.description,
                "arguments": _clip(self.arguments, 100000 if self.tool == "creative_tools" else 4000), "choices": self.choices,
                "expires_at": self.expires_at}


@dataclass(frozen=True)
class Decision:
    behavior: str            # "allow" or "deny"
    reason: str = ""
    rule: dict | None = None


def _clip(value, limit=4000):
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    return text if len(text) <= limit else text[:limit] + "…"


def _load() -> dict:
    try:
        with open(PERMISSIONS_FILE, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        data = {}
    data.setdefault("rules", [])
    data.setdefault("audit", [])
    data.setdefault("seeded", [])
    return data


def _save(data: dict) -> None:
    data["audit"] = data["audit"][-AUDIT_LIMIT:]
    write_json_atomic(PERMISSIONS_FILE, data)


def _matches(rule: dict, tool: str, target: str | None, is_admin: bool = False) -> bool:
    """A rule with no content covers the whole tool, which is only ever used
    for the tools this app pre-approves for itself, including admin shell.
    A person's prompt-based grant carries content; :* is a prefix."""
    if rule["tool"] != tool:
        return False
    if rule.get("admin_only") and not is_admin:
        return False
    content = rule.get("content")
    if not content:
        return True
    if target is None:
        return False
    if content.endswith(":*"):
        return target.startswith(content[:-2])
    return target == content


def derive_target(tool: str, arguments: dict) -> str | None:
    """The part of a request a grant should be scoped to.

    Deliberately coarse on the left and specific on the right: a shell grant
    covers a command, not the shell; a file grant covers a directory, not the
    disk. When nothing sensible can be derived the request stays unscoped,
    which means it can only ever be allowed once.
    """
    if not isinstance(arguments, dict):
        return None
    for key in ("command", "cmd"):
        value = arguments.get(key)
        if isinstance(value, str) and value.strip():
            return " ".join(value.strip().split()[:2])
    for key in ("path", "file_path", "filename", "doc_id", "slug"):
        value = arguments.get(key)
        if isinstance(value, str) and value.strip():
            cleaned = value.replace("\\", "/").strip("/")
            return cleaned.rsplit("/", 1)[0] or cleaned
    for key in ("url", "base_url", "to"):
        value = arguments.get(key)
        if isinstance(value, str) and value.strip():
            return value.split("/")[2] if "://" in value else value.strip()
    return None


def list_rules() -> list[dict]:
    data = _load()
    session = [rule for rules in _session_rules.values() for rule in rules]
    return data["rules"] + session


def audit() -> list[dict]:
    return _load()["audit"]


def record_tool_use(outcome: str, tool: str, effect: str, arguments: dict, by: str) -> None:
    """A JARVIS tool that changed something, ran code or reached another
    service (core/tool_registry.py), in the same audit as the decisions."""
    data = _load()
    content = (f"{arguments.get('action', '')} {arguments.get('url', '')}".strip()
               if tool == "computer" else derive_target(tool, arguments))
    _record(data, {"decision": outcome, "tool": tool, "effect": effect,
                   "content": content, "by": by})
    _save(data)


def record_event(entry: dict) -> None:
    """Any other decision worth keeping in the same audit trail, such as a
    terminal being paired or revoked (core/cli_access.py)."""
    data = _load()
    _record(data, dict(entry))
    _save(data)


def record_mode_change(session_id: str, mode: str, user: str) -> None:
    data = _load()
    _record(data, {"decision": "chat_mode_changed", "session_id": session_id,
                   "mode": mode, "by": user})
    _save(data)


def revoke(rule_id: str) -> bool:
    data = _load()
    remaining = [rule for rule in data["rules"] if rule["id"] != rule_id]
    removed = len(remaining) != len(data["rules"])
    if removed:
        data["rules"] = remaining
        _record(data, {"decision": "revoked", "rule_id": rule_id})
        _save(data)
        return True
    for surface, rules in _session_rules.items():
        kept = [rule for rule in rules if rule["id"] != rule_id]
        if len(kept) != len(rules):
            _session_rules[surface] = kept
            return True
    return False


ADMIN_SHELL_TOOLS = ("Bash", "PowerShell", "run_shell")


def ensure_seeded(tools: list[str]) -> None:
    """Make the app's own pre-approvals visible.

    These tools were already granted - hardcoded in core/brain.py, invisible
    and unrevocable. Writing them in as rules changes no behaviour and makes
    them inspectable and revocable. Admin shell tools are seeded when the
    admin config includes them; non-admin configs never do. run_shell, the
    local models' admin shell, is seeded the same way (David, 2026-09-24:
    automatic, but visible and revocable, like Claude's Bash).
    """
    data = _load()
    known = set(data["seeded"])
    additions = [tool for tool in tools if tool not in known]
    if not additions:
        return
    now = time.time()
    for tool in additions:
        data["rules"].append({"id": uuid.uuid4().hex, "tool": tool, "content": None,
                              "behavior": "allow", "scope": "forever", "granted_at": now,
                              "granted_by": "jarvis", "source": "built-in",
                              "admin_only": tool in ADMIN_SHELL_TOOLS})
        data["seeded"].append(tool)
    _save(data)


def retire_builtin_grants(tools: set[str]) -> None:
    """Undo an automatic grant withdrawn by a release review (2026-10-15).
    Explicit grants from the person survive; only the old built-in defaults go.
    """
    data = _load()
    kept = [rule for rule in data["rules"]
            if not (rule["tool"] in tools and rule.get("source") == "built-in")]
    if len(kept) != len(data["rules"]):
        data["rules"] = kept
        _save(data)


def standing_grants() -> set[str]:
    """Tools a saved rule allows whole and for good - what core/brain.py may
    still pre-approve. A seeded built-in grant that has been revoked is no
    longer here, so the tool goes back to being asked about."""
    return {rule["tool"] for rule in _load()["rules"]
            if rule.get("behavior") == "allow" and not rule.get("content") and rule.get("scope") == "forever"}


def grant_standing(tools: list[str], granted_by: str) -> None:
    """Grant tools whole and for good, when someone explicitly adds them
    (Settings > Agent Tools' extra allowed list). Seeding happens once per
    tool, so without this a tool revoked earlier could never be re-allowed
    by adding it back."""
    data = _load()
    held = {rule["tool"] for rule in data["rules"]
            if rule.get("behavior") == "allow" and not rule.get("content") and rule.get("scope") == "forever"}
    additions = [tool for tool in tools if tool not in held]
    if not additions:
        return
    now = time.time()
    for tool in additions:
        data["rules"].append({"id": uuid.uuid4().hex, "tool": tool, "content": None,
                              "behavior": "allow", "scope": "forever", "granted_at": now,
                              "granted_by": granted_by, "source": "settings",
                              "admin_only": tool in ADMIN_SHELL_TOOLS})
        if tool not in data["seeded"]:
            data["seeded"].append(tool)
        _record(data, {"decision": "granted", "tool": tool, "by": granted_by})
    _save(data)


def _record(data: dict, entry: dict) -> None:
    data["audit"].append({"at": time.time(), **entry})


def _remember(rule: dict, surface: str) -> None:
    if rule["scope"] == "session":
        _session_rules.setdefault(surface, []).append(rule)
        return
    data = _load()
    data["rules"].append(rule)
    _record(data, {"decision": "granted", "tool": rule["tool"], "content": rule.get("content"),
                   "scope": rule["scope"], "by": rule.get("granted_by")})
    _save(data)


def stored_decision(surface: str, tool: str, target: str | None, is_admin: bool = False) -> Decision | None:
    """An answer that needs no one, or None if this has to be asked."""
    for rule in _session_rules.get(surface, []) + _load()["rules"]:
        if _matches(rule, tool, target, is_admin):
            return Decision(rule["behavior"], "A saved rule covers this.", rule)
    return None


def open_channel(surface: str) -> asyncio.Queue:
    """A surface that can ask. Closing it makes every later request deny."""
    queue: asyncio.Queue = asyncio.Queue()
    _channels[surface] = queue
    return queue


def close_channel(surface: str) -> None:
    _channels.pop(surface, None)
    for request in [item for item in _pending.values() if item.surface == surface]:
        if not request.answer.done():
            request.answer.set_result(QuestionOutcome("skipped", reason="The window asking for this closed.")
                                      if request.kind == "question" else
                                      Decision("deny", "The window asking for this closed."))


def drop_session(surface: str) -> None:
    _session_rules.pop(surface, None)


async def decide(*, surface: str, tool: str, arguments: dict, title: str = "", description: str = "",
                 target: str | None = None, choices: list[dict] | None = None,
                 timeout: float = DEFAULT_TIMEOUT_SECONDS, is_admin: bool = False,
                 force_prompt: bool = False) -> Decision:
    """Answer from a rule, or ask the person and wait."""
    target = target if target is not None else derive_target(tool, arguments)
    # Builder imports/connections and first-run app commands need explicit
    # review when requested, even on an Auto surface.
    #
    # hand_to_agent joined this set on 2026-10-13. core/tool_registry.py has
    # always asked for a forced prompt once a turn has read untrusted content,
    # so that injected text cannot put an agent to work unseen - but without
    # membership here, Auto answered first and the gate never fired. It was
    # inert on exactly the two surfaces it was written for: an admin's Auto
    # chat, and an agent's own surface, which always runs in Auto. A tainted
    # handoff on a surface nobody is watching now falls through to the deny
    # below, which is the honest answer: an agent should not hand work on
    # after reading a web page when there is nobody to ask.
    # 2026-10-16: local preview grants always belong to the person, including Auto.
    # 2026-10-25: so does a folder dropped on the notch (core/notch_folders.py).
    explicit_review = force_prompt and tool in {"save_skill", "add_mcp_server", "forge_app_start", "model_setup_install", "forge_git_push", "forge_git_merge", "hand_to_agent", "coordinate_bots", "post_to_room", "computer_local_app", "creative_tools", "folder_access"}
    # Auto is an explicit, per-chat admin choice. It answers broker requests
    # for this chat only, including requests from a tainted turn; it does not
    # add a standing grant or change the policy for other chats/tasks.
    if is_admin and surface.startswith("chat:") and not explicit_review:
        from core.session_manager import session_manager
        session_id = surface.removeprefix("chat:")
        session = session_manager.get_session(session_id)
        if session and session.get("permission_mode") == "auto":
            data = _load()
            _record(data, {"decision": "allow", "source": "chat_auto", "session_id": session_id,
                           "tool": tool, "content": target})
            _save(data)
            return Decision("allow", "Allowed by this chat's Auto mode.")
    # Agents always run in Auto (David, 2026-10-05), on every model: an
    # agent's own runs are approved like an Auto chat's, tainted turns
    # included, and every one is audited. Only admins can create and direct
    # agents (routes/agent_routes.py).
    if surface.startswith("agent:") and not explicit_review:
        data = _load()
        _record(data, {"decision": "allow", "source": "agent_auto", "surface": surface,
                       "tool": tool, "content": target})
        _save(data)
        return Decision("allow", "Allowed: agents run in Auto mode.")
    # A tainted turn can force a fresh decision without revoking the person's
    # standing grant for future clean turns.
    saved = None if force_prompt else stored_decision(surface, tool, target, is_admin)
    if saved:
        return saved
    queue = _channels.get(surface)
    if queue is None:
        # Nobody is watching this surface - a scheduled task, a chat in a
        # channel with no prompt, a closed window. Denying is the only honest
        # answer, and it says where to grant it instead.
        return Decision("deny", f"{tool} needs permission and this surface cannot ask. "
                                "Grant it in Settings > Permissions, then try again.")
    request = Request(id=uuid.uuid4().hex, surface=surface, tool=tool, target=target,
                      arguments=arguments if isinstance(arguments, dict) else {},
                      title=title or tool, description=description,
                      choices=choices or _default_choices(tool, target), expires_at=time.time() + timeout)
    _pending[request.id] = request
    await queue.put(request.payload())
    try:
        return await asyncio.wait_for(asyncio.shield(request.answer), timeout=timeout)
    except asyncio.TimeoutError:
        return Decision("deny", f"Nobody answered the request to use {tool} within "
                                f"{int(timeout)} seconds, so it was not allowed.")
    finally:
        _pending.pop(request.id, None)
        if _channels.get(surface) is queue:
            queue.put_nowait({"permission_closed": request.id})


def pending_request(request_id: str):
    request = _pending.get(request_id)
    return request if request and not request.answer.done() and request.expires_at > time.time() else None


def pending_for(surface: str) -> list[dict]:
    return [r.payload() for r in _pending.values() if r.surface == surface and pending_request(r.id)]


def _default_choices(tool: str, target: str | None) -> list[dict]:
    """What the person is offered. Always-grants state their own scope in
    words, so nobody clicks "always" without seeing what it covers."""
    choices = [{"id": "once", "label": "Allow once", "behavior": "allow", "scope": "once"}]
    if target:
        choices.append({"id": "session", "label": f"Always in this chat ({target})",
                        "behavior": "allow", "scope": "session"})
        choices.append({"id": "forever", "label": f"Always allow {target}",
                        "behavior": "allow", "scope": "forever"})
    choices.append({"id": "reject", "label": "Reject", "behavior": "deny", "scope": "once"})
    return choices


def answer(request_id: str, choice_id: str, user: str) -> bool:
    """Resolve a pending request. Request ids are server-made, so a model
    cannot answer its own question by guessing one."""
    request = pending_request(request_id)
    if request is None or request.kind == "question":
        return False
    choice = next((item for item in request.choices if item["id"] == choice_id), None)
    if choice is None:
        return False
    rule = None
    if choice["scope"] in ("session", "forever"):
        rule = {"id": uuid.uuid4().hex, "tool": request.tool, "content": request.target,
                "behavior": choice["behavior"], "scope": choice["scope"], "granted_at": time.time(),
                "granted_by": user, "source": "asked"}
        _remember(rule, request.surface)
    data = _load()
    _record(data, {"decision": choice["behavior"], "tool": request.tool, "content": request.target,
                   "scope": choice["scope"], "by": user, "request_id": request_id})
    _save(data)
    reason = ("Allowed by the owner." if choice["behavior"] == "allow"
              else f"{request.tool} was refused by the owner.")
    request.answer.set_result(Decision(choice["behavior"], reason, rule))
    return True


@dataclass(frozen=True)
class QuestionOutcome:
    status: str
    answers: dict | None = None
    reason: str = ""


def normalize_questions(raw) -> list[dict] | None:
    if not isinstance(raw, list) or not 1 <= len(raw) <= 4:
        return None
    result, seen = [], set()
    for item in raw:
        if not isinstance(item, dict):
            return None
        text = item.get("question")
        if not isinstance(text, str) or not text.strip() or len(text.strip()) > 2000:
            return None
        text = text.strip()
        if text in seen:
            return None
        seen.add(text)
        options = item.get("options", [])
        if not isinstance(options, list) or len(options) > 8:
            return None
        normalized, labels = [], set()
        for option in options:
            if not isinstance(option, dict) or not isinstance(option.get("label"), str):
                return None
            label = option["label"].strip()[:200]
            if not label or label in labels:
                return None
            labels.add(label)
            description = option.get("description", "")
            normalized.append({"label": label, "description": description.strip()[:500] if isinstance(description, str) else ""})
        header = item.get("header", "")
        result.append({"question": text, "header": header.strip()[:40] if isinstance(header, str) else "",
                       "multiSelect": item.get("multiSelect") is True, "options": normalized})
    return result


def _open_question(*, surface, tool, questions, timeout):
    queue = _channels.get(surface)
    if queue is None:
        return None, None
    request = Request(id=uuid.uuid4().hex, surface=surface, tool=tool, target=None,
                      arguments={}, title="Waiting for your response", description="", choices=[],
                      kind="question", questions=questions, expires_at=time.time() + timeout)
    _pending[request.id] = request
    queue.put_nowait(request.payload())
    return request, queue


def _close_question(request, queue):
    if request and _pending.pop(request.id, None) is not None:
        if _channels.get(request.surface) is queue:
            queue.put_nowait({"permission_closed": request.id})


async def _wait_question(request, queue, timeout):
    if request is None:
        return QuestionOutcome("unavailable", reason="Nobody is here to answer questions in this run.")
    try:
        return await asyncio.wait_for(asyncio.shield(request.answer), timeout=timeout)
    except asyncio.TimeoutError:
        return QuestionOutcome("timeout", reason="Nobody answered within 30 minutes.")
    finally:
        _close_question(request, queue)


async def ask(*, surface, tool, questions, timeout=QUESTION_TIMEOUT_SECONDS) -> QuestionOutcome:
    request, queue = _open_question(surface=surface, tool=tool, questions=questions, timeout=timeout)
    return await _wait_question(request, queue, timeout)


def ask_later(*, surface, agent_id, raw_questions, tool, timeout=QUESTION_TIMEOUT_SECONDS) -> asyncio.Task:
    """Enqueue before returning, then apply the same policy as ask_person."""
    questions, refusal = _prepare_question(surface, agent_id, raw_questions, tool)
    request, queue = (None, None) if refusal else _open_question(
        surface=surface, tool=tool, questions=questions, timeout=timeout)

    async def wait():
        if refusal:
            return refusal
        return _question_message(await _wait_question(request, queue, timeout), agent_id)

    task = asyncio.create_task(wait())
    # Cancellation before the coroutine starts must close the card too.
    task.add_done_callback(lambda _: _close_question(request, queue))
    return task


def waiting(surface: str) -> bool:
    return any(r.surface == surface and pending_request(r.id) for r in _pending.values())


def respond(request_id, *, answers: dict | None, skip: bool, user: str) -> str | None:
    request = pending_request(request_id)
    if request is None or request.kind != "question":
        return "That question is no longer waiting for an answer."
    cleaned = {}
    if not skip:
        questions = request.questions or []
        if not isinstance(answers, dict) or set(answers) != {q["question"] for q in questions}:
            return "Answer every question, with no extra answers."
        def valid(value):
            return isinstance(value, str) and bool(value.strip()) and len(value.strip()) <= 4000
        for question in questions:
            value = answers[question["question"]]
            if isinstance(value, str) and valid(value):
                cleaned[question["question"]] = value.strip()
            elif (question["multiSelect"] and isinstance(value, list) and
                  1 <= len(value) <= len(question["options"]) + 1 and all(valid(v) for v in value) and
                  len({v.strip() for v in value}) == len(value)):
                cleaned[question["question"]] = [v.strip() for v in value]
            else:
                return "Each question needs a valid, non-empty answer."
    status = "skipped" if skip else "answered"
    data = _load()
    _record(data, {"decision": status, "tool": request.tool, "kind": "question", "by": user, "request_id": request_id})
    _save(data)
    request.answer.set_result(QuestionOutcome(status, answers=None if skip else cleaned))
    return None


def _nobody_message(agent_id):
    return ("Nobody is watching this run live, so a question cannot be answered here. Use agent_ask to put it in the person's inbox, then finish what you can."
            if agent_id else "Nobody is here to answer questions in this run. Continue with your best judgment and say what you assumed.")


def _prepare_question(surface, agent_id, raw_questions, tool):
    questions = normalize_questions(raw_questions)
    if questions is None:
        return None, QuestionOutcome("malformed", reason=f"{tool} needs 1 to 4 questions, each with question text and at most 8 distinct options.")
    if not surface.startswith("chat:"):
        return None, QuestionOutcome("unavailable", reason=_nobody_message(agent_id))
    return questions, None


def _question_message(outcome, agent_id):
    if outcome.status == "answered":
        return outcome
    messages = {
        "skipped": "The person skipped this question without answering. Continue with your best judgment and say what you assumed, or ask again in plain text.",
        "timeout": "Nobody answered within 30 minutes. Continue with your best judgment and say what you assumed.",
    }
    return QuestionOutcome(outcome.status, reason=messages.get(outcome.status, _nobody_message(agent_id)))


async def ask_person(*, surface: str, agent_id: str | None, raw_questions, tool: str) -> QuestionOutcome:
    """Shared question policy for native Claude and registry tools."""
    questions, refusal = _prepare_question(surface, agent_id, raw_questions, tool)
    if refusal:
        return refusal
    return _question_message(await ask(surface=surface, tool=tool, questions=questions), agent_id)
