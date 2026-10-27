"""A04 efficiency: backend time from send to the provider receiving its request (app share of time-to-first-token),
and the turn's tail after the reply (work after the last token). Scripted provider, local endpoint.
Run: .venv/Scripts/python.exe -B -X utf8 scripts/g2_ttft_probe.py"""
import asyncio, os, statistics, sys, tempfile, time
from pathlib import Path
from unittest.mock import patch
fixture = tempfile.TemporaryDirectory(prefix="kairos-g2-ttft-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = fixture.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core.session_manager import session_manager
from services import chat_service
ENDPOINT = {"id": "local", "kind": "local", "model": "local-model", "name": "Local"}
marks = {}
async def post(client, base_url, api_key, body):
    marks["request"] = time.perf_counter()
    return {"choices": [{"message": {"role": "assistant", "content": "ok"}}]}
async def main():
    sid = session_manager.create_session("ttft")["id"]
    out = []
    with patch.object(chat_service, "_resolve_endpoint", side_effect=lambda s: ENDPOINT), \
         patch("core.model_endpoints.resolve_runtime", return_value=("http://fake", "local-model", None, None)), \
         patch("core.providers.openai_compatible._post_chat", new=post):
        for n in range(12):
            t0 = time.perf_counter(); first = None
            async for _chunk in chat_service.stream_message(sid, f"hello {n}"):
                if first is None: first = time.perf_counter()
            t1 = time.perf_counter()
            out.append(((marks["request"] - t0) * 1000, ((first or t1) - t0) * 1000, (t1 - t0) * 1000))
    return out[2:]
rows = asyncio.run(main())
for i, name in enumerate(("send -> provider request (ms)", "send -> first streamed chunk (ms)", "send -> turn complete (ms)")):
    col = sorted(r[i] for r in rows); print(f"{name}: p50={statistics.median(col):.0f} p95={col[int(len(col)*.95)-1]:.0f}")
