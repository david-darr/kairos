"""Desktop semantics: find a cell by its accessible name, type by its ref."""


async def setup(env):
    await env.computer()


async def cell_row(env, cell):
    reply = await env.command("desktop_read", query=cell)
    return next((row for row in reply.get("elements", []) if row.get("tag") == "table cell" and row.get("label") == cell), None)


async def oracle(env):
    cell, value = env.variant["cell"], env.variant["value"]
    await env.act("launch", app="calc")
    await env.wait_for(lambda: cell_row(env, cell), seconds=60)
    page = (await env.act("read", desktop=True, query=cell))["text"]
    await env.act("type", ref=env.ref(page, "table cell " + cell), text=value)
    await env.act("key", desktop=True, key="Enter")


async def evaluate(env):
    try:
        row = await env.wait_for(lambda: cell_row(env, env.variant["cell"]), seconds=5)
    except AssertionError:
        return 0.0
    return 1.0 if row.get("value") == env.variant["value"] else 0.0
