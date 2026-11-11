"""Bot and team reports (services/bot_activity_report.py). Read only; the owner comes only from authentication."""
from fastapi import APIRouter, Depends, Query

from core.middleware import require_user
from services import bot_activity_report as reports

router = APIRouter(prefix="/api/bot-reports", tags=["bot-reports"])


@router.get("/bots/{bot_id}")
def bot_report(bot_id: str, days: int = Query(reports.DEFAULT_DAYS, ge=1, le=reports.MAX_DAYS),
               user: str = Depends(require_user)):
    return reports.bot_report(user, bot_id, days=days)


@router.get("/teams/{team_id}")
def team_report(team_id: str, days: int = Query(reports.DEFAULT_DAYS, ge=1, le=reports.MAX_DAYS),
                user: str = Depends(require_user)):
    return reports.team_report(user, team_id, days=days)


@router.get("/content-team")
def content_team(user: str = Depends(require_user)):
    """The team Studio > Content's bots belong to, so Studio can link to its report."""
    return {"team_id": reports.content_team_id(user)}
