"""Read each switch's state from the rows, flip only the ones that differ."""
import re

LABELS = {"email": "Email alerts", "dark": "Dark mode", "digest": "Weekly digest"}


async def setup(env):
    pass


async def oracle(env):
    await env.act("open", url=env.origin + "/settings.html")
    page = (await env.act("read"))["text"]
    steps = []
    for key, label in LABELS.items():
        row = re.search(r"\[(r\d+:\d+)\] input " + label + r" \((checked|not checked)\)", page)
        now = "on" if row.group(2) == "checked" else "off"
        if now != env.variant[key]:
            steps.append({"action": "click", "ref": row.group(1)})
    steps.append({"action": "click", "ref": env.ref(page, "button Apply settings")})
    await env.act("steps", steps=steps)


async def evaluate(env):
    v = env.variant
    return 1.0 if await env.page_has(f"Applied: email={v['email']} dark={v['dark']} digest={v['digest']}") else 0.0
