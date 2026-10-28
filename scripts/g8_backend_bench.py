"""A21 benchmark (g8): real uvicorn backend on a free loopback port with a throwaway data folder.

Measures cold start to first /api/health, hot-route latency (p50/p95, 40 calls each), the
requests per route, backend memory/threads before and after a burst of concurrent work,
idle CPU/requests over a quiet window, and that stopping leaves no child process behind.
Never touches the real data folder or ports 8420/8430/8432.

    .venv\\Scripts\\python.exe -B -X utf8 scripts\\g8_backend_bench.py [idle_seconds]
"""
import json
import os
import socket
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
IDLE = int(sys.argv[1]) if len(sys.argv) > 1 else 30


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def tasklist(pid):
    out = subprocess.run(["powershell", "-NoProfile", "-Command",
                          f"$p=Get-Process -Id {pid} -ErrorAction SilentlyContinue; if($p){{ '{{0}} {{1}} {{2}} {{3}}' -f $p.WorkingSet64,$p.Threads.Count,$p.Handles,$p.CPU }}"],
                         capture_output=True, text=True).stdout.split()
    return dict(rss_mb=round(int(out[0]) / 1048576, 1), threads=int(out[1]), handles=int(out[2]), cpu_s=float(out[3])) if out else None


def children(pid):
    out = subprocess.run(["powershell", "-NoProfile", "-Command",
                          f"(Get-CimInstance Win32_Process | Where-Object {{ $_.ParentProcessId -eq {pid} }} | Measure-Object).Count"],
                         capture_output=True, text=True).stdout.strip()
    return int(out or 0)


def real_pid(pid):
    """The venv python.exe is a launcher stub; the server is its child."""
    out = subprocess.run(["powershell", "-NoProfile", "-Command",
                          f"(Get-CimInstance Win32_Process | Where-Object {{ $_.ParentProcessId -eq {pid} }} | Select-Object -First 1).ProcessId"],
                         capture_output=True, text=True).stdout.strip()
    return int(out) if out else pid


def get(base, path):
    t = time.perf_counter()
    with urllib.request.urlopen(base + path, timeout=30) as r:
        body = r.read()
    return (time.perf_counter() - t) * 1000, len(body), r.status


def pct(values, p):
    values = sorted(values)
    return values[min(len(values) - 1, int(round(p * (len(values) - 1))))]


def main():
    data = tempfile.mkdtemp(prefix="g8-bench-")
    port = free_port()
    assert port not in (8420, 8430, 8432)
    env = {**os.environ, "JARVIS_DATA_DIR": data, "JARVIS_VAULT_DIR": os.path.join(data, "vault"),
           "APP_PORT": str(port), "PYTHONUNBUFFERED": "1"}
    env.pop("AUTH_ENABLED", None)
    base = f"http://127.0.0.1:{port}"
    t0 = time.perf_counter()
    proc = subprocess.Popen([str(ROOT / ".venv" / "Scripts" / "python.exe"), "-B", "-X", "utf8", "-m", "uvicorn", "app:app",
                             "--host", "127.0.0.1", "--port", str(port), "--log-level", "warning"],
                            cwd=str(ROOT), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    result = {"port": port, "pid": proc.pid}
    try:
        while True:
            try:
                get(base, "/api/health")
                break
            except Exception:
                if time.perf_counter() - t0 > 90:
                    raise SystemExit("backend never became healthy")
                time.sleep(0.1)
        result["cold_start_to_health_s"] = round(time.perf_counter() - t0, 2)
        time.sleep(2)
        server = real_pid(proc.pid)
        result["server_pid"] = server
        result["after_start"] = tasklist(server)
        routes = ["/api/health", "/api/system/status", "/api/sessions", "/api/runs", "/api/system/tabs",
                  "/api/settings", "/api/system/events", "/api/computer", "/api/file-checkpoints",
                  "/api/sandbox/changes", "/api/system/diagnostics", "/api/system/logs/files", "/api/home/tab-cards"]
        table = {}
        for path in routes:
            try:
                get(base, path)  # warm
                times = [get(base, path) for _ in range(40)]
                table[path] = dict(status=times[0][2], bytes=times[0][1],
                                   p50=round(statistics.median(t[0] for t in times), 1),
                                   p95=round(pct([t[0] for t in times], 0.95), 1))
            except Exception as exc:
                table[path] = f"error {exc}"
        result["routes"] = table
        # burst: 8 threads x 60 requests across hot routes
        errors = []

        def burst():
            for i in range(60):
                try:
                    get(base, routes[i % 5])
                except Exception as exc:
                    errors.append(str(exc))
        threads = [threading.Thread(target=burst) for _ in range(8)]
        b0 = time.perf_counter()
        [t.start() for t in threads]
        [t.join() for t in threads]
        result["burst_480_requests_s"] = round(time.perf_counter() - b0, 2)
        result["burst_errors"] = len(errors)
        time.sleep(2)
        result["after_burst"] = tasklist(server)
        a = tasklist(server)
        time.sleep(IDLE)
        b = tasklist(server)
        result["idle"] = dict(seconds=IDLE, cpu_s_used=round(b["cpu_s"] - a["cpu_s"], 2),
                              rss_delta_mb=round(b["rss_mb"] - a["rss_mb"], 1), threads=b["threads"])
        result["children_while_running"] = children(server)
    finally:
        pid = proc.pid
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)], capture_output=True)
        time.sleep(1)
        result["alive_after_stop"] = bool(tasklist(pid))
        result["port_still_open"] = socket.socket().connect_ex(("127.0.0.1", port)) == 0
    print(json.dumps(result, indent=1))


if __name__ == "__main__":
    main()
