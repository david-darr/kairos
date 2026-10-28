"""Cost of core.session_manager_store's compaction data migration on a large synthetic store: the connect-time
part (startup path, step 1) and the background tool-text re-index (step 2), with requests interleaved.
Run: .venv/Scripts/python.exe -B -X utf8 scripts/bench_compaction_migration.py [--chats 2000] [--per-chat 100]
     [--stores 3] [--profile]
Builds legacy-shaped stores (notices not display-only, FTS without tool text, markers cleared) in a temp folder
(JARVIS_DATA_DIR override, same as scripts/test_g12_compaction.py), times the migration cold and already-migrated,
checks the result, measures peak Python memory with tracemalloc. No network, no app server.
"""
import argparse
import cProfile
import json
import os
import pstats
import random
import statistics
import sys
import tempfile
import threading
import time
import tracemalloc
from pathlib import Path

fixture = tempfile.TemporaryDirectory(prefix="kairos-bench-compaction-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = fixture.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core import session_manager_store as store  # noqa: E402

HEAD = store.COMPACTION_NOTICE_HEAD
WORDS = ("plan vendor invoice schedule meeting review budget deploy server notes calendar email draft agent "
         "model token context summary project export report fix test build release window panel setting").split()


def text(rng, n):
    out, size = [], 0
    while size < n:
        w = rng.choice(WORDS)
        out.append(w)
        size += len(w) + 1
    return " ".join(out)


def build(path, chats, per_chat, tools_per_chat, rng):
    """One legacy-shaped store at `path`; returns expected counts."""
    store._conn = None
    store.DB_FILE = path
    conn = store._connect()  # creates schema; migration on the empty store sets the markers
    n_msgs = n_tools = n_notices = 0
    t0 = time.perf_counter()
    with conn:
        for c in range(chats):
            sid = f"chat-{c:05d}"
            through = per_chat // 2
            summary = f"SUMMARY-{c}: " + text(rng, 900)
            doc = {"id": sid, "title": f"Chat {c}", "created_at": 1.0, "updated_at": 2.0 + c,
                   "compactions": [{"summary": summary, "through_index": through, "at": 1.5}]}
            conn.execute("INSERT INTO sessions (id, doc, title, starred, created_at, updated_at, message_count, "
                         "model_endpoint_id, project_id, open_mic, agent_id) VALUES (?, ?, ?, 0, 1.0, ?, ?, NULL, NULL, 0, NULL)",
                         (sid, json.dumps(doc), doc["title"], doc["updated_at"], per_chat))
            tool_at = set(rng.sample(range(1, through), tools_per_chat))
            rows, fts = [], []
            for i in range(per_chat):
                role = "user" if i % 2 == 0 else "assistant"
                m = {"role": role, "content": text(rng, rng.randint(150, 1400)), "ts": 1.0 + i}
                if i < through:
                    m["archived"] = True
                if i in tool_at:
                    role, m["role"] = "assistant", "assistant"
                    m["tool_rounds"] = {"endpoint_id": "local", "messages": [
                        {"role": "assistant", "content": None, "tool_calls": [{"id": "c1", "type": "function",
                            "function": {"name": "read_vault_file", "arguments": '{"path":"notes.md"}'}}]},
                        {"role": "tool", "tool_call_id": "c1",
                         "content": f"result-{c}-{i} " + text(rng, rng.randint(1500, 6000))}]}
                    n_tools += 1
                if i == per_chat - 1:  # the legacy notice: assistant, no display_only, matches the checkpoint
                    role, m["role"] = "assistant", "assistant"
                    m["content"] = f"{HEAD}\n\n{summary}"
                    n_notices += 1
                rows.append((sid, i, role, m["content"], m["ts"], json.dumps(m)))
                fts.append((m["content"], sid, i, role))  # as an older build indexed: message text only
            conn.executemany("INSERT INTO messages (session_id, idx, role, content, ts, doc) VALUES (?, ?, ?, ?, ?, ?)", rows)
            conn.executemany("INSERT INTO messages_fts (content, session_id, idx, role) VALUES (?, ?, ?, ?)", fts)
            n_msgs += per_chat
        conn.execute("DELETE FROM meta WHERE key IN (?, ?)", (store.NOTICE_MIGRATION_MARKER, store.TOOL_INDEX_MIGRATION_MARKER))
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    return {"chats": chats, "messages": n_msgs, "tools": n_tools, "notices": n_notices,
            "build_s": time.perf_counter() - t0, "mb": os.path.getsize(path) / 1e6, "conn": conn}


def check(conn, exp, first_tool_probe):
    notices = conn.execute("SELECT count(*) FROM messages WHERE doc LIKE '%\"display_only\": true%'").fetchone()[0]
    fts_tool = conn.execute("SELECT count(*) FROM messages_fts WHERE messages_fts MATCH 'read_vault_file'").fetchone()[0]
    probe = conn.execute("SELECT count(*) FROM messages_fts WHERE messages_fts MATCH ?", (first_tool_probe,)).fetchone()[0]
    markers = conn.execute("SELECT count(*) FROM meta WHERE key IN (?, ?)",
                           (store.NOTICE_MIGRATION_MARKER, store.TOOL_INDEX_MIGRATION_MARKER)).fetchone()[0]
    fts_rows = conn.execute("SELECT count(*) FROM messages_fts").fetchone()[0]
    return {"display_only": notices, "fts_tool_rows": fts_tool, "probe_hits": probe, "markers": markers, "fts_rows": fts_rows}


def snapshot(conn):
    return (conn.execute("SELECT count(*), sum(length(doc)) FROM messages").fetchone()[:],
            conn.execute("SELECT count(*), sum(length(content)) FROM messages_fts").fetchone()[:])


def reopen(path):
    """Close and reconnect, as an app start does; returns (conn, seconds the connect-time migration took)."""
    if store._conn is not None:
        store._conn.close()
    store._conn = None
    store.DB_FILE = path
    t0 = time.perf_counter()
    conn = store._connect()
    return conn, time.perf_counter() - t0


def run_background(conn, probe_sid):
    """Run step 2 in the app's background thread while a 'request' thread keeps reading the store and one message
    with tool rounds is appended mid-run. Returns (seconds, worst request wait in ms, requests served, late message
    indexed exactly once)."""
    waits, stop_probe = [], threading.Event()

    def requests():
        while not stop_probe.is_set():
            t0 = time.perf_counter()
            store.session_exists(probe_sid)
            waits.append(time.perf_counter() - t0)
            time.sleep(0.002)

    probe = threading.Thread(target=requests, daemon=True)
    probe.start()
    t0 = time.perf_counter()
    thread = store.start_background_migration()
    time.sleep(0.5)  # land the write while the run is in progress
    header, count = store.get_session_header(probe_sid)
    late = {"role": "assistant", "content": "late reply", "ts": 9.0, "tool_rounds": {"messages": [
        {"role": "tool", "tool_call_id": "z", "content": "latebenchword result"}]}}
    store.append_message(probe_sid, count, late, header)
    thread.join()
    dt = time.perf_counter() - t0
    stop_probe.set()
    probe.join()
    once = store.connection().execute(
        "SELECT count(*) FROM messages_fts WHERE session_id = ? AND idx = ?", (probe_sid, count)).fetchone()[0] == 1 and \
        store.connection().execute("SELECT count(*) FROM messages_fts WHERE messages_fts MATCH 'latebenchword'").fetchone()[0] == 1
    return dt, max(waits) * 1000 if waits else 0.0, len(waits), once


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chats", type=int, default=2000)
    ap.add_argument("--per-chat", type=int, default=100)
    ap.add_argument("--stores", type=int, default=3)
    ap.add_argument("--profile", action="store_true", help="cProfile the connect-time migration of the last store")
    a = ap.parse_args()
    tools_per_chat = 10  # 2000 chats x 10 = 20,000 tool-result messages
    startup, bg, warm, peaks, ok = [], [], [], [], True
    for n in range(a.stores):
        path = os.path.join(fixture.name, f"store{n}", "sessions.db")
        os.makedirs(os.path.dirname(path))
        exp = build(path, a.chats, a.per_chat, tools_per_chat, random.Random(n))
        conn = exp.pop("conn")
        print(f"store {n}: {exp['chats']} chats, {exp['messages']} msgs, {exp['tool_messages'] if 'tool_messages' in exp else exp['tools']} tool msgs, "
              f"{exp['notices']} notices, {exp['mb']:.0f} MB, built in {exp['build_s']:.1f}s")
        before = check(conn, exp, "\"result 0\"")
        profiler = cProfile.Profile() if (a.profile and n == a.stores - 1) else None
        if profiler:
            profiler.enable()
        conn, dt = reopen(path)  # startup path: _connect() runs step 1 only (timed without tracemalloc)
        if profiler:
            profiler.disable()
        tracemalloc.start()
        startup.append(dt)
        mid = check(conn, exp, "\"result 0\"")
        t_run, worst_ms, served, once = run_background(conn, "chat-00000")
        peaks.append(tracemalloc.get_traced_memory()[1] / 1e6)
        tracemalloc.stop()
        bg.append(t_run)
        conn = store.connection()
        after = check(conn, exp, "\"result 0\"")
        snap = snapshot(conn)
        conn, w = reopen(path)  # already-migrated start
        warm.append(w)
        again = snapshot(conn)
        store.migrate_tool_text_index()  # marker set: no change
        good = (mid["display_only"] == exp["notices"] and mid["probe_hits"] == 0 and mid["markers"] == 1
                and after["probe_hits"] >= 1 and before["probe_hits"] == 0 and after["markers"] == 2
                and after["fts_rows"] == before["fts_rows"] + 1 and snap == again and once)
        ok &= good
        print(f"  startup-path migration {dt:.2f}s  background {t_run:.1f}s  worst request wait {worst_ms:.0f} ms ({served} requests)  "
              f"already-migrated start {w * 1000:.1f} ms  peak py mem {peaks[-1]:.1f} MB")
        print(f"  display_only {before['display_only']}->{after['display_only']}  tool text hits {before['fts_tool_rows']}->{after['fts_tool_rows']}  "
              f"fts rows {before['fts_rows']}->{after['fts_rows']} (+1 late write)  second start unchanged={snap == again}  "
              f"late write indexed once={once}  correct={good}")
        if profiler:
            pstats.Stats(profiler).sort_stats("cumulative").print_stats(10)
        store._conn.close()
        store._conn = None
    print(f"startup-path p50 {statistics.median(startup):.2f}s (runs {', '.join(f'{c:.2f}' for c in startup)})  target < 1.5 s: "
          f"{'PASS' if statistics.median(startup) < 1.5 else 'FAIL'}")
    print(f"background completion p50 {statistics.median(bg):.1f}s  target < 60 s: {'PASS' if statistics.median(bg) < 60 else 'FAIL'}")
    print(f"already-migrated start p50 {statistics.median(warm) * 1000:.2f} ms  target < 50 ms: "
          f"{'PASS' if statistics.median(warm) < 0.05 else 'FAIL'}")
    print(f"peak python memory p50 {statistics.median(peaks):.1f} MB   correctness on big store: {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


if __name__ == "__main__":
    code = main()
    store.stop_background_migration()
    fixture.cleanup()
    sys.exit(code)
