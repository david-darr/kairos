"""The Bots resources router (Bots Phase 2): everything beneath /api/bots.

app.py mounts this one router. It includes each unit's router by a fixed import, listed here, so no unit
edits app.py and the order is fixed: the routers with static prefixes (/connections, /mcp, /keys, /logins,
/skills-library, /profile and the like) come before the ones that start with a bot id.

    bot_connections_routes  unit U5   connections, MCP, keys, logins, setup import
    bot_skills_routes       unit U3   private skills, library, learned-skill requests
    bot_recall_routes       unit U2   recall, forget, About you
    bot_access_routes       unit U4   grants and the ceiling
    bot_memory_routes       unit U1   the notebook

A router whose file has not arrived yet (its unit is not merged) is skipped; any other import failure is
raised, never hidden. Unit tests of one unit mount only that unit's router.
"""
import importlib

from fastapi import APIRouter

router = APIRouter()

ROUTERS = ("bot_connections_routes", "bot_skills_routes", "bot_recall_routes", "bot_access_routes", "bot_memory_routes")
included: list = []

for _name in ROUTERS:
    try:
        _module = importlib.import_module(f"routes.{_name}")
    except ModuleNotFoundError as error:
        if error.name != f"routes.{_name}":
            raise
        continue
    router.include_router(_module.router)
    included.append(_name)
