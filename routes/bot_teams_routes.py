"""Team API aggregator. Only an absent sibling module is optional."""
from importlib import import_module
from fastapi import APIRouter

router = APIRouter()
MODULES = ("routes.bot_peer_routes", "routes.bot_room_routes", "routes.bot_department_routes", "routes.bot_team_routes")
LOADED = []
for name in MODULES:
    try:
        module = import_module(name)
    except ModuleNotFoundError as error:
        if error.name != name:
            raise
    else:
        router.include_router(module.router)
        LOADED.append(name)
