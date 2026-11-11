"""Prepare post: everything an approved post needs on its platform, assembled in one place (Content Studio Team build
spec, section 6, locked "Prepare post first"; D1 "both posting routes").

For an approved post Kairos assembles, for the post's platform (each channel is one platform):
- the file: the render the person approved, or the editor's export of the same version in the platform's aspect
  (9:16 for Shorts, Reels and TikTok; 16:9 for a long YouTube video) and an accepted file type, checked for length;
- the text: YouTube's title, description with the chapter list and the tag box; TikTok's and Instagram's caption;
  the post's tags as hashtags within each platform's count;
- the platform's AI-content disclosure, always on (spec section 2);
- the thumbnail or cover image, the schedule time, and a checklist that says what Kairos fills and what the person
  does by hand.

Then one of two routes:
- YouTube's own API, already built (youtube_publish.py), when the person connected posting through their own Google
  project. The schedule becomes YouTube's scheduled publish.
- The person's own upload page in the Kairos Browser. The person presses "Open upload page" in Studio; the desktop app
  opens the platform's page in a Browse tab on their own sign-in and fills what it can (electron/studio-prepare.js).
  It never presses Post, Publish, Share, Next or Schedule, never solves a CAPTCHA and never types a password: if the
  page asks for a sign-in, the person signs in (Browse's own saved-password offer applies, as on any page).

Nothing here posts anything. Bots (the Publisher and the Producer) can prepare a post; only the person opens the page
and presses Post, because bots never work in the person's own tabs (Kairos Browser D1).
"""
import os
import re
import time

from core import accounts

from . import platforms, policy
from .store import StudioError, conflict

# A Studio render's file name: aspect, version, type (core/video_render.py, core/video_export.py).
RENDER_NAME = re.compile(r"^(16-9|9-16|1-1)-v([1-9][0-9]{0,5})\.(mp4|mov|webm)$")
SLUGS = {"16:9": "16-9", "9:16": "9-16", "1:1": "1-1"}
ASPECT_OF = {v: k for k, v in SLUGS.items()}
TYPE_ORDER = ("mp4", "mov", "webm")
COVER_MAX_BYTES = 2 * 1024 * 1024      # YouTube's thumbnail limit; the cover Kairos makes stays under it
FILL_KEYS = ("file", "title", "description", "caption", "tags", "ai_label", "made_for_kids", "thumbnail")


class PrepareError(StudioError):
    pass


# -- the file ----------------------------------------------------------------------------------------------------

def _render_folder(render_ref):
    """The folder and file name a post's render link names, or raises: a Studio render or a generated-files link."""
    from . import youtube_publish
    ref = (render_ref or "").strip()
    match = youtube_publish._STUDIO.match(ref)
    if match:
        from core import video_store
        return str(video_store._folder(match.group(1)) / "renders"), match.group(2), True
    match = youtube_publish._GENERATED.match(ref)
    if match:
        from urllib.parse import unquote
        from core import image_gen
        return image_gen.generated_files_dir(), unquote(match.group(1)), False
    raise PrepareError("The post has no rendered video to post. The Editor records the render link "
                       "(/api/videos/<id>/renders/<file>.mp4) when the video is rendered.", 409)


def _inside(folder, name):
    if not name or os.path.basename(name) != name or name.startswith("."):
        return None
    path = os.path.realpath(os.path.join(folder, name))
    return path if os.path.dirname(path) == os.path.realpath(folder) and os.path.isfile(path) else None


def candidates(render_ref):
    """The approved render and the editor's exports of the same version (other aspects and file types), each
    {name, path, aspect, type, version, approved}. The approved one first."""
    folder, name, studio = _render_folder(render_ref)
    approved = _inside(folder, name)
    if approved is None:
        raise PrepareError("The rendered video file is missing. Render it again in Studio, then prepare the post.", 409)
    match = RENDER_NAME.match(name)
    ext = name.rsplit(".", 1)[-1].lower()
    first = {"name": name, "path": approved, "aspect": ASPECT_OF.get(match.group(1)) if match else None, "type": ext,
             "version": int(match.group(2)) if match else None, "approved": True}
    out = [first]
    if studio and match:
        for slug in SLUGS.values():
            for kind in TYPE_ORDER:
                other = f"{slug}-v{match.group(2)}.{kind}"
                path = other != name and _inside(folder, other)
                if path:
                    out.append({"name": other, "path": path, "aspect": ASPECT_OF[slug], "type": kind,
                                "version": int(match.group(2)), "approved": False})
    return out, folder


def probe(path):
    """{seconds, width, height} of a video through the FFmpeg Kairos already found, or None when it cannot tell."""
    try:
        from core import video_export
        text = video_export._probe(path)
    except Exception:  # noqa: BLE001 - no FFmpeg, or it could not read the file: the length stays unknown
        return None
    out = {}
    found = re.search(r"Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)", text)
    if found:
        out["seconds"] = round(int(found[1]) * 3600 + int(found[2]) * 60 + float(found[3]), 2)
    size = re.search(r"Video: [^\n]*?, (\d{2,5})x(\d{2,5})", text)
    if size:
        out["width"], out["height"] = int(size[1]), int(size[2])
    return out or None


def _aspect_of_size(width, height):
    if not width or not height:
        return None
    ratio = width / height
    shapes = {"16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1.0}
    return min(shapes, key=lambda a: abs(ratio - shapes[a]))


def wanted(platform, channel, post):
    """The aspect and rules the post needs on its platform: a long YouTube video is 16:9, everything else follows the
    channel's aspect where the platform takes it, else 9:16."""
    rules = platforms.rules(platform)
    if platform == "youtube" and (post.get("long_form") or (channel.get("aspect") == "16:9")):
        return "16:9", rules["long"], "video"
    short = rules["short"]
    aspect = channel.get("aspect") if channel.get("aspect") in short["aspects"] else short["aspects"][0]
    return aspect, short, "short" if platform == "youtube" else ("reel" if platform == "instagram" else "video")


def choose_file(found, aspect, kind_rules):
    """The best file for the platform: the wanted aspect first, then the type the platform likes best."""
    usable = [f for f in found if f["aspect"] == aspect and f["type"] in kind_rules["types"]]
    if not usable:
        return None
    return sorted(usable, key=lambda f: (TYPE_ORDER.index(f["type"]), not f["approved"]))[0]


# -- the cover ----------------------------------------------------------------------------------------------------

def _cover_dir():
    return os.path.join(accounts.account_dir(), "content_studio", "covers")


def make_cover(folder, aspect, post_id):
    """A JPEG cover from the render's own thumbnail frame (thumb-<aspect>.png), under YouTube's 2 MB, kept in the
    account's Content Studio folder. None when the render has no thumbnail frame."""
    source = _inside(folder, f"thumb-{SLUGS.get(aspect, '')}.png") if aspect else None
    if source is None:
        return None
    os.makedirs(_cover_dir(), exist_ok=True)
    out = os.path.join(_cover_dir(), f"post-{int(post_id)}.jpg")
    try:
        from PIL import Image
        with Image.open(source) as image:
            image = image.convert("RGB")
            if image.width > 1280 or image.height > 1280:
                image.thumbnail((1280, 1280))
            for quality in (90, 80, 70, 60):
                image.save(out, "JPEG", quality=quality, optimize=True)
                if os.path.getsize(out) <= COVER_MAX_BYTES:
                    break
    except Exception:  # noqa: BLE001 - no Pillow or an unreadable frame: no cover, the checklist says so
        return None
    return out


# -- assembly -----------------------------------------------------------------------------------------------------

def _clock(seconds):
    seconds = int(round(seconds or 0))
    return f"{seconds // 60}:{seconds % 60:02d}" if seconds < 3600 else f"{seconds // 3600}:{seconds // 60 % 60:02d}:{seconds % 60:02d}"


def _when(at):
    return time.strftime("%a %d %b %Y, %H:%M", time.localtime(at)) if at else ""


def assemble(store, post_id, scheduled_at=None, probe_fn=None, api_ready=None):
    """The prepared post for its platform: {platform, kind, file, text, hashtags, ai_label, cover, schedule, checklist,
    problems, routes, upload_url, rules_note}. `problems` lists what stops it from being posted as it is."""
    post = store.get_post(post_id)
    channel = store.get_channel(post["channel_id"])
    platform = channel["platform"]
    rules = platforms.rules(platform)
    problems, checklist = [], []

    def item(key, text, by, status="todo"):
        checklist.append({"key": key, "text": text, "by": by, "status": status})

    # The file.
    found, folder = candidates(post["render_ref"])
    aspect, kind_rules, kind = wanted(platform, channel, post)
    chosen = choose_file(found, aspect, kind_rules)
    if chosen is None:
        have = sorted({f"{f['aspect'] or 'unknown aspect'} {f['type'].upper()}" for f in found})
        problems.append(f"{rules['name']} needs a {aspect} video ({', '.join(t.upper() for t in kind_rules['types'])}); "
                        f"this version has {', '.join(have)}. Render the {aspect} version in Studio, then prepare again.")
        chosen = found[0]
    measured = (probe_fn or probe)(chosen["path"]) or {}
    if chosen["aspect"] is None and measured.get("width"):
        chosen["aspect"] = _aspect_of_size(measured["width"], measured["height"])
        if chosen["aspect"] != aspect:
            problems.append(f"{rules['name']} needs a {aspect} video; this file is {chosen['aspect']}.")
    seconds = measured.get("seconds")
    if seconds is None:
        item("length", "Kairos could not measure the video's length (FFmpeg not found). Check it is within "
             f"{_clock(kind_rules['max_s'])} for {rules['name']}.", "you")
    elif seconds > kind_rules["max_s"] + 0.5:
        problems.append(f"The video is {_clock(seconds)}; {rules['name']} takes at most {_clock(kind_rules['max_s'])} "
                        f"for this kind of post. Make a shorter cut in Studio.")
    if platform == "youtube" and kind == "video" and seconds and seconds > rules["verified_over_s"]:
        item("verified", f"Videos over {_clock(rules['verified_over_s'])} need a verified YouTube account (a phone check in "
             "YouTube's settings).", "you")
    file_info = {"name": chosen["name"], "aspect": chosen["aspect"], "type": chosen["type"],
                 "bytes": os.path.getsize(chosen["path"]), "seconds": seconds, "approved_file": chosen["approved"],
                 "width": measured.get("width"), "height": measured.get("height")}
    item("file", f"Attach {chosen['name']} ({chosen['aspect'] or 'aspect unknown'}"
         + (f", {_clock(seconds)}" if seconds else "") + ")"
         + ("" if chosen["approved"] else ", the editor's export of the version you approved"), "kairos")

    # The text.
    caption = post.get("caption") or ""
    added, dropped = platforms.hashtags(post.get("tags"), caption, rules["hashtags_max"])
    tail = (" ".join(added)) if added else ""
    text = {}
    if platform == "youtube":
        from . import youtube_publish
        title = (post["title"] or "").replace("<", "").replace(">", "")
        description = youtube_publish.description(post).replace("<", "").replace(">", "")
        if tail:
            description = (description.rstrip() + "\n\n" + tail).strip()
        tags = platforms.youtube_tags(post.get("tags"), rules["tags_max_chars"])
        text = {"title": title, "description": description, "tags": ", ".join(tags)}
        if len(title) > rules["title_max"]:
            problems.append(f"The title is {len(title)} characters; YouTube takes {rules['title_max']}. Redraft it shorter.")
        if len(description) > rules["text_max"]:
            problems.append(f"The description is {len(description)} characters; YouTube takes {rules['text_max']}.")
        item("title", "Title", "kairos")
        item("description", "Description" + (" with the chapter list" if post.get("long_form") else "")
             + (f" and {len(added)} hashtag{'s' if len(added) != 1 else ''}" if added else ""), "kairos")
        if tags:
            item("tags", f"Tags ({len(tags)}), under Show more", "kairos")
        audience = store.audience(post)
        if audience["made_for_kids"] is None:
            problems.append("Say whether this video is made for kids before it goes up: this blocky world look draws children, "
                            "and YouTube asks every upload. Set it on the channel (Content > Channels > Look) or on the post.")
        else:
            item("made_for_kids", f"Audience: {rules['made_for_kids_yes' if audience['made_for_kids'] else 'made_for_kids']}"
                 + {"post": " (this post's setting)", "channel": " (the channel's setting)", "default": ""}[audience["source"]], "kairos")
    else:
        body = caption.strip() or (post["title"] or "")
        if tail:
            body = (body.rstrip() + "\n\n" + tail).strip()
        text = {"caption": body}
        if len(body) > rules["text_max"]:
            problems.append(f"The caption is {len(body)} characters; {rules['name']} takes {rules['text_max']}. Redraft it shorter.")
        item("caption", "Caption" + (f" with {len(added)} hashtag{'s' if len(added) != 1 else ''}" if added else ""), "kairos")
    if dropped:
        item("hashtags", f"{len(dropped)} tag{'s' if len(dropped) != 1 else ''} left out: {rules['name']} counts at most "
             f"{rules['hashtags_max']} hashtags ({' '.join(dropped)}).", "you", "note")

    # The AI label, always on.
    label = rules["ai_label"]
    item("ai_label", f"{label['name']}: on. {label['how']}", "kairos")

    # Thumbnail or cover.
    cover_path = make_cover(folder, chosen["aspect"], post["id"])
    cover = {"name": rules["cover"]["name"], "how": rules["cover"]["how"], "file": os.path.basename(cover_path) if cover_path else None,
             "what": post.get("thumbnail") or ""}
    if platform == "youtube" and kind == "video" and cover_path:
        item("thumbnail", f"Thumbnail: {cover['file']}" + (f" ({cover['what']})" if cover["what"] else ""), "kairos")
    else:
        item("cover", f"{rules['cover']['name']}: {rules['cover']['how']}"
             + (f" Kairos made {cover['file']} from the video." if cover_path else " The render has no cover frame; pick one on the page."), "you")

    # Schedule.
    prep = store.preparation_for(post_id)
    at = scheduled_at if scheduled_at is not None else (prep or {}).get("scheduled_at")
    schedule = {"at": at, "supported": rules["schedule"]["supported"], "how": rules["schedule"]["how"]}
    if at:
        item("schedule", f"Schedule for {_when(at)}. {rules['schedule']['how']}", "you")

    # Routes and the last steps, always the person's.
    routes = ["browser"]
    if platform == "youtube" and (api_ready if api_ready is not None else _api_ready(store, post_id)):
        routes.insert(0, "api")
    item("check", "Read the page once: every field as approved, nothing added by the platform you do not want.", "you")
    item("post", f"Press {rules['post_button']} yourself. Kairos never presses it.", "you")
    item("link", "Paste the live link in Kairos (Mark posted), or the Publisher records it, so the numbers can be tracked.", "you")
    return {"platform": platform, "platform_name": rules["name"], "kind": kind, "aspect": aspect, "channel": channel["handle"],
            "file": file_info, "text": text, "hashtags": added, "hashtags_left_out": dropped,
            "ai_label": {"on": True, "name": label["name"], "how": label["how"]}, "cover": cover, "schedule": schedule,
            "checklist": checklist, "problems": problems, "routes": routes, "upload_url": rules["upload_url"],
            "post_button": rules["post_button"], "rules_note": platforms.RULES_NOTE, "rules_checked": platforms.RULES_CHECKED,
            "approved_by": post.get("approved_by"), "approved_at": post.get("approved_at")}


def _api_ready(store, post_id):
    from . import youtube_publish
    return youtube_publish.check(store, post_id) is None


def _gate(store, post_id):
    post = store.get_post(post_id)
    if post["state"] != "approved":
        raise PrepareError("Only a post you approved can be prepared." if post["state"] != "posted" else "That post is already posted.", 409)
    channel = store.get_channel(post["channel_id"])
    if channel["status"] != "live" or channel["paused"]:
        raise PrepareError("That channel is archived or paused.", 409)
    # The checks that matter at posting time: never the same video on two of the team's own channels, the AI label on.
    findings = policy.crosspost_findings(store, post)
    if not post.get("ai_label", 1):
        findings.append({"check": "ai_label", "result": "reject", "reason": "The AI label is off; every post carries it."})
    result = {"ok": not any(f["result"] == "reject" for f in findings), "findings": findings}
    if not result["ok"]:
        store.add_evidence(post_id, "policy_check", {"step": "prepare", **result})
        raise PrepareError("The policy checks stopped this post: " + policy.reasons(result), 409)
    return post, channel


def prepare(store, post_id, by, scheduled_at=None, probe_fn=None, now=None, notifier=None):
    """Assembles an approved post and records it as prepared. Returns the preparation row (with its package)."""
    now = time.time() if now is None else now
    post, channel = _gate(store, post_id)
    if scheduled_at is not None:
        if isinstance(scheduled_at, bool) or not isinstance(scheduled_at, (int, float)) or scheduled_at < now - 60:
            raise PrepareError("the schedule time must be a time from now on")
    package = assemble(store, post_id, scheduled_at, probe_fn)
    route = package["routes"][0]
    prep = store.save_preparation(post_id, channel["platform"], package, route, by, scheduled_at, now=now)
    if not package["problems"]:
        _tell(store, prep, post, channel, notifier, now)
    return prep


def _tell(store, prep, post, channel, notifier, now):
    """One Inbox line from the Producer when a post is ready for the person to post (never repeated for the same post)."""
    from . import delivery
    key = f"prepared:{post['id']}"
    with store.lock:
        seen = dict(store.settings()["notified"])
        if key in seen:
            return False
        name = platforms.rules(channel["platform"])["name"]
        body = (f"\"{post['title']}\" is ready to post on {name} ({channel['handle']}). In Studio > Content > Publishing, "
                + ("press Post to YouTube, or " if prep["route"] == "api" else "")
                + f"press Open upload page: Kairos fills the page and stops before {platforms.rules(channel['platform'])['post_button']}, "
                "which you press yourself.")
        if delivery._send(store, "Ready for you to post", body, False, notifier):
            seen[key] = now
            store.update_settings(notified=seen)
            return True
    return False


def schedule(store, post_id, at, now=None):
    """Sets or clears the schedule and refreshes the package's checklist to match."""
    prep = store.set_schedule(post_id, at, now=now)
    try:
        package = assemble(store, post_id, at if at is not None else 0)
        if at is None:
            package["schedule"]["at"] = None
            package["checklist"] = [c for c in package["checklist"] if c["key"] != "schedule"]
        store.update_preparation(prep["id"], package=package, now=now)
    except StudioError:
        pass  # the file moved since: the schedule is still kept, and preparing again shows the problem
    return store.get_preparation(prep["id"])


# -- the desktop app's fill (electron/studio-prepare.js) --------------------------------------------------------

def fill_plan(store, prep_id, now=None):
    """What the desktop app fills on the upload page: the file's local path (re-checked here), the text and the
    switches. Refused for a post that is not approved, already posted, or has a problem that stops it."""
    now = time.time() if now is None else now
    prep = store.get_preparation(prep_id)
    post, channel = _gate(store, prep["post_id"])
    package = prep["package"]
    if package.get("problems"):
        raise PrepareError("This post has a problem to fix before it can go on the page: " + package["problems"][0], 409)
    found, folder = candidates(post["render_ref"])
    chosen = next((f for f in found if f["name"] == package["file"]["name"]), None)
    if chosen is None:
        raise PrepareError("The prepared video file is missing now. Prepare the post again.", 409)
    rules = platforms.rules(channel["platform"])
    fields = [{"key": "file", "kind": "file", "path": chosen["path"], "name": chosen["name"]}]
    for key, value in package["text"].items():
        if value:
            # YouTube's tag box turns each comma into a tag, so the last tag ends with one too.
            fields.append({"key": key, "kind": "text", "value": value + "," if key == "tags" else value})
    toggles = [{"key": "ai_label", "name": rules["ai_label"]["name"]}]
    if channel["platform"] == "youtube":
        kids = bool(store.audience(post)["made_for_kids"])
        toggles.append({"key": "made_for_kids", "name": rules["made_for_kids_yes" if kids else "made_for_kids"], "value": kids})
        cover = os.path.join(_cover_dir(), package["cover"]["file"]) if package["cover"].get("file") else None
        if package["kind"] == "video" and cover and os.path.isfile(cover):
            fields.append({"key": "thumbnail", "kind": "file", "path": cover, "name": os.path.basename(cover)})
    store.update_preparation(prep_id, opened_at=now, now=now)
    return {"prep_id": prep["id"], "post_id": post["id"], "platform": channel["platform"], "upload_url": rules["upload_url"],
            "post_button": rules["post_button"], "fields": fields, "toggles": toggles, "title": post["title"]}


def report_fill(store, prep_id, stage, filled=(), missing=(), note="", now=None):
    """The desktop app says how the fill went. The post now waits for the person to press Post (or failed)."""
    now = time.time() if now is None else now
    prep = store.get_preparation(prep_id)
    if prep["state"] == "posted":
        return prep
    if stage not in ("filling", "done", "stopped", "failed"):
        raise StudioError("stage is filling, done, stopped or failed")
    clean = lambda keys: sorted({k for k in keys if k in FILL_KEYS})
    fill = {"stage": stage, "filled": clean(filled), "missing": clean(missing), "note": (note or "")[:300], "at": now}
    if stage == "failed":
        return store.update_preparation(prep_id, state="failed", fill=fill, error=note or "The upload page could not be filled.", now=now)
    return store.update_preparation(prep_id, state="waiting_for_you", fill=fill, error="", now=now)


def record_failure(store, post_id, error, now=None):
    """A route failed (YouTube refused the upload, the page could not be filled): the dashboard shows it with the reason."""
    prep = store.preparation_for(post_id)
    if prep and prep["state"] != "posted":
        store.update_preparation(prep["id"], state="failed", error=str(error)[:500], now=now)
