"""Bots redesign, Phase 3 unit U5: durable approval and question cards (2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-3-design.md, sections 3, 5.3 and 9.

A card is the person's side of one request a bot made: "may I run this?",
"which of these do you want?", or a typed request such as connecting an app. The
broker (core/permissions.py) still owns the live request and its waiting
future; a card is the durable, redacted record the transcript shows, so a
reload, a restart or a second window shows the same thing and an answer settles
exactly once.

Rules this file keeps:
- Provider request handles live in memory only. After a restart no handle
  exists, so an old permission card settles as unavailable ("the action did not
  run"); it is never answered into a new provider process and never replayed. A
  persistent question may take a later answer as a new turn instead.
- An answer can only pick one of the choices the card displayed, so it cannot
  grant a broader target than the person saw. Remembering ("always") is just one
  of those displayed choices.
- A duplicate or racing answer is refused; an answer the broker will not take
  reopens the card when the request is still live, and settles it unavailable
  when it is not.
- Details are redacted before they are stored. Secret values never reach a
  card: credential cards carry only a reference to where the value is stored.
- The owner always comes from the caller's trusted context, never from card
  fields.
"""
from __future__ import annotations

import copy
import logging
import os
import re
import threading
import time
import uuid
from typing import Callable, Optional

from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR

logger = logging.getLogger(__name__)

CARDS_FILE: Optional[str] = None  # a test can point it at its own file


def cards_file() -> str:
    from core import accounts
    return CARDS_FILE or accounts.path("bot_cards.json")
VERSION = 1

KINDS = ("approval", "question", "connector", "credential", "signin", "computer")
OPEN_STATUSES = ("pending", "settling")
SETTLED_STATUSES = ("allowed", "denied", "answered", "skipped", "expired", "unavailable", "cancelled")
STATUSES = OPEN_STATUSES + SETTLED_STATUSES

APPROVAL_SECONDS = 120
QUESTION_SECONDS = 1800
PERSISTENT_SECONDS = 7 * 24 * 3600
KEEP_SETTLED_SECONDS = 30 * 24 * 3600
MAX_CARDS_PER_OWNER = 500

MAX_QUESTIONS = 6
MAX_OPTIONS = 12
MAX_LABEL = 120
MAX_DESCRIPTION = 400
MAX_CUSTOM_ANSWER = 2000
MAX_QUESTION_TEXT = 2000
MAX_HEADER = 40
MAX_TITLE = 160
MAX_SUMMARY = 400
MAX_DETAIL_LINES = 12
MAX_DETAIL_VALUE = 400

UNAVAILABLE_TEXT = "This request is no longer waiting, so the action did not run."
RESTART_TEXT = "Kairos restarted before this was answered, so the action did not run."


class CardError(Exception):
    """Base class; `status` is the HTTP status a route should use."""
    status = 400

    def __init__(self, message: str, card: dict | None = None):
        super().__init__(message)
        self.card = card


class CardNotFound(CardError):
    status = 404


class CardConflict(CardError):
    status = 409


# -- redaction -------------------------------------------------------------------

_SECRET_KEY = re.compile(r"(secret|token|passw|api[_-]?key|authorization|cookie|credential|signature|private[_-]?key)", re.I)
_PATTERNS = (
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}"), r"\1 [hidden]"),
    (re.compile(r"(?i)((?:api[_-]?key|token|secret|passw(?:or)?d|authorization|signature|sig|x-kairos-secret)\s*[=:]\s*)[^\s&\"',;]+"), r"\1[hidden]"),
    (re.compile(r"\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}"), "[hidden]"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"), "[hidden]"),
    (re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"), "[hidden]"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "[hidden]"),
    (re.compile(r"(?<![A-Za-z0-9/_-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9/_-])"), "[hidden]"),
)


def redact(value, limit: int = MAX_DETAIL_VALUE) -> str:
    """Text safe to store and show: secret-looking values replaced, clipped."""
    text = value if isinstance(value, str) else str(value)
    for pattern, replacement in _PATTERNS:
        text = pattern.sub(replacement, text)
    text = " ".join(text.split()) if "\n" not in text else text.strip()
    return text if len(text) <= limit else text[:limit - 1] + "…"


def redact_details(raw) -> dict:
    """`{summary, lines:[{label,value}], target, tool}` from whatever a request
    carried. Keys that name secrets are hidden outright."""
    if not isinstance(raw, dict):
        return {"summary": redact(raw or "", MAX_SUMMARY), "lines": [], "target": "", "tool": ""}
    lines = []
    source = raw.get("lines")
    if isinstance(source, list):
        for item in source[:MAX_DETAIL_LINES]:
            if isinstance(item, dict):
                label = redact(item.get("label", ""), 60)
                value = "[hidden]" if _SECRET_KEY.search(str(item.get("label", ""))) else redact(item.get("value", ""))
                if label:
                    lines.append({"label": label, "value": value})
    arguments = raw.get("arguments")
    if isinstance(arguments, dict):
        for key, value in list(arguments.items())[:MAX_DETAIL_LINES]:
            if len(lines) >= MAX_DETAIL_LINES:
                break
            shown = "[hidden]" if _SECRET_KEY.search(str(key)) else redact(
                value if isinstance(value, str) else repr(value))
            lines.append({"label": redact(key, 60), "value": shown})
    return {"summary": redact(raw.get("summary", ""), MAX_SUMMARY), "lines": lines,
            "target": redact(raw.get("target") or "", 300), "tool": redact(raw.get("tool") or "", 80)}


# -- questions -------------------------------------------------------------------

_ID = re.compile(r"^[a-z0-9_-]{1,40}$")


def normalize_questions(raw) -> tuple[list[dict] | None, str]:
    """Up to six questions, twelve options each. Each question gets a stable id
    (kept when given, `q1`, `q2` ... otherwise); answers are submitted by it."""
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_QUESTIONS:
        return None, f"Ask 1 to {MAX_QUESTIONS} questions."
    questions, ids, texts = [], set(), set()
    for index, item in enumerate(raw, 1):
        if not isinstance(item, dict):
            return None, "Each question is an object."
        text = item.get("question")
        if not isinstance(text, str) or not text.strip() or len(text.strip()) > MAX_QUESTION_TEXT:
            return None, f"Each question needs text of up to {MAX_QUESTION_TEXT} characters."
        text = text.strip()
        qid = item.get("id") if item.get("id") is not None else f"q{index}"
        if not isinstance(qid, str) or not _ID.match(qid) or qid in ids:
            return None, "Question ids are short, distinct and use letters, digits, - or _."
        if text in texts:
            return None, "Each question needs its own wording."
        ids.add(qid)
        texts.add(text)
        options = item.get("options", [])
        if not isinstance(options, list) or len(options) > MAX_OPTIONS:
            return None, f"A question has at most {MAX_OPTIONS} options."
        cleaned, labels = [], set()
        for option in options:
            if not isinstance(option, dict) or not isinstance(option.get("label"), str):
                return None, "Each option needs a label."
            label = option["label"].strip()
            if not label or len(label) > MAX_LABEL:
                return None, f"Option labels are 1 to {MAX_LABEL} characters."
            if label in labels:
                return None, "Option labels must be distinct."
            labels.add(label)
            description = option.get("description", "")
            if description is None:
                description = ""
            if not isinstance(description, str) or len(description.strip()) > MAX_DESCRIPTION:
                return None, f"Option descriptions are up to {MAX_DESCRIPTION} characters."
            cleaned.append({"label": label, "description": description.strip()})
        header = item.get("header", "") or ""
        multi = item.get("multi_select", item.get("multiSelect")) is True
        custom = item.get("allow_custom", True) is not False
        if not cleaned and not custom:
            return None, "A question with no options must accept a typed answer."
        questions.append({"id": qid, "question": text, "header": str(header).strip()[:MAX_HEADER],
                          "multi_select": multi, "allow_custom": custom, "options": cleaned})
    return questions, ""


def check_answers(questions: list[dict], answers) -> tuple[dict | None, str]:
    """Validate answers keyed by question id (or, for older callers, by the
    question text). Returns answers keyed by id."""
    if not isinstance(answers, dict):
        return None, "Answer every question."
    by_id = {q["id"]: q for q in questions}
    by_text = {q["question"]: q for q in questions}
    keyed: dict[str, object] = {}
    for key, value in answers.items():
        question = by_id.get(key) or by_text.get(key)
        if question is None:
            return None, "That answer does not match any question."
        if question["id"] in keyed:
            return None, "Each question gets one answer."
        keyed[question["id"]] = value
    if set(keyed) != set(by_id):
        return None, "Answer every question."
    clean: dict[str, object] = {}
    for qid, value in keyed.items():
        question = by_id[qid]
        labels = {o["label"] for o in question["options"]}

        def one(item) -> str | None:
            if not isinstance(item, str) or not item.strip() or len(item.strip()) > MAX_CUSTOM_ANSWER:
                return None
            item = item.strip()
            if item not in labels and not question["allow_custom"]:
                return None
            return item
        if isinstance(value, str):
            single = one(value)
            if single is None:
                return None, "Each question needs a valid answer."
            clean[qid] = [single] if question["multi_select"] else single
        elif isinstance(value, list) and question["multi_select"]:
            items = [one(v) for v in value]
            if (not items or any(v is None for v in items) or len(set(items)) != len(items)
                    or len(items) > len(labels) + 1):
                return None, "Each question needs a valid answer."
            clean[qid] = items
        else:
            return None, "Each question needs a valid answer."
    return clean, ""


# -- the store ------------------------------------------------------------------

def _now() -> float:
    return time.time()


def _owner(owner: Optional[str]) -> str:
    from core.auth import SINGLE_USER, owner_or_default
    return owner_or_default(owner) or SINGLE_USER


def _mine(card_owner: str, who: str) -> bool:
    """A card is yours when it names you; a card saved for the single local user (before accounts were turned
    on) is also the only account's."""
    from core.auth import SINGLE_USER, owner_or_default
    return card_owner == who or (card_owner == SINGLE_USER and who == owner_or_default(None))


class CardStore:
    def __init__(self, path: str | None = None) -> None:
        self.path = path or cards_file()
        self._lock = threading.RLock()
        data = read_json(self.path, {})
        self._cards: dict[str, dict] = {c["id"]: c for c in (data.get("cards") or []) if isinstance(c, dict) and "id" in c}
        # In memory only: card id -> the live broker request answering it.
        self._handles: dict[str, str] = {}
        self._generation: dict[str, int] = {}
        self._resume_handlers: dict[str, Callable[[dict, str], dict]] = {}
        with _store_lock:
            self._listeners: list[Callable[[dict], None]] = list(_listeners)  # the host's, on every account's store
        self._reconcile_start()

    # persistence ---------------------------------------------------------------

    def _save(self) -> None:
        cutoff = _now() - KEEP_SETTLED_SECONDS
        for card_id in [i for i, c in self._cards.items()
                        if c["status"] in SETTLED_STATUSES and (c.get("settled_at") or 0) < cutoff]:
            del self._cards[card_id]
        by_owner: dict[str, list[dict]] = {}
        for card in self._cards.values():
            by_owner.setdefault(card["owner_user"], []).append(card)
        for cards in by_owner.values():
            overflow = len(cards) - MAX_CARDS_PER_OWNER
            if overflow > 0:
                for card in sorted((c for c in cards if c["status"] in SETTLED_STATUSES),
                                   key=lambda c: c.get("settled_at") or 0)[:overflow]:
                    self._cards.pop(card["id"], None)
        write_json_atomic(self.path, {"version": VERSION, "cards": list(self._cards.values())})

    def _reconcile_start(self) -> None:
        """A new process has no provider handles. Settle what needed one."""
        changed = False
        with self._lock:
            for card in self._cards.values():
                if card["status"] not in OPEN_STATUSES:
                    continue
                if card.get("persistent") and card["kind"] == "question" and card["status"] == "pending":
                    continue
                self._settle_locked(card, "unavailable", reason=RESTART_TEXT, notify=False)
                changed = True
            if changed:
                self._save()

    # events --------------------------------------------------------------------

    def add_listener(self, listener: Callable[[dict], None]) -> Callable[[], None]:
        """The host publishes card changes through its live feed. The listener
        gets `{type: "bot_card", event: "opened"|"settled"|"updated", card}`."""
        with _store_lock:
            _listeners.append(listener)
            for store_ in _stores.values():
                store_._listeners.append(listener)

        def remove() -> None:
            with _store_lock:
                if listener in _listeners:
                    _listeners.remove(listener)
                for store_ in _stores.values():
                    if listener in store_._listeners:
                        store_._listeners.remove(listener)
        return remove

    def _emit(self, event: str, card: dict) -> None:
        packet = {"type": "bot_card", "event": event, "card": self.public(card)}
        for listener in list(self._listeners):
            try:
                listener(packet)
            except Exception:
                logger.exception("bot card listener failed")

    @staticmethod
    def public(card: dict) -> dict:
        shown = {k: copy.deepcopy(v) for k, v in card.items() if not k.startswith("_")}
        shown["waiting"] = card["status"] in OPEN_STATUSES
        return shown

    # opening -------------------------------------------------------------------

    def open_card(self, *, owner: Optional[str], bot_id: str, thread_id: Optional[str], kind: str, title: str,
                  details=None, choices: list[dict] | None = None, questions: list[dict] | None = None,
                  request_id: str | None = None, run_id: str | None = None, generation: int = 0,
                  expires_at: float | None = None, persistent: bool = False, source_key: str | None = None,
                  resume: dict | None = None) -> dict:
        if kind not in KINDS:
            raise CardError(f"Unknown card type {kind!r}.")
        if not isinstance(bot_id, str) or not bot_id:
            raise CardError("A card belongs to a bot.")
        if kind == "question":
            questions, problem = normalize_questions(questions)
            if problem:
                raise CardError(problem)
        else:
            questions = None
        cleaned_choices = []
        if kind == "approval":
            for choice in choices or []:
                if not isinstance(choice, dict) or not choice.get("id") or choice.get("behavior") not in ("allow", "deny"):
                    raise CardError("Each choice needs an id and allow or deny.")
                cleaned_choices.append({"id": str(choice["id"])[:40], "label": redact(choice.get("label", ""), 200),
                                        "behavior": choice["behavior"], "scope": choice.get("scope") or "once"})
            if not any(c["behavior"] == "allow" for c in cleaned_choices) or not any(c["behavior"] == "deny" for c in cleaned_choices):
                raise CardError("An approval offers a way to allow and a way to deny.")
        owner = _owner(owner)
        with self._lock:
            for card in self._cards.values():
                if card["status"] in OPEN_STATUSES and card["owner_user"] == owner and (
                        (request_id and self._handles.get(card["id"]) == request_id)
                        or (source_key and card.get("source_key") == source_key)):
                    return self.public(card)
            now = _now()
            ttl = PERSISTENT_SECONDS if persistent else (QUESTION_SECONDS if kind == "question" else APPROVAL_SECONDS)
            card = {
                "id": uuid.uuid4().hex[:16], "owner_user": owner, "bot_id": bot_id, "thread_id": thread_id,
                "run_id": run_id, "generation": int(generation or 0), "kind": kind, "status": "pending",
                "revision": 1, "title": redact(title or "Needs you", MAX_TITLE), "details": redact_details(details),
                "choices": cleaned_choices, "questions": questions, "persistent": bool(persistent),
                "source_key": source_key, "resume": copy.deepcopy(resume) if resume else None,
                "created_at": now, "expires_at": float(expires_at) if expires_at else now + ttl,
                "settled_at": None, "outcome": None,
            }
            if request_id:
                # Memory only: a restart drops every handle (see the module docstring).
                self._handles[card["id"]] = request_id
            self._cards[card["id"]] = card
            self._save()
            self._emit("opened", card)
            return self.public(card)

    def open_from_payload(self, payload: dict, *, owner: Optional[str], bot_id: str, thread_id: Optional[str],
                          run_id: str | None = None, generation: int = 0) -> dict:
        """The adapter for a broker request (core/permissions.Request.payload()).
        The host calls it when a bot surface asks, and keeps the card id."""
        if not isinstance(payload, dict) or not payload.get("id"):
            raise CardError("That is not a broker request.")
        expires = payload.get("expires_at")
        if payload.get("kind") == "question":
            raw = [{"question": q.get("question"), "header": q.get("header", ""), "multi_select": q.get("multiSelect") is True,
                    "options": q.get("options") or []} for q in payload.get("questions") or []]
            return self.open_card(owner=owner, bot_id=bot_id, thread_id=thread_id, kind="question",
                                  title=payload.get("title") or "Waiting for your response", questions=raw,
                                  request_id=payload["id"], run_id=run_id, generation=generation, expires_at=expires)
        arguments = payload.get("arguments")
        if isinstance(arguments, str):
            arguments = {"request": arguments}
        details = {"summary": payload.get("description") or "", "target": payload.get("target") or "",
                   "tool": payload.get("tool") or "", "arguments": arguments if isinstance(arguments, dict) else {}}
        return self.open_card(owner=owner, bot_id=bot_id, thread_id=thread_id, kind="approval",
                              title=payload.get("title") or payload.get("tool") or "Needs your OK", details=details,
                              choices=payload.get("choices") or [], request_id=payload["id"], run_id=run_id,
                              generation=generation, expires_at=expires)

    def attach_request(self, card_id: str, request_id: str) -> None:
        with self._lock:
            card = self._cards.get(card_id)
            if card and card["status"] in OPEN_STATUSES:
                self._handles[card_id] = request_id

    def update_details(self, card_id: str, details) -> dict:
        """A changed request: the details change and the revision moves, so an
        answer reviewed against the old details is refused."""
        with self._lock:
            card = self._cards.get(card_id)
            if card is None or card["status"] not in OPEN_STATUSES:
                raise CardNotFound("No open card with that id.")
            card["details"] = redact_details(details)
            card["revision"] += 1
            self._save()
            self._emit("updated", card)
            return self.public(card)

    # reading -------------------------------------------------------------------

    def get(self, card_id: str, owner: Optional[str]) -> dict:
        with self._lock:
            return self.public(self._owned(card_id, owner))

    def _owned(self, card_id: str, owner: Optional[str]) -> dict:
        card = self._cards.get(card_id)
        if card is None or not _mine(card["owner_user"], _owner(owner)):
            raise CardNotFound("No card with that id.")
        self._expire_locked(card)
        return card

    def list_cards(self, owner: Optional[str], *, thread_id: str | None = None, bot_id: str | None = None,
                   status: str | None = None, limit: int = 200) -> list[dict]:
        who = _owner(owner)
        with self._lock:
            found = []
            changed = False
            for card in self._cards.values():
                if not _mine(card["owner_user"], who):
                    continue
                if thread_id is not None and card["thread_id"] != thread_id:
                    continue
                if bot_id is not None and card["bot_id"] != bot_id:
                    continue
                if self._expire_locked(card):
                    changed = True
                if status == "pending" and card["status"] not in OPEN_STATUSES:
                    continue
                if status and status != "pending" and card["status"] != status:
                    continue
                found.append(card)
            if changed:
                self._save()
            found.sort(key=lambda c: c["created_at"])
            return [self.public(c) for c in found[-max(1, min(limit, 500)):]]

    # settling ------------------------------------------------------------------

    def _expire_locked(self, card: dict) -> bool:
        if card["status"] == "pending" and card["expires_at"] <= _now():
            self._settle_locked(card, "expired", reason="Nobody answered in time, so the action did not run."
                                if card["kind"] == "approval" else "Nobody answered in time.")
            self._save()
            return True
        return False

    def _settle_locked(self, card: dict, status: str, *, reason: str = "", outcome: dict | None = None,
                       notify: bool = True, close_broker: bool = False) -> None:
        card["status"] = status
        card["settled_at"] = _now()
        card["outcome"] = {"reason": reason, **(outcome or {})}
        request_id = self._handles.pop(card["id"], None)
        if close_broker and request_id:
            self._close_broker(request_id, card)
        if notify:
            self._emit("settled", card)
            self._audit(card)

    @staticmethod
    def _close_broker(request_id: str, card: dict) -> None:
        """A card that can no longer be answered must not leave its request live:
        deny it, so the action cannot run after the card says it did not."""
        from core import permissions
        try:
            if card["kind"] == "approval":
                deny = next((c for c in card["choices"] if c["behavior"] == "deny"), None)
                if deny:
                    permissions.answer(request_id, deny["id"], "system")
            elif card["kind"] == "question":
                permissions.respond(request_id, answers=None, skip=True, user="system")
        except Exception:
            logger.exception("could not close the broker request")

    @staticmethod
    def _audit(card: dict) -> None:
        try:
            from core import permissions
            permissions.record_event({"decision": f"card_{card['status']}", "source": "bot_card", "card_id": card["id"],
                                      "bot_id": card["bot_id"], "tool": card["details"].get("tool") or card["kind"],
                                      "scope": (card.get("outcome") or {}).get("scope"),
                                      "by": (card.get("outcome") or {}).get("by") or "system"})
        except Exception:
            logger.exception("bot card audit failed")

    def settle(self, card_id: str, status: str, *, reason: str = "", outcome: dict | None = None) -> dict | None:
        """Settle an open card by id (typed resume handlers, host cleanup)."""
        if status not in SETTLED_STATUSES:
            raise CardError("Unknown outcome.")
        with self._lock:
            card = self._cards.get(card_id)
            if card is None or card["status"] not in OPEN_STATUSES:
                return None
            self._settle_locked(card, status, reason=reason, outcome=outcome)
            self._save()
            return self.public(card)

    def settle_for_request(self, request_id: str, status: str = "unavailable", *, reason: str = "") -> dict | None:
        """The broker closed this request (timeout, window closed, answered
        somewhere else): settle its card the same way."""
        with self._lock:
            for card in self._cards.values():
                if card["status"] in OPEN_STATUSES and self._handles.get(card["id"]) == request_id:
                    default = {"expired": "Nobody answered in time, so the action did not run.",
                               "allowed": "Answered in another window.", "denied": "Answered in another window."}
                    self._settle_locked(card, status, reason=reason or default.get(status, UNAVAILABLE_TEXT))
                    self._save()
                    return self.public(card)
        return None

    def set_generation(self, thread_id: str, generation: int) -> list[dict]:
        """The thread's live turn generation moved: cards from an older one can
        no longer be answered into the provider. Returns the cards it settled."""
        settled = []
        with self._lock:
            self._generation[thread_id] = max(generation, self._generation.get(thread_id, 0))
            for card in self._cards.values():
                if (card["thread_id"] == thread_id and card["status"] in OPEN_STATUSES and not card.get("persistent")
                        and card["generation"] < self._generation[thread_id]):
                    self._settle_locked(card, "unavailable", reason=UNAVAILABLE_TEXT, close_broker=True)
                    settled.append(self.public(card))
            if settled:
                self._save()
        return settled

    def close_thread(self, thread_id: str, *, reason: str = "The turn ended, so the action did not run.",
                     kinds: tuple = ("approval",)) -> list[dict]:
        """Execution permissions expire when a turn is stopped or ends, or a
        downgrade closes execution cards."""
        settled = []
        with self._lock:
            for card in self._cards.values():
                if card["thread_id"] == thread_id and card["status"] in OPEN_STATUSES and card["kind"] in kinds:
                    self._settle_locked(card, "cancelled", reason=reason, close_broker=True)
                    settled.append(self.public(card))
            if settled:
                self._save()
        return settled

    # answering -----------------------------------------------------------------

    def respond(self, card_id: str, owner: Optional[str], *, action: str, choice_id: str | None = None,
                remember: str | None = None, answers=None, reviewed_revision: int | None = None) -> dict:
        """Answer a card. Returns `{ok, card, message, resume?}`.

        Raises CardNotFound (not yours), CardConflict (already settled, being
        answered, or the details changed) or CardError (a bad answer)."""
        from core import permissions
        who = _owner(owner)
        with self._lock:
            card = self._owned(card_id, who)
            if card["status"] == "settling":
                raise CardConflict("Another answer is already being delivered.", self.public(card))
            if card["status"] != "pending":
                raise CardConflict("This was already settled.", self.public(card))
            if reviewed_revision is not None and reviewed_revision != card["revision"]:
                raise CardConflict("The details changed. Review them again.", self.public(card))
            if card["generation"] < self._generation.get(card["thread_id"] or "", 0) and not card.get("persistent"):
                self._settle_locked(card, "unavailable", reason=UNAVAILABLE_TEXT, close_broker=True)
                self._save()
                return {"ok": False, "card": self.public(card), "message": UNAVAILABLE_TEXT}
            plan = self._plan(card, action, choice_id, remember, answers)
            request_id = self._handles.get(card_id)
            live = bool(request_id and permissions.pending_request(request_id))
            if not live and not (card["kind"] == "question" and card.get("persistent")):
                self._settle_locked(card, "unavailable", reason=UNAVAILABLE_TEXT)
                self._save()
                return {"ok": False, "card": self.public(card), "message": UNAVAILABLE_TEXT}
            card["status"] = "settling"
            self._save()
        delivered, problem = False, ""
        try:
            if not live:
                delivered = True  # a persistent question answered later becomes a new turn
            elif card["kind"] == "question":
                broker_answers = None
                if plan["status"] == "answered":
                    texts = {q["id"]: q["question"] for q in card["questions"]}
                    broker_answers = {texts[qid]: value for qid, value in plan["answers"].items()}
                    # The broker takes a single string for a single-choice question.
                    for q in card["questions"]:
                        value = broker_answers[q["question"]]
                        if not q["multi_select"] and isinstance(value, list):
                            broker_answers[q["question"]] = value[0]
                problem = permissions.respond(request_id, answers=broker_answers, skip=plan["status"] == "skipped",
                                              user=who) or ""
                delivered = not problem
            else:
                delivered = bool(permissions.answer(request_id, plan["choice"]["id"], who))
                if not delivered:
                    problem = "The answer could not be delivered."
        except Exception as error:  # the broker misbehaved: reopen so it can be tried again
            logger.exception("bot card answer failed")
            delivered, problem = False, f"The answer could not be delivered: {error}"
        with self._lock:
            card = self._cards[card_id]
            if delivered:
                outcome = {"by": who}
                if plan["status"] in ("allowed", "denied"):
                    outcome.update(choice_id=plan["choice"]["id"], label=plan["choice"]["label"],
                                   scope=plan["choice"]["scope"])
                if plan["status"] == "answered":
                    outcome["answers"] = {qid: ([redact(v, MAX_CUSTOM_ANSWER) for v in value] if isinstance(value, list)
                                                 else redact(value, MAX_CUSTOM_ANSWER))
                                          for qid, value in plan["answers"].items()}
                reply = {"ok": True, "request_id": request_id}
                if not live and plan["status"] == "answered":
                    outcome["as_new_turn"] = True
                    reply["resume"] = {"as_new_turn": True, "card_id": card_id, "bot_id": card["bot_id"],
                                       "thread_id": card["thread_id"], "answers": outcome["answers"],
                                       "text": self.answer_text(card, plan["answers"])}
                self._settle_locked(card, plan["status"], outcome=outcome)
                self._save()
                reply.update(card=self.public(card), message="")
                return reply
            gone = not (request_id and permissions.pending_request(request_id))
            if gone:
                self._settle_locked(card, "unavailable", reason=UNAVAILABLE_TEXT)
                self._save()
                return {"ok": False, "card": self.public(card), "message": UNAVAILABLE_TEXT}
            card["status"] = "pending"  # reopen: the person can fix the answer or try again
            self._save()
            raise CardError(problem or "The answer could not be delivered.", self.public(card))

    def _plan(self, card: dict, action: str, choice_id, remember, answers) -> dict:
        if card["kind"] == "approval":
            if action not in ("allow", "deny"):
                raise CardError("Choose Allow or Deny.")
            if choice_id:
                choice = next((c for c in card["choices"] if c["id"] == choice_id), None)
                if choice is None or (choice["behavior"] == "allow") != (action == "allow"):
                    raise CardError("That choice was not offered.")
            elif action == "deny":
                choice = next(c for c in card["choices"] if c["behavior"] == "deny")
            else:
                scope = {"once": "once", "session": "session", "always": "forever", None: "once"}.get(remember)
                if scope is None:
                    raise CardError("Remember is once, session or always.")
                choice = next((c for c in card["choices"] if c["behavior"] == "allow" and c["scope"] == scope), None)
                if choice is None:
                    raise CardError("That kind of Always allow was not offered for this request.")
            return {"status": "allowed" if choice["behavior"] == "allow" else "denied", "choice": choice}
        if card["kind"] == "question":
            if action == "skip":
                return {"status": "skipped", "answers": None}
            if action != "answer":
                raise CardError("Answer the questions or skip them.")
            clean, problem = check_answers(card["questions"], answers)
            if problem:
                raise CardError(problem)
            return {"status": "answered", "answers": clean}
        raise CardError("This card is answered through its own action.")

    def register_resume_handler(self, kind: str, handler: Callable[[dict, str], dict]) -> None:
        """Connector, credential, sign-in and computer-help cards finish through a
        handler their owning phase supplies: `handler(card, outcome)` returns
        `{status, message}` with a settled status. The card never sees a secret;
        a credential value goes straight to the existing credential storage."""
        if kind not in KINDS or kind in ("approval", "question"):
            raise CardError(f"{kind!r} cards have no resume handler.")
        self._resume_handlers[kind] = handler

    def resume_card(self, card_id: str, owner: Optional[str], outcome: str) -> dict:
        """The person finished (`done`) or declined (`skipped`) a typed card."""
        who = _owner(owner)
        if outcome not in ("done", "skipped"):
            raise CardError("The outcome is done or skipped.")
        with self._lock:
            card = self._owned(card_id, who)
            if card["status"] == "settling":
                raise CardConflict("Another answer is already being delivered.", self.public(card))
            if card["status"] != "pending":
                raise CardConflict("This was already settled.", self.public(card))
            if card["kind"] in ("approval", "question"):
                raise CardError("This card is answered with Allow, Deny or its questions.")
            handler = self._resume_handlers.get(card["kind"])
            if handler is None and outcome == "done":
                raise CardConflict("Nothing here can continue this yet.", self.public(card))
            card["status"] = "settling"
            self._save()
            snapshot = self.public(card)
        status, message = "skipped", ""
        try:
            if outcome == "done":
                result = handler(snapshot, outcome) or {}
                status = result.get("status") if result.get("status") in SETTLED_STATUSES else "answered"
                message = str(result.get("message") or "")
        except Exception as error:
            logger.exception("bot card resume failed")
            with self._lock:
                self._cards[card_id]["status"] = "pending"
                self._save()
            raise CardError(f"That could not continue: {error}", self.get(card_id, who))
        with self._lock:
            card = self._cards[card_id]
            self._settle_locked(card, status, reason=message, outcome={"by": who, "resume": outcome})
            self._save()
            return {"ok": True, "card": self.public(card), "message": message}

    @staticmethod
    def answer_text(card: dict, answers: dict | None) -> str:
        """What a later answer says to the bot, as the start of a new turn."""
        lines = []
        for q in card["questions"] or []:
            value = (answers or {}).get(q["id"])
            lines.append(f"- {q['question']}: {', '.join(value) if isinstance(value, list) else value}")
        return "The person answered your earlier question:\n" + "\n".join(lines)


_stores: dict[str, CardStore] = {}  # one per cards file, so each account has its own
_listeners: list[Callable[[dict], None]] = []  # added through any store; every store hears them
_test_path: str | None = None
_store_lock = threading.RLock()


def store() -> CardStore:
    with _store_lock:
        path = _test_path or cards_file()
        found = _stores.get(path)
        if found is None:
            found = _stores[path] = CardStore(path)
        return found


def reset_for_test(path: str | None = None) -> CardStore:
    """Tests: forget the cached store (a new one is a restart)."""
    global _test_path
    with _store_lock:
        _test_path = path
        _stores.pop(path or cards_file(), None)
        return store()
