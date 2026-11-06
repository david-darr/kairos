"""Which bot is which role on the Content Studio team (spec section 3), kept per account in the studio store.

The team template names its bots bot-1 .. bot-7; an import maps them to real bot ids and
`import_roles` records `team_roles` (bot id -> role) and `team_bot_ids` (for the report's spend line).
The bots' Kairos tools (core/bot_content_studio_tools.py) read the role from here, so a renamed or
duplicated bot keeps its job and a bot that was never on the team has none.
"""
import re

from .store import StudioError, TEAM_ROLES

KEYS = {"bot-1": "producer", "bot-2": "researcher", "bot-3": "evaluator", "bot-4": "script_writer",
        "bot-5": "editor", "bot-6": "publisher", "bot-7": "executor"}
_KEY = re.compile(r"^bot-[1-9][0-9]{0,2}$")


def roles(store):
    return store.settings()["team_roles"]


def role_of(store, bot_id):
    return roles(store).get(bot_id)


def bots_with(store, role):
    return [bot for bot, r in roles(store).items() if r == role]


def producer_id(store):
    found = bots_with(store, "producer")
    return found[0] if found else None


def import_roles(store, data, mapping):
    """Records the imported bots' roles. Returns an undo."""
    if not isinstance(data, dict) or set(data) - {"roles"} or not isinstance(data.get("roles"), dict):
        raise ValueError("Invalid content studio section")
    given = data["roles"]
    if len(given) > 20 or any(not isinstance(k, str) or not _KEY.fullmatch(k) or v not in TEAM_ROLES for k, v in given.items()):
        raise ValueError("Content studio roles are team roles by package bot key")
    before = store.settings()
    new = {mapping[k]: v for k, v in given.items() if k in mapping}
    if not new:
        return lambda: None
    try:
        store.update_settings(team_roles={**before["team_roles"], **new},
                             team_bot_ids=list(dict.fromkeys([*before["team_bot_ids"], *new])))
    except StudioError as exc:
        raise ValueError(str(exc)) from exc

    def undo():
        store.update_settings(team_roles=before["team_roles"], team_bot_ids=before["team_bot_ids"])
    return undo
