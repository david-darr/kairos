"""Startup cost of core.session_manager_store._migrate_compaction_data on a large synthetic store.
Run: .venv/Scripts/python.exe -B -X utf8 scripts/bench_compaction_migration.py [--chats 2000] [--per-chat 100]
     [--stores 3] [--profile] [--small]
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


def proposed_fix_step2(conn):
    """The proposed minimal fix for step 2 (NOT app code): one pass over messages_fts to map (session_id, idx) to
    rowid, then delete/insert by rowid. messages_fts has no index on session_id/idx (UNINDEXED columns), so the
    app's per-message `DELETE ... WHERE session_id = ? AND idx = ?` scans the whole FTS table every time."""
    rowid = {(r[1], r[2]): r[0] for r in conn.execute("SELECT rowid, session_id, idx FROM messages_fts")}
    with conn:
        for r in conn.execute("SELECT session_id, idx, role, doc FROM messages WHERE doc LIKE '%\"tool_rounds\"%'").fetchall():
            old = rowid.get((r[0], r[1]))
            if old is not None:
                conn.execute("DELETE FROM messages_fts WHERE rowid = ?", (old,))
            conn.execute("INSERT INTO messages_fts (content, session_id, idx, role) VALUES (?, ?, ?, ?)",
                         (store.search_text(json.loads(r[3])), r[0], r[1], r[2]))
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, '1')", (store.TOOL_INDEX_MIGRATION_MARKER,))
    conn.commit()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chats", type=int, default=2000)
    ap.add_argument("--per-chat", type=int, default=100)
    ap.add_argument("--stores", type=int, default=3)
    ap.add_argument("--fixed", action="store_true", help="run step 1 of the app, then the proposed rowid step 2")
    ap.add_argument("--profile", action="store_true", help="cProfile the cold run of the last store")
    a = ap.parse_args()
    tools_per_chat = 10  # 2000 chats x 10 = 20,000 tool-result messages
    cold, warm, peaks, ok = [], [], [], True
    for n in range(a.stores):
        path = os.path.join(fixture.name, f"store{n}", "sessions.db")
        os.makedirs(os.path.dirname(path))
        exp = build(path, a.chats, a.per_chat, tools_per_chat, random.Random(n))
        conn = exp.pop("conn")
        print(f"store {n}: {exp['chats']} chats, {exp['messages']} msgs, {exp['tools']} tool msgs, "
              f"{exp['notices']} notices, {exp['mb']:.0f} MB, built in {exp['build_s']:.1f}s")
        before = check(conn, exp, "\"result 0\"")
        profiler = cProfile.Profile() if (a.profile and n == a.stores - 1) else None
        tracemalloc.start()
        t0 = time.perf_counter()
        if profiler:
            profiler.enable()
        if a.fixed:
            conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, '1')", (store.TOOL_INDEX_MIGRATION_MARKER,))
            conn.commit()
            store._migrate_compaction_data(conn)  # step 1 only (step 2 marker preset)
            conn.execute("DELETE FROM meta WHERE key = ?", (store.TOOL_INDEX_MIGRATION_MARKER,))
            conn.commit()
            proposed_fix_step2(conn)
        else:
            store._migrate_compaction_data(conn)
        if profiler:
            profiler.disable()
        dt = time.perf_counter() - t0
        peaks.append(tracemalloc.get_traced_memory()[1] / 1e6)
        tracemalloc.stop()
        cold.append(dt)
        after = check(conn, exp, "\"result 0\"")
        snap = snapshot(conn)
        t0 = time.perf_counter()
        store._migrate_compaction_data(conn)
        warm.append(time.perf_counter() - t0)
        again = snapshot(conn)
        good = (after["display_only"] == exp["notices"] and after["probe_hits"] >= 1 and before["probe_hits"] == 0
                and after["markers"] == 2 and after["fts_rows"] == before["fts_rows"] and snap == again)
        ok &= good
        print(f"  cold {dt:.2f}s  already-migrated {warm[-1] * 1000:.2f} ms  peak py mem {peaks[-1]:.1f} MB  "
              f"display_only {before['display_only']}->{after['display_only']}  tool text hits {before['fts_tool_rows']}->{after['fts_tool_rows']}  "
              f"second run unchanged={snap == again}  correct={good}")
        if profiler:
            pstats.Stats(profiler).sort_stats("cumulative").print_stats(10)
        conn.close()
        store._conn = None
    print(f"cold p50 {statistics.median(cold):.2f}s (runs {', '.join(f'{c:.2f}' for c in cold)})  target < 5 s: "
          f"{'PASS' if statistics.median(cold) < 5 else 'FAIL'}")
    print(f"already-migrated p50 {statistics.median(warm) * 1000:.2f} ms  target < 50 ms: "
          f"{'PASS' if statistics.median(warm) < 0.05 else 'FAIL'}")
    print(f"peak python memory p50 {statistics.median(peaks):.1f} MB   correctness on big store: {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


if __name__ == "__main__":
    code = main()
    fixture.cleanup()
    sys.exit(code)
