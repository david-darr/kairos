"""CRM follow-ups and their evidence. One atomic store, scoped by owner.

Follows the custom-tab service convention. A batch's tasks and processed
message marker commit together; a failed write rolls back in-memory state.
"""
import copy
import hashlib
import os
import re
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import date, datetime
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

from core import tab_api

api = tab_api.for_tab(__package__)
api.adopt_data_file("crm.json")
STATUSES = ("active", "in_progress", "waiting", "needs_review", "done", "dismissed")
PRIORITIES = ("urgent", "high", "normal", "low")
DEFAULTS = {"endpoint_id": None, "model": None, "timezone": "UTC", "review_all": False,
            "daily_completion": True,
            "auto_scan": False, "interval_minutes": 30, "lookback_days": 14, "max_messages": 40,
            "schedule_mode": "interval", "schedule_times": ["09:00"], "schedule_days": list(range(7)),
            "schedule_since": 0}


def key(value):
    return re.sub(r"\W+", " ", str(value).casefold()).strip()


def safe_url(value):
    parsed = urlparse(value or "")
    return value if parsed.scheme == "https" and parsed.hostname and not parsed.username else None


def valid_due(value):
    if not value:
        return None
    if len(value) == 10:
        date.fromisoformat(value)
    else:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("A deadline with a time needs a timezone")
    return value


class CRMService:
    def __init__(self, name=None):
        self.name = name or "crm.json"
        self._lock = threading.RLock()
        self._data = api.read_json(self.name, {"settings": {}, "sources": {}, "messages": {}, "tasks": {}, "runs": []})

    @contextmanager
    def transaction(self):
        with self._lock:
            before = copy.deepcopy(self._data)
            try:
                yield
                api.write_json(self.name, self._data)
            except BaseException:
                self._data = before
                raise

    def settings(self, owner):
        with self._lock:
            return copy.deepcopy({**DEFAULTS, **self._data["settings"].get(owner, {})})

    def owners(self):
        with self._lock:
            return sorted(set(self._data["settings"]) | {t["owner"] for t in self._data["tasks"].values()})

    def daily_status(self, owner):
        with self._lock:
            return copy.deepcopy(self._data.get("daily_completion", {}).get(owner, {}))

    def save_daily_status(self, owner, **fields):
        with self.transaction():
            self._data.setdefault("daily_completion", {}).setdefault(owner, {}).update(fields)

    def configure(self, owner, fields):
        values = {**self.settings(owner), **fields}
        ZoneInfo(values["timezone"])
        if values["schedule_mode"] not in ("interval", "times"):
            raise ValueError("Choose a scan schedule")
        times, days = values["schedule_times"], values["schedule_days"]
        if (not isinstance(times, list) or not 1 <= len(times) <= 6
                or any(not isinstance(t, str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", t) for t in times)
                or len(set(times)) != len(times)):
            raise ValueError("Choose 1 to 6 unique scan times in HH:MM format")
        if (not isinstance(days, list) or not days
                or any(type(d) is not int or not 0 <= d <= 6 for d in days)):
            raise ValueError("Choose at least one scan day")
        values["schedule_times"], values["schedule_days"] = sorted(times), sorted(set(days))
        previous = self.settings(owner)
        if any(values[k] != previous[k] for k in ("auto_scan", "schedule_mode", "schedule_times", "schedule_days", "timezone")):
            # Slots before this moment never trigger a catch-up scan.
            values["schedule_since"] = time.time()
        for name, lo, hi in (("interval_minutes", 5, 1440), ("lookback_days", 1, 90), ("max_messages", 1, 100)):
            if not lo <= values[name] <= hi:
                raise ValueError(f"{name} must be between {lo} and {hi}")
        with self.transaction():
            self._data["settings"][owner] = values
        return values

    def sources(self, owner):
        with self._lock:
            return copy.deepcopy([s for s in self._data["sources"].values() if s["owner"] == owner])

    def source(self, owner, source_id):
        with self._lock:
            source = self._data["sources"].get(source_id)
            if not source or source["owner"] != owner:
                raise KeyError(source_id)
            return copy.deepcopy(source)

    def add_source(self, owner, kind, connection_id, label, folder="INBOX", conversations=None):
        if kind not in ("email", "connector", "discord", "document"):
            raise ValueError("Unsupported source type")
        if any(c in folder for c in "\r\n\x00") or len(folder) > 200:
            raise ValueError("Invalid mailbox folder")
        with self.transaction():
            existing = next((s for s in self._data["sources"].values() if s["owner"] == owner
                             and (s["kind"], s["connection_id"], s["folder"]) == (kind, connection_id, folder)), None)
            if existing:
                return copy.deepcopy(existing)
            sid = uuid.uuid4().hex[:12]
            source = {"id": sid, "owner": owner, "kind": kind, "connection_id": connection_id,
                      "label": label, "folder": folder, "conversations": conversations or [],
                      "enabled": True, "created_at": time.time(), "last_scan_at": None, "error": None}
            self._data["sources"][sid] = source
            return copy.deepcopy(source)

    def toggle_source(self, owner, source_id, enabled):
        self.source(owner, source_id)
        with self.transaction():
            self._data["sources"][source_id]["enabled"] = enabled
        return self.source(owner, source_id)

    def capture(self, source, message):
        """Durably queue a source message before paid extraction. Never reopen it."""
        identity = message["external_id"]
        mid = hashlib.sha256(f"{source['owner']}:{source['id']}:{identity}".encode()).hexdigest()[:32]
        queued = {**message, "id": mid, "source_id": source["id"],
            "owner": source["owner"], "source_label": source["label"], "source_kind": source["kind"],
            "url": safe_url(message.get("url")), "state": "pending", "attempts": 0,
            "captured_at": time.time(), "error": None}
        with self.transaction():
            if mid not in self._data["messages"]:
                self._data["messages"][mid] = queued
            elif self._data["messages"][mid]["state"] == "unreadable":
                self._data["messages"][mid].update(queued)
        return self.message(source["owner"], mid)

    def read_failure(self, source, identity):
        """Persist UID failures separately from model validation attempts."""
        mid = hashlib.sha256(f"{source['owner']}:{source['id']}:{identity}".encode()).hexdigest()[:32]
        with self.transaction():
            m = self._data["messages"].setdefault(mid, {"id": mid, "external_id": identity,
                "owner": source["owner"], "source_id": source["id"], "state": "unreadable",
                "attempts": 0, "read_attempts": 0, "body": "", "captured_at": time.time()})
            if m["state"] != "unreadable":
                return False
            m["read_attempts"] = m.get("read_attempts", 0) + 1
            if m["read_attempts"] >= 3:
                m["state"] = "skipped"
                return True
        return False

    def message(self, owner, message_id):
        with self._lock:
            message = self._data["messages"].get(message_id)
            if not message or message["owner"] != owner:
                raise KeyError(message_id)
            return copy.deepcopy(message)

    def save_source_link(self, owner, message_id, url):
        self.message(owner, message_id)
        value = safe_url(url)
        if not value:
            raise ValueError("Original message links must use HTTPS")
        with self.transaction():
            self._data["messages"][message_id]["url"] = value
            for task in self._data["tasks"].values():
                if task["owner"] == owner:
                    for evidence in task["evidence"]:
                        if evidence["message_id"] == message_id:
                            evidence["url"] = value

    def pending(self, owner, source_id):
        with self._lock:
            return copy.deepcopy(sorted((m for m in self._data["messages"].values()
                if m["owner"] == owner and m["source_id"] == source_id and m["state"] in ("pending", "failed")
                and m["attempts"] < 3), key=lambda m: (bool(m["attempts"] or m.get("retry_pending")), m.get("sent_at") or "")))

    def known(self, owner, source_id):
        with self._lock:
            return {m["external_id"] for m in self._data["messages"].values()
                    if m["owner"] == owner and m["source_id"] == source_id and m["state"] != "unreadable"}

    def retry_failed(self, owner):
        with self.transaction():
            for m in self._data["messages"].values():
                if m["owner"] == owner and m["state"] == "failed":
                    m.update(state="pending", attempts=0, call_attempts=0, error=None, retry_pending=True)

    def thread(self, owner, message):
        with self._lock:
            return copy.deepcopy(sorted((m for m in self._data["messages"].values()
                if m["owner"] == owner and m["source_id"] == message["source_id"]
                and m.get("thread_id") == message.get("thread_id")), key=lambda m: m.get("sent_at") or "")[-6:])

    def tasks(self, owner):
        with self._lock:
            return copy.deepcopy([t for t in self._data["tasks"].values() if t["owner"] == owner])

    def task(self, owner, task_id):
        with self._lock:
            task = self._data["tasks"].get(task_id)
            if not task or task["owner"] != owner:
                raise KeyError(task_id)
            return copy.deepcopy(task)

    def create_task(self, owner, fields):
        title = (fields.get("title") or "").strip()
        if not title:
            raise ValueError("A task needs a title")
        priority = fields.get("priority", "normal")
        if priority not in PRIORITIES:
            raise ValueError("Invalid priority")
        status = fields.get("status", "active")
        if status not in STATUSES:
            raise ValueError("Invalid status")
        due = valid_due(fields.get("due_date"))
        tid = uuid.uuid4().hex[:12]
        task = {"id": tid, "owner": owner, "title": title[:300], "notes": fields.get("notes", ""),
                "contact": fields.get("contact", ""), "project": fields.get("project", ""),
                "priority": priority, "priority_reason": "Set by you", "status": status,
                "due_date": due, "deadline_text": "", "deadline_kind": "manual", "snoozed_until": None,
                "evidence": [], "review_reason": None, "proposal": None, "overrides": [],
                "created_at": time.time(), "updated_at": time.time()}
        with self.transaction():
            self._data["tasks"][tid] = task
        return copy.deepcopy(task)

    def update_task(self, owner, task_id, fields):
        self.task(owner, task_id)
        if "status" in fields and fields["status"] not in STATUSES:
            raise ValueError("Invalid status")
        if "priority" in fields and fields["priority"] not in PRIORITIES:
            raise ValueError("Invalid priority")
        if "title" in fields and not fields["title"].strip():
            raise ValueError("A task needs a title")
        for name in ("due_date", "snoozed_until"):
            if name in fields:
                fields[name] = valid_due(fields[name])
        allowed = ("title", "notes", "contact", "project", "due_date", "priority", "status", "snoozed_until")
        with self.transaction():
            task = self._data["tasks"][task_id]
            for name in allowed:
                if name in fields:
                    task[name] = fields[name]
                    if name not in task["overrides"]:
                        task["overrides"].append(name)
            if "due_date" in fields:
                task["deadline_kind"] = "manual"
            if "priority" in fields:
                task["priority_reason"] = "Set by you"
            if "status" in fields:
                task["completion_not_before"] = time.time()
                task["completion"] = ({"kind": "manual", "at": time.time(), "actor": "user"}
                                      if fields["status"] == "done" else None)
                if fields["status"] == "done":
                    task["proposal"] = None
            if task["status"] != "needs_review":
                task["review_reason"] = None
            task["updated_at"] = time.time()
        return self.task(owner, task_id)

    def apply(self, owner, message_id, items):
        """Only validated extraction enters here. Tasks + marker are one commit."""
        message = self.message(owner, message_id)
        count = 0
        with self.transaction():
            if self._data["messages"][message_id]["state"] == "processed":
                return 0
            for item in items:
                evidence = {"message_id": message_id, "quote": item["evidence"], "url": message.get("url"),
                            "label": message["source_label"], "subject": message.get("subject", ""),
                            "sent_at": message.get("sent_at")}
                target = self._data["tasks"].get(item.get("match_task_id"))
                if target and (target["owner"] != owner or target.get("source_id") != message["source_id"]
                               or target.get("thread_id") != message.get("thread_id")):
                    raise ValueError("A task match must belong to this source thread")
                if target is None:
                    # A thread id names the same conversation in every selected mailbox, so the
                    # same message captured twice is one task; without one, match within the source.
                    target = next((t for t in self._data["tasks"].values() if t["owner"] == owner
                        and (bool(message.get("thread_id")) or t.get("source_id") == message["source_id"])
                        and t.get("thread_id") == message.get("thread_id")
                        and key(t["title"]) == key(item["title"])), None)
                if target:
                    if evidence not in target["evidence"]:
                        target["evidence"].append(evidence)
                    # Only an explicit, unambiguous confirmation in the current
                    # source message can close the same outstanding action.
                    if (item["status"] == "done" and not item.get("review_reason")
                            and item["evidence"] in message["body"]
                            and not re.search(r"\b(not|never|haven't|hasn't|didn't|couldn't|can't|will|would|should|plan to|need to)\b",
                                              item["evidence"].replace("\u2019", "'"), re.I)
                            and target["status"] in ("active", "in_progress", "waiting")
                            and self._source_completion_is_new(target, message)):
                        self._finish(target, {"kind": "source", "message_id": message_id,
                                              "quote": item["evidence"], "actor": "source"})
                        continue
                    # New evidence never reopens a dismissed/completed task or overwrites user edits.
                    changed = any(item.get(n) != target.get(n) for n in ("due_date", "status", "title", "priority", "project"))
                    if changed and target["status"] not in ("done", "dismissed"):
                        target["proposal"] = {**item, "message_id": message_id}
                        target["review_reason"] = "A later message suggests a change. Review it before applying."
                    target["updated_at"] = time.time()
                    continue
                tid = uuid.uuid4().hex[:12]
                self._data["tasks"][tid] = {**item, "id": tid, "owner": owner,
                    "source_id": message["source_id"], "thread_id": message.get("thread_id"),
                    "contact": message.get("sender", ""), "notes": "", "snoozed_until": None,
                    "evidence": [evidence], "proposal": None, "overrides": [],
                    "created_at": time.time(), "updated_at": time.time()}
                count += 1
            self._data["messages"][message_id].update(state="processed", error=None)
        return count

    def resolve_proposal(self, owner, task_id, accept):
        current = self.task(owner, task_id)
        if not current.get("proposal"):
            raise ValueError("No suggested change to review")
        with self.transaction():
            task = self._data["tasks"][task_id]
            if accept:
                proposed = task["proposal"]
                for field in ("title", "due_date", "status", "priority", "project", "deadline_text", "deadline_kind", "priority_reason"):
                    if field in proposed:
                        task[field] = proposed[field]
                if task["status"] == "needs_review":
                    task["status"] = "active"
            task.update(proposal=None, review_reason=None, updated_at=time.time())
        return self.task(owner, task_id)

    def fail_message(self, owner, message_id, reason):
        self.message(owner, message_id)
        with self.transaction():
            m = self._data["messages"][message_id]
            m.update(state="failed", attempts=m["attempts"] + 1, error=reason)

    def keep_pending(self, owner, message_id, limit=3):
        """A model-call failure keeps the message queued without spending its
        validation attempts. A message that fails the call on `limit` separate
        scans (e.g. a provider rejecting it as too long) is marked failed so it
        cannot hold the head of the queue forever. Returns True when it failed."""
        self.message(owner, message_id)
        with self.transaction():
            m = self._data["messages"][message_id]
            m["call_attempts"] = m.get("call_attempts", 0) + 1
            if m["call_attempts"] >= limit:
                # Repeated scans proved it is not transient: only Retry failed reopens it.
                m.update(state="failed", attempts=3, call_attempts=0,
                         error="The extraction model could not process this message; retry the scan.")
                return True
            m.update(state="pending", error=None)
            return False

    # Reply and chat bookkeeping. Kept out of update_task: these aren't the
    # person's edits, so they must not land in a task's overrides.
    _WORK_FIELDS = ("reply_draft", "last_reply", "chat_session_id", "chat_evidence_count", "chat_context_signature", "completion_card_receipt")

    @staticmethod
    def _source_completion_is_new(task, message):
        guard = task.get("completion_not_before", 0)
        if not guard:
            return True
        try:
            return datetime.fromisoformat(message["sent_at"].replace("Z", "+00:00")).timestamp() > guard
        except (KeyError, ValueError, TypeError):
            return False

    @staticmethod
    def _finish(task, receipt):
        now = time.time()
        task.update(status="done", proposal=None, review_reason=None, snoozed_until=None,
                    completion={**receipt, "at": now}, updated_at=now)

    def auto_complete(self, owner, task_id, version, receipt, observed_at):
        """Compare-and-set protects edits/reopens made while a model was judging."""
        with self.transaction():
            task = self._data["tasks"].get(task_id)
            if not task or task["owner"] != owner:
                raise KeyError(task_id)
            if (task["updated_at"] != version or task["status"] not in ("active", "in_progress", "waiting")
                    or observed_at <= task.get("completion_not_before", 0)):
                return False
            self._finish(task, receipt)
            return True

    def agent_complete(self, owner, task_id, receipt):
        """An owner's agent reports it finished the task; no reader-model wait."""
        with self.transaction():
            task = self._data["tasks"].get(task_id)
            if not task or task["owner"] != owner:
                raise KeyError(task_id)
            if task["status"] == "done":
                return "already_done"
            if task["status"] not in ("active", "in_progress", "waiting", "needs_review"):
                return task["status"]
            self._finish(task, receipt)
            return "done"

    def queue_completion(self, owner, turn):
        with self.transaction():
            queue = self._data.setdefault("completion_queue", {})
            identity = owner + ":" + turn["id"]
            if identity in queue:
                return False
            tasks = [t for t in self._data["tasks"].values() if t["owner"] == owner
                     and t["status"] in ("active", "in_progress", "waiting")
                     and t["created_at"] <= turn["at"]
                     and (not turn.get("task_id") or t["id"] == turn["task_id"])
                     and turn["at"] > t.get("completion_not_before", 0)]
            text = key(str(turn.get("message") or "") + " " + str(turn.get("reply") or "") + " " + str(turn.get("request") or ""))
            words = set(text.split())
            generic = {"the", "and", "for", "this", "that", "with", "from", "send", "sent", "done", "task", "please"}
            def relevant(task):
                if turn.get("task_id") or (turn.get("session_id") and turn["session_id"] == task.get("chat_session_id")):
                    return True
                terms = {word for word in key(task["title"] + " " + task.get("project", "") + " " + task.get("contact", "")).split()
                         if len(word) >= 3 and word not in generic}
                return bool(terms & words)
            tasks = [t for t in tasks if relevant(t)]
            if not tasks:
                return False
            queue[identity] = {"id": identity, "owner": owner, "turn": copy.deepcopy(turn),
                "tasks": [{k: t.get(k) for k in ("id", "title", "notes", "project", "contact", "updated_at")}
                          for t in tasks], "attempts": 0, "state": "pending"}
            return True

    def completion_queue(self):
        with self._lock:
            return copy.deepcopy([r for r in self._data.get("completion_queue", {}).values()
                                  if r["state"] == "pending" and r["attempts"] < 3])

    def finish_completion_check(self, identity, success):
        with self.transaction():
            queue = self._data["completion_queue"]
            check = queue[identity]
            check["attempts"] += 1
            if success or check["attempts"] >= 3:
                # Keep a small deduplication receipt, not another chat transcript.
                check.update(state="checked" if success else "failed", turn=None, tasks=[])
            completed = [k for k, v in queue.items() if v["state"] != "pending"]
            for key in completed[:-100]:
                del queue[key]

    def set_work(self, owner, task_id, **fields):
        self.task(owner, task_id)
        if set(fields) - set(self._WORK_FIELDS):
            raise ValueError("Unknown task work field")
        with self.transaction():
            self._data["tasks"][task_id].update(fields)
        return self.task(owner, task_id)

    def reply_target(self, owner, task_id):
        """Where a reply goes: the newest email evidence's sender, from the
        account that received it. None for non-email tasks, a source that was
        removed, or mail the account itself sent."""
        task = self.task(owner, task_id)
        with self._lock:
            found = []
            for evidence in task["evidence"]:
                message = self._data["messages"].get(evidence["message_id"])
                if not message or message["owner"] != owner or message.get("source_kind") != "email":
                    continue
                source = self._data["sources"].get(message["source_id"])
                if source and source["owner"] == owner:
                    found.append((message.get("sent_at") or "", message, source))
        if not found:
            return None
        _, message, source = max(found, key=lambda row: row[0])
        sender, account = (message.get("sender") or "").strip(), (message.get("account") or "").strip()
        if not sender or sender.casefold() == account.casefold():
            return None
        subject = message.get("subject") or task["title"]
        return {"account_id": source["connection_id"], "account": account, "to": sender,
                "subject": subject if subject.lower().startswith("re:") else "Re: " + subject,
                "in_reply_to": message.get("message_id") or None, "message_id": message["id"]}

    def attach_card(self, owner, task_id, card_id):
        self.task(owner, task_id)
        with self.transaction():
            self._data["tasks"][task_id]["agent_card_id"] = card_id

    def record_scan(self, owner, source_id, result):
        self.source(owner, source_id)
        with self.transaction():
            self._data["sources"][source_id].update(last_scan_at=time.time(), error=result.get("error"))
            self._data["runs"].append({"id": uuid.uuid4().hex[:12], "owner": owner,
                                     "source_id": source_id, "at": time.time(), **result})
            # Keep per-owner history, so another person's scans cannot displace it.
            counts, keep = {}, []
            for run in reversed(self._data["runs"]):
                who = run["owner"]
                counts[who] = counts.get(who, 0) + 1
                if counts[who] <= 50:
                    keep.append(run)
            self._data["runs"] = list(reversed(keep))

    def snapshot(self, owner):
        tasks = self.tasks(owner)
        with self._lock:
            runs = copy.deepcopy([r for r in reversed(self._data["runs"]) if r["owner"] == owner])
            failed = [m for m in self._data["messages"].values() if m["owner"] == owner and m["state"] == "failed"]
        return {"tasks": tasks, "sources": self.sources(owner), "settings": self.settings(owner),
                "runs": runs, "failed_messages": len(failed)}

    def calendar_events(self, owner, start, end):
        zone = ZoneInfo(self.settings(owner)["timezone"])
        first = datetime.fromisoformat(start.replace("Z", "+00:00")).astimezone(zone)
        last = datetime.fromisoformat(end.replace("Z", "+00:00")).astimezone(zone)
        items = []
        for task in self.tasks(owner):
            due = task.get("due_date")
            if not due or task["status"] in ("done", "dismissed", "needs_review"):
                continue
            all_day = len(due) == 10
            in_range = first.date() <= date.fromisoformat(due) < last.date() if all_day else (
                first <= datetime.fromisoformat(due.replace("Z", "+00:00")) < last)
            if in_range:
                items.append({"id": task["id"], "title": task["title"], "start": due, "end": due,
                              "all_day": all_day, "source": "tab", "source_label": "From CRM",
                              "toggle_url": f"/api/tab-crm/tasks/{task['id']}/completed", "completed": False,
                              "location": task.get("contact", ""), "description": task.get("notes", "")})
        return items


crm_service = tab_api.per_account(lambda _path: CRMService(), lambda: os.path.join(api.data_dir, "crm.json"))
