"""Desktop: launch the editor, type, save through its dialog."""
import asyncio


async def setup(env):
    await env.computer()


async def focused(env, word):
    window = (await env.command("focused_window"))["window"]
    return word in (window.get("class", "") + " " + window.get("title", "")).lower()


async def name_field(env):
    """The Save dialog's Name field, by its accessible row."""
    read = await env.act("read", desktop=True, query="Name")
    if read.get("code"):
        return None
    return env.ref(read["text"], r"text Name\b")


async def save_text(env, text, path):
    """Shared with pdf_total: write `text` in the editor and save it at `path`."""
    await env.act("launch", app="editor")
    await env.wait_for(lambda: focused(env, "mousepad"))
    await env.act("type", desktop=True, text=text)
    await env.act("key", desktop=True, key="Control+s")
    await env.wait_for(lambda: focused(env, "save"))
    # The dialog can be active before its Name field holds the keyboard
    # (measured 2026-10-22): type by the field's ref, which focuses it first.
    dialog = await env.wait_for(lambda: name_field(env))
    await env.act("type", ref=dialog, text=path)
    await env.act("key", desktop=True, key="Enter")
    await env.wait_for(lambda: env.file_text(path), seconds=15)
    await asyncio.sleep(0.3)


async def oracle(env):
    await save_text(env, env.variant["text"], env.variant["path"])


async def evaluate(env):
    saved = await env.file_text(env.variant["path"])
    return 1.0 if saved is not None and saved.strip() == env.variant["text"] else 0.0
