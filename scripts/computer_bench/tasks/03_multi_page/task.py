"""Three pages in a row: each navigation makes the last read's refs stale."""


async def setup(env):
    pass


async def oracle(env):
    v = env.variant
    await env.act("open", url=env.origin + "/step1.html")
    page = (await env.act("read"))["text"]
    await env.act("steps", steps=[{"action": "click", "ref": env.ref(page, f"input {v['shipping']} shipping")},
                                  {"action": "click", "ref": env.ref(page, "button Next")}])
    page = (await env.act("read"))["text"]
    await env.act("steps", steps=[{"action": "type", "ref": env.ref(page, "input Postcode"), "text": v["postcode"]},
                                  {"action": "click", "ref": env.ref(page, "button Next")}])
    page = (await env.act("read"))["text"]
    await env.act("click", ref=env.ref(page, "button Finish"))


async def evaluate(env):
    v = env.variant
    return 1.0 if await env.page_has(f"Flow finished: {v['shipping'].lower()} {v['postcode']}") else 0.0
