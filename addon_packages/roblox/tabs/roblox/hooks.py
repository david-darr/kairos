from core import tab_api
workspace = tab_api.roblox_workspace


async def stop():
    await workspace.stop()
