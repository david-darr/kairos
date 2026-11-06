"""Bots data panel routes (services/bot_data.py). Signed-in users, each in their own account.

Static paths come before `/{bot_id}`. Bodies are bounded and forbid unknown fields. A refusal that
the person should read as a card (a failed query) comes back with `detail`, `line` and `hint`."""
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field

from core.middleware import require_user
from services import bot_data, bot_data_cards, bot_data_load
from services.agent_service import agent_service
from services.bot_data import DataError

router = APIRouter(prefix="/api/bot-data", tags=["bot-data"])
ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class Run(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sql: str = Field(max_length=bot_data.DRAFT_SQL_BYTES)
    card_id: Optional[str] = Field(default=None, max_length=40)
    title: Optional[str] = Field(default=None, max_length=bot_data_cards.MAX_TITLE)
    spec: Optional[dict] = None
    run_id: Optional[str] = Field(default=None, pattern=r"^[A-Za-z0-9_-]{4,40}$")
    rows: int = Field(default=bot_data.ROWS_DEFAULT, ge=1, le=bot_data.ROWS_MAX)


class Cancel(BaseModel):
    model_config = ConfigDict(extra="forbid")
    run_id: str = Field(pattern=r"^[A-Za-z0-9_-]{4,40}$")


class SortItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    column: str = Field(max_length=200)
    desc: bool = False


class Page(BaseModel):
    model_config = ConfigDict(extra="forbid")
    card_id: str = Field(max_length=40)
    offset: int = Field(default=0, ge=0, le=bot_data.TABLE_ROWS)
    limit: int = Field(default=100, ge=1, le=bot_data.PAGE_MAX)
    sort: list[SortItem] = Field(default_factory=list, max_length=3)
    filter: dict[str, str] = Field(default_factory=dict, max_length=20)


class Load(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source: str = Field(min_length=1, max_length=2048)
    table: Optional[str] = Field(default=None, max_length=64)
    sheet: Optional[str] = Field(default=None, max_length=120)


class Export(BaseModel):
    model_config = ConfigDict(extra="forbid")
    card_id: str = Field(max_length=40)
    format: str = Field(pattern="^(csv|xlsx)$")


class CardPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: Optional[str] = Field(default=None, max_length=bot_data_cards.MAX_TITLE)
    pinned: Optional[bool] = None
    spec: Optional[dict] = None
    clear_spec: bool = False


def _bot(bot_id: str) -> str:
    if not ID.match(bot_id) or agent_service.get(bot_id) is None:
        raise HTTPException(404, "bot not found")
    return bot_id


def _fail(error: DataError) -> JSONResponse:
    return JSONResponse({"detail": str(error), "line": error.line, "hint": error.hint}, status_code=error.status)


@router.get("/{bot_id}")
def overview(bot_id: str, user: str = Depends(require_user)):
    try:
        return bot_data.overview(_bot(bot_id))
    except DataError as error:
        return _fail(error)


@router.post("/{bot_id}/run")
def run(bot_id: str, body: Run, user: str = Depends(require_user)):
    try:
        return bot_data.run(_bot(bot_id), body.sql, body.card_id, body.title, body.spec, body.run_id, body.rows)
    except DataError as error:
        return _fail(error)


@router.post("/{bot_id}/cancel")
def cancel(bot_id: str, body: Cancel, user: str = Depends(require_user)):
    return {"cancelled": bot_data.cancel(_bot(bot_id), body.run_id)}


@router.post("/{bot_id}/page")
def page(bot_id: str, body: Page, user: str = Depends(require_user)):
    try:
        return bot_data.page(_bot(bot_id), body.card_id, body.offset, body.limit,
                             [item.model_dump() for item in body.sort], body.filter)
    except DataError as error:
        return _fail(error)


@router.post("/{bot_id}/load")
def load(bot_id: str, body: Load, user: str = Depends(require_user)):
    try:
        loaded = bot_data_load.load(_bot(bot_id), body.source, body.table, body.sheet)
        return {"loaded": loaded, **bot_data.overview(bot_id)}
    except DataError as error:
        return _fail(error)


@router.post("/{bot_id}/export")
def export(bot_id: str, body: Export, user: str = Depends(require_user)):
    try:
        name, data, media = bot_data.export(_bot(bot_id), body.card_id, body.format)
    except DataError as error:
        return _fail(error)
    return Response(data, media_type=media, headers={"Content-Disposition": f'attachment; filename="{name}"',
                                                     "X-Content-Type-Options": "nosniff"})


@router.patch("/{bot_id}/cards/{card_id}")
def patch_card(bot_id: str, card_id: str, body: CardPatch, user: str = Depends(require_user)):
    fields = {k: v for k, v in (("title", body.title), ("pinned", body.pinned), ("spec", body.spec)) if v is not None}
    if body.clear_spec:
        fields["spec"] = None
    try:
        return bot_data_cards.update(_bot(bot_id), card_id, **fields)
    except bot_data_cards.CardError as error:
        return _fail(DataError(str(error), error.status))


@router.delete("/{bot_id}/cards/{card_id}")
def delete_card(bot_id: str, card_id: str, user: str = Depends(require_user)):
    try:
        bot_data_cards.delete(_bot(bot_id), card_id)
    except bot_data_cards.CardError as error:
        return _fail(DataError(str(error), error.status))
    return {"ok": True}


@router.get("/{bot_id}/cards/{card_id}/chart")
def card_chart(bot_id: str, card_id: str, user: str = Depends(require_user)):
    try:
        return bot_data.chart_for(_bot(bot_id), card_id)
    except DataError as error:
        return _fail(error)


@router.get("/{bot_id}/tables/{table}/stats")
def table_stats(bot_id: str, table: str, user: str = Depends(require_user)):
    try:
        return bot_data.engine(_bot(bot_id)).stats(table)
    except DataError as error:
        return _fail(error)


@router.get("/{bot_id}/tables/{table}/histogram")
def table_histogram(bot_id: str, table: str, column: str = Query(max_length=200), bins: int = Query(default=20, ge=2, le=200),
                    user: str = Depends(require_user)):
    try:
        return bot_data.engine(_bot(bot_id)).histogram(table, column, bins)
    except DataError as error:
        return _fail(error)
