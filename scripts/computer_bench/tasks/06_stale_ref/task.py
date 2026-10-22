"""A trap for stale refs: a ref read before the list moved must not press
another row's button. The oracle reads again after the page settles."""
import asyncio


async def setup(env):
    pass


async def oracle(env):
    await env.act("open", url=env.origin + "/inbox.html")
    early = (await env.act("read"))["text"]
    await asyncio.sleep(2)
    stale = await env.act("click", ref=env.ref(early, f"button Archive message from {env.variant['sender']}"))
    env.notes["early_click"] = stale.get("code")
    page = (await env.act("read"))["text"]
    await env.act("click", ref=env.ref(page, f"button Archive message from {env.variant['sender']}"))


async def evaluate(env):
    sender = env.variant["sender"]
    others = [name for name in ("Ada", "Grace", "Alan", "Margaret") if name != sender]
    for name in others:
        if await env.page_has("Archived: " + name):
            return 0.0
    return 1.0 if await env.page_has("Archived: " + sender) else 0.0
