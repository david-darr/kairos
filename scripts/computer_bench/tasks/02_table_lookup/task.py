"""Look narrowly (read with query) for one row of a table, then answer."""
import re


async def setup(env):
    pass


async def oracle(env):
    product = env.variant["product"]
    await env.act("open", url=env.origin + "/prices.html")
    found = (await env.act("read", query=product))["text"]
    line = next(line for line in found.splitlines() if line.startswith(product))
    price = re.search(r"\$([0-9.]+)", line).group(1)
    page = (await env.act("read", query="Answer"))["text"]
    await env.act("steps", steps=[{"action": "type", "ref": env.ref(page, "input Answer"), "text": price},
                                  {"action": "click", "ref": env.ref(page, "button Check")}])


async def evaluate(env):
    return 1.0 if await env.page_has(f"Answer recorded: {env.variant['price']}") else 0.0
