"""The official TikTok and Instagram routes in one place (section 12; David 2026-11-10): which route a post takes, the
prepared package an API post sends, the account's status, and the daily numbers pass.

Route choice (prepare.py): a channel connected through the person's own app takes the API ("api" first in the prepared
post's routes); otherwise Prepare post's fill-the-upload-page route, unchanged. Numbers: a connected channel's posts get
official snapshots (tiktok_api, instagram_api); the page reads skip them (page_reads.py) and run only as the fallback.
"""
import time

from core import accounts

from . import social_auth
from .store import StudioError

DAILY_EVERY_S = 22 * 3600
RETRY_AFTER_FAILURE_S = 3 * 3600


def api_ready(store, post_id):
    """True when an approved post's channel is connected to its platform's official API and nothing stops posting."""
    try:
        post = store.get_post(post_id)
        channel = store.get_channel(post["channel_id"])
    except StudioError:
        return False
    return (channel["platform"] in social_auth.PLATFORMS and post["state"] == "approved"
            and social_auth.connected(channel["id"], channel["platform"]))


def package_for(store, post_id, by, platform, allow_schedule=False):
    """(post, channel, prep, file path, package) for an API post: the posting-time checks (approved, live, not paused,
    no cross-posting, the AI label on), the prepared package (prepared now when it was not), without problems, and the
    file it names still on disk."""
    from . import prepare
    post, channel = prepare._gate(store, post_id)
    if channel["platform"] != platform:
        raise social_auth.SocialError(f"That post is for {channel['platform']}, not {platform}.", 409)
    if not social_auth.connected(channel["id"], platform):
        raise social_auth.SocialError(f"Connect {channel['handle']} to {'TikTok' if platform == 'tiktok' else 'Instagram'} "
                                      "first, or use Open upload page.", 409)
    prep = store.preparation_for(post_id)
    if prep is None:
        prep = prepare.prepare(store, post_id, by or "you")
    package = prep["package"]
    if package.get("problems"):
        raise social_auth.SocialError("This post has a problem to fix first: " + package["problems"][0], 409)
    if not allow_schedule and prep.get("scheduled_at") and prep["scheduled_at"] > time.time() + 60:
        name = "TikTok" if platform == "tiktok" else "Instagram"
        raise social_auth.SocialError(f"{name}'s API posts at once and has no schedule. This post is planned for "
                                      f"{time.strftime('%a %d %b %H:%M', time.localtime(prep['scheduled_at']))}: post it "
                                      "then, or clear the schedule.", 409)
    found, _ = prepare.candidates(post["render_ref"])
    chosen = next((f for f in found if f["name"] == (package.get("file") or {}).get("name")), None)
    if chosen is None:
        raise social_auth.SocialError("The prepared video file is missing now. Prepare the post again.", 409)
    return post, channel, prep, chosen["path"], package


def api_note(platform):
    """What the prepared post says about the API route."""
    if platform == "tiktok":
        return ("Post to TikTok sends it through your own TikTok app. You choose who can see it and the interactions each "
                "time. " + ("" if social_auth.audited() else social_auth.TIKTOK_AUDIT_NOTE))
    if platform == "instagram":
        return "Post to Instagram sends it as a Reel through your own Meta app, with Meta's AI label."
    return ""


# -- the daily numbers pass ---------------------------------------------------------------------------------------

def _connected_platforms(store):
    channels = store.list_channels(status="live")
    return sorted({c["platform"] for c in channels if c["platform"] in social_auth.PLATFORMS
                   and social_auth.connected(c["id"], c["platform"])})


async def sync(store, platform=None, now=None):
    from . import instagram_api, tiktok_api
    done = {}
    for name in ([platform] if platform else _connected_platforms(store)):
        module = tiktok_api if name == "tiktok" else instagram_api
        done[name] = await module.sync(store, now)
    _passes[accounts.effective_account()] = {"at": time.time() if now is None else now,
                                              "failed": any(r.get("stopped") for r in done.values())}
    return done


_passes = {}    # account id -> the last pass (in memory: after a restart the first look runs a pass)


def due(store, now=None):
    now = time.time() if now is None else now
    if not _connected_platforms(store) and not social_auth.published():
        return False
    last = _passes.get(accounts.effective_account())
    if last is None:
        return True
    return now - last["at"] >= (RETRY_AFTER_FAILURE_S if last["failed"] else DAILY_EVERY_S)


async def sync_all_due(now=None, store_for=None):
    """The daily pass: each account with a connected TikTok or Instagram channel, run as that account. One account's
    trouble never stops the others."""
    from . import studio
    done = {}
    for account_id in accounts.all_accounts():
        with accounts.as_account(account_id):
            store = store_for() if store_for else studio
            try:
                if due(store, now):
                    done[account_id] = await sync(store, now=now)
            except Exception as exc:  # noqa: BLE001 - recorded, never raised into the scheduler
                done[account_id] = f"failed: {exc}"
    return done
