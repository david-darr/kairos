"""What each platform wants from a post, for Prepare post and the page-read analytics (Content Studio Team build
spec, section 6; "Prepare post first", D1 "both").

These numbers and page addresses are from general knowledge as of 2026-11 and were NOT checked against the
platforms' own pages while building (no sign-in, no real site visited, by rule). They are kept in one place so a
change on a platform is a one-line fix here. `RULES_NOTE` says so wherever the rules are shown to the person.

Each platform:
- `short`: what a short vertical post must be (aspect, longest length in seconds, accepted file types).
- `long` (YouTube only): a long video in chapters, 16:9.
- text limits: title, caption or description, hashtags (how many), tags (YouTube's tag box).
- `ai_label`: the platform's own AI-content disclosure, which Content Studio turns on for every post (spec section 2).
- `upload_url`: the page Prepare post opens in Browse; `hosts`: the only sites the fill and the page reads act on.
"""
import re
from urllib.parse import urlsplit

RULES_CHECKED = "2026-11-10"
RULES_NOTE = ("Platform limits and page layouts are from general knowledge (2026-11), not checked against the platforms' "
              "own pages. If a platform says otherwise, the platform wins.")

PLATFORMS = {
    "youtube": {
        "name": "YouTube",
        "short": {"aspects": ("9:16", "1:1"), "max_s": 180, "types": ("mp4", "mov", "webm")},
        "long": {"aspects": ("16:9",), "max_s": 12 * 3600, "types": ("mp4", "mov", "webm")},
        "title_max": 100, "text_max": 5000, "hashtags_max": 15, "tags_max_chars": 500,
        "ai_label": {"name": "Altered or synthetic content",
                     "how": "In Details, under Altered content, answer Yes.",
                     "api": "YouTube's containsSyntheticMedia flag is sent on with every upload."},
        "made_for_kids": "No, it's not made for kids",
        "cover": {"name": "Thumbnail", "how": "Upload the thumbnail in Details. Shorts take a frame you pick in the YouTube app."},
        "schedule": {"supported": True, "how": "In Visibility, choose Schedule and set the date and time."},
        "upload_url": "https://www.youtube.com/upload",
        "hosts": ("youtube.com", "www.youtube.com", "studio.youtube.com"),
        "post_button": "Publish",
        "verified_over_s": 15 * 60,
    },
    "tiktok": {
        "name": "TikTok",
        "short": {"aspects": ("9:16",), "max_s": 600, "types": ("mp4", "mov", "webm")},
        "title_max": None, "text_max": 2200, "hashtags_max": 5, "tags_max_chars": None,
        "ai_label": {"name": "AI-generated content",
                     "how": "Under Show more (or More options), turn on AI-generated content."},
        "cover": {"name": "Cover", "how": "Choose Edit cover and pick a frame or upload the cover image Kairos made."},
        "schedule": {"supported": True, "how": "Turn on Schedule and set the date and time (TikTok allows up to about 10 days ahead)."},
        "upload_url": "https://www.tiktok.com/tiktokstudio/upload",
        "hosts": ("tiktok.com", "www.tiktok.com"),
        "post_button": "Post",
    },
    "instagram": {
        "name": "Instagram",
        "short": {"aspects": ("9:16",), "max_s": 180, "types": ("mp4", "mov")},
        "title_max": None, "text_max": 2200, "hashtags_max": 5, "tags_max_chars": None,
        "ai_label": {"name": "AI label",
                     "how": "Under Advanced settings, turn on Add AI label. If the web page has no such switch, add it in the Instagram app after posting."},
        "cover": {"name": "Cover", "how": "In Edit, choose Cover photo and select the cover image Kairos made."},
        "schedule": {"supported": False, "how": "Instagram on the web posts at once. Press Share at the planned time, or schedule it in Meta Business Suite."},
        # Instagram on the web has no upload address of its own: the person presses Create (the plus) and the fill
        # attaches the video as soon as the file picker is on the page.
        "upload_url": "https://www.instagram.com/",
        "hosts": ("instagram.com", "www.instagram.com"),
        "post_button": "Share",
    },
}


def rules(platform):
    try:
        return PLATFORMS[platform]
    except KeyError:
        raise ValueError(f"unknown platform: {platform}") from None


def host_ok(platform, url):
    """True when `url` is https on one of the platform's own hosts (never a look-alike such as youtube.com.evil.test)."""
    parts = urlsplit(url or "")
    host = (parts.hostname or "").lower()
    return parts.scheme == "https" and any(host == h or host.endswith("." + h) for h in rules(platform)["hosts"])


# -- hashtags ---------------------------------------------------------------------------------------------------

_TAG_CHARS = re.compile(r"[^\w]+", re.UNICODE)
_IN_TEXT = re.compile(r"(?<![\w#])#(\w{1,100})", re.UNICODE)


def hashtag(tag):
    """'space physics' -> '#spacephysics'; '' when nothing usable is left."""
    word = _TAG_CHARS.sub("", (tag or "").strip().lstrip("#"))
    return "#" + word[:100] if word else ""


def hashtags(tags_text, caption, limit):
    """The post's tags as hashtags, without the ones the caption already carries, within the platform's count.
    Returns (added, dropped): the hashtags to add after the caption, and the ones over the limit."""
    present = {m.lower() for m in _IN_TEXT.findall(caption or "")}
    room = max(0, (limit or 0) - len(present)) if limit else 10 ** 6
    added, dropped, seen = [], [], set(present)
    for raw in (tags_text or "").split(","):
        tag = hashtag(raw)
        if not tag or tag[1:].lower() in seen:
            continue
        seen.add(tag[1:].lower())
        (added if len(added) < room else dropped).append(tag)
    return added, dropped


def youtube_tags(tags_text, max_chars=500):
    """YouTube's tag box: the tags as written (no #), within its character limit."""
    out, total = [], 0
    for raw in (tags_text or "").split(","):
        tag = raw.strip().lstrip("#").strip()
        if tag and tag.lower() not in {t.lower() for t in out} and total + len(tag) + (1 if out else 0) <= max_chars:
            out.append(tag[:100])
            total += len(tag) + (1 if len(out) > 1 else 0)
    return out


# -- the creator pages the page-read analytics opens (read-only, the person's own posts) -------------------------

_TIKTOK_POST = re.compile(r"^/@([A-Za-z0-9._]{2,24})/video/(\d{5,25})/?$")
_INSTAGRAM_POST = re.compile(r"^/(?:[A-Za-z0-9._]{1,30}/)?(reel|reels|p)/([A-Za-z0-9_-]{5,40})/?$")


def plain_handle(handle):
    return (handle or "").strip().lstrip("@").lower()


def analytics_url(platform, posted_url, handle):
    """The page that shows this post's numbers to its owner, or raises ValueError with the reason.
    Built only from the post's own recorded link on one of the person's registered channels: a TikTok link must
    name that channel's handle. Never a search, a profile listing or anyone else's page."""
    if not host_ok(platform, posted_url):
        raise ValueError(f"the post's link is not an https link on {rules(platform)['name']}")
    path = urlsplit(posted_url).path
    if platform == "tiktok":
        match = _TIKTOK_POST.match(path)
        if not match:
            raise ValueError("the TikTok link is not a video link (https://www.tiktok.com/@handle/video/<id>)")
        if match.group(1).lower() != plain_handle(handle):
            raise ValueError(f"the TikTok link is on @{match.group(1)}, not on this channel ({handle})")
        return f"https://www.tiktok.com/tiktokstudio/analytics/{match.group(2)}"
    if platform == "instagram":
        match = _INSTAGRAM_POST.match(path)
        if not match:
            raise ValueError("the Instagram link is not a post or reel link (https://www.instagram.com/reel/<code>/)")
        return f"https://www.instagram.com/reel/{match.group(2)}/"
    raise ValueError("YouTube's numbers come from its analytics API, not from a page")


PAGE_READ_PLATFORMS = ("tiktok", "instagram")
