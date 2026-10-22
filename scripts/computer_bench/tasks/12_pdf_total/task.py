"""Desktop: a PDF placed in Documents, its total copied into a text file."""
import asyncio
import importlib.util
from pathlib import Path


def _editor():
    spec = importlib.util.spec_from_file_location("bench_editor_save", Path(__file__).parents[1] / "10_editor_save" / "task.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def invoice_pdf(total: str) -> bytes:
    """A one-page PDF with plain text, built by hand (no new dependency)."""
    lines = ["Invoice 2026-118", "Kairos Supplies", "Paper, 4 boxes", "Ink, 2 cartridges", f"Invoice total: {total}"]
    text = "BT /F1 18 Tf 72 720 Td 26 TL " + " ".join(f"({line}) Tj T*" for line in lines) + " ET"
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
               b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
               b"<< /Length %d >>\nstream\n%s\nendstream" % (len(text), text.encode()),
               b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out, offsets = bytearray(b"%PDF-1.4\n"), []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (number, body)
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return bytes(out)


async def setup(env):
    await env.computer()
    await env.put_file(env.variant["pdf"], invoice_pdf(env.variant["total"]))


async def focused(env, word):
    window = (await env.command("focused_window"))["window"]
    return word in (window.get("class", "") + " " + window.get("title", "")).lower()


async def oracle(env):
    await env.act("launch", app="pdf")
    await env.wait_for(lambda: focused(env, "atril"))
    await env.act("key", desktop=True, key="Control+o")
    await env.wait_for(lambda: focused(env, "open"))
    await asyncio.sleep(1)  # the dialog takes keys a moment after it takes focus
    await env.act("type", desktop=True, text=env.variant["pdf"])
    await env.act("key", desktop=True, key="Enter")
    await env.wait_for(lambda: focused(env, "invoice"))
    await asyncio.sleep(0.5)
    await _editor().save_text(env, env.variant["total"], env.variant["out"])


async def evaluate(env):
    saved = await env.file_text(env.variant["out"])
    return 1.0 if saved is not None and saved.strip().replace("$", "") == env.variant["total"] else 0.0
