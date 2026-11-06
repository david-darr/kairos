"""Approval levels and a monthly spend cap in bot packages (Content Studio Team, 2026-11-06).

The package validator drops access settings, so a package's bots arrive at the account's default level.
A team that must never act on its own (the Content Studio Team) names the level it needs here, and an
import applies it. The section can only LOWER things:

- `approval`: {package bot key: "ask" | "edits"}. A level that is not lower than the bot's own is skipped.
- `monthly_cap_usd` / `warn_percent`: the Bots spend cap (services/bot_usage.py). An existing lower cap
  stays; an import never raises or removes a limit.

Bots are named by package keys (`bot-1`, ...). Every import returns an undo.
"""
from __future__ import annotations

import re

from services import bot_package

KEY = re.compile(r"^bot-[1-9][0-9]{0,2}$")
LEVELS = ("ask", "edits")
ORDER = ("ask", "edits", "auto", "full", "custom")


def export_policy(bot_ids):
    return {}  # approval and spend are workspace settings; they never travel with an export


def import_policy(data, mapping):
    from services import bot_usage
    from services.agent_service import agent_service
    if not isinstance(data, dict) or set(data) - {"approval", "monthly_cap_usd", "warn_percent"}:
        raise ValueError("Invalid policy")
    approval = data.get("approval", {})
    if not isinstance(approval, dict) or len(approval) > 100 or any(
            not isinstance(k, str) or not KEY.fullmatch(k) or v not in LEVELS for k, v in approval.items()):
        raise ValueError("Policy approval levels are ask or edits, by package bot key")
    cap, warn = data.get("monthly_cap_usd"), data.get("warn_percent")
    if cap is not None and (type(cap) not in (int, float) or not 0 < cap <= 1_000_000):
        raise ValueError("The monthly cap is a positive dollar amount")
    if warn is not None and (type(warn) is not int or not 1 <= warn <= 100):
        raise ValueError("The warning level is a whole percent")
    changed, before_budget = [], None

    def undo():
        for ident, mode in reversed(changed):
            if agent_service.get(ident) is not None:
                agent_service.update(ident, approval_mode=mode)
        if before_budget is not None:
            bot_usage.update_settings(budget=before_budget)

    try:
        for key, mode in approval.items():
            ident = mapping.get(key)
            agent = agent_service.get(ident) if ident else None
            if agent is None or ORDER.index(agent.get("approval_mode", "ask")) <= ORDER.index(mode):
                continue
            agent_service.update(ident, approval_mode=mode)
            changed.append((ident, agent.get("approval_mode")))
        if cap is not None:
            current = bot_usage.settings()["budget"]
            before_budget = dict(current)
            existing = current["monthly_usd"]
            bot_usage.update_settings(budget={**current, "monthly_usd": cap if existing is None else min(existing, cap),
                                              "warn_percent": warn or current["warn_percent"]})
    except Exception:
        undo()
        raise
    return undo


bot_package.register_section("policy", export_policy, import_policy)
