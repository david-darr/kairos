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
# The named strategies the template's instructions give the Script Writer and the Evaluator (spec section 5).
# The first of each role is the starting default; the weekly review swaps the loser for a variation of the winner.
STARTING_STRATEGIES = (("script_writer", "hook-first"), ("script_writer", "story-first"),
                       ("evaluator", "trend-weighted"), ("evaluator", "track-record-weighted"))


def roles(store):
    return store.settings()["team_roles"]


def role_of(store, bot_id):
    return roles(store).get(bot_id)


def bots_with(store, role):
    return [bot for bot, r in roles(store).items() if r == role]


def producer_id(store):
    found = bots_with(store, "producer")
    return found[0] if found else None


def seed_strategies(store):
    """Creates the starting strategies that are missing (by name, any status). Returns the ids it created."""
    have = {(s["owner_role"], s["name"].lower()) for s in store.list_strategies()}
    return [store.create_strategy(role, name)["id"] for role, name in STARTING_STRATEGIES if (role, name) not in have]


def strategy_by_name(store, role, name):
    """An active strategy of `role` by name, or the role's default when no name is given."""
    active = store.list_strategies(role, "active")
    if name:
        found = next((s for s in active if s["name"].lower() == name.strip().lower()), None)
        if found is None:
            names = ", ".join(s["name"] for s in active) or "none yet"
            raise StudioError(f"no active {role.replace('_', ' ')} strategy is called {name!r}; active: {names}")
        return found
    return next((s for s in active if s["is_default"]), active[0] if active else None)


def import_roles(store, data, mapping):
    """Records the imported bots' roles and seeds the starting strategies. Returns an undo."""
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
        created = seed_strategies(store)
    except StudioError as exc:
        raise ValueError(str(exc)) from exc

    def undo():
        store.update_settings(team_roles=before["team_roles"], team_bot_ids=before["team_bot_ids"])
        for sid in created:  # a failed import takes back the strategies it made, while no post uses them
            store._write("DELETE FROM strategies WHERE id = ? AND NOT EXISTS (SELECT 1 FROM posts WHERE "
                         "script_strategy_id = ? OR evaluator_strategy_id = ?)", (sid, sid, sid))
    return undo
