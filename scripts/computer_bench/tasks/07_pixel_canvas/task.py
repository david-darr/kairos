"""Pixels only: no refs exist, so this measures where a model's clicks land
in the 1280 x 800 screenshot (the coordinate-scaling check, spec 5.2)."""


async def setup(env):
    pass


def url(env):
    return f"{env.origin}/{env.variant['page']}"


async def oracle(env):
    await env.act("open", url=url(env))
    await env.act("click", x=env.variant["x"], y=env.variant["y"])


async def evaluate(env):
    return 1.0 if await env.page_has("Hit the circle") else 0.0
