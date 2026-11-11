"""The Content Studio scoring record: one SQLite file per account (Content Studio Team build spec, sections 3-5, 8).

Niches, channels (made by the user, never by bots), topics with evidence, posts, metrics snapshots as a time
series, strategies and decisions. Plain storage and the rules that protect it (caps, state changes); the
selection maths is in scoring.py and review.py. Every time-dependent call takes `now` so tests can move the clock.
"""
import hashlib
import json
import os
import re
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
    "batch_approval": False,     # spec section 2: a per-post OK first; the person turns on one-tap batch approval later
    # Page-read analytics (page_reads.py): reading TikTok and Instagram numbers from the person's own signed-in pages in
    # the Kairos Browser. Off until the person turns each platform on.
    "page_reads": {"tiktok": False, "instagram": False},
    "page_reads_reset": {},      # platform -> when the person pressed Try again after the reads paused
}
TEAM_ROLES = ("producer", "researcher", "evaluator", "script_writer", "editor", "publisher", "executor")
ASPECTS = ("9:16", "16:9", "1:1")
# Columns added after the first release; a store made before them gains them when it opens.
LATER_COLUMNS = {"snapshots": {"source": "TEXT NOT NULL DEFAULT 'manual'"},
                 "channels": {"look": "TEXT", "aspect": "TEXT", "notes": "TEXT NOT NULL DEFAULT ''", "voice": "TEXT", "style_pack": "TEXT",
                              "long_per_week": "INTEGER", "renderer": "TEXT", "fps": "INTEGER", "made_for_kids": "INTEGER"},
                 "posts": {"pick_reason": "TEXT NOT NULL DEFAULT ''", "tags": "TEXT NOT NULL DEFAULT ''",
                           "ai_label": "INTEGER NOT NULL DEFAULT 1", "format_id": "INTEGER REFERENCES formats(id)",
                           "port_id": "INTEGER REFERENCES ports(id)", "style_pack": "TEXT",
                           "thumbnail": "TEXT NOT NULL DEFAULT ''", "long_form": "INTEGER NOT NULL DEFAULT 0", "video_id": "TEXT",
                           "made_for_kids": "INTEGER"}}
# Made for kids (YouTube's audience setting, which the law behind it requires creators to answer honestly): "yes", "no",
# or "" for not set. A post's own answer wins over its channel's. A blocky world (Pack C) post with neither cannot be
# prepared or posted: that look draws children, so the person says. Other posts default to "no", as before.
AUDIENCE = {"": None, "no": 0, "yes": 1}
# What a post keeps as appeal evidence (Video Styles build spec section 7): the person's approval, the shot plan,
# the sources behind its facts, and the policy checks it passed.
EVIDENCE_KINDS = ("approval", "shot_plan", "sources", "policy_check", "port", "plan_approval", "api_post")
VOICE_ID = re.compile(r"^[a-z]{2}_[a-z0-9]{1,30}$")
# Long-form (Video Styles section 7, V3, locked): one long video a week per YouTube channel, plus daily Shorts. The cap is
# set per channel (0 to 7) and is soft: the person can change it on the channel; the team plans long videos within it.
LONG_PER_WEEK = {"youtube": 1, "tiktok": 0, "instagram": 0}
LONG_FORM_PLATFORMS = ("youtube",)
WEEK = 7 * DAY


def youtube_chapters(post):
    """The chapter list a long post's render carries for its YouTube description ("0:00 Title" lines), or ""."""
    if not post.get("long_form"):
        return ""
    from core import video_longform
    return video_longform.chapters_for_render(post.get("render_ref"))


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
  created_at REAL NOT NULL, archived_at REAL, archive_reason TEXT, look TEXT, aspect TEXT, notes TEXT NOT NULL DEFAULT '');
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
  created_at REAL NOT NULL, step_since REAL NOT NULL, pick_reason TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES posts(id), taken_at REAL NOT NULL,
  views INTEGER NOT NULL, avg_view_duration_s REAL NOT NULL, video_length_s REAL NOT NULL,
  likes INTEGER NOT NULL, comments INTEGER NOT NULL, shares INTEGER NOT NULL, follows_gained INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual');
CREATE INDEX IF NOT EXISTS snapshots_post ON snapshots(post_id, taken_at);
CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY, at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS post_evidence (
  id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES posts(id), kind TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '{}', at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS post_evidence_post ON post_evidence(post_id, id);
CREATE TABLE IF NOT EXISTS formats (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, premise TEXT NOT NULL, beats TEXT NOT NULL DEFAULT '[]',
  length_min_s REAL NOT NULL, length_max_s REAL NOT NULL, audience TEXT NOT NULL DEFAULT '{}',
  source_niche TEXT NOT NULL DEFAULT '', do_not_use TEXT NOT NULL DEFAULT '[]', evidence TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active', created_by TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL,
  updated_at REAL NOT NULL, retired_at REAL, retire_reason TEXT);
CREATE TABLE IF NOT EXISTS ports (
  id INTEGER PRIMARY KEY, format_id INTEGER NOT NULL REFERENCES formats(id), niche_id INTEGER NOT NULL REFERENCES niches(id),
  audience_match TEXT NOT NULL, audience_evidence TEXT NOT NULL DEFAULT '[]', premise TEXT NOT NULL,
  subject TEXT NOT NULL, mascot TEXT NOT NULL DEFAULT '', style_pack TEXT NOT NULL, thumbnail TEXT NOT NULL DEFAULT '',
  example_title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'proposed', checks TEXT NOT NULL DEFAULT '{}',
  verdict_by TEXT, verdict_reason TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL,
  decided_at REAL);
CREATE TABLE IF NOT EXISTS preparations (
  id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL UNIQUE REFERENCES posts(id), platform TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'prepared', route TEXT NOT NULL DEFAULT 'browser', package TEXT NOT NULL DEFAULT '{}',
  scheduled_at REAL, prepared_by TEXT NOT NULL DEFAULT '', prepared_at REAL NOT NULL, opened_at REAL,
  fill TEXT NOT NULL DEFAULT '{}', error TEXT NOT NULL DEFAULT '', updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS page_reads (
  id INTEGER PRIMARY KEY, platform TEXT NOT NULL, post_id INTEGER REFERENCES posts(id), url TEXT NOT NULL DEFAULT '',
  at REAL NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', snapshot_id INTEGER);
CREATE INDEX IF NOT EXISTS page_reads_at ON page_reads(platform, at);
CREATE TABLE IF NOT EXISTS review_marks (
  review_id INTEGER NOT NULL REFERENCES reviews(id), subject_type TEXT NOT NULL, subject_id INTEGER NOT NULL,
  score REAL NOT NULL, median REAL, behind INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id INTEGER NOT NULL,
  subject_name TEXT NOT NULL DEFAULT '', numbers TEXT NOT NULL DEFAULT '{}', reason TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL, proposed_by TEXT NOT NULL,
  confirmed_by TEXT, user_ok_by TEXT, at REAL NOT NULL, resolved_at REAL);
"""
JSON_COLS = {"numbers", "payload", "body", "beats", "audience", "do_not_use", "evidence", "audience_evidence", "checks", "package", "fill"}
JSON_LISTS = {"beats", "do_not_use", "evidence", "audience_evidence"}


def _audience(value):
    """A made-for-kids answer as stored: 1, 0, or None (not set)."""
    if isinstance(value, bool):
        return int(value)
    if value not in AUDIENCE:
        raise StudioError('made for kids is "yes", "no", or empty for not set')
    return AUDIENCE[value]


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
        for table, columns in LATER_COLUMNS.items():
            have = {row["name"] for row in self.db.execute(f"PRAGMA table_info({table})")}
            for name, kind in columns.items():
                if name not in have:
                    self.db.execute(f"ALTER TABLE {table} ADD COLUMN {name} {kind}")
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
                    item[col] = json.loads(item[col] or ("[]" if col in JSON_LISTS else "{}"))
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
            elif key == "batch_approval":
                if not isinstance(value, bool):
                    raise StudioError("batch_approval is true or false")
            elif key == "page_reads":
                if not isinstance(value, dict) or not set(value) <= {"tiktok", "instagram"} or \
                        any(not isinstance(v, bool) for v in value.values()):
                    raise StudioError("page_reads maps tiktok and instagram to true or false")
                value = {**current[key], **value}
            elif key == "page_reads_reset":
                if not isinstance(value, dict) or not set(value) <= {"tiktok", "instagram"}:
                    raise StudioError("page_reads_reset maps tiktok and instagram to a time")
                value = {**current[key], **{k: _num(v, "reset time") for k, v in value.items()}}
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

    def long_cap(self, channel):
        """Long videos a week this channel takes: its own setting, else one on YouTube and none elsewhere."""
        if channel["platform"] not in LONG_FORM_PLATFORMS:
            return 0
        own = channel.get("long_per_week")
        return LONG_PER_WEEK.get(channel["platform"], 0) if own is None else own

    def long_this_week(self, channel_id, now=None):
        """Long videos planned for the channel in the last seven days (rejected ones do not count)."""
        now = time.time() if now is None else now
        row = self._row("SELECT COUNT(*) AS n FROM posts WHERE channel_id = ? AND long_form = 1 AND state != 'rejected' "
                        "AND created_at > ?", (channel_id, now - WEEK))
        return row["n"] if row else 0

    def edit_channel(self, channel_id, look=None, aspect=None, notes=None, voice=None, style_pack=None, long_per_week=None,
                     renderer=None, fps=None, made_for_kids=None):
        """The channel's own look (a Studio video look id), aspect, voice notes, narrator voice (a Kokoro voice id) and
        style pack (a built-in or the account's own approved pack), so the Editor and Script Writer make each channel's
        posts in its own style and the channel keeps one voice. None leaves a field as it is; "" clears it.
        `renderer` picks what draws a glossy 3D pack's videos on this channel: "threejs" (built in), "blender" (only when
        Blender is installed, core/blender_tools.py), or "" for the pack's own choice. `fps` is the channel's frame
        rate, 30 or 60 (0 clears it back to 30): the Editor makes the channel's videos at it. `made_for_kids` is the
        channel's audience answer ("yes", "no", or "" for not set), used for every post that has no answer of its own."""
        self.get_channel(channel_id)
        changes = {}
        if made_for_kids is not None:
            changes["made_for_kids"] = _audience(made_for_kids)
        if fps is not None:
            if isinstance(fps, bool) or fps not in (0, 30, 60):
                raise StudioError("the frame rate is 30 or 60 frames a second")
            changes["fps"] = fps if fps == 60 else None
        if renderer is not None:
            if renderer not in ("", "threejs", "blender"):
                raise StudioError("the 3D renderer is threejs, blender, or empty for the style pack's own choice")
            if renderer == "blender":
                from core import blender_tools
                if not blender_tools.find():
                    raise StudioError(blender_tools.detect()["message"])
            changes["renderer"] = renderer or None
        if style_pack is not None:
            style_pack = _clean_text(style_pack, "style pack", 40, False)
            if style_pack:
                from core import style_packs
                pack = style_packs.get(style_pack)
                if pack is None:
                    raise StudioError("that style pack is not in this account")
                if not pack["available"]:
                    raise StudioError(f"{pack['name']} cannot be used yet: {pack['note']}")
            changes["style_pack"] = style_pack or None
        if voice is not None:
            voice = _clean_text(voice, "voice", 40, False)
            if voice and not VOICE_ID.match(voice):
                raise StudioError("the narrator voice is a Kokoro voice id, for example af_heart or bm_george")
            changes["voice"] = voice or None
        if look is not None:
            look = _clean_text(look, "look", 80, False)
            if look and not all(ch.isalnum() or ch in "-_" for ch in look):
                raise StudioError("a look id uses letters, digits, - and _")
            changes["look"] = look or None
        if aspect is not None:
            if aspect not in ("",) + ASPECTS:
                raise StudioError(f"aspect must be one of {', '.join(ASPECTS)}")
            changes["aspect"] = aspect or None
        if notes is not None:
            changes["notes"] = _clean_text(notes, "notes", 1000, False)
        if long_per_week is not None:
            if isinstance(long_per_week, bool) or not isinstance(long_per_week, int) or not 0 <= long_per_week <= 7:
                raise StudioError("long videos a week is a whole number from 0 to 7")
            if long_per_week and self.get_channel(channel_id)["platform"] not in LONG_FORM_PLATFORMS:
                raise StudioError("long videos are for YouTube channels; this channel makes Shorts only")
            changes["long_per_week"] = long_per_week
        if changes:
            self._update("channels", channel_id, **changes)
        return self.get_channel(channel_id)

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

    # -- format cards and ports (formats.py validates; policy.py checks a port) ---------------------

    def save_format(self, data, by="", format_id=None, now=None):
        """A new format card, or a new version of one (the whole card is given again; evidence keeps its dates)."""
        from .formats import clean_format
        now = time.time() if now is None else now
        fields = clean_format(data)
        with self.lock:
            clash = self._row("SELECT id FROM formats WHERE lower(name) = lower(?) AND status = 'active' AND id IS NOT ?",
                              (fields["name"], format_id))
            if clash:
                raise conflict(f"an active format card is already called {fields['name']!r} (format {clash['id']})")
            if format_id is None:
                format_id = self._insert("formats", **fields, created_by=_clean_text(by, "by", 80, False), created_at=now,
                                         updated_at=now)
            else:
                if self.get_format(format_id)["status"] != "active":
                    raise conflict("that format card is retired")
                self._update("formats", format_id, **fields, updated_at=now)
        return self.get_format(format_id)

    def ensure_shipped_formats(self, now=None):
        """Kairos's shipped format cards (formats.SHIPPED) in this store, once each: added when missing, never brought back
        after the team retired one, never changed under the team."""
        from .formats import SHIPPED, SHIPPED_BY, clean_format
        now = time.time() if now is None else now
        added = []
        with self.lock:
            for card in SHIPPED.values():
                if self._row("SELECT id FROM formats WHERE lower(name) = lower(?)", (card["name"],)):
                    continue
                added.append(self._insert("formats", **clean_format(card, shipped=True), created_by=SHIPPED_BY, created_at=now, updated_at=now))
        return added

    def get_format(self, format_id):
        row = self._row("SELECT * FROM formats WHERE id = ?", (format_id,))
        if not row:
            raise not_found("format card")
        return row

    def list_formats(self, status=None):
        if status:
            return self._rows("SELECT * FROM formats WHERE status = ? ORDER BY id", (status,))
        return self._rows("SELECT * FROM formats ORDER BY id")

    def retire_format(self, format_id, reason, now=None):
        """Out of the rotation, history kept: its ports retire with it and its posts keep their format id."""
        now = time.time() if now is None else now
        if self.get_format(format_id)["status"] != "active":
            raise conflict("that format card is already retired")
        with self.lock:
            self._update("formats", format_id, status="retired", retired_at=now, retire_reason=_clean_text(reason, "reason", 300, False))
            self._write("UPDATE ports SET status = 'retired', decided_at = ? WHERE format_id = ? AND status IN ('proposed', 'accepted')",
                        (now, format_id))
        return self.get_format(format_id)

    PORT_SQL = ("SELECT p.*, f.name AS format_name, f.source_niche, n.name AS niche_name FROM ports p "
                "JOIN formats f ON f.id = p.format_id JOIN niches n ON n.id = p.niche_id")

    def create_port(self, format_id, niche_id, data, by="", now=None):
        from .formats import clean_port
        now = time.time() if now is None else now
        if self.get_format(format_id)["status"] != "active":
            raise conflict("that format card is retired")
        if self.get_niche(niche_id)["status"] != "live":
            raise conflict("a port goes into a live niche")
        fields = clean_port(data)
        with self.lock:
            if self._row("SELECT id FROM ports WHERE format_id = ? AND niche_id = ? AND status IN ('proposed', 'accepted')",
                         (format_id, niche_id)):
                raise conflict("that format already has an open port into this niche")
            port_id = self._insert("ports", format_id=format_id, niche_id=niche_id, **fields,
                                   created_by=_clean_text(by, "by", 80, False), created_at=now)
        return self.get_port(port_id)

    def get_port(self, port_id):
        row = self._row(f"{self.PORT_SQL} WHERE p.id = ?", (port_id,))
        if not row:
            raise not_found("port")
        return row

    def list_ports(self, format_id=None, status=None, niche_id=None):
        where, args = [], []
        for col, value in (("p.format_id", format_id), ("p.status", status), ("p.niche_id", niche_id)):
            if value is not None:
                where.append(f"{col} = ?")
                args.append(value)
        clause = f"WHERE {' AND '.join(where)}" if where else ""
        return self._rows(f"{self.PORT_SQL} {clause} ORDER BY p.id", tuple(args))

    def record_port_checks(self, port_id, checks):
        self.get_port(port_id)
        self._update("ports", port_id, checks=checks)
        return self.get_port(port_id)

    def decide_port(self, port_id, status, by, reason="", now=None):
        """The Evaluator's verdict on a proposed port. Accepting needs checks that passed (policy.port_findings)."""
        now = time.time() if now is None else now
        if status not in ("accepted", "rejected"):
            raise StudioError("a verdict is accepted or rejected")
        port = self.get_port(port_id)
        if port["status"] != "proposed":
            raise conflict(f"that port is already {port['status']}")
        self._update("ports", port_id, status=status, verdict_by=_clean_text(by, "by", 80, False),
                     verdict_reason=_clean_text(reason, "reason", 500, False), decided_at=now)
        return self.get_port(port_id)

    # -- posts ----------------------------------------------------------------------------------

    POST_SQL = ("SELECT p.*, c.platform, c.handle, c.niche_id, n.name AS niche_name, f.name AS format_name FROM posts p "
                "JOIN channels c ON c.id = p.channel_id JOIN niches n ON n.id = c.niche_id LEFT JOIN formats f ON f.id = p.format_id")

    def create_post(self, channel_id, title, topic_id=None, script_strategy_id=None, evaluator_strategy_id=None,
                    script_ref=None, caption="", format=None, pick_reason="", format_id=None, port_id=None, style_pack=None,
                    long_form=False, now=None):
        now = time.time() if now is None else now
        channel = self.get_channel(channel_id)
        if channel["status"] != "live":
            raise conflict("that channel is archived")
        if channel["paused"]:
            raise conflict("that channel is paused after a platform warning")
        if long_form:
            cap = self.long_cap(channel)
            if channel["platform"] not in LONG_FORM_PLATFORMS:
                raise StudioError("long videos are made for YouTube channels; make a Short for this channel")
            used = self.long_this_week(channel_id, now)
            if used >= cap:
                raise conflict(f"{channel['handle']} takes {cap} long video{'' if cap == 1 else 's'} a week and {used} "
                               f"{'is' if used == 1 else 'are'} already planned in the last 7 days; make a Short, or the person "
                               "can change the channel's long videos a week in Studio > Content > Channels")
        if topic_id is not None and self.get_topic(topic_id)["niche_id"] != channel["niche_id"]:
            raise StudioError("that topic belongs to another niche")
        for sid, role in ((script_strategy_id, "script_writer"), (evaluator_strategy_id, "evaluator")):
            if sid is not None:
                self._active_strategy(sid, role)
        if port_id is not None:
            port = self.get_port(port_id)
            if port["status"] != "accepted":
                raise conflict("only an accepted port can be made")
            if port["niche_id"] != channel["niche_id"]:
                raise StudioError("that port is for another niche")
            if format_id is not None and format_id != port["format_id"]:
                raise StudioError("the port belongs to another format")
            format_id, style_pack = port["format_id"], style_pack or port["style_pack"]
        if format_id is not None and self.get_format(format_id)["status"] != "active":
            raise conflict("that format is retired")
        from .formats import all_packs
        style_pack = style_pack or channel.get("style_pack") or "motion-type"   # the channel's own pack by default
        packs = all_packs()
        if style_pack not in packs:
            raise StudioError(f"style pack must be one of {', '.join(packs)}")
        post_id = self._insert(
            "posts", channel_id=channel_id, topic_id=topic_id, title=_clean_text(title, "title", 200),
            caption=_clean_text(caption, "caption", 5000, False), format=_clean_text(format, "format", 80, False) or None,
            script_strategy_id=script_strategy_id, evaluator_strategy_id=evaluator_strategy_id,
            script_ref=_clean_text(script_ref, "script", self.EDITABLE["script_ref"], False) or None,
            pick_reason=_clean_text(pick_reason, "pick reason", 500, False), format_id=format_id, port_id=port_id,
            style_pack=style_pack, long_form=1 if long_form else 0, created_at=now, step_since=now)
        return self.get_post(post_id)

    def _active_strategy(self, strategy_id, role):
        strategy = self.get_strategy(strategy_id)
        if strategy["owner_role"] != role or strategy["status"] != "active":
            raise StudioError(f"strategy {strategy_id} is not an active {role} strategy")
        return strategy

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

    EDITABLE = {"title": 200, "caption": 5000, "script_ref": 20000, "render_ref": 500, "format": 80, "tags": 500,
                "pick_reason": 500, "thumbnail": 300}
    TEXT_FIELDS = ("title", "caption", "tags", "pick_reason", "thumbnail")  # stay text when cleared; the others become None

    def edit_post(self, post_id, now=None, **fields):
        """Content edits (by the user at approval, or by a bot while drafting). Not allowed once approved."""
        now = time.time() if now is None else now
        post = self.get_post(post_id)
        if post["state"] in ("approved", "posted"):
            raise conflict(f"a {post['state']} post can no longer be edited")
        changes = {}
        for key, value in fields.items():
            if key == "ai_label":
                if value is not True:
                    raise StudioError("every post carries the AI label; it cannot be turned off")
                changes[key] = 1
            elif key == "made_for_kids":
                changes[key] = _audience(value)
            elif key == "render_status":
                if value not in ("pending", "ok", "failed"):
                    raise StudioError("render_status must be pending, ok or failed")
                changes[key] = value
            elif key in self.EDITABLE:
                text = _clean_text(value, key, self.EDITABLE[key], key == "title")
                changes[key] = text if key in self.TEXT_FIELDS else (text or None)
            elif key in ("script_strategy_id", "evaluator_strategy_id"):
                if post["state"] != "drafted":
                    raise conflict("a strategy is recorded while the post is drafted")
                if value is not None:
                    self._active_strategy(value, "script_writer" if key == "script_strategy_id" else "evaluator")
                changes[key] = value
            else:
                raise StudioError(f"cannot edit {key}")
        if "render_status" in changes or "render_ref" in changes:
            changes["step_since"] = now
        if changes:
            self._update("posts", post_id, **changes)
        return self.get_post(post_id)

    def audience(self, post):
        """Whether a post is made for kids, and where the answer comes from: {made_for_kids: True, False or None, source:
        "post", "channel", "default" or "unset"}. A blocky world (Pack C) post with no answer is "unset" (None)."""
        from . import policy
        channel = self.get_channel(post["channel_id"])
        for source, value in (("post", post.get("made_for_kids")), ("channel", channel.get("made_for_kids"))):
            if value is not None:
                return {"made_for_kids": bool(value), "source": source}
        if policy.is_voxel(post.get("style_pack")) or policy.is_voxel(channel.get("style_pack")):
            return {"made_for_kids": None, "source": "unset"}
        return {"made_for_kids": False, "source": "default"}

    def _move(self, post_id, allowed, new_state, now, **fields):
        post = self.get_post(post_id)
        if post["state"] not in allowed:
            raise conflict(f"a {post['state']} post cannot become {new_state}")
        self._update("posts", post_id, state=new_state, step_since=now, **fields)
        return self.get_post(post_id)

    def submit_for_approval(self, post_id, now=None):
        """Into the approval queue, only past the policy checks (policy.py); the result is kept as evidence."""
        from . import policy
        now = time.time() if now is None else now
        post = self.get_post(post_id)
        if post["render_status"] != "ok" or not post["render_ref"]:
            raise conflict("the video is not rendered yet")
        result = policy.check(self, post_id)
        self.add_evidence(post_id, "policy_check", {"step": "submit", **result}, now=now)
        if not result["ok"]:
            raise conflict("the policy checks stopped this post: " + policy.reasons(result))
        return self._move(post_id, ("drafted",), "awaiting_approval", now)

    def approve(self, post_id, by, now=None):
        """Approval only marks the post approved. Handing it to the platform is the Publisher's later step.
        What the person approved is kept as evidence: title, caption, tags, the render and the script's hash."""
        now = time.time() if now is None else now
        post = self.get_post(post_id)
        channel = self.get_channel(post["channel_id"])
        if channel["status"] != "live" or channel["paused"]:
            raise conflict("that channel is archived or paused")
        approved = self._move(post_id, ("awaiting_approval",), "approved", now, approved_by=by, approved_at=now)
        self.add_evidence(post_id, "approval", {
            "by": by, "at": now, "title": post["title"], "caption": post["caption"], "tags": post["tags"],
            "render_ref": post["render_ref"], "ai_label": bool(post["ai_label"]), "channel": channel["handle"],
            "platform": channel["platform"],
            "script_sha256": hashlib.sha256((post["script_ref"] or "").encode("utf-8")).hexdigest(),
            **({"chapters": youtube_chapters(post)} if post["long_form"] else {})}, now=now)
        return approved

    def link_video(self, post_id, video_id):
        """The Studio video a long post is made as (its plan goes to the person before it renders)."""
        post = self.get_post(post_id)
        if post["state"] != "drafted":
            raise conflict(f"a {post['state']} post's video cannot change")
        if not isinstance(video_id, str) or not re.fullmatch(r"[a-f0-9]{12}", video_id):
            raise StudioError("video_id is a Studio video's 12-character id")
        self._update("posts", post_id, video_id=video_id)
        return self.get_post(post_id)

    def reject(self, post_id, reason="", now=None):
        now = time.time() if now is None else now
        post = self.get_post(post_id)
        rejected = self._move(post_id, ("awaiting_approval", "approved"), "rejected", now,
                              rejection_count=post["rejection_count"] + 1, reject_reason=_clean_text(reason, "reason", 500, False))
        # A prepared package was made from what was approved; a rejected post is prepared again after its next approval.
        self._write("DELETE FROM preparations WHERE post_id = ?", (post_id,))
        return rejected

    # -- Prepare post (prepare.py assembles; publishing.py draws the dashboard) -------------------------

    PREP_STATES = ("prepared", "waiting_for_you", "posted", "failed")

    def save_preparation(self, post_id, platform, package, route, by="", scheduled_at=None, now=None):
        """The assembled post for its platform. Preparing again replaces the package and starts the state over;
        the schedule is kept unless a new one is given."""
        now = time.time() if now is None else now
        with self.lock:
            old = self.preparation_for(post_id)
            if old and old["state"] == "posted":
                raise conflict("that post is already posted")
            fields = dict(platform=platform, state="prepared", route=route, package=package,
                          prepared_by=_clean_text(by, "by", 80, False), prepared_at=now, opened_at=None, fill={}, error="",
                          updated_at=now, scheduled_at=scheduled_at if scheduled_at is not None else (old or {}).get("scheduled_at"))
            if old:
                self._update("preparations", old["id"], **fields)
                return self.get_preparation(old["id"])
            return self.get_preparation(self._insert("preparations", post_id=post_id, **fields))

    def get_preparation(self, prep_id):
        row = self._row("SELECT * FROM preparations WHERE id = ?", (prep_id,))
        if not row:
            raise not_found("prepared post")
        return row

    def preparation_for(self, post_id):
        return self._row("SELECT * FROM preparations WHERE post_id = ?", (post_id,))

    def list_preparations(self):
        return self._rows("SELECT * FROM preparations ORDER BY id")

    def update_preparation(self, prep_id, now=None, **fields):
        now = time.time() if now is None else now
        prep = self.get_preparation(prep_id)
        if "state" in fields and fields["state"] not in self.PREP_STATES:
            raise StudioError(f"a prepared post's state is one of {', '.join(self.PREP_STATES)}")
        if prep["state"] == "posted" and fields.get("state", "posted") != "posted":
            raise conflict("that post is already posted")
        if "error" in fields:
            fields["error"] = _clean_text(fields["error"], "error", 500, False)
        self._update("preparations", prep_id, updated_at=now, **fields)
        return self.get_preparation(prep_id)

    def set_schedule(self, post_id, at, now=None):
        """When the post should go out (None clears it). Only an approved post that is not posted yet; the time is
        part of the prepared post's checklist and, on YouTube's own route, YouTube's scheduled publish."""
        now = time.time() if now is None else now
        post = self.get_post(post_id)
        if post["state"] != "approved":
            raise conflict("only an approved post that is not posted yet can be scheduled")
        if at is not None:
            at = _num(at, "schedule time")
            if at < now - 60:
                raise StudioError("the schedule time is in the past")
            if at > now + 180 * DAY:
                raise StudioError("schedule at most 180 days ahead")
        prep = self.preparation_for(post_id)
        if prep is None:
            raise conflict("prepare the post first; the schedule is part of the prepared post")
        self._update("preparations", prep["id"], scheduled_at=at, updated_at=now)
        return self.get_preparation(prep["id"])

    # -- page-read analytics log (page_reads.py): what was read, when, and how it went -----------------

    PAGE_READ_STATUSES = ("ok", "signed_out", "not_yours", "parse_failed", "failed", "unavailable")

    def record_page_read(self, platform, status, post_id=None, url="", detail="", snapshot_id=None, now=None):
        now = time.time() if now is None else now
        if status not in self.PAGE_READ_STATUSES:
            raise StudioError(f"a page read is one of {', '.join(self.PAGE_READ_STATUSES)}")
        rid = self._insert("page_reads", platform=platform, post_id=post_id, url=_clean_text(url, "url", 500, False), at=now,
                           status=status, detail=_clean_text(detail, "detail", 500, False), snapshot_id=snapshot_id)
        self._write("DELETE FROM page_reads WHERE id IN (SELECT id FROM page_reads WHERE platform = ? "
                    "ORDER BY id DESC LIMIT -1 OFFSET 2000)", (platform,))
        return self._row("SELECT * FROM page_reads WHERE id = ?", (rid,))

    def page_reads(self, platform=None, since=None, post_id=None, limit=200):
        where, args = [], []
        for col, op, value in (("platform", "=", platform), ("at", ">=", since), ("post_id", "=", post_id)):
            if value is not None:
                where.append(f"{col} {op} ?")
                args.append(value)
        clause = f"WHERE {' AND '.join(where)}" if where else ""
        return self._rows(f"SELECT * FROM page_reads {clause} ORDER BY id DESC LIMIT ?", (*args, int(limit)))

    def redraft(self, post_id, now=None):
        """A rejected post goes back to the drafting steps (the rejection count stays, for the Producer's watch)."""
        now = time.time() if now is None else now
        return self._move(post_id, ("rejected",), "drafted", now, render_status="pending")

    def approve_batch(self, post_ids, by, now=None):
        """One tap approves the batch the person was shown (spec section 2), once they turned batch approval on.
        Each post is approved on its own terms; one that cannot be (moved on, or its channel paused) is skipped."""
        now = time.time() if now is None else now
        if not self.settings()["batch_approval"]:
            raise conflict("batch approval is off; approve each post, or turn it on in the team settings")
        if not isinstance(post_ids, list) or not post_ids or len(post_ids) > 200:
            raise StudioError("send between 1 and 200 post ids")
        approved, skipped = [], []
        with self.lock:
            for post_id in dict.fromkeys(post_ids):
                try:
                    approved.append(self.approve(post_id, by, now))
                except StudioError as exc:
                    skipped.append({"post_id": post_id, "reason": exc.detail})
        return {"approved": approved, "skipped": skipped}

    def mark_posted(self, post_id, url, posted_at=None, now=None):
        now = time.time() if now is None else now
        url = _clean_text(url, "posted link", 500)
        post = self.get_post(post_id)
        if any(other["posted_url"] == url and other["channel_id"] != post["channel_id"] for other in self.list_posts()):
            raise conflict("that link is already recorded on another of the team's channels; one video is never "
                           "posted on two of its own channels")
        posted = self._move(post_id, ("approved",), "posted", now, posted_url=url,
                            posted_at=now if posted_at is None else _num(posted_at, "posted_at"))
        prep = self.preparation_for(post_id)
        if prep:
            self._update("preparations", prep["id"], state="posted", error="", updated_at=now)
        return posted

    # -- appeal evidence ------------------------------------------------------------------------

    def add_evidence(self, post_id, kind, body, now=None):
        """Append-only: evidence is never edited, so it shows what was true when it was recorded."""
        now = time.time() if now is None else now
        self.get_post(post_id)
        if kind not in EVIDENCE_KINDS:
            raise StudioError(f"evidence is one of {', '.join(EVIDENCE_KINDS)}")
        if not isinstance(body, dict) or len(json.dumps(body, default=str)) > 60000:
            raise StudioError("evidence is an object under 60 KB")
        eid = self._insert("post_evidence", post_id=post_id, kind=kind, body=json.loads(json.dumps(body, default=str)), at=now)
        return self._row("SELECT * FROM post_evidence WHERE id = ?", (eid,))

    def evidence(self, post_id, kind=None):
        self.get_post(post_id)
        if kind:
            return self._rows("SELECT * FROM post_evidence WHERE post_id = ? AND kind = ? ORDER BY id", (post_id, kind))
        return self._rows("SELECT * FROM post_evidence WHERE post_id = ? ORDER BY id", (post_id,))

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
