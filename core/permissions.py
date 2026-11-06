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

from core import accounts
from core.atomic_io import write_json_atomic

PERMISSIONS_FILE = None  # tests may point this at their own file; else the current account's permissions.json
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
    # Set for a bot's request (core/bot_policy.py): bot_id, thread_id, run_id, owner, command, cwd, provider.
    bot: dict | None = None

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
    # Set when this allow took a unit of a bot's daily send allowance: settle it with finish_bot_call().
    invocation_id: str | None = None
    owner: str | None = None


def _clip(value, limit=4000):
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    return text if len(text) <= limit else text[:limit] + "…"


def permissions_file() -> str:
    return PERMISSIONS_FILE or accounts.path("permissions.json")


def _load() -> dict:
    try:
        with open(permissions_file(), encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        data = {}
    data.setdefault("rules", [])
    data.setdefault("audit", [])
    data.setdefault("seeded", [])
    return data


def _save(data: dict) -> None:
    data["audit"] = data["audit"][-AUDIT_LIMIT:]
    write_json_atomic(permissions_file(), data)


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


def stored_decision(surface: str, tool: str, target: str | None, is_admin: bool = False,
                    bot_id: str | None = None) -> Decision | None:
    """An answer that needs no one, or None if this has to be asked. For a bot, only rules made by
    answering that bot's own requests count: the app's built-in grants, and another bot's, never
    stand in for the approval level."""
    saved = _load()["rules"]
    if bot_id:
        saved = [rule for rule in saved if rule.get("bot_id") == bot_id]
    for rule in _session_rules.get(surface, []) + saved:
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
            _card_settle(request.id, "unavailable", "The window asking for this closed, so the action did not run.")
            request.answer.set_result(QuestionOutcome("skipped", reason="The window asking for this closed.")
                                      if request.kind == "question" else
                                      Decision("deny", "The window asking for this closed."))


def drop_session(surface: str) -> None:
    _session_rules.pop(surface, None)


# -- the bot grant ceiling (Bots Phase 2 U4) --------------------------------------------------------
# Kept apart from decide() so the approval work that follows can extend decide() without touching it.

def _surface_bot(surface: str) -> str | None:
    """The bot behind a surface: an agent's own, or the bot a chat belongs to."""
    if surface.startswith("agent:"):
        return surface.removeprefix("agent:") or None
    if surface.startswith("chat:"):
        from core.session_manager import session_manager
        return ((session_manager.get_session(surface.removeprefix("chat:")) or {}).get("agent_id")) or None
    return None


def ceiling_denial(surface: str, tool: str, arguments: dict, agent_id: str | None = None,
                   mcp: tuple | None = None, is_admin: bool = False) -> "Decision | None":
    """A deny when the bot's grants forbid this call, however the approval level would answer."""
    bot = agent_id or _surface_bot(surface)
    if not bot:
        return None
    from services import bot_grants
    # Execution rights (admin-only tools) are judged at each call site from the trusted context; the
    # `is_admin` argument here is whatever the asking code passed, so it is not used to narrow the ceiling.
    reason = bot_grants.ceiling_denial(bot, tool, arguments, is_admin=True, mcp=mcp)
    if reason is None:
        return None
    try:
        data = _load()
        _record(data, {"decision": "deny", "source": "grant_ceiling", "surface": surface, "tool": tool})
        _save(data)
    except Exception:
        pass
    return Decision("deny", reason)


EXPLICIT_REVIEW_TOOLS = frozenset({"save_skill", "add_mcp_server", "forge_app_start", "model_setup_install",
                                   "forge_git_push", "forge_git_merge", "hand_to_agent", "coordinate_bots",
                                   "post_to_room", "computer_local_app", "creative_tools", "folder_access"})


def _bot_log(outcome, decision: str, source: str, actor: str, scope: str | None = None,
             target: str | None = None) -> None:
    from core import bot_policy
    bot_policy.record_decision(bot_id=outcome.bot_id, thread_id=outcome.thread_id,
                               tool=outcome.op.tool if outcome.op else "", op=outcome.op, mode=outcome.mode,
                               outcome=decision, source=source, actor=actor, owner=outcome.owner,
                               unattended=outcome.unattended, invocation_id=outcome.invocation_id, scope=scope,
                               target=target, reason=outcome.reason)


def _card_open(request: "Request", outcome) -> None:
    """The durable card for a bot's live request (services/bot_cards.py), when that service is there."""
    from core import bot_policy
    store = bot_policy.cards()
    if store is None:
        return
    try:
        run = outcome.run or {}
        store.open_from_payload(request.payload(), owner=outcome.owner, bot_id=outcome.bot_id,
                                thread_id=outcome.thread_id, run_id=run.get("run_id"),
                                generation=bot_policy.generation(outcome.thread_id))
    except Exception:
        import logging
        logging.getLogger(__name__).exception("could not open the approval card")


def _card_settle(request_id: str, status: str, reason: str = "") -> None:
    try:
        from core import bot_policy
        store = bot_policy.cards()
        if store is not None:
            store.settle_for_request(request_id, status, reason=reason)
    except Exception:
        import logging
        logging.getLogger(__name__).exception("could not settle the approval card")


def _bot_choices(outcome, target: str | None) -> list[dict]:
    """What a person is offered for a bot's request. A send or a deletion is only ever allowed once; a
    command can be remembered, but only as that exact command in that folder."""
    from core import bot_policy
    once = {"id": "once", "label": "Allow once", "behavior": "allow", "scope": "once"}
    reject = {"id": "reject", "label": "Deny", "behavior": "deny", "scope": "once"}
    op = outcome.op
    if op is not None and op.kind in (bot_policy.OUTBOUND, bot_policy.DESTRUCTIVE, bot_policy.OPAQUE):
        return [once, reject]
    if op is not None and op.kind == bot_policy.EXECUTE and op.scope == "shell" and op.command and outcome.cwd:
        return [once, {"id": "command", "label": "Always allow this exact command here", "behavior": "allow",
                       "scope": "command"}, reject]
    return [dict(item, label="Deny") if item["id"] == "reject" else item for item in _default_choices("", target)]


def cancel_pending(match, reason: str) -> int:
    """Deny every waiting request whose metadata `match` accepts (a downgrade, a run that ended) and
    settle its card. Returns how many it closed."""
    closed = 0
    for request in list(_pending.values()):
        meta = {"surface": request.surface, **(request.bot or {})}
        if request.answer.done() or not match(meta):
            continue
        _card_settle(request.id, "cancelled", reason)
        request.answer.set_result(QuestionOutcome("skipped", reason=reason) if request.kind == "question"
                                  else Decision("deny", reason))
        closed += 1
    return closed


async def decide(*, surface: str, tool: str, arguments: dict, title: str = "", description: str = "",
                 target: str | None = None, choices: list[dict] | None = None,
                 timeout: float = DEFAULT_TIMEOUT_SECONDS, is_admin: bool = False,
                 force_prompt: bool = False, agent_id: str | None = None,
                 mcp: tuple | None = None, bot_context: dict | None = None) -> Decision:
    """Answer from a rule, or ask the person and wait. A bot's grant ceiling is judged first (Auto and
    Full cannot lift it); then its approval level (core/bot_policy.py), which can only narrow what the
    ceiling allows. `bot_context` is trusted caller state: provider, invocation_id, cwd, outer."""
    denied = ceiling_denial(surface, tool, arguments, agent_id, mcp, is_admin)
    if denied is not None:
        return denied
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
    explicit_review = force_prompt and tool in EXPLICIT_REVIEW_TOOLS
    bot_id = agent_id or _surface_bot(surface)
    outcome = None
    if bot_id:
        # A bot's own approval level answers here. Bot chats no longer ride the chat's legacy Auto
        # switch, and an agent's own surface is no longer Auto by definition (Bots Phase 3).
        from core import bot_policy
        context = bot_context or {}
        outcome = bot_policy.authorize_operation(
            bot_id=bot_id, tool=tool, arguments=arguments, mcp=mcp, surface=surface, provider=context.get("provider"),
            force_prompt=force_prompt, explicit_review=explicit_review, invocation_id=context.get("invocation_id"),
            outer=bool(context.get("outer")), cwd=context.get("cwd"), is_admin=is_admin)
        if outcome.action == "deny":
            _bot_log(outcome, "deny", outcome.source, "policy", target=target)
            return Decision("deny", outcome.reason)
        if outcome.action == "allow":
            _bot_log(outcome, "allow", outcome.source, "policy", target=target)
            reserved = bool(outcome.reservation and not outcome.reservation.get("reused"))
            return Decision("allow", outcome.reason, outcome.rule, outcome.invocation_id if reserved else None,
                            outcome.owner if reserved else None)
    # Auto is an explicit, per-chat admin choice. It answers broker requests
    # for this chat only, including requests from a tainted turn; it does not
    # add a standing grant or change the policy for other chats/tasks.
    elif is_admin and surface.startswith("chat:") and not explicit_review:
        from core.session_manager import session_manager
        session_id = surface.removeprefix("chat:")
        session = session_manager.get_session(session_id)
        if session and session.get("permission_mode") == "auto":
            data = _load()
            _record(data, {"decision": "allow", "source": "chat_auto", "session_id": session_id,
                           "tool": tool, "content": target})
            _save(data)
            return Decision("allow", "Allowed by this chat's Auto mode.")
    # A tainted turn can force a fresh decision without revoking the person's
    # standing grant for future clean turns.
    saved = None if force_prompt else stored_decision(surface, tool, target, is_admin, bot_id)
    if saved:
        if outcome is not None:
            _bot_log(outcome, saved.behavior, "saved-rule", "rule", target=target)
        return saved
    queue = _channels.get(surface)
    run = outcome.run if outcome is not None else None
    if queue is None and not (run and _card_service_ready()):
        # Nobody is watching this surface - a scheduled task, a chat in a
        # channel with no prompt, a closed window. Denying is the only honest
        # answer, and it says where to grant it instead.
        if outcome is not None:
            _bot_log(outcome, "deny", "nobody-to-ask", "policy", target=target)
        return Decision("deny", f"{tool} needs permission and this surface cannot ask. "
                                "Grant it in Settings > Permissions, then try again.")
    if outcome is not None and run and queue is None:
        timeout = max(timeout, _unattended_wait())
    request = Request(id=uuid.uuid4().hex, surface=surface, tool=tool, target=target,
                      arguments=arguments if isinstance(arguments, dict) else {},
                      title=title or tool, description=description or (outcome.reason if outcome else ""),
                      choices=choices or (_bot_choices(outcome, target) if outcome is not None
                                          else _default_choices(tool, target)),
                      expires_at=time.time() + timeout)
    if outcome is not None:
        op = outcome.op
        request.bot = {"bot_id": outcome.bot_id, "thread_id": outcome.thread_id, "owner": outcome.owner,
                       "run_id": (run or {}).get("run_id"), "provider": outcome.provider, "cwd": outcome.cwd,
                       "command": op.command if op else None, "tool_kind": op.kind if op else None}
    _pending[request.id] = request
    if queue is not None:
        await queue.put(request.payload())
    waiting_task = (run or {}).get("routine_id") or (run or {}).get("task_id")
    if outcome is not None:
        _card_open(request, outcome)
        if waiting_task:
            _routine_wait(waiting_task, True, f"Waiting for you: {request.title}")
    ended = "answered"
    try:
        decision = await asyncio.wait_for(asyncio.shield(request.answer), timeout=timeout)
        if outcome is not None and decision.behavior == "allow":
            # Execute only after revalidating live scope: the grants, the run and the bot may have changed.
            again = ceiling_denial(surface, tool, arguments, agent_id, mcp, is_admin)
            if again is not None:
                return again
            from core import bot_policy
            stale = bot_policy.live_denial(outcome.bot_id, outcome.thread_id, outcome)
            if stale:
                return Decision("deny", stale)
            if (bot_context or {}).get("outer"):
                bot_policy.mark_inflight(outcome)
        return decision
    except asyncio.TimeoutError:
        ended = "expired"
        return Decision("deny", f"Nobody answered the request to use {tool} within "
                                f"{int(timeout)} seconds, so it was not allowed.")
    finally:
        _pending.pop(request.id, None)
        if outcome is not None:
            if not request.answer.done():
                _card_settle(request.id, "expired" if ended == "expired" else "cancelled")
            if waiting_task:
                _routine_wait(waiting_task, False)
            answered = request.answer.done() and not request.answer.cancelled()
            result = request.answer.result() if answered else None
            _bot_log(outcome, getattr(result, "behavior", "deny") if answered else "expired",
                     "asked" if answered else "timeout", "owner" if answered else "timeout", target=target,
                     scope=((result.rule or {}).get("scope") if answered and getattr(result, "rule", None) else None))
        if _channels.get(surface) is queue and queue is not None:
            queue.put_nowait({"permission_closed": request.id})


def _card_service_ready() -> bool:
    from core import bot_policy
    return bot_policy.cards() is not None


def _unattended_wait() -> float:
    from core import bot_policy
    return bot_policy.UNATTENDED_WAIT_SECONDS


def _routine_wait(task_id: str, waiting: bool, reason: str = "") -> None:
    try:
        from core import bot_routine_runner
        if waiting:
            bot_routine_runner.mark_waiting(task_id, reason)
        else:
            bot_routine_runner.clear_waiting(task_id)
    except Exception:
        pass


async def gate_bot_call(ctx, name: str, args: dict | None, provider: str | None = None) -> Decision:
    """The pre-execution gate for a bot's registry call (core/tool_registry.py), before its handler runs.
    Reads and ordinary chats pass. Everything else gets the approval level's answer through decide(),
    so there is one gate. A handler's own check inside the call is covered by this approval."""
    if not getattr(ctx, "agent_id", None):
        return Decision("allow", "")
    from core import bot_policy
    arguments = args if isinstance(args, dict) else {}
    if bot_policy.classify(name, arguments).kind == bot_policy.READ:
        return Decision("allow", "")
    return await decide(surface=ctx.permission_surface, tool=name, arguments=arguments,
                        title=f"Let this bot use {name}", description="", is_admin=ctx.is_admin, agent_id=ctx.agent_id,
                        force_prompt=bool(getattr(getattr(ctx, "turn_taint", None), "tainted", False)),
                        bot_context={"outer": True, "invocation_id": getattr(ctx, "invocation_id", None),
                                     "provider": provider})


def finish_bot_call(decision: "Decision | None", bot_id: str | None, result) -> None:
    """A gated call has run: settle the allowance unit it took, if any."""
    if decision is not None and bot_id:
        from core import bot_policy
        bot_policy.clear_inflight(bot_id)       # the call is over: its cover for inner checks ends with it
        if getattr(decision, "invocation_id", None):
            bot_policy.finish(decision.owner, bot_id, decision.invocation_id, result)


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
    bot = request.bot or {}
    if choice["scope"] == "command":
        # Only the exact command, in the folder and on the AI the person was shown.
        from core import bot_policy
        try:
            bot_policy.add_command_rule(bot.get("bot_id"), bot.get("command"), bot.get("cwd"), bot.get("provider"),
                                        by=user, request_id=request_id)
        except bot_policy.PolicyError:
            return False
    elif choice["scope"] in ("session", "forever"):
        rule = {"id": uuid.uuid4().hex, "tool": request.tool, "content": request.target,
                "behavior": choice["behavior"], "scope": choice["scope"], "granted_at": time.time(),
                "granted_by": user, "source": "asked"}
        if bot.get("bot_id"):
            rule["bot_id"] = bot["bot_id"]
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
    _question_card(request)
    return request, queue


def _question_card(request) -> None:
    """A bot's question gets a durable card too, so a reload shows it (services/bot_cards.py)."""
    try:
        bot = _surface_bot(request.surface)
        if not bot:
            return
        from core import bot_policy
        store = bot_policy.cards()
        if store is None:
            return
        session_id = request.surface.removeprefix("chat:") if request.surface.startswith("chat:") else None
        session = bot_policy._session(session_id) or {}
        store.open_from_payload(request.payload(), owner=session.get("owner_user"), bot_id=bot, thread_id=session_id,
                                generation=bot_policy.generation(session_id))
    except Exception:
        import logging
        logging.getLogger(__name__).exception("could not open the question card")


def _close_question(request, queue):
    if request and _pending.pop(request.id, None) is not None:
        done = request.answer.done() and not request.answer.cancelled()
        status = getattr(request.answer.result(), "status", "") if done else ""
        _card_settle(request.id, status if status in ("answered", "skipped") else "cancelled")
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
