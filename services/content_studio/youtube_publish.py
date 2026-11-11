"""Direct YouTube posting for Content Studio, through the person's own Google project (build spec "Content
Studio Team", section 6 and D1).

Prepare post (the Kairos Browser) stays the default route for every platform. This is the optional second route
D1 adds for YouTube: the person connects posting ("Connect YouTube posting"), which adds the youtube.upload grant
(plus youtube.readonly, so Kairos can check the channel) to one of their Google sign-ins, made with the Google
OAuth client they entered in Kairos. Nothing is uploaded until a post is approved, and only an approved post on a
live, unpaused YouTube channel that the signed-in Google account owns is ever sent, exactly as approved: the
title, the caption as the description, the tags, the video file the Editor rendered, and YouTube's
altered-or-synthetic content flag (the AI label) always on.

Unaudited Google projects: YouTube may keep uploads from a project that has not passed its API audit private.
The privacy the person picks is requested; when YouTube returns a stricter one, the result says so and the post
is recorded with what YouTube actually set. Public posts then go out through Prepare post.

Unverified against a real Google project (no account was used to build this): the containsSyntheticMedia field
name and the private lock are from YouTube's published API notes as remembered, to confirm on first real use.

Per channel, like analytics (youtube.py): data/accounts/<id>/content_studio/youtube_posting.json holds each YouTube
channel's Google account for posting ({"channels": {channel id: {"google_account", ...}}}), the privacy and the last
upload. Each channel posts through its own Google account, which must own it.
"""
import asyncio
import json
import os
import re
import secrets
import time
from urllib.parse import unquote

from core import accounts
from core import google_workspace as google

from . import youtube
from .store import StudioError

SCOPES = google.YOUTUBE_UPLOAD_SCOPES
PRIVACY = ("private", "unlisted", "public")
MAX_BYTES = 256 * 1024 * 1024    # a short video is far below this; the upload is sent in one request
UPLOAD_TIMEOUT_S = 900
CATEGORY_PEOPLE_BLOGS = "22"     # YouTube's default category for an upload
NOTICE = ("Posting goes through your own Google project and only ever sends a post you approved. YouTube may keep "
          "uploads from a project that has not passed its API audit private, whatever you choose here. For public "
          "posts until then, use Prepare post. Every upload carries YouTube's AI-content label.")

_locks = {}       # account id -> asyncio.Lock: one upload at a time per account
_sending = set()  # (account id, post id) in flight, so a second tap never uploads twice


class PostingError(StudioError):
    pass


def _load():
    return youtube._load("posting")


def _save(state):
    youtube._save(state, "posting")


def status(user=None, store=None):
    state, out = youtube.link_status("posting", user, store)
    out.update(privacy=state.get("privacy") or "private", privacy_choices=list(PRIVACY),
               last_upload=state.get("last_upload"), notice=NOTICE)
    return out


def connect(redirect_uri, user, channel_id, google_account=None, new_account=False, store=None):
    """Connect one YouTube channel for posting: the Google account that owns it gets youtube.upload (plus
    youtube.readonly, so Kairos can check the channel). See youtube.connect_channel."""
    return youtube.connect_channel("posting", redirect_uri, user, channel_id, google_account, new_account, store)


def set_privacy(privacy):
    if privacy not in PRIVACY:
        raise PostingError(f"privacy is one of {', '.join(PRIVACY)}")
    state = _load()
    state["privacy"] = privacy
    _save(state)
    return status()


def disconnect(user=None, channel_id=None, store=None):
    """Stops posting from Kairos for one channel, or all of them (the privacy choice goes too). The grant itself
    is Google's to revoke (myaccount.google.com)."""
    youtube.unlink("posting", user, channel_id, store)
    return status(user, store)


# -- the file the Editor rendered ---------------------------------------------------------------------

_STUDIO = re.compile(r"^/api/videos/([a-f0-9]{12})/renders/([A-Za-z0-9._-]+\.mp4)$")
_GENERATED = re.compile(r"^/generated-files/([^/?#]+)$")


def render_file(render_ref):
    """The local MP4 a post's render_ref names: a Studio render link or a generated-files link. Anything else
    (a bare Studio video id, an outside link, free text) cannot be uploaded and says why."""
    ref = (render_ref or "").strip()
    folder = name = None
    match = _STUDIO.match(ref)
    if match:
        from core import video_store
        folder, name = str(video_store._folder(match.group(1)) / "renders"), match.group(2)
    else:
        match = _GENERATED.match(ref)
        if match:
            from core import image_gen
            folder, name = image_gen.generated_files_dir(), unquote(match.group(1))
    if folder is None:
        raise PostingError("The post has no rendered MP4 to upload. The Editor records the render link "
                           "(/api/videos/<id>/renders/<file>.mp4) when the video is rendered.", 409)
    if not name.lower().endswith(".mp4") or os.path.basename(name) != name or name.startswith("."):
        raise PostingError("Only a rendered MP4 can be uploaded.", 409)
    path = os.path.realpath(os.path.join(folder, name))
    if os.path.dirname(path) != os.path.realpath(folder) or not os.path.isfile(path):
        raise PostingError("The rendered video file is missing. Render it again in Studio.", 409)
    if os.path.getsize(path) > MAX_BYTES:
        raise PostingError("The video is over 256 MB; post it with Prepare post.", 413)
    return path


def _tags(text):
    tags, total = [], 0
    for raw in (text or "").split(","):
        tag = raw.strip().lstrip("#").strip()
        if tag and tag.lower() not in {t.lower() for t in tags} and total + len(tag) <= 450:
            tags.append(tag[:100])
            total += len(tag)
    return tags


def description(post):
    """The caption, and for a long video its chapter list (YouTube's chapter format: "0:00 Title" per line, the first
    at 0:00), unless the caption already carries one. The person saw the chapters on the approval card."""
    from .store import youtube_chapters
    caption = post.get("caption") or ""
    chapters = youtube_chapters(post)
    if not chapters or re.search(r"(?m)^\s*0?0:00\b", caption):
        return caption
    return (caption.rstrip() + "\n\nChapters\n" + chapters).strip()


def metadata(post, privacy, publish_at=None, made_for_kids=False):
    """Exactly what was approved, plus the AI label. YouTube refuses < and > in titles and descriptions.
    `publish_at` (a schedule set on the prepared post) becomes YouTube's scheduled publish: the video uploads private
    and YouTube makes it public at that time (an unaudited project may keep it private regardless)."""
    clean = lambda s: (s or "").replace("<", "").replace(">", "")
    status = {"privacyStatus": privacy, "selfDeclaredMadeForKids": bool(made_for_kids), "containsSyntheticMedia": True}
    if publish_at:
        status.update(privacyStatus="private", publishAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(publish_at)))
    return {"snippet": {"title": clean(post["title"])[:100], "description": clean(description(post))[:5000],
                        "tags": _tags(post.get("tags")), "categoryId": CATEGORY_PEOPLE_BLOGS}, "status": status}


def _body(meta, video):
    boundary = "kairos_" + secrets.token_hex(16)
    head = (f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{json.dumps(meta)}\r\n"
            f"--{boundary}\r\nContent-Type: video/mp4\r\n\r\n").encode("utf-8")
    return head + video + f"\r\n--{boundary}--\r\n".encode("ascii"), f"multipart/related; boundary={boundary}"


# -- posting ------------------------------------------------------------------------------------------

def check(store, post_id):
    """Why this post cannot be posted directly right now, or None. Used by the screen and the Publisher."""
    try:
        _ready(store, post_id)
    except StudioError as exc:
        return exc.detail
    return None


def _ready(store, post_id):
    post = store.get_post(post_id)
    if post["state"] != "approved":
        raise PostingError("Only a post you approved can be posted.", 409)
    channel = store.get_channel(post["channel_id"])
    if channel["platform"] != "youtube":
        raise PostingError("Direct posting is for YouTube only. Use Prepare post for this platform.", 409)
    if channel["status"] != "live" or channel["paused"]:
        raise PostingError("That channel is archived or paused.", 409)
    if store.audience(post)["made_for_kids"] is None:
        raise PostingError("Say whether this video is made for kids first (on the channel's Look or on the post): this blocky "
                           "world look draws children, and YouTube asks every upload.", 409)
    ident = youtube.connected_links("posting", store).get(channel["id"])
    if ident is None:
        raise PostingError(f"Connect YouTube posting for {channel['handle']} first.", 409)
    return post, channel, ident, render_file(post["render_ref"])


async def publish(store, post_id, by, now=None):
    """Uploads one approved post to its YouTube channel and records the posted link. Returns what YouTube set."""
    account = accounts.effective_account()
    key = (account, post_id)
    if key in _sending:
        raise PostingError("That post is already uploading.", 409)
    _sending.add(key)
    try:
        async with _locks.setdefault(account, asyncio.Lock()):
            post, channel, ident, path = _ready(store, post_id)
            state = _load()
            try:
                owned = await youtube._owned_channels(ident)
            except youtube._Quota as exc:
                raise PostingError("YouTube's quota for your project ran out. Try again tomorrow, or use Prepare post.", 429) from exc
            except StudioError as exc:
                raise PostingError(exc.detail, exc.status) from exc
            owner_id = youtube._owner_of(channel, owned)
            if owner_id is None:
                email = (google.account_info(ident) or {}).get("email")
                raise PostingError("The connected Google account does not own this channel. "
                                   + youtube.not_owned_text(email, channel["handle"], owned), 409)
            privacy = state.get("privacy") or "private"
            prep = store.preparation_for(post_id)
            publish_at = prep["scheduled_at"] if prep and prep.get("scheduled_at") and prep["scheduled_at"] > time.time() + 60 else None
            if publish_at:
                privacy = "private"   # a scheduled upload is private until YouTube publishes it at publish_at
            with open(path, "rb") as handle:
                content, kind = _body(metadata(post, privacy, publish_at, store.audience(post)["made_for_kids"]), handle.read())
            try:
                answer = await google.request("youtube_upload", "POST", "/videos",
                                              params={"part": "snippet,status", "uploadType": "multipart"},
                                              content=content, content_type=kind, account=ident, timeout=UPLOAD_TIMEOUT_S)
            except google.GoogleError as exc:
                if exc.status in (401, 403) and exc.reason not in youtube.QUOTA_REASONS:
                    raise PostingError("YouTube refused the upload for this sign-in. Connect YouTube posting again.", 409) from exc
                if exc.status == 429 or exc.reason in youtube.QUOTA_REASONS:
                    raise PostingError("YouTube's upload quota for your project ran out. Try again tomorrow, or use Prepare post.", 429) from exc
                raise PostingError(f"YouTube did not take the upload: {exc}", 502) from exc
            video = answer.get("id") if isinstance(answer, dict) else None
            if not video:
                raise PostingError("YouTube answered without a video id; check YouTube Studio before trying again.", 502)
            if (answer.get("snippet") or {}).get("channelId") not in (None, owner_id):
                raise PostingError("YouTube put the video on a different channel than the one registered; check YouTube Studio.", 502)
            actual = (answer.get("status") or {}).get("privacyStatus") or privacy
            url = f"https://www.youtube.com/watch?v={video}"
            posted = store.mark_posted(post_id, url, now=now)
            stricter = PRIVACY.index(actual) < PRIVACY.index(privacy) if actual in PRIVACY else False
            result = {"post": posted, "video_id": video, "url": url, "privacy": actual, "asked_privacy": privacy,
                      "kept_private": stricter, "by": by, "publish_at": publish_at,
                      "note": ("YouTube kept it " + actual + ". Uploads from a project that has not passed YouTube's API "
                               "audit stay private; make it public in YouTube Studio or use Prepare post.") if stricter else
                              (f"Scheduled: YouTube makes it public at {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime(publish_at))}."
                               if publish_at else "")}
            state["last_upload"] = {"post_id": post_id, "video_id": video, "privacy": actual, "at": time.time() if now is None else now}
            _save(state)
            return result
    except PostingError as exc:
        if exc.status >= 500 or exc.status in (413, 429) or exc.detail.startswith(("YouTube", "The connected Google account")):
            # The dashboard shows the failed state with YouTube's reason (only for a post that was prepared).
            from . import prepare
            try:
                if store.get_post(post_id)["state"] == "approved":
                    prepare.record_failure(store, post_id, exc.detail, now=now)
            except StudioError:
                pass
        raise
    finally:
        _sending.discard(key)
