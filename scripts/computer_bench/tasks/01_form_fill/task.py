"""Fill four fields and a choice, then save: one steps call for the oracle."""


async def setup(env):
    pass


async def oracle(env):
    v = env.variant
    await env.act("open", url=env.origin + "/form.html")
    page = (await env.act("read"))["text"]
    await env.act("steps", steps=[
        {"action": "type", "ref": env.ref(page, "input Name"), "text": v["name"]},
        {"action": "type", "ref": env.ref(page, "input Email"), "text": v["email"]},
        {"action": "type", "ref": env.ref(page, "input City"), "text": v["city"]},
        {"action": "click", "ref": env.ref(page, f"input {v['plan']} plan")},
        {"action": "click", "ref": env.ref(page, "button Save details")},
    ])


async def evaluate(env):
    v = env.variant
    return 1.0 if await env.page_has(f"Saved: {v['name']} | {v['email']} | {v['city']} | {v['plan']}") else 0.0
