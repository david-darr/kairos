"""A06 benchmark (g8): the real contained browser in Docker, no public network, no model.

Cold start (docker run to first driver answer), snapshot/read/frame latency (p50/p95),
payload sizes for a fixture page, and cleanup (containers left behind after close_all).
The page is set inside the driver, so nothing is fetched from the internet.

    .venv\\Scripts\\python.exe -B -X utf8 scripts\\g8_computer_bench.py
"""
import asyncio
import base64
import json
import os
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
data = tempfile.mkdtemp(prefix="g8-cbench-")
os.environ["JARVIS_DATA_DIR"] = data
os.environ["JARVIS_VAULT_DIR"] = os.path.join(data, "vault")

from core import computer  # noqa: E402
from core.computer_driver import SOURCE  # noqa: E402

PAGE = ("<h1>Fixture shop</h1><nav>" + "".join(f'<a href="#p{i}">Product {i}</a> ' for i in range(30)) + "</nav>"
        "<form><label for=n>Name</label><input id=n><label for=e>Email</label><input id=e>"
        "<button type=button>Save</button></form><p>" + ("Lorem ipsum dolor sit amet. " * 200) + "</p>")
FIXTURE = SOURCE.replace("            if action == 'state':", """            if action == 'bench_fixture':
                await page.set_content(%r)
                return {'url': page.url}
            if action == 'state':""" % PAGE, 1)


def stats(values):
    values = sorted(values)
    return dict(n=len(values), p50=round(statistics.median(values), 1),
                p95=round(values[min(len(values) - 1, int(round(0.95 * (len(values) - 1))))], 1))


def containers():
    out = subprocess.run(["docker", "ps", "-a", "--format", "{{.Names}}"], capture_output=True, text=True).stdout.split()
    return {n for n in out if n.startswith("jarvis-")}


async def timed(awaitable):
    t = time.perf_counter()
    result = await awaitable
    return (time.perf_counter() - t) * 1000, result


async def main():
    before = containers()
    manager = computer.ComputerManager()
    owner = "chat:g8-bench"
    out = {}
    try:
        with patch("core.computer.SOURCE", FIXTURE):
            ms, c = await timed(manager._get(owner))
            ms2, _ = await timed(manager._command(c, "state"))
            out["cold_start_ms"] = round(ms + ms2)
            await manager._command(c, "bench_fixture")
            snap, read, frame, ref = [], [], [], []
            sizes = {}
            for i in range(15):
                t, r = await timed(manager._command(c, "snapshot"))
                snap.append(t)
                sizes["snapshot_jpeg_bytes"] = len(base64.b64decode(r["screenshot"]))
            for i in range(15):
                t, r = await timed(manager._command(c, "read"))
                read.append(t)
                sizes["read_text_chars"] = len(r.get("text") or r.get("content") or json.dumps({k: v for k, v in r.items() if k != "screenshot"}))
                sizes["read_reply_keys"] = sorted(r)
            for i in range(15):
                c.last_snapshot = 0
                t, r = await timed(manager.frame(owner))
                frame.append(t)
                sizes["frame_b64_chars"] = len(r["image"])
            out["snapshot_ms"], out["read_ms"], out["frame_ms"] = stats(snap), stats(read), stats(frame)
            out["sizes"] = sizes
    finally:
        await manager.close_all()
    await asyncio.sleep(2)
    out["containers_left_after_close"] = sorted(containers() - before)
    print(json.dumps(out, indent=1))


asyncio.run(main())
