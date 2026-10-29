"""Team tools, including siblings when their build units are installed."""
from importlib import import_module

MODULES = ("core.bot_delegation_tools", "core.bot_room_tools", "core.bot_chief_tools")
LOADED = []
for name in MODULES:
    try:
        import_module(name)
    except ModuleNotFoundError as error:
        if error.name != name:
            raise
    else:
        LOADED.append(name)

from core import bot_loop_guard  # installs the run observer once
