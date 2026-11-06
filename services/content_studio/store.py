"""The Content Studio scoring record: one SQLite file per account (Content Studio Team build spec, sections 3-5, 8).

Niches, channels (made by the user, never by bots), topics with evidence, posts, metrics snapshots as a time
series, strategies and decisions. Plain storage and the rules that protect it (caps, state changes); the
selection maths is in scoring.py and review.py. Every time-dependent call takes `now` so tests can move the clock.
"""
import json
import os
import sqlite3
import threading
import time

PLATFORMS = ("youtube", "tiktok", "instagram")
POST_STATES = ("drafted", "awaiting_approval", "approved", "rejected", "posted")
ROLES = ("script_writer", "evaluator")
HARD_MAX_NICHES = 5  # D3: never more than five live at once, whatever the setting says
DAY = 86400.0

DEFAULT_SETTINGS = {
    "weights": {"views": 0.4, "watch": 0.4, "engagement": 0.2},  # D2, a team setting
    "follow_weight": 5,          # one follow counts as this many likes/comments/shares in the third part
    "score_after_days": 7,       # "views at 7 days"
    "min_weeks": 3, "min_posts": 10,
    "max_niches": HARD_MAX_NICHES, "start_niches": 3,
    "behind_ratio": 0.5, "behind_reviews": 2,
    "strategy_margin": 5.0,      # points a loser must trail the winner by before it is dropped
    "review_gap_days": 6,        # a real weekly review will not run twice inside this
    "step_windows_h": {"pick": 24, "script": 12, "render": 6, "queue": 12, "approval": 48, "publish": 48},
    "team_bot_ids": [],          # the Studio team's bots, for the spend line of the report
    "team_roles": {},            # bot id -> role (producer, researcher, ...), filled in when the team template is imported
    "notified": {},              # delivery keys already sent to the Inbox, so a watch does not repeat itself
}
TEAM_ROLES = ("producer", "researcher", "evaluator", "script_writer", "editor", "publisher", "executor")


class StudioError(Exception):
    def __init__(self, detail, status=400):
        super().__init__(detail)
        self.detail, self.status = detail, status


def not_found(what):
    return StudioError(f"{what} not found", 404)


def conflict(detail):
    return StudioError(detail, 409)


SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS niches (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'live',
  slots INTEGER NOT NULL DEFAULT 1, created_at REAL NOT NULL, retired_at REAL, retire_reason TEXT);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY, niche_id INTEGER NOT NULL REFERENCES niches(id), platform TEXT NOT NULL,
  handle TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'live', paused INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL, archived_at REAL, archive_reason TEXT);
CREATE TABLE IF NOT EXISTS channel_warnings (
  id INTEGER PRIMARY KEY, channel_id INTEGER NOT NULL REFERENCES channels(id), text TEXT NOT NULL,
  at REAL NOT NULL, cleared_at REAL);
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY, niche_id INTEGER NOT NULL REFERENCES niches(id), title TEXT NOT NULL,
  source TEXT NOT NULL, evidence_date REAL NOT NULL, signal TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS strategies (
  id INTEGER PRIMARY KEY, owner_role TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
  parent_id INTEGER REFERENCES strategies(id), is_default INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL, dropped_at REAL);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY, channel_id INTEGER NOT NULL REFERENCES channels(id),
  topic_id INTEGER REFERENCES topics(id), title TEXT NOT NULL, caption TEXT NOT NULL DEFAULT '',
  format TEXT, script_strategy_id INTEGER REFERENCES strategies(id), evaluator_strategy_id INTEGER REFERENCES strategies(id),
  script_ref TEXT, render_ref TEXT, render_status TEXT NOT NULL DEFAULT 'pending',
  state TEXT NOT NULL DEFAULT 'drafted', rejection_count INTEGER NOT NULL DEFAULT 0, reject_reason TEXT,
  approved_by TEXT, approved_at REAL, posted_url TEXT, posted_at REAL,
  created_at REAL NOT NULL, step_since REAL NOT NULL);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES posts(id), taken_at REAL NOT NULL,
  views INTEGER NOT NULL, avg_view_duration_s REAL NOT NULL, video_length_s REAL NOT NULL,
  likes INTEGER NOT NULL, comments INTEGER NOT NULL, shares INTEGER NOT NULL, follows_gained INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual');
CREATE INDEX IF NOT EXISTS snapshots_post ON snapshots(post_id, taken_at);
CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY, at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS review_marks (
  review_id INTEGER NOT NULL REFERENCES reviews(id), subject_type TEXT NOT NULL, subject_id INTEGER NOT NULL,
  score REAL NOT NULL, median REAL, behind INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id INTEGER NOT NULL,
  subject_name TEXT NOT NULL DEFAULT '', numbers TEXT NOT NULL DEFAULT '{}', reason TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL, proposed_by TEXT NOT NULL,
  confirmed_by TEXT, user_ok_by TEXT, at REAL NOT NULL, resolved_at REAL);
"""
JSON_COLS = {"numbers", "payload"}


def _clean_text(value, what, limit=300, required=True):
    text = value.strip() if isinstance(value, str) else ("" if value is None else str(value).strip())
    if required and not text:
        raise StudioError(f"{what} is required")
    if len(text) > limit:
        raise StudioError(f"{what} is too long")
    return text


def _num(value, what, integer=False, minimum=0):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise StudioError(f"{what} must be a number")
    if value != value or value < minimum:
        raise StudioError(f"{what} must be at least {minimum}")
    return int(value) if integer else float(value)


class Store:
    def __init__(self, path):
        self.path = path
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript(SCHEMA)
        if "source" not in {row["name"] for row in self.db.execute("PRAGMA table_info(snapshots)")}:
            self.db.execute("ALTER TABLE snapshots ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'")  # stores made before connectors
        self.db.commit()

    def close(self):
        with self.lock:
            self.db.close()

    # -- plumbing -------------------------------------------------------------------------------

    def _rows(self, sql, args=()):
        with self.lock:
            out = []
            for row in self.db.execute(sql, args).fetchall():
                item = dict(row)
                for col in JSON_COLS & item.keys():
                    item[col] = json.loads(item[col] or "{}")
                out.append(item)
            return out

    def _row(self, sql, args=()):
        rows = self._rows(sql, args)
        return rows[0] if rows else None

    def _write(self, sql, args=()):
        with self.lock:
            cur = self.db.execute(sql, args)
            self.db.commit()
            return cur.lastrowid

    def _insert(self, table, **fields):
        for col in JSON_COLS & fields.keys():
            fields[col] = json.dumps(fields[col])
        names = ", ".join(fields)
        return self._write(f"INSERT INTO {table} ({names}) VALUES ({', '.join('?' * len(fields))})", tuple(fields.values()))

    def _update(self, table, row_id, **fields):
        for col in JSON_COLS & fields.keys():
            fields[col] = json.dumps(fields[col])
        sets = ", ".join(f"{k} = ?" for k in fields)
        self._write(f"UPDATE {table} SET {sets} WHERE id = ?", (*fields.values(), row_id))

    # -- settings -------------------------------------------------------------------------------

    def settings(self):
        out = json.loads(json.dumps(DEFAULT_SETTINGS))
        for row in self._rows("SELECT key, value FROM settings"):
            if row["key"] in out:
                out[row["key"]] = json.loads(row["value"])
        return out

    def update_settings(self, **changes):
        current = self.settings()
        for key, value in changes.items():
            if key not in DEFAULT_SETTINGS:
                raise StudioError(f"unknown setting: {key}")
            if key == "weights":
                if not isinstance(value, dict) or set(value) != {"views", "watch", "engagement"}:
                    raise StudioError("weights needs views, watch and engagement")
                value = {k: _num(v, f"weight {k}") for k, v in value.items()}
                if sum(value.values()) <= 0:
                    raise StudioError("weights must add up to more than zero")
            elif key == "max_niches":
                value = _num(value, key, True, 1)
                if value > HARD_MAX_NICHES:
                    raise StudioError(f"at most {HARD_MAX_NICHES} niches can be live at once")
            elif key == "step_windows_h":
                if not isinstance(value, dict):
                    raise StudioError("step_windows_h must be an object")
                value = {**current[key], **{k: _num(v, f"window {k}", minimum=0.01) for k, v in value.items()}}
            elif key == "team_bot_ids":
                if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
                    raise StudioError("team_bot_ids must be a list of bot ids")
            elif key == "team_roles":
                if not isinstance(value, dict) or len(value) > 100 or any(
                        not isinstance(k, str) or v not in TEAM_ROLES for k, v in value.items()):
                    raise StudioError("team_roles maps bot ids to team roles")
            elif key == "notified":
                if not isinstance(value, dict) or any(not isinstance(k, str) for k in value):
                    raise StudioError("notified must be an object")
                value = dict(sorted(value.items(), key=lambda kv: kv[1])[-500:])
            elif key in ("min_weeks", "min_posts", "behind_reviews", "start_niches", "score_after_days", "review_gap_days"):
                value = _num(value, key, True, 0 if key == "review_gap_days" else 1)
            else:
                value = _num(value, key)
            current[key] = value
            self._write("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        (key, json.dumps(value)))
        return current

    # -- niches ---------------------------------------------------------------------------------

    def create_niche(self, name, now=None):
        now = time.time() if now is None else now
        name = _clean_text(name, "niche name", 80)
        with self.lock:
            live = self.list_niches("live")
            if len(live) >= min(self.settings()["max_niches"], HARD_MAX_NICHES):
                raise conflict(f"{len(live)} niches are already live (the cap); retire one first")
            if any(n["name"].lower() == name.lower() for n in live):
                raise conflict("a live niche already has that name")
            niche_id = self._insert("niches", name=name, created_at=now)
            self._fulfil_replacement(niche_id, name, now)
        return self.get_niche(niche_id)

    def _fulfil_replacement(self, niche_id, name, now):
        """A new niche answers the oldest open replacement request, so the history says what replaced what."""
        ask = self._row("SELECT * FROM decisions WHERE kind = 'replace' AND subject_type = 'niche' AND status = 'open' "
                        "ORDER BY id LIMIT 1")
        if ask:
            self._update("decisions", ask["id"], status="confirmed", resolved_at=now,
                         payload={**ask["payload"], "replaced_by": niche_id, "replaced_by_name": name})

    def get_niche(self, niche_id):
        row = self._row("SELECT * FROM niches WHERE id = ?", (niche_id,))
        if not row:
            raise not_found("niche")
        return row

    def list_niches(self, status=None):
        if status:
            return self._rows("SELECT * FROM niches WHERE status = ? ORDER BY id", (status,))
        return self._rows("SELECT * FROM niches ORDER BY id")

    def retire_niche(self, niche_id, reason, now=None):
        """Retired, not deleted: the niche and its channels stay on record, out of the rotation."""
        now = time.time() if now is None else now
        niche = self.get_niche(niche_id)
        if niche["status"] != "live":
            raise conflict("that niche is already retired")
        with self.lock:
            self._update("niches", niche_id, status="retired", retired_at=now, retire_reason=reason)
            for channel in self.list_channels(niche_id=niche_id, status="live"):
                self._update("channels", channel["id"], status="archived", archived_at=now,
                             archive_reason=f"niche retired: {reason}")
        return self.get_niche(niche_id)

    def add_slots(self, niche_id, count):
        niche = self.get_niche(niche_id)
        self._update("niches", niche_id, slots=niche["slots"] + count)

    # -- channels -------------------------------------------------------------------------------

    def create_channel(self, niche_id, platform, handle, now=None):
        """Registers a channel the user made. Bots never get here: nothing in the team creates accounts."""
        now = time.time() if now is None else now
        if platform not in PLATFORMS:
            raise StudioError(f"platform must be one of {', '.join(PLATFORMS)}")
        handle = _clean_text(handle, "handle", 100)
        if self.get_niche(niche_id)["status"] != "live":
            raise conflict("that niche is retired")
        with self.lock:
            if self._row("SELECT id FROM channels WHERE platform = ? AND lower(handle) = lower(?) AND status = 'live'",
                         (platform, handle)):
                raise conflict("that channel is already registered")
            channel_id = self._insert("channels", niche_id=niche_id, platform=platform, handle=handle, created_at=now)
        return self.get_channel(channel_id)

    def get_channel(self, channel_id):
        row = self._row("SELECT c.*, n.name AS niche_name FROM channels c JOIN niches n ON n.id = c.niche_id WHERE c.id = ?",
                        (channel_id,))
        if not row:
            raise not_found("channel")
        return row

    def list_channels(self, niche_id=None, status=None):
        where, args = [], []
        for col, value in (("c.niche_id", niche_id), ("c.status", status)):
            if value is not None:
                where.append(f"{col} = ?")
                args.append(value)
        clause = f"WHERE {' AND '.join(where)}" if where else ""
        return self._rows(f"SELECT c.*, n.name AS niche_name FROM channels c JOIN niches n ON n.id = c.niche_id {clause} "
                          "ORDER BY c.id", tuple(args))

    def archive_channel(self, channel_id, reason="", now=None):
        now = time.time() if now is None else now
        if self.get_channel(channel_id)["status"] == "archived":
            raise conflict("that channel is already archived")
        self._update("channels", channel_id, status="archived", archived_at=now, archive_reason=reason)
        return self.get_channel(channel_id)

    def restore_channel(self, channel_id):
        channel = self.get_channel(channel_id)
        if channel["status"] != "archived":
            raise conflict("that channel is not archived")
        if self.get_niche(channel["niche_id"])["status"] != "live":
            raise conflict("its niche is retired")
        if self._row("SELECT id FROM channels WHERE platform = ? AND lower(handle) = lower(?) AND status = 'live'",
                     (channel["platform"], channel["handle"])):
            raise conflict("that channel is already registered")
        self._update("channels", channel_id, status="live", archived_at=None, archive_reason=None)
        return self.get_channel(channel_id)

    def record_warning(self, channel_id, text, now=None):
        """A platform warning on a channel pauses it until the user clears it (spec section 4)."""
        now = time.time() if now is None else now
        self.get_channel(channel_id)
        text = _clean_text(text, "warning", 500)
        with self.lock:
            self._insert("channel_warnings", channel_id=channel_id, text=text, at=now)
            self._update("channels", channel_id, paused=1)
        return self.get_channel(channel_id)

    def resume_channel(self, channel_id, now=None):
        now = time.time() if now is None else now
        self.get_channel(channel_id)
        with self.lock:
            self._write("UPDATE channel_warnings SET cleared_at = ? WHERE channel_id = ? AND cleared_at IS NULL",
                        (now, channel_id))
            self._update("channels", channel_id, paused=0)
        return self.get_channel(channel_id)

    def open_warnings(self):
        return self._rows("SELECT w.*, c.platform, c.handle FROM channel_warnings w JOIN channels c ON c.id = w.channel_id "
                          "WHERE w.cleared_at IS NULL ORDER BY w.at")

    # -- topics ---------------------------------------------------------------------------------

    def add_topic(self, niche_id, title, source, evidence_date=None, signal="", now=None):
        """A candidate always carries where it came from and when (spec section 7)."""
        now = time.time() if now is None else now
        if self.get_niche(niche_id)["status"] != "live":
            raise conflict("that niche is retired")
        topic_id = self._insert(
            "topics", niche_id=niche_id, title=_clean_text(title, "title", 200), source=_clean_text(source, "source", 300),
            signal=_clean_text(signal, "signal", 300, False), created_at=now,
            evidence_date=now if evidence_date is None else _num(evidence_date, "evidence date"))
        return self.get_topic(topic_id)

    def get_topic(self, topic_id):
        row = self._row("SELECT * FROM topics WHERE id = ?", (topic_id,))
        if not row:
            raise not_found("topic")
        return row

    def list_topics(self, niche_id=None):
        if niche_id is not None:
            return self._rows("SELECT * FROM topics WHERE niche_id = ? ORDER BY id", (niche_id,))
        return self._rows("SELECT * FROM topics ORDER BY id")

    # -- strategies -----------------------------------------------------------------------------

    def create_strategy(self, owner_role, name, parent_id=None, make_default=False, now=None):
        now = time.time() if now is None else now
        if owner_role not in ROLES:
            raise StudioError(f"owner role must be one of {', '.join(ROLES)}")
        name = _clean_text(name, "strategy name", 80)
        with self.lock:
            if self._row("SELECT id FROM strategies WHERE owner_role = ? AND lower(name) = lower(?)", (owner_role, name)):
                raise conflict("that role already has a strategy by that name")
            if parent_id is not None and self.get_strategy(parent_id)["owner_role"] != owner_role:
                raise StudioError("the parent strategy belongs to another role")
            first = not self._row("SELECT id FROM strategies WHERE owner_role = ? AND status = 'active'", (owner_role,))
            sid = self._insert("strategies", owner_role=owner_role, name=name, parent_id=parent_id, created_at=now)
            if first or make_default:
                self.set_default_strategy(sid)
        return self.get_strategy(sid)

    def get_strategy(self, strategy_id):
        row = self._row("SELECT * FROM strategies WHERE id = ?", (strategy_id,))
        if not row:
            raise not_found("strategy")
        return row

    def list_strategies(self, owner_role=None, status=None):
        where, args = [], []
        for col, value in (("owner_role", owner_role), ("status", status)):
            if value is not None:
                where.append(f"{col} = ?")
                args.append(value)
        clause = f"WHERE {' AND '.join(where)}" if where else ""
        return self._rows(f"SELECT * FROM strategies {clause} ORDER BY id", tuple(args))

    def set_default_strategy(self, strategy_id):
        strategy = self.get_strategy(strategy_id)
        if strategy["status"] != "active":
            raise conflict("a dropped strategy cannot be the default")
        with self.lock:
            self._write("UPDATE strategies SET is_default = 0 WHERE owner_role = ?", (strategy["owner_role"],))
            self._update("strategies", strategy_id, is_default=1)

    def drop_strategy(self, strategy_id, now=None):
        now = time.time() if now is None else now
        if self.get_strategy(strategy_id)["status"] != "active":
            raise conflict("that strategy is already dropped")
        self._update("strategies", strategy_id, status="dropped", dropped_at=now, is_default=0)

    # -- posts ----------------------------------------------------------------------------------

    POST_SQL = ("SELECT p.*, c.platform, c.handle, c.niche_id, n.name AS niche_name FROM posts p "
                "JOIN channels c ON c.id = p.channel_id JOIN niches n ON n.id = c.niche_id")

    def create_post(self, channel_id, title, topic_id=None, script_strategy_id=None, evaluator_strategy_id=None,
                    script_ref=None, caption="", format=None, now=None):
        now = time.time() if now is None else now
        channel = self.get_channel(channel_id)
        if channel["status"] != "live":
            raise conflict("that channel is archived")
        if channel["paused"]:
            raise conflict("that channel is paused after a platform warning")
        if topic_id is not None and self.get_topic(topic_id)["niche_id"] != channel["niche_id"]:
            raise StudioError("that topic belongs to another niche")
        for sid, role in ((script_strategy_id, "script_writer"), (evaluator_strategy_id, "evaluator")):
            if sid is not None:
                strategy = self.get_strategy(sid)
                if strategy["owner_role"] != role or strategy["status"] != "active":
                    raise StudioError(f"strategy {sid} is not an active {role} strategy")
        post_id = self._insert(
            "posts", channel_id=channel_id, topic_id=topic_id, title=_clean_text(title, "title", 200),
            caption=_clean_text(caption, "caption", 5000, False), format=_clean_text(format, "format", 80, False) or None,
            script_strategy_id=script_strategy_id, evaluator_strategy_id=evaluator_strategy_id,
            script_ref=script_ref, created_at=now, step_since=now)
        return self.get_post(post_id)

    def get_post(self, post_id):
        row = self._row(f"{self.POST_SQL} WHERE p.id = ?", (post_id,))
        if not row:
            raise not_found("post")
        return row

    def list_posts(self, state=None, channel_id=None, niche_id=None):
        where, args = [], []
        for col, value in (("p.state", state), ("p.channel_id", channel_id), ("c.niche_id", niche_id)):
            if value is not None:
                where.append(f"{col} = ?")
                args.append(value)
        clause = f"WHERE {' AND '.join(where)}" if where else ""
        return self._rows(f"{self.POST_SQL} {clause} ORDER BY p.id", tuple(args))

    EDITABLE = {"title": 200, "caption": 5000, "script_ref": 500, "render_ref": 500, "format": 80}

    def edit_post(self, post_id, now=None, **fields):
        """Content edits (by the user at approval, or by a bot while drafting). Not allowed once approved."""
        now = time.time() if now is None else now
        post = self.get_post(post_id)
        if post["state"] in ("approved", "posted"):
            raise conflict(f"a {post['state']} post can no longer be edited")
        changes = {}
        for key, value in fields.items():
            if key == "render_status":
                if value not in ("pending", "ok", "failed"):
                    raise StudioError("render_status must be pending, ok or failed")
                changes[key] = value
            elif key in self.EDITABLE:
                text = _clean_text(value, key, self.EDITABLE[key], key == "title")
                changes[key] = text if key in ("title", "caption") else (text or None)
            else:
                raise StudioError(f"cannot edit {key}")
        if "render_status" in changes or "render_ref" in changes:
            changes["step_since"] = now
        if changes:
            self._update("posts", post_id, **changes)
        return self.get_post(post_id)

    def _move(self, post_id, allowed, new_state, now, **fields):
        post = self.get_post(post_id)
        if post["state"] not in allowed:
            raise conflict(f"a {post['state']} post cannot become {new_state}")
        self._update("posts", post_id, state=new_state, step_since=now, **fields)
        return self.get_post(post_id)

    def submit_for_approval(self, post_id, now=None):
        now = time.time() if now is None else now
        post = self.get_post(post_id)
        if post["render_status"] != "ok" or not post["render_ref"]:
            raise conflict("the video is not rendered yet")
        return self._move(post_id, ("drafted",), "awaiting_approval", now)

    def approve(self, post_id, by, now=None):
        """Approval only marks the post approved. Handing it to the platform is the Publisher's later step."""
        now = time.time() if now is None else now
        channel = self.get_channel(self.get_post(post_id)["channel_id"])
        if channel["status"] != "live" or channel["paused"]:
            raise conflict("that channel is archived or paused")
        return self._move(post_id, ("awaiting_approval",), "approved", now, approved_by=by, approved_at=now)

    def reject(self, post_id, reason="", now=None):
        now = time.time() if now is None else now
        post = self.get_post(post_id)
        return self._move(post_id, ("awaiting_approval", "approved"), "rejected", now,
                          rejection_count=post["rejection_count"] + 1, reject_reason=_clean_text(reason, "reason", 500, False))

    def redraft(self, post_id, now=None):
        """A rejected post goes back to the drafting steps (the rejection count stays, for the Producer's watch)."""
        now = time.time() if now is None else now
        return self._move(post_id, ("rejected",), "drafted", now, render_status="pending")

    def mark_posted(self, post_id, url, posted_at=None, now=None):
        now = time.time() if now is None else now
        url = _clean_text(url, "posted link", 500)
        return self._move(post_id, ("approved",), "posted", now, posted_url=url,
                          posted_at=now if posted_at is None else _num(posted_at, "posted_at"))

    # -- metrics --------------------------------------------------------------------------------

    def add_snapshot(self, post_id, views, avg_view_duration_s, video_length_s, likes=0, comments=0, shares=0,
                     follows_gained=0, taken_at=None, source="manual", now=None):
        now = time.time() if now is None else now
        post = self.get_post(post_id)
        if post["state"] != "posted":
            raise conflict("numbers can only be added to a posted post")
        values = dict(views=_num(views, "views", True), avg_view_duration_s=_num(avg_view_duration_s, "avg_view_duration_s"),
                      video_length_s=_num(video_length_s, "video_length_s"), likes=_num(likes, "likes", True),
                      comments=_num(comments, "comments", True), shares=_num(shares, "shares", True),
                      follows_gained=_num(follows_gained, "follows_gained", True))
        taken = now if taken_at is None else _num(taken_at, "taken_at")
        if post["posted_at"] is not None and taken < post["posted_at"]:
            raise StudioError("those numbers are dated before the post went up")
        sid = self._insert("snapshots", post_id=post_id, taken_at=taken, source=_clean_text(source, "source", 40), **values)
        return self._row("SELECT * FROM snapshots WHERE id = ?", (sid,))

    def add_snapshots(self, rows, now=None, source="manual"):
        """A batch of snapshots, all or nothing: one bad row stores none of them."""
        if not isinstance(rows, list) or not rows or len(rows) > 500:
            raise StudioError("send between 1 and 500 rows")
        with self.lock:
            stored = []
            try:
                for row in rows:
                    if not isinstance(row, dict) or "post_id" not in row:
                        raise StudioError("each row needs a post_id")
                    fields = {k: v for k, v in row.items() if k != "post_id"}
                    unknown = set(fields) - {"views", "avg_view_duration_s", "video_length_s", "likes", "comments",
                                             "shares", "follows_gained", "taken_at"}
                    if unknown:
                        raise StudioError(f"unknown fields: {', '.join(sorted(unknown))}")
                    stored.append(self.add_snapshot(row["post_id"], now=now, source=source, **fields))
            except (StudioError, TypeError):
                for snap in stored:
                    self._write("DELETE FROM snapshots WHERE id = ?", (snap["id"],))
                raise
            return stored

    def snapshots(self, post_id=None):
        if post_id is not None:
            return self._rows("SELECT * FROM snapshots WHERE post_id = ? ORDER BY taken_at, id", (post_id,))
        return self._rows("SELECT * FROM snapshots ORDER BY post_id, taken_at, id")

    # -- decisions and reviews ------------------------------------------------------------------

    def add_decision(self, kind, subject_type, subject_id, subject_name, status, proposed_by, numbers=None, reason="",
                     payload=None, confirmed_by=None, user_ok_by=None, now=None):
        now = time.time() if now is None else now
        did = self._insert("decisions", kind=kind, subject_type=subject_type, subject_id=subject_id,
                           subject_name=subject_name, numbers=numbers or {}, reason=reason, payload=payload or {},
                           status=status, proposed_by=proposed_by, confirmed_by=confirmed_by, user_ok_by=user_ok_by, at=now,
                           resolved_at=now if status in ("confirmed", "rejected") else None)
        return self.get_decision(did)

    def get_decision(self, decision_id):
        row = self._row("SELECT * FROM decisions WHERE id = ?", (decision_id,))
        if not row:
            raise not_found("decision")
        return row

    def list_decisions(self, status=None, kind=None):
        where, args = [], []
        for col, value in (("status", status), ("kind", kind)):
            if value is not None:
                where.append(f"{col} = ?")
                args.append(value)
        clause = f"WHERE {' AND '.join(where)}" if where else ""
        return self._rows(f"SELECT * FROM decisions {clause} ORDER BY id", tuple(args))

    def update_decision(self, decision_id, **fields):
        self._update("decisions", decision_id, **fields)
        return self.get_decision(decision_id)

    def record_review(self, at, marks):
        with self.lock:
            review_id = self._insert("reviews", at=at)
            for m in marks:
                self._insert("review_marks", review_id=review_id, subject_type=m["subject_type"], subject_id=m["subject_id"],
                             score=m["score"], median=m.get("median"), behind=1 if m["behind"] else 0)
        return review_id

    def recent_reviews(self, count):
        return self._rows("SELECT * FROM reviews ORDER BY at DESC, id DESC LIMIT ?", (count,))

    def marks_for(self, review_id):
        return self._rows("SELECT * FROM review_marks WHERE review_id = ?", (review_id,))
