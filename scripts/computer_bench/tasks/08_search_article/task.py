"""Search, then follow a result: a diff read shows what the search added."""


async def setup(env):
    pass


async def oracle(env):
    v = env.variant
    await env.act("open", url=env.origin + "/help.html")
    page = (await env.act("read"))["text"]
    searched = await env.act("steps", steps=[
        {"action": "type", "ref": env.ref(page, "input Search the help"), "text": v["term"]},
        {"action": "click", "ref": env.ref(page, "button Search")}])
    await env.act("click", ref=env.ref(searched["text"], "a " + v["title"]))
    article = (await env.act("read"))["text"]
    await env.act("click", ref=env.ref(article, "button Mark as read"))


async def evaluate(env):
    return 1.0 if await env.page_has("Marked read: " + env.variant["title"]) else 0.0
