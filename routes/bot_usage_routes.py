"""Admin usage endpoints. Owner filtering is applied before aggregation."""
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from core.middleware import require_admin
from services import bot_usage
from core import model_prices

router = APIRouter(prefix="/api/bot-usage", tags=["bot-usage"])


def _call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None


@router.get("/summary")
def summary(from_: str | None = Query(None, alias="from"), to: str | None = None,
            group_by: Literal["bot", "model", "endpoint", "day", "trigger", "routine"] = "bot",
            bot_id: str | None = None, user: str = Depends(require_admin)):
    return _call(bot_usage.summary, from_, to, group_by, bot_id, user)


@router.get("/runs")
def runs(from_: str | None = Query(None, alias="from"), to: str | None = None,
         bot_id: str | None = None, offset: int = Query(0, ge=0, le=1_000_000),
         limit: int = Query(50, ge=1, le=100), user: str = Depends(require_admin)):
    return _call(bot_usage.runs, from_, to, bot_id, offset, limit, user)


@router.get("/traces")
def traces(from_: str | None = Query(None, alias="from"), to: str | None = None,
           bot_id: str | None = None, offset: int = Query(0, ge=0, le=1_000_000),
           limit: int = Query(50, ge=1, le=100), user: str = Depends(require_admin)):
    return _call(bot_usage.runs, from_, to, bot_id, offset, limit, user)


@router.get("/traces/{run_id}")
def trace(run_id: str, user: str = Depends(require_admin)):
    from services.bot_trace import detail
    try:
        return detail(run_id, user)
    except KeyError:
        raise HTTPException(404, "Run not found") from None


@router.get("/usage.csv")
def csv(from_: str | None = Query(None, alias="from"), to: str | None = None,
        bot_id: str | None = None, user: str = Depends(require_admin)):
    return Response(_call(bot_usage.csv_export, from_, to, bot_id, user), media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="bot-usage.csv"'})


class Budget(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    monthly_usd: float | None = Field(None, ge=0, le=1_000_000_000)
    warn_percent: int = Field(80, ge=1, le=100)


@router.get("/budget")
def budget(user: str = Depends(require_admin)):
    from services.bot_spend import budget
    return budget()


@router.put("/budget")
def save_budget(body: Budget, user: str = Depends(require_admin)):
    bot_usage.update_settings(budget=body.model_dump())
    return budget(user)


class Rate(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    input: float = Field(ge=0, le=1_000_000)
    output: float = Field(ge=0, le=1_000_000)
    cache_read: float = Field(ge=0, le=1_000_000)
    cache_write: float = Field(ge=0, le=1_000_000)


class Prices(BaseModel):
    model_config = ConfigDict(extra="forbid")
    prices_override: dict[str, Rate] = Field(default_factory=dict, max_length=200)


@router.get("/prices")
def prices(user: str = Depends(require_admin)):
    return {"as_of": model_prices.PRICES_AS_OF, "prices": model_prices.LIST_PRICES,
            "prices_override": bot_usage.settings()["prices_override"]}


@router.put("/prices")
def save_prices(body: Prices, user: str = Depends(require_admin)):
    if any(not 1 <= len(k) <= 200 for k in body.prices_override):
        raise HTTPException(422, "Model names are limited to 200 characters")
    bot_usage.update_settings(prices_override={k: v.model_dump() for k, v in body.prices_override.items()})
    return prices(user)


@router.get("/plan")
def plan(refresh: bool = False, user: str = Depends(require_admin)):
    from core.quota_usage import get_bot_plan
    return get_bot_plan(refresh)


class Housekeeping(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    event_retention_days: int = Field(30, ge=1, le=3650)
    event_size_cap_mb: float = Field(50, ge=.25, le=4096)


@router.get("/housekeeping")
def housekeeping(user: str = Depends(require_admin)):
    config = bot_usage.settings()
    return {k: config[k] for k in ("event_retention_days", "event_size_cap_mb")}


@router.put("/housekeeping")
def save_housekeeping(body: Housekeeping, user: str = Depends(require_admin)):
    bot_usage.update_settings(**body.model_dump())
    return housekeeping(user)
