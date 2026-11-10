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

Per account: data/accounts/<id>/content_studio/youtube_posting.json (which Google account, the privacy).
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
from core.atomic_io import read_json, write_json_atomic

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


def _state_path():
    return os.path.join(accounts.account_dir(create=False), "content_studio", "youtube_posting.json")


def _load():
    state = read_json(_state_path(), {})
    return state if isinstance(state, dict) else {}


def _save(state):
    os.makedirs(os.path.dirname(_state_path()), exist_ok=True)
    write_json_atomic(_state_path(), state)


def _link():
    state = _load()
    info = google.account_info(state.get("google_account")) if state.get("google_account") else None
    granted = bool(info and info["connected"] and set(SCOPES) <= set(info["granted_scopes"]))
    return state, info, granted


def status():
    state, info, granted = _link()
    connected = bool(state.get("google_account") and granted)
    return {"configured": google.configured(), "connected": connected,
            "pending": bool(state.get("google_account")) and not connected,
            "google_account": {"id": info["id"], "email": info["email"]} if info else None,
            "needs_reconnect": bool(info and info.get("error")), "privacy": state.get("privacy") or "private",
            "privacy_choices": list(PRIVACY), "scopes": list(SCOPES), "last_upload": state.get("last_upload"),
            "notice": NOTICE}


def connect_url(redirect_uri, user, google_account=None):
    """The consent page that adds YouTube posting to one of this user's Google sign-ins."""
    try:
        ident = google.resolve_account(user, google_account)
        url = google.start_sign_in(redirect_uri, user, account_id=ident, extra_scopes=SCOPES)
    except google.GoogleError as exc:
        raise PostingError(str(exc), 409 if exc.status == 401 else exc.status) from exc
    state = _load()
    if state.get("google_account") != ident:
        state = {"google_account": ident, "privacy": state.get("privacy") or "private"}
    state["requested_at"] = time.time()
    _save(state)
    return url


def set_privacy(privacy):
    if privacy not in PRIVACY:
        raise PostingError(f"privacy is one of {', '.join(PRIVACY)}")
    state = _load()
    state["privacy"] = privacy
    _save(state)
    return status()


def disconnect():
    """Stops posting from Kairos. The grant itself is Google's to revoke (myaccount.google.com)."""
    try:
        os.remove(_state_path())
    except FileNotFoundError:
        pass
    return status()


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


def metadata(post, privacy):
    """Exactly what was approved, plus the AI label. YouTube refuses < and > in titles and descriptions."""
    clean = lambda s: (s or "").replace("<", "").replace(">", "")
    return {"snippet": {"title": clean(post["title"])[:100], "description": clean(description(post))[:5000],
                        "tags": _tags(post.get("tags")), "categoryId": CATEGORY_PEOPLE_BLOGS},
            "status": {"privacyStatus": privacy, "selfDeclaredMadeForKids": False, "containsSyntheticMedia": True}}


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
    state, info, granted = _link()
    if not state.get("google_account") or not granted:
        raise PostingError("Connect YouTube posting first.", 409)
    return post, channel, state, render_file(post["render_ref"])


async def publish(store, post_id, by, now=None):
    """Uploads one approved post to its YouTube channel and records the posted link. Returns what YouTube set."""
    account = accounts.effective_account()
    key = (account, post_id)
    if key in _sending:
        raise PostingError("That post is already uploading.", 409)
    _sending.add(key)
    try:
        async with _locks.setdefault(account, asyncio.Lock()):
            post, channel, state, path = _ready(store, post_id)
            ident = state["google_account"]
            owned = await youtube._owned_channels(ident)
            owner_id = youtube._owner_of(channel, owned)
            if owner_id is None:
                raise PostingError(f"The connected Google account does not own {channel['handle']}. Connect posting "
                                   "with the Google account that owns this channel.", 409)
            privacy = state.get("privacy") or "private"
            with open(path, "rb") as handle:
                content, kind = _body(metadata(post, privacy), handle.read())
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
                      "kept_private": stricter, "by": by,
                      "note": ("YouTube kept it " + actual + ". Uploads from a project that has not passed YouTube's API "
                               "audit stay private; make it public in YouTube Studio or use Prepare post.") if stricter else ""}
            state["last_upload"] = {"post_id": post_id, "video_id": video, "privacy": actual, "at": time.time() if now is None else now}
            _save(state)
            return result
    finally:
        _sending.discard(key)
