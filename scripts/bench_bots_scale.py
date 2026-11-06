"""Is 100 bots a supported size? Times the main bot routes at 10 bots and at 100.

Each size runs in a child process on its own throwaway JARVIS_DATA_DIR (never the real data folder),
no model turns: bots, a few rooms, teams, routines and inbox items are made through the service layer,
then the routes' API calls are timed with TestClient, the routine scheduler's tick and the bot
services' startup are timed, and memory is read (tracemalloc for Python allocations, and the process
working set on Windows).

Run: .venv\\Scripts\\python.exe -X utf8 scripts\\bench_bots_scale.py [--runs 15] [--sizes 10 100]
"""
import argparse
import asyncio
import ctypes
import json
import os
import subprocess
import sys
import tempfile
import time
import tracemalloc
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SLOW_MS = 500


def working_set_mb() -> float:
    if os.name != "nt":
        return 0.0

    class Counters(ctypes.Structure):
        _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong), ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t)]
    counters = Counters()
    counters.cb = ctypes.sizeof(counters)
    kernel, psapi = ctypes.windll.kernel32, ctypes.windll.psapi
    kernel.GetCurrentProcess.restype = ctypes.c_void_p
    psapi.GetProcessMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.POINTER(Counters), ctypes.c_ulong]
    psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb)
    return counters.WorkingSetSize / 1048576


def pct(values, p):
    values = sorted(values)
    return values[min(len(values) - 1, int(round(p / 100 * (len(values) - 1))))]


def child(size: int, runs: int) -> dict:
    data = tempfile.mkdtemp(prefix=f"kairos-bots-bench-{size}-")
    os.environ["JARVIS_DATA_DIR"] = data
    os.environ["JARVIS_VAULT_DIR"] = str(Path(data) / "vault")
    os.environ["AUTH_ENABLED"] = "false"
    (Path(data) / "vault").mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(ROOT))
    from fastapi.testclient import TestClient
    import app as kairos
    from core import task_scheduler
    from services import bot_chat_service, bot_departments, bot_rooms, bot_routines
    from services.agent_service import agent_service

    owner = "local"
    base_mb = working_set_mb()
    bots = [agent_service.create(f"Bench Bot {i:03d}", role=f"Role {i % 7}", instructions="Help with the bench.") for i in range(size)]
    ids = [b["id"] for b in bots]
    for i, bid in enumerate(ids):  # something waiting on the person for a third of the bots
        if i % 3 == 0:
            agent_service.add_item(bid, "question", f"Question from bot {i}", "Which one?")
    for r in range(5):
        bot_rooms.create(owner, f"Room {r}", bot_ids=ids[r * 2:r * 2 + 3] or ids[:3], setup_done=True)
    for t in range(3):
        bot_departments.create(f"Team {t}", ids[t * 3:t * 3 + 3], owner)
    for i in range(min(size, 20)):
        spec = bot_routines.normalize_config({"name": f"Routine {i}", "instructions": "Look around.",
                                              "schedule": {"kind": "daily", "time": f"{8 + i % 10:02d}:00", "time_zone": "UTC"}})
        bot_routines.create(owner, ids[i], spec)
    seeded_mb = working_set_mb()

    client = TestClient(kairos.app)
    first, second = ids[0], ids[len(ids) // 2]
    calls = [("GET /api/agents (bots list)", "/api/agents"),
             ("GET /api/agents/{id} (detail)", f"/api/agents/{first}"),
             ("GET /api/agents/{id}/overview", f"/api/agents/{second}/overview"),
             ("GET /api/agents/inbox", "/api/agents/inbox"),
             ("GET bot-attention/inbox", "/api/bot-attention/inbox"),
             ("GET bot-attention/notifications (updates)", "/api/bot-attention/notifications"),
             ("GET bot-attention/today (home)", "/api/bot-attention/today"),
             ("GET bot-attention/needs-you", "/api/bot-attention/needs-you"),
             ("GET bot-peers/{id}/roster (Kip roster)", f"/api/bot-peers/{first}/roster"),
             ("GET bot-team/map", "/api/bot-team/map"),
             ("GET bot-rooms", "/api/bot-rooms"),
             ("GET bot-routines", "/api/bot-routines")]
    results = {}
    for label, path in calls:
        samples, status = [], None
        for _ in range(runs + 1):
            start = time.perf_counter()
            response = client.get(path)
            samples.append((time.perf_counter() - start) * 1000)
            status = response.status_code
        samples = samples[1:]  # the first call warms caches
        results[label] = {"status": status, "p50": pct(samples, 50), "p95": pct(samples, 95)}

    task_scheduler._check_mcp_servers = lambda loop: None  # no network probes in a benchmark

    async def timed_async():
        out = {}
        samples = []
        for _ in range(runs + 1):
            start = time.perf_counter()
            await task_scheduler._tick()
            samples.append((time.perf_counter() - start) * 1000)
        samples = samples[1:]
        out["routine scheduler tick"] = {"status": "-", "p50": pct(samples, 50), "p95": pct(samples, 95)}
        for label, fn in (("startup: bot_chat_service", bot_chat_service.startup), ("startup: bot_rooms", bot_rooms.startup)):
            samples = []
            for _ in range(5):
                start = time.perf_counter()
                await fn()
                samples.append((time.perf_counter() - start) * 1000)
            out[label] = {"status": "-", "p50": pct(samples, 50), "p95": pct(samples, 95)}
        return out
    results.update(asyncio.run(timed_async()))

    tracemalloc.start()
    for _, path in calls:
        client.get(path)
    asyncio.run(task_scheduler._tick())
    current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    return {"size": size, "results": results, "py_peak_mb": peak / 1048576, "py_current_mb": current / 1048576,
            "rss_base_mb": base_mb, "rss_seeded_mb": seeded_mb, "rss_end_mb": working_set_mb()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=15)
    parser.add_argument("--sizes", type=int, nargs="+", default=[10, 100])
    parser.add_argument("--child", type=int)
    args = parser.parse_args()
    if args.child:
        print("RESULT " + json.dumps(child(args.child, args.runs)))
        return 0
    reports = []
    for size in args.sizes:
        done = subprocess.run([sys.executable, "-X", "utf8", "-B", __file__, "--child", str(size), "--runs", str(args.runs)],
                              capture_output=True, text=True, timeout=1800)
        line = next((l for l in done.stdout.splitlines() if l.startswith("RESULT ")), None)
        if not line:
            print(done.stdout[-2000:], done.stderr[-3000:])
            return 1
        reports.append(json.loads(line[7:]))
    small = reports[0]
    print(f"{'call':46s} {'status':>6s} " + " ".join(f"{'p50@' + str(r['size']):>9s} {'p95@' + str(r['size']):>9s}" for r in reports) + "   ratio(p50)")
    flagged = []
    for label in small["results"]:
        row = [r["results"][label] for r in reports]
        ratio = row[-1]["p50"] / max(row[0]["p50"], 0.01)
        mark = ""
        if row[-1]["p95"] > SLOW_MS or (ratio > 15 and row[-1]["p50"] > 50):
            mark = "  <-- slow or super-linear"
            flagged.append(label)
        print(f"{label:46s} {str(row[-1]['status']):>6s} " + " ".join(f"{x['p50']:9.1f} {x['p95']:9.1f}" for x in row) + f"   {ratio:6.1f}x{mark}")
    for r in reports:
        print(f"memory @{r['size']:3d} bots: python peak {r['py_peak_mb']:.1f} MB (live {r['py_current_mb']:.1f}); "
              f"working set {r['rss_base_mb']:.0f} -> seeded {r['rss_seeded_mb']:.0f} -> end {r['rss_end_mb']:.0f} MB")
    print("flagged: " + (", ".join(flagged) if flagged else "none"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
