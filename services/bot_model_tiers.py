"""Model tiers for team templates (David, 2026-11-11: "smaller models for less tedious roles", decided at team creation).

A package bot may carry `model_tier`: light (routine record keeping, watching, hand-offs), standard, or strong
(judgment and writing). At import each tier becomes a concrete model from the connections this account really has
(core/model_endpoints.py), preferring the connection new bots use by default (services/bot_record.py defaults_view:
the first Claude connection). A provider the account has not connected is never picked: every choice names one of
the account's own endpoint ids, and an import refuses one that is not.

How a tier maps, per kind of connection:
- Claude (claude_cli): strong Opus, standard Sonnet, light Haiku (core/model_catalog.py's curated ids).
- Codex (codex_cli): its own catalog; light is a "mini" model when it lists one, and the effort follows the tier
  (high, medium, low) when the model supports it.
- Antigravity (antigravity_cli): the Argon models for strong and standard, a Flash model for light, by effort.
- An API or local connection has one model, so every tier on it is that model.
When the preferred connection cannot express a tier, another connected one that can is used; when none can, the
preferred connection's own model is used and the note says so. With no connection at all, nothing is chosen.

The relative cost line weighs light 1, standard 4, strong 15 (the rough ratio of the Claude prices) against every
bot on the strongest tier. It is an estimate, and says so.
"""
from __future__ import annotations

from typing import Optional

TIERS = ("light", "standard", "strong")
LABELS = {"light": "Light", "standard": "Standard", "strong": "Strong"}
BLURBS = {"light": "Cheap and fast: routine record keeping, watching, hand-offs.",
          "standard": "Everyday work: research, checks, building.",
          "strong": "Judgment and writing: decisions, scripts, reviews."}
WEIGHT = {"light": 1, "standard": 4, "strong": 15}
EFFORT = {"light": "low", "standard": "medium", "strong": "high"}
CLAUDE = {"strong": "claude-opus-5-5", "standard": "claude-sonnet-5-5", "light": "claude-haiku-5-5"}
CLAUDE_TIER = {v: k for k, v in CLAUDE.items()}
KIND_LABEL = {"claude_cli": "Claude", "codex_cli": "Codex", "antigravity_cli": "Antigravity", "api": "API", "local": "Local"}


def connected() -> list[dict]:
    """The account's own connections (and ones shared with it): never a provider it has not connected."""
    from core import model_endpoints
    return [e for e in model_endpoints.list_endpoints() if e.get("id") and e.get("kind")]


def preferred(endpoints: list[dict]) -> Optional[dict]:
    """The connection new bots use by default: the first Claude connection, else the first one there is."""
    return next((e for e in endpoints if e["kind"] == "claude_cli"), None) or (endpoints[0] if endpoints else None)


def _catalog(kind: str) -> list[dict]:
    try:
        from core import model_catalog
        return model_catalog.list_models(kind)
    except Exception:
        return []


def _effort(kind: str, model: Optional[str], tier: str) -> Optional[str]:
    try:
        from core import model_catalog
        wanted = EFFORT[tier]
        return wanted if kind in model_catalog.CATALOG_KINDS and model_catalog.validate_effort(kind, model, wanted) else None
    except Exception:
        return None


def _label(endpoint: dict, model: Optional[str], effort: Optional[str] = None) -> str:
    name = endpoint.get("name") or KIND_LABEL.get(endpoint["kind"], "Model")
    shown = model or endpoint.get("model") or "its default model"
    for entry in _catalog(endpoint["kind"]):
        if entry.get("id") == model:
            shown = entry.get("display_name") or model
    return f"{shown} on {name}" + (f", {effort} effort" if effort else "")


def _choice(endpoint: dict, model: Optional[str], tier: str, *, exact: bool, effort: Optional[str] = None) -> dict:
    override = model if model and model != endpoint.get("model") else None
    return {"endpoint_id": endpoint["id"], "model_override": override, "model_effort": effort,
            "label": _label(endpoint, model, effort), "kind": endpoint["kind"], "tier": tier if exact else None}


def express(endpoint: dict, tier: str) -> Optional[dict]:
    """This connection's model for the tier, or None when it cannot tell tiers apart."""
    kind = endpoint["kind"]
    if kind == "claude_cli":
        model = CLAUDE[tier]
        return _choice(endpoint, model, tier, exact=True)
    if kind == "codex_cli":
        models = [m["id"] for m in _catalog(kind)]
        mini = next((m for m in models if "mini" in m.lower() or "nano" in m.lower()), None)
        if tier == "light" and mini:
            return _choice(endpoint, mini, tier, exact=True, effort=_effort(kind, mini, tier))
        main = endpoint.get("model") or next((m for m in models if m != mini), None)
        effort = _effort(kind, main, tier)
        if tier != "light" and effort:
            return _choice(endpoint, main, tier, exact=True, effort=effort)
        if tier == "light" and effort:
            return _choice(endpoint, main, tier, exact=True, effort=effort)
        return None
    if kind == "antigravity_cli":
        models = [m["id"] for m in _catalog(kind)]
        family = "flash" if tier == "light" else "argon"
        found = next((m for m in models if family in m.lower()), None)
        if not found:
            return None
        return _choice(endpoint, found, tier, exact=True, effort=_effort(kind, found, tier))
    return None  # an API or local connection has one model


def resolve(tier: Optional[str], endpoints: Optional[list] = None, prefer: Optional[str] = None) -> Optional[dict]:
    """The concrete model for a tier, with a plain note when it is not an exact match. None: nothing connected."""
    endpoints = connected() if endpoints is None else endpoints
    if not endpoints:
        return None
    first = next((e for e in endpoints if e["id"] == prefer), None) or preferred(endpoints)
    if tier not in TIERS:
        choice = _choice(first, first.get("model"), "standard", exact=False)
        return {**choice, "note": "No tier was given, so it uses your default model."}
    exact = express(first, tier)
    if exact:
        return {**exact, "note": ""}
    for endpoint in endpoints:
        if endpoint is first:
            continue
        found = express(endpoint, tier)
        if found:
            return {**found, "note": f"{KIND_LABEL.get(first['kind'], 'Your default')} has no {tier} model, so it uses "
                                     f"{found['label']}."}
    fallback = _choice(first, first.get("model"), tier, exact=False)
    return {**fallback, "note": f"No {tier} model is connected, so it uses {fallback['label']}."}


def options(endpoints: Optional[list] = None) -> list[dict]:
    """Every model a person can pick for a bot here, each on a connection the account has."""
    endpoints = connected() if endpoints is None else endpoints
    out, seen = [], set()
    for endpoint in endpoints:
        rows = []
        for tier in ("strong", "standard", "light"):
            found = express(endpoint, tier)
            if found:
                rows.append(found)
        if endpoint["kind"] in ("claude_cli", "codex_cli", "antigravity_cli"):
            for entry in _catalog(endpoint["kind"])[:30]:
                rows.append(_choice(endpoint, entry["id"], CLAUDE_TIER.get(entry["id"], ""), exact=entry["id"] in CLAUDE_TIER))
        rows.append(_choice(endpoint, endpoint.get("model"), "", exact=False))
        for row in rows:
            key = (row["endpoint_id"], row["model_override"], row["model_effort"])
            if key in seen:
                continue
            seen.add(key)
            out.append({**row, "value": encode(row)})
    return out


def encode(choice: dict) -> str:
    return "|".join([choice.get("endpoint_id") or "", choice.get("model_override") or "", choice.get("model_effort") or ""])


def decode(value: str) -> dict:
    parts = (str(value or "").split("|") + ["", "", ""])[:3]
    return {"endpoint_id": parts[0] or None, "model_override": parts[1] or None, "model_effort": parts[2] or None}


def tier_of_choice(choice: Optional[dict]) -> Optional[str]:
    """The tier a picked model counts as for the cost line: its own tier when known, else standard."""
    if not choice:
        return None
    if choice.get("tier") in TIERS:
        return choice["tier"]
    if choice.get("model_override") in CLAUDE_TIER:
        return CLAUDE_TIER[choice["model_override"]]
    effort = choice.get("model_effort")
    return {"low": "light", "medium": "standard", "high": "strong", "xhigh": "strong"}.get(effort, "standard")


def cost_line(tiers: list) -> str:
    tiers = [t for t in tiers if t in TIERS]
    if not tiers:
        return ""
    share = sum(WEIGHT[t] for t in tiers) / (len(tiers) * WEIGHT["strong"])
    percent = max(1, round(share * 100))
    if percent >= 100:
        return "Estimated cost: the same as every bot on a strong model."
    return f"Estimated cost: about {percent}% of running every bot on a strong model. An estimate, not a quote."


def check_choice(choice: dict, endpoints: Optional[list] = None) -> dict:
    """A person's pick, checked: its connection must be one of this account's, and the model and effort valid."""
    endpoints = connected() if endpoints is None else endpoints
    if not isinstance(choice, dict) or set(choice) - {"endpoint_id", "model_override", "model_effort"}:
        raise ValueError("A model choice is a connection, a model and an effort")
    endpoint = next((e for e in endpoints if e["id"] == choice.get("endpoint_id")), None)
    if endpoint is None:
        raise ValueError("Pick a model from a connection this account has")
    from services.agent_service import _check_model
    override, effort = _check_model(endpoint["id"], choice.get("model_override"), choice.get("model_effort"))
    return {"endpoint_id": endpoint["id"], "model_override": override or None, "model_effort": effort}


def plan(bots: list, endpoints: Optional[list] = None) -> dict:
    """The import preview's model rows: each bot with its role, tier and the model chosen for it."""
    endpoints = connected() if endpoints is None else endpoints
    rows, tiers = [], []
    for bot in bots:
        tier = bot.get("model_tier")
        if tier not in TIERS:
            continue
        choice = resolve(tier, endpoints)
        rows.append({"key": bot["key"], "name": bot.get("name"), "role": bot.get("role") or "", "tier": tier,
                     "tier_label": LABELS[tier], "tier_blurb": BLURBS[tier], "choice": choice,
                     "value": encode(choice) if choice else "", "note": (choice or {}).get("note") or
                     ("" if choice else "No model is connected yet. Add one in Settings > Models; the bot uses it then.")})
        tiers.append(tier_of_choice(choice) or tier)
    return {"rows": rows, "options": options(endpoints) if rows else [], "cost": cost_line(tiers),
            "weights": WEIGHT, "connected": bool(endpoints)}


def suggest(members: list, tiers: dict) -> dict:
    """A proposal for a team that exists: each member's tier and the model it would get. Nothing changes until the
    person applies it."""
    endpoints = connected()
    rows, chosen = [], []
    for bot in members:
        tier = tiers.get(bot["id"])
        current = {"endpoint_id": bot.get("endpoint_id"), "model_override": bot.get("model_override"),
                   "model_effort": bot.get("model_effort")}
        endpoint = next((e for e in endpoints if e["id"] == current["endpoint_id"]), None)
        current_label = _label(endpoint, current["model_override"] or endpoint.get("model"), current["model_effort"]) \
            if endpoint else "No model chosen"
        choice = resolve(tier, endpoints) if tier in TIERS else None
        same = bool(choice) and all((choice.get(k) or None) == (current.get(k) or None)
                                    for k in ("endpoint_id", "model_override", "model_effort"))
        rows.append({"bot_id": bot["id"], "name": bot.get("name"), "role": bot.get("role") or "", "tier": tier,
                     "tier_label": LABELS.get(tier, "No tier"), "current": current_label,
                     "choice": choice, "value": encode(choice) if choice else "", "same": same,
                     "note": (choice or {}).get("note") or ("" if tier in TIERS else "This bot has no tier, so it keeps its model.")})
        if tier in TIERS:
            chosen.append(tier_of_choice(choice) or tier)
    return {"rows": rows, "options": options(endpoints), "cost": cost_line(chosen)}
