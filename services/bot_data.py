"""Bots data panel: each bot's own analysis database (Phase 6 unit U2, 2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-6-design.md, sections 1.5, 3.2, 3.3 and 5.2.

The engine is the standard library's sqlite3, behind a thin `Engine` (load, describe, run, page,
export) so a later swap touches this file only. One database per bot at
data/bot_data/<bot_id>/data.sqlite3, opened lazily and closed after ten idle minutes. Every
statement passes `bot_data_guard` first and runs under its authorizer, a 60 second limit and a
cancel switch. Rows are never stored anywhere but that database: cards (`bot_data_cards`) keep
the SQL and the chart spec only.

Tools (`TOOLS`, registered once by core/bot_workbench_tools.py): data_load, data_describe,
data_sql, data_show, data_export. Whatever text they return is table content from outside the
conversation: it is fenced with wrap_untrusted and the turn is marked tainted.
"""
from __future__ import annotations

import csv
import io
import json
import math
import os
import re
import sqlite3
import threading
import time
import uuid
from typing import Any, Optional

from core.constants import DATA_DIR
from services import bot_data_cards as cards
from services import bot_data_charts as charts
from services import bot_data_guard as guard

ROWS_DEFAULT = 50
ROWS_MAX = 500
TEXT_BYTES = 32 * 1024
TIMEOUT_SECONDS = 60
CHART_MARKS = charts.MAX_MARKS
TABLE_ROWS = 1_000_000
PAGE_MAX = 1024
IDLE_SECONDS = 600
MAX_DB_PAGES = 262_144          # about 1 GB of 4 KB pages
CELL_CHARS = 20_000
MAX_TABLES = 200
DRAFT_SQL_BYTES = 100 * 1024


class DataError(ValueError):
    """A refusal or failure the person (or the model) reads: message, line, hint."""

    def __init__(self, message: str, status: int = 400, line: Optional[int] = None, hint: str = ""):
        super().__init__(message)
        self.status, self.line, self.hint = status, line, hint


def _from_guard(error: guard.GuardError) -> DataError:
    return DataError(str(error), 400, error.line, error.hint)


def _from_cards(error: cards.CardError) -> DataError:
    return DataError(str(error), error.status)


def _cell(value: Any) -> Any:
    if isinstance(value, bytes):
        return f"<{len(value)} bytes>"
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return str(value)
    if isinstance(value, str) and len(value) > CELL_CHARS:
        return value[:CELL_CHARS] + "..."
    return value


def _row(values) -> list:
    return [_cell(v) for v in values]


def _csv_cell(value: Any) -> Any:
    """A string a spreadsheet would read as a formula is prefixed with a quote; numbers are left alone."""
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + value
    if isinstance(value, bytes):
        return f"<{len(value)} bytes>"
    return value


class Engine:
    """One bot's database. Statements run one at a time (a lock); cancel and interrupt come from other threads."""

    def __init__(self, bot_id: str, clock=time.time):
        self.bot_id = bot_id
        self.clock = clock
        self.path = os.path.join(cards.folder(bot_id), "data.sqlite3")
        self._conn: Optional[sqlite3.Connection] = None
        self._lock = threading.RLock()
        self.last_used = clock()
        self._runs: dict[str, dict] = {}
        self._runs_lock = threading.Lock()

    # -- the connection --------------------------------------------------------

    def _open(self) -> sqlite3.Connection:
        if self._conn is None:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            conn = sqlite3.connect(self.path, isolation_level=None, check_same_thread=False, timeout=5)
            conn.row_factory = None
            try:
                conn.enable_load_extension(False)
            except (AttributeError, sqlite3.NotSupportedError):
                pass
            for limit, value in ((sqlite3.SQLITE_LIMIT_ATTACHED, 0), (sqlite3.SQLITE_LIMIT_LENGTH, 50_000_000),
                                 (sqlite3.SQLITE_LIMIT_COLUMN, 2000), (sqlite3.SQLITE_LIMIT_SQL_LENGTH, 200_000),
                                 (sqlite3.SQLITE_LIMIT_EXPR_DEPTH, 200), (sqlite3.SQLITE_LIMIT_COMPOUND_SELECT, 100)):
                try:
                    conn.setlimit(limit, value)
                except (AttributeError, sqlite3.Error):
                    pass
            conn.execute(f"PRAGMA max_page_count={MAX_DB_PAGES}")
            conn.execute("PRAGMA journal_mode=WAL")
            self._conn = conn
        self.last_used = self.clock()
        return self._conn

    @property
    def is_open(self) -> bool:
        return self._conn is not None

    def close(self) -> None:
        with self._lock:
            if self._conn is not None:
                try:
                    self._conn.close()
                finally:
                    self._conn = None

    # -- running -----------------------------------------------------------------

    def _watch(self, conn: sqlite3.Connection, run_id: str, timeout: float) -> dict:
        state = {"deadline": time.monotonic() + timeout, "cancelled": False, "timed_out": False}

        def progress():
            if state["cancelled"]:
                return 1
            if time.monotonic() > state["deadline"]:
                state["timed_out"] = True
                return 1
            return 0

        conn.set_progress_handler(progress, 2000)
        with self._runs_lock:
            self._runs[run_id] = {"state": state, "conn": conn}
        return state

    def _unwatch(self, conn: sqlite3.Connection, run_id: str) -> None:
        try:
            conn.set_progress_handler(None, 0)
            conn.set_authorizer(None)
        finally:
            with self._runs_lock:
                self._runs.pop(run_id, None)

    def cancel(self, run_id: str) -> bool:
        with self._runs_lock:
            run = self._runs.get(run_id)
        if not run:
            return False
        run["state"]["cancelled"] = True
        try:
            run["conn"].interrupt()
        except sqlite3.Error:
            pass
        return True

    def _error(self, error: Exception, sql: str, state: dict) -> DataError:
        if isinstance(error, DataError):
            return error
        if isinstance(error, guard.GuardError):
            return _from_guard(error)
        message = str(error)
        if state.get("cancelled"):
            return DataError("The query was stopped.", 409)
        if state.get("timed_out"):
            return DataError(f"The query took longer than {TIMEOUT_SECONDS} seconds and was stopped.", 408, None,
                             "Narrow it with WHERE or LIMIT, or build a smaller table first.")
        if isinstance(error, sqlite3.OperationalError) and "interrupted" in message:
            return DataError("The query was stopped.", 409)
        if "not authorized" in message or "authoriz" in message:
            return DataError("That query uses something this panel does not allow.", 400, None,
                             "Only reads and CREATE TABLE or VIEW ... AS SELECT are allowed.")
        if "string or blob too big" in message:
            return DataError("That value is too large to build.", 400, None, "Shrink the expression.")
        if "database or disk is full" in message or "database is full" in message:
            return DataError("This bot's data is full.", 400, None, "Drop a table you no longer need.")
        hint = ""
        if "no such table" in message:
            names = ", ".join(t["name"] for t in self._tables()) or "none yet"
            hint = f"Tables you have: {names}. Load data first with data_load."
        elif "no such column" in message:
            hint = "Check the column names with describe (data_describe)."
        elif "already exists" in message:
            hint = "Use CREATE OR REPLACE to overwrite it."
        elif "syntax error" in message:
            hint = "SQLite flavour: check commas, quotes and keywords."
        return DataError(message[:500], 400, guard.locate(sql, message), hint)

    def _tables(self) -> list[dict]:
        conn = self._open()
        rows = conn.execute("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') "
                            "AND name NOT LIKE 'sqlite_%' ORDER BY name COLLATE NOCASE").fetchall()
        return [{"name": n, "kind": t} for n, t in rows]

    def run(self, sql: str, *, run_id: Optional[str] = None, max_rows: int = ROWS_DEFAULT,
            timeout: float = TIMEOUT_SECONDS, count: bool = True) -> dict:
        """Run one allowed statement. Returns {columns, rows, row_count, truncated, created}.
        A create makes (or replaces) its table or view and returns the new object's first rows."""
        max_rows = max(1, min(int(max_rows), PAGE_MAX))
        try:
            parsed = guard.parse(sql)
        except guard.GuardError as error:
            raise _from_guard(error)
        run_id = run_id or uuid.uuid4().hex[:12]
        with self._lock:
            conn = self._open()
            state = self._watch(conn, run_id, timeout)
            try:
                if parsed.kind == "create":
                    self._create(conn, parsed)
                    select = f"SELECT * FROM {guard.quote(parsed.name)}"
                    created = {"name": parsed.name, "kind": parsed.object_kind}
                else:
                    select, created = parsed.sql, None
                conn.set_authorizer(guard.authorizer())
                cursor = conn.execute(select)
                columns = [d[0] for d in cursor.description or []]
                fetched = cursor.fetchmany(max_rows + 1)
                truncated = len(fetched) > max_rows
                rows = [_row(r) for r in fetched[:max_rows]]
                total = len(rows)
                if truncated and count:
                    total = self._count(conn, select)
                cursor.close()
                return {"run_id": run_id, "columns": columns, "rows": rows, "row_count": total,
                        "truncated": truncated, "created": created, "select": select}
            except Exception as error:
                raise self._error(error, sql, state)
            finally:
                self._unwatch(conn, run_id)
                self.last_used = self.clock()

    def _count(self, conn: sqlite3.Connection, select: str) -> Optional[int]:
        try:
            return conn.execute(f"SELECT COUNT(*) FROM ({select})").fetchone()[0]
        except sqlite3.Error:
            return None

    def _create(self, conn: sqlite3.Connection, parsed: guard.Parsed) -> None:
        name = guard.quote(parsed.name)
        existing = conn.execute("SELECT type FROM sqlite_master WHERE name = ? COLLATE NOCASE", (parsed.name,)).fetchone()
        conn.execute("BEGIN")
        try:
            if existing and parsed.replace:
                conn.set_authorizer(guard.authorizer(drop=parsed.name))
                conn.execute(f"DROP {'VIEW' if existing[0] == 'view' else 'TABLE'} {name}")
            conn.set_authorizer(guard.authorizer(parsed))
            temp = "TEMP " if parsed.temp else ""
            conn.execute(f"CREATE {temp}{'VIEW' if parsed.object_kind == 'view' else 'TABLE'} {name} AS {parsed.body}")
            conn.set_authorizer(None)
            conn.execute("COMMIT")
        except Exception:
            conn.set_authorizer(None)
            try:
                conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise

    # -- a card's rows -----------------------------------------------------------------

    @staticmethod
    def select_of(sql: str) -> str:
        """The read query behind a card's SQL (a create shows its new object)."""
        try:
            parsed = guard.parse(sql)
        except guard.GuardError as error:
            raise _from_guard(error)
        return f"SELECT * FROM {guard.quote(parsed.name)}" if parsed.kind == "create" else parsed.sql

    def _guarded_read(self, sql: str, params: tuple = (), *, timeout: float = TIMEOUT_SECONDS, run_id: Optional[str] = None,
                      fetch: Optional[int] = None):
        run_id = run_id or uuid.uuid4().hex[:12]
        with self._lock:
            conn = self._open()
            state = self._watch(conn, run_id, timeout)
            try:
                conn.set_authorizer(guard.authorizer())
                cursor = conn.execute(sql, params)
                columns = [d[0] for d in cursor.description or []]
                rows = cursor.fetchall() if fetch is None else cursor.fetchmany(fetch)
                cursor.close()
                return columns, rows
            except Exception as error:
                raise self._error(error, sql, state)
            finally:
                self._unwatch(conn, run_id)
                self.last_used = self.clock()

    def page(self, sql: str, offset: int = 0, limit: int = 100, sort: Optional[list] = None,
             filters: Optional[dict] = None) -> dict:
        """One page of a card's rows with server-side sort and column filters."""
        select = self.select_of(sql)
        offset, limit = max(0, int(offset)), max(1, min(int(limit), PAGE_MAX))
        columns, _ = self._guarded_read(f"SELECT * FROM ({select}) LIMIT 0")
        known = set(columns)
        where, params = [], []
        for column, text in (filters or {}).items():
            if column not in known:
                raise DataError(f"There is no column called {column}.")
            like = "%" + str(text).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            where.append(f'CAST("{column.replace(chr(34), chr(34) * 2)}" AS TEXT) LIKE ? ESCAPE \'\\\'')
            params.append(like)
        order = []
        for item in sort or []:
            column = item.get("column") if isinstance(item, dict) else None
            if column not in known:
                raise DataError(f"There is no column called {column}.")
            order.append(f'"{column.replace(chr(34), chr(34) * 2)}" {"DESC" if item.get("desc") else "ASC"}')
        base = f"SELECT * FROM ({select})" + (" WHERE " + " AND ".join(where) if where else "")
        total = self._guarded_read(f"SELECT COUNT(*) FROM ({base})", tuple(params))[1][0][0]
        query = base + (" ORDER BY " + ", ".join(order) if order else "") + " LIMIT ? OFFSET ?"
        _, rows = self._guarded_read(query, tuple(params) + (limit, offset))
        return {"columns": columns, "rows": [_row(r) for r in rows], "row_count": total, "offset": offset,
                "limit": limit, "capped": total > TABLE_ROWS}

    def rows_for_export(self, sql: str):
        """(columns, iterator of rows) up to TABLE_ROWS, for csv and xlsx."""
        select = self.select_of(sql)
        columns, rows = self._guarded_read(select, fetch=TABLE_ROWS + 1)
        if len(rows) > TABLE_ROWS:
            raise DataError(f"That result has more than {TABLE_ROWS:,} rows.", 400, None, "Add a LIMIT or summarize it first.")
        return columns, rows

    def chart(self, sql: str, spec: dict) -> dict:
        """The reduction a chart draws: at most CHART_MARKS points."""
        select = self.select_of(sql)
        columns, _ = self._guarded_read(f"SELECT * FROM ({select}) LIMIT 0")
        try:
            plan = charts.compile_chart(spec, select, columns)
        except charts.ChartError as error:
            raise DataError(str(error))
        query, note = plan["sql"], plan.get("note")
        if plan.get("count_sql"):
            count = self._guarded_read(plan["count_sql"])[1][0][0]
            limit = charts.MAX_MARKS if plan["type"] == "scatter" else 2000
            if count > limit:
                query, note = plan["downsample_sql"], plan.get("note_downsampled")
        names, rows = self._guarded_read(query)
        return {"type": plan["type"], "fields": plan["fields"], "rows": [_row(r) for r in rows[:charts.MAX_MARKS]],
                "note": note, "spec": charts.validate(spec), "marks": min(len(rows), charts.MAX_MARKS)}

    # -- tables ------------------------------------------------------------------------

    def tables(self) -> list[dict]:
        with self._lock:
            conn = self._open()
            out = []
            for item in self._tables()[:MAX_TABLES]:
                quoted = guard.quote(item["name"]) if guard.IDENT.match(item["name"]) else '"' + item["name"].replace('"', '""') + '"'
                try:
                    count = conn.execute(f"SELECT COUNT(*) FROM {quoted}").fetchone()[0]
                except sqlite3.Error:
                    count = None
                info = conn.execute(f"PRAGMA table_info({quoted})").fetchall()
                out.append({**item, "rows": count, "columns": [{"name": c[1], "type": c[2] or "TEXT"} for c in info]})
            self.last_used = self.clock()
            return out

    def _table(self, name: str) -> dict:
        found = next((t for t in self.tables() if t["name"].lower() == str(name).lower()), None)
        if not found:
            raise DataError(f"There is no table called {name}.", 404, None, "Load data first with data_load.")
        return found

    def sample(self, name: str, rows: int = 5) -> list[list]:
        table = self._table(name)
        quoted = '"' + table["name"].replace('"', '""') + '"'
        return [_row(r) for r in self._guarded_read(f"SELECT * FROM {quoted} LIMIT ?", (rows,))[1]]

    def stats(self, name: str) -> dict:
        """Per-column counts, distinct values, min, max and average."""
        table = self._table(name)
        quoted = '"' + table["name"].replace('"', '""') + '"'
        out = []
        for column in table["columns"]:
            c = '"' + column["name"].replace('"', '""') + '"'
            _, (row,) = self._guarded_read(
                f"SELECT COUNT({c}), COUNT(DISTINCT {c}), MIN({c}), MAX({c}), "
                f"AVG(CASE WHEN typeof({c}) IN ('integer','real') THEN {c} END) FROM {quoted}")
            out.append({"name": column["name"], "type": column["type"], "non_null": row[0], "distinct": row[1],
                        "min": _cell(row[2]), "max": _cell(row[3]), "avg": _cell(row[4])})
        return {"table": table["name"], "rows": table["rows"], "columns": out}

    def histogram(self, name: str, column: str, bins: int = 20) -> dict:
        table = self._table(name)
        if column not in [c["name"] for c in table["columns"]]:
            raise DataError(f"There is no column called {column}.", 404)
        bins = max(2, min(int(bins), 200))
        quoted = '"' + table["name"].replace('"', '""') + '"'
        spec = {"type": "histogram", "x": column, "bins": bins}
        plan = charts.compile_chart(spec, f"SELECT * FROM {quoted}", [c["name"] for c in table["columns"]])
        _, rows = self._guarded_read(plan["sql"])
        return {"table": table["name"], "column": column, "fields": plan["fields"], "rows": [_row(r) for r in rows]}

    # -- loading (internal writes, not model SQL) -------------------------------------

    def replace_table(self, name: str, columns: list[str], types: list[str], rows) -> int:
        """Create (or replace) a table from an iterator of row tuples. Returns the row count."""
        if not guard.IDENT.match(name) or name.lower().startswith(guard.RESERVED_PREFIXES):
            raise DataError(f"'{name}' is not a usable table name.")
        if not columns:
            raise DataError("That file has no columns.")
        quoted = guard.quote(name)
        defs = ", ".join('"' + c.replace('"', '""') + '" ' + t for c, t in zip(columns, types))
        marks = ", ".join("?" * len(columns))
        with self._lock:
            conn = self._open()
            existing = conn.execute("SELECT type FROM sqlite_master WHERE name = ? COLLATE NOCASE", (name,)).fetchone()
            if existing is None and len(self._tables()) >= MAX_TABLES:
                raise DataError(f"This bot already has {MAX_TABLES} tables.", 400, None, "Drop some first.")
            conn.execute("BEGIN")
            try:
                if existing:
                    conn.execute(f"DROP {'VIEW' if existing[0] == 'view' else 'TABLE'} {quoted}")
                conn.execute(f"CREATE TABLE {quoted} ({defs})")
                count, batch = 0, []
                for row in rows:
                    batch.append(row)
                    count += 1
                    if count > TABLE_ROWS:
                        raise DataError(f"That source has more than {TABLE_ROWS:,} rows.", 400, None,
                                        "Load a smaller file, or split it.")
                    if len(batch) >= 5000:
                        conn.executemany(f"INSERT INTO {quoted} VALUES ({marks})", batch)
                        batch = []
                if batch:
                    conn.executemany(f"INSERT INTO {quoted} VALUES ({marks})", batch)
                conn.execute("COMMIT")
            except Exception as error:
                try:
                    conn.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                if isinstance(error, DataError):
                    raise
                raise DataError(f"Could not load {name}: {str(error)[:300]}")
            self.last_used = self.clock()
            return count


# -- the registry: one engine per bot, closed when idle ---------------------------------

_ENGINES: dict[str, Engine] = {}
_REG_LOCK = threading.Lock()
_REAPER: Optional[threading.Thread] = None
_CLOCK = time.time


def engine(bot_id: str) -> Engine:
    global _REAPER
    try:
        cards.folder(bot_id)
    except cards.CardError as error:
        raise _from_cards(error)
    with _REG_LOCK:
        found = _ENGINES.get(bot_id)
        if found is None:
            found = _ENGINES[bot_id] = Engine(bot_id, clock=lambda: _CLOCK())
        if _REAPER is None:
            _REAPER = threading.Thread(target=_reap_loop, name="bot-data-idle", daemon=True)
            _REAPER.start()
        return found


def close_idle(now: Optional[float] = None, idle: float = IDLE_SECONDS) -> list[str]:
    """Close every open database untouched for `idle` seconds. Returns the bot ids closed."""
    now = _CLOCK() if now is None else now
    closed = []
    with _REG_LOCK:
        for bot_id, item in list(_ENGINES.items()):
            if item.is_open and now - item.last_used >= idle and not item._runs:
                item.close()
                closed.append(bot_id)
    return closed


def _reap_loop() -> None:
    while True:
        time.sleep(60)
        try:
            close_idle()
        except Exception:
            pass


def close_all() -> None:
    with _REG_LOCK:
        for item in _ENGINES.values():
            item.close()
        _ENGINES.clear()


def forget_bot(bot_id: str) -> None:
    """Drop a deleted bot's database and cards."""
    import shutil
    with _REG_LOCK:
        item = _ENGINES.pop(bot_id, None)
    if item:
        item.close()
    try:
        shutil.rmtree(cards.folder(bot_id), ignore_errors=True)
    except cards.CardError:
        pass


# -- operations the routes and tools share ------------------------------------------------

def overview(bot_id: str) -> dict:
    """Sources (tables with row counts) and saved cards."""
    return {"sources": [{"name": t["name"], "kind": t["kind"], "rows": t["rows"], "columns": t["columns"]}
                        for t in engine(bot_id).tables()],
            "cards": cards.list_cards(bot_id)}


def run(bot_id: str, sql: str, card_id: Optional[str] = None, title: Optional[str] = None, spec: Optional[dict] = None,
        run_id: Optional[str] = None, max_rows: int = ROWS_DEFAULT) -> dict:
    """Run SQL and save it as a card: the first run makes one, a later run with `card_id` updates it.
    A failed run saves nothing."""
    eng = engine(bot_id)
    result = eng.run(sql, run_id=run_id, max_rows=max_rows)
    try:
        if card_id:
            fields = {"sql": sql}
            if title is not None:
                fields["title"] = title
            if spec is not None:
                fields["spec"] = spec
            card = cards.update(bot_id, card_id, **fields)
        else:
            card = cards.create(bot_id, sql, title=title or _title_from(sql, result), spec=spec)
    except cards.CardError as error:
        raise _from_cards(error)
    out = {**{k: result[k] for k in ("run_id", "columns", "rows", "row_count", "truncated", "created")}, "card": card}
    if card.get("spec"):
        try:
            out["chart"] = eng.chart(sql, card["spec"])
        except DataError as error:
            out["chart_error"] = str(error)
    return out


def _title_from(sql: str, result: dict) -> str:
    created = result.get("created")
    if created:
        return created["name"].replace("_", " ").capitalize()
    text = " ".join(sql.split())
    return (text[:60] + "...") if len(text) > 60 else text


def page(bot_id: str, card_id: str, offset: int = 0, limit: int = 100, sort=None, filters=None) -> dict:
    try:
        card = cards.get(bot_id, card_id)
    except cards.CardError as error:
        raise _from_cards(error)
    return engine(bot_id).page(card["sql"], offset, limit, sort, filters)


def cancel(bot_id: str, run_id: str) -> bool:
    return engine(bot_id).cancel(run_id)


def chart_for(bot_id: str, card_id: str) -> dict:
    try:
        card = cards.get(bot_id, card_id)
    except cards.CardError as error:
        raise _from_cards(error)
    if not card.get("spec"):
        raise DataError("That result has no chart.", 404)
    return engine(bot_id).chart(card["sql"], card["spec"])


def export(bot_id: str, card_id: str, fmt: str) -> tuple[str, bytes, str]:
    """(filename, bytes, media type) for a card as csv or xlsx."""
    if fmt not in ("csv", "xlsx"):
        raise DataError("Export as csv or xlsx.")
    try:
        card = cards.get(bot_id, card_id)
    except cards.CardError as error:
        raise _from_cards(error)
    columns, rows = engine(bot_id).rows_for_export(card["sql"])
    stem = re.sub(r"[^A-Za-z0-9_-]+", "-", card["title"]).strip("-")[:60] or "result"
    if fmt == "csv":
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow([_csv_cell(c) for c in columns])
        for row in rows:
            writer.writerow([_csv_cell(v) for v in row])
        return f"{stem}.csv", buffer.getvalue().encode("utf-8-sig"), "text/csv"
    import openpyxl
    book = openpyxl.Workbook(write_only=True)
    sheet = book.create_sheet("Result")
    sheet.append([str(c)[:200] for c in columns])
    for row in rows:
        sheet.append([_xlsx_cell(v) for v in row])
    out = io.BytesIO()
    book.save(out)
    return f"{stem}.xlsx", out.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _xlsx_cell(value):
    if isinstance(value, bytes):
        return f"<{len(value)} bytes>"
    if isinstance(value, str):
        text = "".join(ch for ch in value if ch >= " " or ch in "\t\n\r")[:32000]
        return "'" + text if text[:1] in ("=", "+", "-", "@") else text
    return value


# -- what the chat gets about the panel ------------------------------------------------------

def data_context(bot_id: str, context: Optional[dict] = None) -> str:
    """The fenced block bot_chat_service prepends when the person is looking at a result:
    the card's SQL and chart spec, their unsaved draft, and the table names. Empty when there is nothing
    to say. Everything inside is the person's or the bot's own text, so it is wrapped as untrusted data."""
    if not isinstance(context, dict):
        return ""
    card_id = context.get("cardId") or context.get("card_id")
    draft = context.get("draftSql") or context.get("draft_sql")
    if draft is not None and (not isinstance(draft, str) or len(draft.encode("utf-8", "replace")) > DRAFT_SQL_BYTES):
        draft = None
    envelope: dict = {}
    if isinstance(card_id, str) and card_id:
        try:
            card = cards.get(bot_id, card_id)
            envelope["card"] = {"id": card["id"], "title": card["title"], "sql": card["sql"], "chart": card.get("spec")}
        except (cards.CardError, ValueError):
            pass
    if draft and draft.strip():
        envelope["draft_sql"] = draft
    if not envelope:
        return ""
    try:
        envelope["tables"] = [t["name"] for t in engine(bot_id).tables()]
    except DataError:
        return ""
    from core.untrusted import wrap_untrusted
    body = json.dumps(envelope, ensure_ascii=False)
    return "<data-context>\n" + wrap_untrusted("the data panel the person is viewing", body) + "\n</data-context>"


# -- the tools ---------------------------------------------------------------------------

def _bot(ctx) -> str:
    bot_id = getattr(ctx, "agent_id", None)
    if not bot_id:
        raise DataError("This tool is for bots.")
    return bot_id


def _mark(ctx) -> None:
    taint = getattr(ctx, "turn_taint", None)
    if taint is not None:
        taint.mark("data")


def _fenced(ctx, label: str, text: str) -> str:
    from core.untrusted import wrap_untrusted
    _mark(ctx)
    if len(text.encode("utf-8", "replace")) > TEXT_BYTES:
        text = text.encode("utf-8", "replace")[:TEXT_BYTES].decode("utf-8", "ignore") + "\n[cut at 32 KB]"
    return wrap_untrusted(label, text)


def _table_text(columns: list, rows: list, note: str = "") -> str:
    lines = [" | ".join(str(c) for c in columns)]
    lines += [" | ".join("" if v is None else str(v) for v in row) for row in rows]
    return "\n".join(lines) + (("\n" + note) if note else "")


async def _tool_load(args: dict, ctx) -> str:
    from services import bot_data_load
    try:
        bot_id = _bot(ctx)
        loaded = await _in_thread(bot_data_load.load, bot_id, str((args or {}).get("source") or ""),
                                  (args or {}).get("table"), (args or {}).get("sheet"))
    except DataError as error:
        return "Not loaded: " + _explain(error)
    lines = [f"{item['table']}: {item['rows']:,} rows, columns {', '.join(item['columns'][:30])}" for item in loaded]
    return "Loaded.\n" + _fenced(ctx, "column names from a data source", "\n".join(lines)) + \
        "\nUse data_describe to look closer and data_sql to ask questions."


async def _tool_describe(args: dict, ctx) -> str:
    try:
        eng = engine(_bot(ctx))
        name = (args or {}).get("table")
        if not name:
            tables = await _in_thread(eng.tables)
            if not tables:
                return "No data is loaded yet. Use data_load first."
            text = "\n".join(f"{t['name']} ({t['kind']}, {t['rows']:,} rows): " +
                             ", ".join(f"{c['name']} {c['type']}" for c in t["columns"][:40]) for t in tables)
            return _fenced(ctx, "table and column names", text)
        table = await _in_thread(eng._table, str(name))
        stats = await _in_thread(eng.stats, table["name"])
        sample = await _in_thread(eng.sample, table["name"], 5)
    except DataError as error:
        return "Not described: " + _explain(error)
    lines = [f"{table['name']}: {table['rows']:,} rows"]
    for column in stats["columns"]:
        lines.append(f"- {column['name']} {column['type']}: {column['non_null']:,} filled, {column['distinct']:,} distinct, "
                     f"min {column['min']}, max {column['max']}" + (f", average {column['avg']:.4g}" if isinstance(column["avg"], (int, float)) else ""))
    lines.append("First rows:\n" + _table_text([c["name"] for c in table["columns"]], sample))
    return _fenced(ctx, "a table's contents", "\n".join(lines))


async def _tool_sql(args: dict, ctx) -> str:
    args = args or {}
    limit = args.get("rows", ROWS_DEFAULT)
    limit = limit if isinstance(limit, int) and not isinstance(limit, bool) else ROWS_DEFAULT
    limit = max(1, min(limit, ROWS_MAX))
    try:
        bot_id = _bot(ctx)
        result = await _in_thread(run, bot_id, str(args.get("sql") or ""), None, args.get("title"),
                                  args.get("chart") if isinstance(args.get("chart"), dict) else None, None, limit)
    except DataError as error:
        return "Query failed: " + _explain(error)
    card = result["card"]
    head = f"Saved as result {card['id']}"
    if result.get("created"):
        head += f" ({result['created']['kind']} {result['created']['name']} created)"
    await _post_result_row(ctx, bot_id, card, result)
    if result["truncated"]:
        total = result["row_count"]
        return (head + f". {total if total is not None else 'More than ' + str(limit)} rows, so none are shown here. "
                f"Columns: {', '.join(result['columns'])}. Use data_show with result {card['id']} to page through it, "
                "or add LIMIT or GROUP BY. The person can see it in the Data panel.")
    return head + ".\n" + _fenced(ctx, "query results", _table_text(result["columns"], result["rows"]))


async def _tool_show(args: dict, ctx) -> str:
    args = args or {}
    offset = args.get("offset", 0)
    limit = args.get("limit", ROWS_DEFAULT)
    offset = offset if isinstance(offset, int) and not isinstance(offset, bool) and offset >= 0 else 0
    limit = max(1, min(limit if isinstance(limit, int) and not isinstance(limit, bool) else ROWS_DEFAULT, ROWS_MAX))
    try:
        bot_id = _bot(ctx)
        result = await _in_thread(page, bot_id, str(args.get("result") or args.get("card_id") or ""), offset, limit)
    except DataError as error:
        return "Not shown: " + _explain(error)
    end = result["offset"] + len(result["rows"])
    note = f"\nRows {result['offset'] + 1} to {end} of {result['row_count']:,}."
    return _fenced(ctx, "query results", _table_text(result["columns"], result["rows"], note))


async def _tool_export(args: dict, ctx) -> str:
    args = args or {}
    try:
        bot_id = _bot(ctx)
        name, data, _ = await _in_thread(export, bot_id, str(args.get("result") or args.get("card_id") or ""),
                                         str(args.get("format") or "csv"))
        from services import bot_data_load
        path = bot_data_load.write_export(bot_id, args.get("name") or name, name, data)
    except DataError as error:
        return "Not exported: " + _explain(error)
    return f"Exported to {path} (in your own folder). Cells that look like formulas are prefixed with a quote."


def _explain(error: DataError) -> str:
    text = str(error)
    if error.line:
        text += f" (line {error.line})"
    if error.hint:
        text += f" {error.hint}"
    return text


async def _in_thread(fn, *args):
    import asyncio
    return await asyncio.to_thread(fn, *args)


async def _post_result_row(ctx, bot_id: str, card: dict, result: dict) -> None:
    """Put an "Open result" row (with an inline chart when the card has one) into the conversation."""
    session_id = getattr(ctx, "session_id", None)
    if not session_id:
        return
    try:
        from services import bot_widgets
        bot_widgets.append_rich_row(session_id, bot_id, "data_result", card["title"],
                                    {"data_result": {"card_id": card["id"], "title": card["title"],
                                                     "rows": result["row_count"], "chart": bool(card.get("spec")),
                                                     "columns": result["columns"][:12]}})
    except Exception:
        pass


def _object(properties: dict, required: tuple = ()) -> dict:
    return {"type": "object", "properties": properties, "required": list(required)}


def _str(description: str = "") -> dict:
    return {"type": "string", **({"description": description} if description else {})}


TOOLS = [
    {"name": "data_load", "effect": "write", "handler": _tool_load,
     "description": ("Load data into your own analysis database so you can ask questions with SQL. The source is a file or "
                     "folder in your own folder (csv, tsv, json, ndjson, xlsx, sqlite, or a glob like data/*.csv), a public "
                     "https csv or json link, or a public Google Sheet link. Each file becomes a table."),
     "schema": _object({"source": _str("A path in your folder, a glob, or an https link"),
                        "table": _str("Optional table name for a single source"),
                        "sheet": _str("Optional sheet name for a workbook")}, ("source",))},
    {"name": "data_describe", "effect": "read", "handler": _tool_describe,
     "description": "List your tables with their columns and row counts, or describe one table in detail.",
     "schema": _object({"table": _str("Optional: one table")})},
    {"name": "data_sql", "effect": "write", "handler": _tool_sql,
     "description": ("Run one SQL statement (SQLite flavour) on your own data: a SELECT, or CREATE [OR REPLACE] TABLE|VIEW "
                     "name AS SELECT ... to keep a result. Results are saved as a card the person can open in the Data panel. "
                     "Up to 50 rows come back (rows up to 500); longer results come back as a result id for data_show. "
                     "Optional chart: {type bar|line|area|scatter|histogram|pie|heatmap, x, y, series, agg, sort, limit, bins}."),
     "schema": _object({"sql": _str("One statement"), "title": _str("A short title"),
                        "rows": {"type": "integer", "description": "How many rows to return, 1 to 500"},
                        "chart": {"type": "object", "description": "How to draw the result"}}, ("sql",))},
    {"name": "data_show", "effect": "read", "handler": _tool_show,
     "description": "Read rows from a saved result by its id, a page at a time (at most 500 rows).",
     "schema": _object({"result": _str("The result id from data_sql"), "offset": {"type": "integer"},
                        "limit": {"type": "integer"}}, ("result",))},
    {"name": "data_export", "effect": "write", "handler": _tool_export,
     "description": "Save a saved result to a csv or xlsx file in your own folder (exports/).",
     "schema": _object({"result": _str("The result id"), "format": {"type": "string", "enum": ["csv", "xlsx"]},
                        "name": _str("Optional file name")}, ("result",))},
]
