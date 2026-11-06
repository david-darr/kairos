"""Content Studio: pipeline view, scoring record, selection review and the approval queue (build spec
"Content Studio Team", steps 2 and 4). Every route needs a signed-in user and works in that account's own
store only (services/content_studio). No platform APIs: numbers come in by manual entry or import.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from core.middleware import require_user
from services.content_studio import StudioError, pipeline, report, review, studio

router = APIRouter(prefix="/api/content-studio", tags=["content-studio"])


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class NicheBody(Body):
    name: str = Field(max_length=80)


class ChannelBody(Body):
    niche_id: int
    platform: str = Field(max_length=20)
    handle: str = Field(max_length=100)


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
    script_ref: Optional[str] = Field(None, max_length=500)
    caption: str = Field("", max_length=5000)
    format: Optional[str] = Field(None, max_length=80)


class EditBody(Body):
    title: Optional[str] = Field(None, max_length=200)
    caption: Optional[str] = Field(None, max_length=5000)
    script_ref: Optional[str] = Field(None, max_length=500)
    render_ref: Optional[str] = Field(None, max_length=500)
    render_status: Optional[str] = Field(None, max_length=10)
    format: Optional[str] = Field(None, max_length=80)


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
    actor: str = Field("user", max_length=10)  # "user", or "producer" for the lead bot's step
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


@router.post("/channels/{channel_id}/restore")
def restore_channel(channel_id: int, user: str = Depends(require_user)):
    return _run(studio.restore_channel, channel_id)


@router.post("/channels/{channel_id}/warning")
def channel_warning(channel_id: int, body: WarningBody, user: str = Depends(require_user)):
    """Records a platform warning; the channel is paused until it is resumed."""
    return _run(studio.record_warning, channel_id, body.text)


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
                body.evaluator_strategy_id, body.script_ref, body.caption, body.format)


@router.get("/posts/{post_id}")
def get_post(post_id: int, user: str = Depends(require_user)):
    return {**_run(studio.get_post, post_id), "metrics": studio.snapshots(post_id)}


@router.post("/posts/{post_id}/edit")
def edit_post(post_id: int, body: EditBody, user: str = Depends(require_user)):
    return _run(studio.edit_post, post_id, **_given(body))


@router.post("/posts/{post_id}/submit")
def submit_post(post_id: int, user: str = Depends(require_user)):
    return _run(studio.submit_for_approval, post_id)


@router.get("/approvals")
def approvals(user: str = Depends(require_user)):
    return {"posts": pipeline.approval_queue(studio)}


@router.post("/posts/{post_id}/approve")
def approve_post(post_id: int, user: str = Depends(require_user)):
    """Marks the post approved. Preparing or sending it to the platform is the Publisher step, built later."""
    return _run(studio.approve, post_id, user)


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
    return _run(review.confirm, studio, decision_id, body.actor, user)


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


@router.get("/settings")
def get_settings(user: str = Depends(require_user)):
    return studio.settings()


@router.put("/settings")
def put_settings(body: SettingsBody, user: str = Depends(require_user)):
    return _run(studio.update_settings, **_given(body))
