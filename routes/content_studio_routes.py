"""Content Studio: pipeline view, scoring record, selection review and the approval queue (build spec
"Content Studio Team", steps 2 and 4). Every route needs a signed-in user and works in that account's own
store only (services/content_studio). Numbers come in by manual entry or import, or from YouTube's read-only analytics.
These routes are the person's: a confirm here is the person's OK. The Producer's own confirm step is its role-gated
tool (core/bot_content_studio_tools.py), never this API.

Prepare post and the publishing dashboard (services/content_studio/prepare.py, publishing.py): the person prepares an
approved post, schedules it, and opens its upload page in the Kairos Browser. The desktop app's main process fetches the
fill plan and reports how the fill went through the /desktop routes, which also need the desktop app's own secret
(X-Kairos-Desktop), so a script in the app page cannot read a local file path or mark a fill. Page-read analytics
(page_reads.py): the person turns TikTok and Instagram reads on, reads now or tries again; the desktop app's hidden
reader takes its jobs from `worker_router` with the per-launch render token, like the design render worker.
"""
import asyncio
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from core.middleware import require_user
from core.middleware import local_api_base
from services.content_studio import (StudioError, delivery, formats, instagram_api, page_reads, pipeline, prepare, publishing,
                                     report, review, social, social_auth, studio, tiktok_api, youtube, youtube_publish)

router = APIRouter(prefix="/api/content-studio", tags=["content-studio"])
worker_router = APIRouter(tags=["content-studio"])
social_router = APIRouter(tags=["content-studio"])   # the TikTok and Instagram sign-in return (no session, state-checked)


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class NicheBody(Body):
    name: str = Field(max_length=80)


class ChannelBody(Body):
    niche_id: int
    platform: str = Field(max_length=20)
    handle: str = Field(max_length=100)


class ChannelEditBody(Body):
    look: Optional[str] = Field(None, max_length=80)
    aspect: Optional[str] = Field(None, max_length=5)
    notes: Optional[str] = Field(None, max_length=1000)
    voice: Optional[str] = Field(None, max_length=40)
    style_pack: Optional[str] = Field(None, max_length=40)
    long_per_week: Optional[int] = Field(None, ge=0, le=7)
    renderer: Optional[str] = Field(None, max_length=10)
    fps: Optional[int] = Field(None, ge=0, le=60)
    made_for_kids: Optional[str] = Field(None, max_length=3)      # "yes", "no", or "" for not set


class BatchBody(Body):
    post_ids: list[int] = Field(min_length=1, max_length=200)


class ReasonBody(Body):
    reason: str = Field("", max_length=500)


class WarningBody(Body):
    text: str = Field(max_length=500)


class TopicBody(Body):
    niche_id: int
    title: str = Field(max_length=200)
    source: str = Field(max_length=300)
    evidence_date: Optional[float] = None
    signal: str = Field("", max_length=300)


class StrategyBody(Body):
    owner_role: str = Field(max_length=20)
    name: str = Field(max_length=80)
    parent_id: Optional[int] = None
    make_default: bool = False


class PostBody(Body):
    channel_id: int
    title: str = Field(max_length=200)
    topic_id: Optional[int] = None
    script_strategy_id: Optional[int] = None
    evaluator_strategy_id: Optional[int] = None
    script_ref: Optional[str] = Field(None, max_length=20000)
    caption: str = Field("", max_length=5000)
    format: Optional[str] = Field(None, max_length=80)
    pick_reason: str = Field("", max_length=500)


class EditBody(Body):
    title: Optional[str] = Field(None, max_length=200)
    caption: Optional[str] = Field(None, max_length=5000)
    script_ref: Optional[str] = Field(None, max_length=20000)
    render_ref: Optional[str] = Field(None, max_length=500)
    render_status: Optional[str] = Field(None, max_length=10)
    format: Optional[str] = Field(None, max_length=80)
    tags: Optional[str] = Field(None, max_length=500)
    thumbnail: Optional[str] = Field(None, max_length=300)
    made_for_kids: Optional[str] = Field(None, max_length=3)      # "yes", "no", or "" for the channel's answer


class PostedBody(Body):
    url: str = Field(max_length=500)
    posted_at: Optional[float] = None


class MetricsBody(Body):
    views: int = Field(ge=0)
    avg_view_duration_s: float = Field(ge=0)
    video_length_s: float = Field(ge=0)
    likes: int = Field(0, ge=0)
    comments: int = Field(0, ge=0)
    shares: int = Field(0, ge=0)
    follows_gained: int = Field(0, ge=0)
    taken_at: Optional[float] = None


class MetricsRow(MetricsBody):
    post_id: int


class ImportBody(Body):
    rows: list[MetricsRow] = Field(max_length=500)


class ReviewBody(Body):
    dry_run: bool = True


class ConfirmBody(Body):
    actor: str = Field("user", max_length=10)  # always "user": the Producer confirms only through its own tool
    reason: str = Field("", max_length=300)


class SettingsBody(Body):
    weights: Optional[dict[str, float]] = None
    follow_weight: Optional[float] = None
    min_weeks: Optional[int] = None
    min_posts: Optional[int] = None
    max_niches: Optional[int] = None
    behind_ratio: Optional[float] = None
    behind_reviews: Optional[int] = None
    strategy_margin: Optional[float] = None
    review_gap_days: Optional[int] = None
    step_windows_h: Optional[dict[str, float]] = None
    team_bot_ids: Optional[list[str]] = None
    team_roles: Optional[dict[str, str]] = None
    batch_approval: Optional[bool] = None


def _run(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except StudioError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc


def _given(body):
    return body.model_dump(exclude_unset=True)


# -- niches, channels -----------------------------------------------------------------------------

@router.get("/niches")
def niches(user: str = Depends(require_user)):
    return {"niches": studio.list_niches(), "max_live": studio.settings()["max_niches"]}


@router.post("/niches")
def add_niche(body: NicheBody, user: str = Depends(require_user)):
    return _run(studio.create_niche, body.name)


@router.get("/channels")
def channels(user: str = Depends(require_user)):
    return {"channels": studio.list_channels()}


@router.post("/channels")
def add_channel(body: ChannelBody, user: str = Depends(require_user)):
    """The user registers a channel they made themselves; bots have no route that creates one."""
    return _run(studio.create_channel, body.niche_id, body.platform, body.handle)


@router.post("/channels/{channel_id}/archive")
def archive_channel(channel_id: int, body: ReasonBody = ReasonBody(), user: str = Depends(require_user)):
    return _run(review.user_archives_channel, studio, channel_id, user, body.reason)


@router.post("/channels/{channel_id}/edit")
def edit_channel(channel_id: int, body: ChannelEditBody, user: str = Depends(require_user)):
    """The channel's look, aspect, voice notes and narrator voice, which the Script Writer and Editor follow."""
    return _run(studio.edit_channel, channel_id, **_given(body))


@router.post("/channels/{channel_id}/restore")
def restore_channel(channel_id: int, user: str = Depends(require_user)):
    return _run(studio.restore_channel, channel_id)


@router.post("/channels/{channel_id}/warning")
def channel_warning(channel_id: int, body: WarningBody, user: str = Depends(require_user)):
    """Records a platform warning; the channel is paused until it is resumed."""
    channel = _run(studio.record_warning, channel_id, body.text)
    return {**channel, "notified": delivery.deliver_warning(studio, channel_id)}


@router.post("/channels/{channel_id}/resume")
def channel_resume(channel_id: int, user: str = Depends(require_user)):
    return _run(studio.resume_channel, channel_id)


# -- topics, strategies ---------------------------------------------------------------------------

@router.get("/topics")
def topics(niche_id: Optional[int] = None, user: str = Depends(require_user)):
    return {"topics": studio.list_topics(niche_id)}


@router.post("/topics")
def add_topic(body: TopicBody, user: str = Depends(require_user)):
    return _run(studio.add_topic, body.niche_id, body.title, body.source, body.evidence_date, body.signal)


@router.get("/strategies")
def strategies(user: str = Depends(require_user)):
    return {"strategies": studio.list_strategies()}


@router.post("/strategies")
def add_strategy(body: StrategyBody, user: str = Depends(require_user)):
    return _run(studio.create_strategy, body.owner_role, body.name, body.parent_id, body.make_default)


# -- format cards and ports (read here; the Researcher writes them, the Evaluator decides ports) ------

@router.get("/formats")
def format_cards(include_retired: bool = False, user: str = Depends(require_user)):
    """The account's format cards, their port proposals with the checks, and the style packs."""
    studio.ensure_shipped_formats()      # Kairos's own cards (the Story Short) show from the start
    cards = studio.list_formats(None if include_retired else "active")
    ports = [p for p in studio.list_ports() if include_retired or p["status"] in ("proposed", "accepted")]
    return {"formats": cards, "ports": ports, "style_packs": formats.packs()}


@router.get("/formats/{format_id}")
def format_card(format_id: int, user: str = Depends(require_user)):
    card = _run(studio.get_format, format_id)
    return {**card, "ports": studio.list_ports(format_id=format_id),
            "posts": [{k: p[k] for k in ("id", "title", "state", "platform", "handle", "style_pack", "posted_url")}
                      for p in studio.list_posts() if p["format_id"] == format_id]}


# -- posts and the approval queue -----------------------------------------------------------------

@router.get("/pipeline")
def pipeline_view(user: str = Depends(require_user)):
    return {"items": pipeline.pipeline(studio)}


@router.get("/posts")
def posts(state: Optional[str] = None, channel_id: Optional[int] = None, niche_id: Optional[int] = None,
          user: str = Depends(require_user)):
    return {"posts": studio.list_posts(state, channel_id, niche_id)}


@router.post("/posts")
def add_post(body: PostBody, user: str = Depends(require_user)):
    return _run(studio.create_post, body.channel_id, body.title, body.topic_id, body.script_strategy_id,
                body.evaluator_strategy_id, body.script_ref, body.caption, body.format, body.pick_reason)


@router.get("/posts/{post_id}")
def get_post(post_id: int, user: str = Depends(require_user)):
    post = _run(studio.get_post, post_id)
    direct = youtube_publish.check(studio, post_id) if post["state"] == "approved" and post["platform"] == "youtube" else None
    from services.content_studio.store import youtube_chapters
    from services.content_studio.scoring import official
    metrics = [{**m, "official": official(m)} for m in studio.snapshots(post_id)]
    return {**post, "metrics": metrics, "direct_post_blocker": direct, "evidence": studio.evidence(post_id),
            "chapters": youtube_chapters(post), "api_connected": social.api_ready(studio, post_id)}


@router.get("/posts/{post_id}/evidence")
def post_evidence(post_id: int, user: str = Depends(require_user)):
    """What the post keeps for an appeal: the approval, the shot plan, the sources and the policy checks."""
    return {"evidence": _run(studio.evidence, post_id)}


@router.post("/posts/{post_id}/edit")
def edit_post(post_id: int, body: EditBody, user: str = Depends(require_user)):
    return _run(studio.edit_post, post_id, **_given(body))


@router.post("/posts/{post_id}/submit")
def submit_post(post_id: int, user: str = Depends(require_user)):
    return _run(studio.submit_for_approval, post_id)


@router.get("/approvals")
def approvals(user: str = Depends(require_user)):
    """Posts waiting for the person, and character sheets and style packs waiting for their OK (approved at
    /api/characters and /api/style-packs)."""
    from core import character_store, style_pack_store
    from core import video_plan
    from services.content_studio.store import youtube_chapters
    packs = [{k: v for k, v in p.items() if k != "spec"} for p in style_pack_store.pending()]
    posts = [{**p, "chapters": youtube_chapters(p)} for p in pipeline.approval_queue(studio)]
    # Long videos whose shot plan waits for the person before it renders (approved at /api/videos/<id>/plan).
    return {"posts": posts, "characters": character_store.pending(), "style_packs": packs, "plans": video_plan.waiting()}


@router.post("/posts/{post_id}/approve")
def approve_post(post_id: int, user: str = Depends(require_user)):
    """Marks the post approved. Preparing it for the platform (Prepare post) and posting are the next steps."""
    return _run(studio.approve, post_id, user)


@router.post("/approvals/approve-batch")
def approve_batch(body: BatchBody, user: str = Depends(require_user)):
    """One tap approves the posts the person was shown, once batch approval is on in the team settings."""
    return _run(studio.approve_batch, body.post_ids, user)


@router.post("/posts/{post_id}/reject")
def reject_post(post_id: int, body: ReasonBody = ReasonBody(), user: str = Depends(require_user)):
    return _run(studio.reject, post_id, body.reason)


@router.post("/posts/{post_id}/redraft")
def redraft_post(post_id: int, user: str = Depends(require_user)):
    return _run(studio.redraft, post_id)


@router.post("/posts/{post_id}/posted")
def posted(post_id: int, body: PostedBody, user: str = Depends(require_user)):
    return _run(studio.mark_posted, post_id, body.url, body.posted_at)


# -- metrics --------------------------------------------------------------------------------------

@router.post("/posts/{post_id}/metrics")
def add_metrics(post_id: int, body: MetricsBody, user: str = Depends(require_user)):
    return _run(studio.add_snapshot, post_id, **body.model_dump())


@router.post("/metrics/import")
def import_metrics(body: ImportBody, user: str = Depends(require_user)):
    """Numbers from an analytics export. All rows are checked first; one bad row stores nothing."""
    for row in body.rows:
        post = _run(studio.get_post, row.post_id)
        if post["state"] != "posted":
            raise HTTPException(409, f"post {row.post_id} is not posted")
    stored = [_run(studio.add_snapshot, **row.model_dump()) for row in body.rows]
    return {"stored": len(stored)}


# -- selection ------------------------------------------------------------------------------------

@router.get("/scoreboard")
def scoreboard(user: str = Depends(require_user)):
    return review.scoreboard(studio)


@router.post("/review/run")
def run_review(body: ReviewBody = ReviewBody(), user: str = Depends(require_user)):
    """dry_run (the default) shows the proposals and records nothing; dry_run false files them as decisions."""
    return _run(review.run_review, studio, None, body.dry_run)


@router.get("/decisions")
def decisions(status: Optional[str] = None, kind: Optional[str] = None, user: str = Depends(require_user)):
    return {"decisions": studio.list_decisions(status, kind)}


@router.post("/decisions/{decision_id}/confirm")
def confirm_decision(decision_id: int, body: ConfirmBody = ConfirmBody(), user: str = Depends(require_user)):
    """The person's OK. Nobody confirms as the Producer here: that step is the Producer bot's own tool."""
    if body.actor != "user":
        raise HTTPException(403, "Only the Producer bot confirms as the Producer, with its own tool.")
    return _run(review.confirm, studio, decision_id, "user", user)


@router.post("/decisions/{decision_id}/reject")
def reject_decision(decision_id: int, body: ConfirmBody = ConfirmBody(), user: str = Depends(require_user)):
    return _run(review.reject, studio, decision_id, user, body.reason)


# -- report, watch, settings ----------------------------------------------------------------------

@router.get("/report")
def weekly_report(user: str = Depends(require_user)):
    data = report.build_report(studio)
    return {**data, "text": report.render_text(data)}


@router.get("/watch")
def watch(user: str = Depends(require_user)):
    return {"findings": pipeline.watch(studio)}


@router.post("/watch/notify")
def watch_notify(user: str = Depends(require_user)):
    """Runs the watch and puts each urgent finding (platform warning, spend near the cap) in the Inbox once."""
    findings = pipeline.watch(studio)
    return {"findings": findings, "notified": delivery.deliver_findings(studio, findings)}


@router.post("/report/send")
def report_send(user: str = Depends(require_user)):
    """Puts the weekly report in the Inbox, as the Producer."""
    return delivery.deliver_report(studio)


@router.get("/settings")
def get_settings(user: str = Depends(require_user)):
    return studio.settings()


@router.put("/settings")
def put_settings(body: SettingsBody, user: str = Depends(require_user)):
    return _run(studio.update_settings, **_given(body))


# -- YouTube analytics (read-only) ----------------------------------------------------------------

class YouTubeConnectBody(Body):
    channel_id: int                                       # the Content Studio YouTube channel to connect
    account: Optional[str] = Field(None, max_length=256)  # one of the user's connected Google accounts; default is their usual one
    new_account: bool = False                             # Use another Google account: Google's chooser adds one


async def _studio_call(coro):
    try:
        return await coro
    except StudioError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc


@router.get("/analytics/youtube/status")
def youtube_status(user: str = Depends(require_user)):
    return youtube.status(user, studio)


@router.post("/analytics/youtube/connect")
async def youtube_connect(body: YouTubeConnectBody, user: str = Depends(require_user)):
    """Connect one YouTube channel's analytics: {"url"} (Google's page, opened in the browser), or {"linked": true}
    when the chosen Google account already holds the read-only permissions and owns the channel."""
    from routes.google_routes import CALLBACK
    out = await _studio_call(youtube.connect(local_api_base() + CALLBACK, user, body.channel_id, body.account,
                                             body.new_account, studio))
    return {**out, "status": youtube.status(user, studio)}


@router.post("/analytics/youtube/sync")
async def youtube_sync(user: str = Depends(require_user)):
    try:
        return {"result": await youtube.sync(studio), "status": youtube.status(user, studio)}
    except StudioError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc


@router.delete("/analytics/youtube")
def youtube_disconnect(user: str = Depends(require_user)):
    return _run(youtube.disconnect, user, None, studio)


@router.delete("/analytics/youtube/channels/{channel_id}")
def youtube_disconnect_channel(channel_id: int, user: str = Depends(require_user)):
    return _run(youtube.disconnect, user, channel_id, studio)


# -- YouTube posting through the person's own Google project (D1) --------------------------------------

class PrivacyBody(Body):
    privacy: str = Field(max_length=10)


@router.get("/posting/youtube/status")
def youtube_posting_status(user: str = Depends(require_user)):
    return youtube_publish.status(user, studio)


@router.post("/posting/youtube/connect")
async def youtube_posting_connect(body: YouTubeConnectBody, user: str = Depends(require_user)):
    """Connect one YouTube channel for posting: {"url"} to open, or {"linked": true}. See the analytics connect."""
    from routes.google_routes import CALLBACK
    out = await _studio_call(youtube_publish.connect(local_api_base() + CALLBACK, user, body.channel_id, body.account,
                                                     body.new_account, studio))
    return {**out, "status": youtube_publish.status(user, studio)}


@router.put("/posting/youtube/privacy")
def youtube_posting_privacy(body: PrivacyBody, user: str = Depends(require_user)):
    _run(youtube_publish.set_privacy, body.privacy)
    return youtube_publish.status(user, studio)


@router.delete("/posting/youtube")
def youtube_posting_disconnect(user: str = Depends(require_user)):
    return _run(youtube_publish.disconnect, user, None, studio)


@router.delete("/posting/youtube/channels/{channel_id}")
def youtube_posting_disconnect_channel(channel_id: int, user: str = Depends(require_user)):
    return _run(youtube_publish.disconnect, user, channel_id, studio)


@router.post("/posts/{post_id}/publish-youtube")
async def publish_youtube(post_id: int, user: str = Depends(require_user)):
    """Uploads an approved YouTube post exactly as approved, with the AI label, and records its link."""
    try:
        return await youtube_publish.publish(studio, post_id, user)
    except StudioError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc


# -- TikTok and Instagram through the person's own registered apps (section 12, David 2026-11-10) ---------------------

class SocialAppBody(Body):
    key: Optional[str] = Field(None, max_length=200)          # TikTok client key, or Meta app ID
    secret: Optional[str] = Field(None, max_length=300)       # sealed at once; never returned
    audited: Optional[bool] = None                            # TikTok: the person says the app passed TikTok's audit
    redirect: Optional[str] = Field(None, max_length=10)      # Instagram: "loopback" or "paste"
    config_id: Optional[str] = Field(None, max_length=40)     # Instagram: optional Facebook Login for Business configuration


class SocialConnectBody(Body):
    channel_id: int


class SocialPasteBody(Body):
    address: str = Field(max_length=4000)


class TikTokPostBody(Body):
    privacy_level: Optional[str] = Field(None, max_length=30)   # no default: the person chooses each time (TikTok's rule)
    allow_comment: bool = False
    allow_duet: bool = False
    allow_stitch: bool = False
    consent: bool = False                                       # the person agreed to TikTok's Music Usage Confirmation


class SocialSyncBody(Body):
    platform: Optional[str] = Field(None, max_length=10)


def _social_platform(platform: str) -> str:
    if platform not in social_auth.PLATFORMS:
        raise HTTPException(404, "Not found")
    return platform


@router.get("/social/status")
def social_status(user: str = Depends(require_user)):
    """The person's TikTok and Instagram apps (never a secret), each channel's connection, and the redirect URIs to
    register with each platform."""
    return social_auth.status(local_api_base())


@router.put("/social/apps/{platform}")
def social_save_app(platform: str, body: SocialAppBody, user: str = Depends(require_user)):
    _social_platform(platform)
    given = _given(body)
    _run(social_auth.save_app, platform, given.get("key"), given.get("secret"), given.get("audited"),
         given.get("redirect"), given.get("config_id"))
    return social_auth.status(local_api_base())


@router.delete("/social/apps/{platform}")
def social_remove_app(platform: str, user: str = Depends(require_user)):
    return _run(social_auth.remove_app, _social_platform(platform))


@router.post("/social/{platform}/connect")
def social_connect(platform: str, body: SocialConnectBody, user: str = Depends(require_user)):
    """The platform's sign-in page for one channel, made for the person's own app. Open it in the browser."""
    _social_platform(platform)
    channel = _run(studio.get_channel, body.channel_id)
    return {"url": _run(social_auth.start, platform, channel, local_api_base(), user),
            "redirect_uri": social_auth.redirect_uri(platform, local_api_base())}


@router.post("/social/instagram/paste")
async def social_paste(body: SocialPasteBody, user: str = Depends(require_user)):
    """The paste route for a Meta app set to return to Facebook's own success page: the person pastes its address."""
    try:
        state, code, error = social_auth.from_pasted(body.address)
        return {"account": await social_auth.finish("instagram", state, code, error), **social_auth.status(local_api_base())}
    except StudioError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc


@router.delete("/social/channels/{channel_id}")
async def social_disconnect(channel_id: int, user: str = Depends(require_user)):
    _run(studio.get_channel, channel_id)
    return await social_auth.disconnect(channel_id)


@router.get("/posts/{post_id}/tiktok-post-form")
async def tiktok_post_form(post_id: int, user: str = Depends(require_user)):
    """What the person sees before Post to TikTok: creator name, who-can-see-it choices, interactions, consent line."""
    try:
        return await tiktok_api.post_form(studio, post_id)
    except StudioError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc


@router.post("/posts/{post_id}/publish-tiktok")
async def publish_tiktok(post_id: int, body: TikTokPostBody, user: str = Depends(require_user)):
    """Posts an approved post to TikTok with the person's own choices (the person's press only; bots have no TikTok tool)."""
    try:
        return await tiktok_api.publish(studio, post_id, user, body.privacy_level, body.allow_comment, body.allow_duet,
                                        body.allow_stitch, body.consent)
    except StudioError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc


@router.post("/posts/{post_id}/publish-instagram")
async def publish_instagram(post_id: int, user: str = Depends(require_user)):
    """Posts an approved post to Instagram as a Reel, exactly as approved, with Meta's AI label."""
    try:
        return await instagram_api.publish(studio, post_id, user)
    except StudioError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc


@router.post("/analytics/social/sync")
async def social_sync(body: SocialSyncBody = SocialSyncBody(), user: str = Depends(require_user)):
    """Reads the official numbers now for connected TikTok and Instagram channels (otherwise once a day)."""
    if body.platform is not None:
        _social_platform(body.platform)
    try:
        return {"result": await social.sync(studio, body.platform), **social_auth.status(local_api_base())}
    except StudioError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc


@social_router.get("/api/content-studio/social/callback/{platform}", response_class=HTMLResponse)
async def social_callback(platform: str, state: str = "", code: Optional[str] = None, error: Optional[str] = None):
    # No Kairos session here, deliberately (like /api/google/oauth/callback): the platform sends the person back to this
    # loopback address in their own browser, which may have no Kairos cookie. The defence is the state (unguessable,
    # single use, ten minutes, bound to the Kairos account and channel that started it), TikTok's PKCE, the app secret
    # for the exchange, and that the address only answers on this computer.
    import html as html_text
    from core import accounts
    if platform not in social_auth.PLATFORMS:
        raise HTTPException(404, "Not found")
    started_by = social_auth.pending_account(state)
    name = "TikTok" if platform == "tiktok" else "Instagram"
    try:
        if started_by is None:
            raise social_auth.SocialError("This sign-in expired or was not started here. Connect again from Kairos.")
        with accounts.as_account(started_by):
            account = await social_auth.finish(platform, state, code, error)
        message, status_code = f"Connected {html_text.escape(account)} to Kairos. Return to Kairos.", 200
    except StudioError as exc:
        message, status_code = html_text.escape(exc.detail), exc.status
    return HTMLResponse(f"<!doctype html><meta charset=utf-8><title>Kairos {name} connection</title>"
                        f"<body style='font-family:system-ui;max-width:34rem;margin:4rem auto;padding:1rem'>"
                        f"<h1>{name}</h1><p>{message}</p></body>", status_code=status_code)


# -- Prepare post and the publishing dashboard ---------------------------------------------------------------------

class PrepareBody(Body):
    schedule_at: Optional[float] = None


class ScheduleBody(Body):
    at: Optional[float] = None


class FillReportBody(Body):
    stage: str = Field(max_length=10)
    filled: list[str] = Field(default_factory=list, max_length=20)
    missing: list[str] = Field(default_factory=list, max_length=20)
    note: str = Field("", max_length=300)


@router.get("/publishing")
def publishing_view(user: str = Depends(require_user)):
    """Every post with its state, schedule, live link and next action, for the dashboard and its week calendar."""
    return {**publishing.dashboard(studio), "page_reads": page_reads.status(studio)}


@router.post("/posts/{post_id}/prepare")
def prepare_post(post_id: int, body: PrepareBody = PrepareBody(), user: str = Depends(require_user)):
    """Assembles an approved post for its platform: file, text, hashtags, AI label, cover, schedule and checklist."""
    return _run(prepare.prepare, studio, post_id, user, body.schedule_at)


@router.get("/preparations/{prep_id}")
def preparation(prep_id: int, user: str = Depends(require_user)):
    return _run(studio.get_preparation, prep_id)


@router.post("/posts/{post_id}/schedule")
def schedule_post(post_id: int, body: ScheduleBody, user: str = Depends(require_user)):
    """Sets (or clears, with null) when a prepared post should go out."""
    return _run(prepare.schedule, studio, post_id, body.at)


def _desktop(request: Request, user: str = Depends(require_user)) -> str:
    from routes.browse_routes import _desktop as desktop_only
    return desktop_only(request, user)


@router.post("/desktop/prepared/{prep_id}")
def desktop_fill_plan(prep_id: int, user: str = Depends(_desktop)):
    """The desktop app's main process, when the person pressed Open upload page: what to fill, with the file's path."""
    return _run(prepare.fill_plan, studio, prep_id)


@router.post("/desktop/prepared/{prep_id}/report")
def desktop_fill_report(prep_id: int, body: FillReportBody, user: str = Depends(_desktop)):
    return _run(prepare.report_fill, studio, prep_id, body.stage, body.filled, body.missing, body.note)


# -- page-read analytics (TikTok and Instagram, the person's own signed-in pages) -------------------------------------

class PageReadsBody(Body):
    tiktok: Optional[bool] = None
    instagram: Optional[bool] = None


class PlatformBody(Body):
    platform: str = Field(max_length=10)


@router.get("/analytics/pages")
def page_reads_status(user: str = Depends(require_user)):
    return page_reads.status(studio)


@router.put("/analytics/pages")
def page_reads_switch(body: PageReadsBody, user: str = Depends(require_user)):
    """The person turns page reads on or off per platform."""
    _run(studio.update_settings, page_reads={k: v for k, v in _given(body).items() if v is not None})
    return page_reads.status(studio)


_reading: dict = {}


@router.post("/analytics/pages/read")
async def page_reads_now(body: PlatformBody, user: str = Depends(require_user)):
    """Read now: the due posts of one platform, within the same limits as the schedule. Runs in the background
    (pages are read at least 20 seconds apart); the status shows each read as it lands."""
    if body.platform not in ("tiktok", "instagram"):
        raise HTTPException(422, "Page reads are for TikTok and Instagram.")
    if not studio.settings()["page_reads"].get(body.platform):
        raise HTTPException(409, "Turn page reads on for this platform first.")
    if not page_reads.available():
        raise HTTPException(409, "Page reads need the Kairos desktop app open.")
    from core import accounts
    key = (accounts.effective_account(), body.platform)
    running = _reading.get(key)
    if running is None or running.done():
        _reading[key] = asyncio.ensure_future(page_reads.read_due(studio, body.platform))
    return {"started": True, **page_reads.status(studio)}


@router.post("/analytics/pages/try-again")
def page_reads_try_again(body: PlatformBody, user: str = Depends(require_user)):
    try:
        return page_reads.try_again(studio, body.platform)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


def _worker(request: Request) -> None:
    if not page_reads.token_ok(request.headers.get("X-Kairos-Render-Token")):
        raise HTTPException(404, "Not found")
    host = request.client.host if request.client else ""
    if host not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(404, "Not found")


@worker_router.get("/api/content-studio/page-reads/jobs")
async def page_read_jobs(request: Request) -> StreamingResponse:
    _worker(request)
    return StreamingResponse(page_reads.worker_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


@worker_router.post("/api/content-studio/page-reads/result/{job_id}")
async def page_read_result(job_id: str, request: Request) -> dict:
    _worker(request)
    body = await request.body()
    if len(body) > 2 * 1024 * 1024:
        raise HTTPException(413, "Too large")
    return {"ok": page_reads.complete(job_id, body, request.headers.get("X-Kairos-Render-Error"))}


# -- hands-off posting and Pause team (services/content_studio/handsoff.py, 2026-11-11) ------------------------------
# The person's click only: these routes need their sign-in, and no bot tool changes either switch.

class SwitchBody(Body):
    on: bool


@router.get("/hands-off")
def hands_off_state(user: str = Depends(require_user)):
    from services.content_studio import handsoff
    taps = [{"post_id": p["id"], "title": p["title"], "handle": p["handle"]} for p in handsoff.tiktok_taps(studio)]
    return {**handsoff.state(studio), "taps": taps}


@router.put("/hands-off")
def set_hands_off(body: SwitchBody, user: str = Depends(require_user)):
    from services.content_studio import handsoff
    return _run(handsoff.set_hands_off, studio, body.on, user)


@router.put("/team-pause")
def set_team_pause(body: SwitchBody, user: str = Depends(require_user)):
    """Pause team (body.on true) stops posting and approving at once; the team's bots may only read until resumed."""
    from services.content_studio import handsoff
    return _run(handsoff.set_paused, studio, body.on, user)