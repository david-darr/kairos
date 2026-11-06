"""Bots data panel: loading sources into a bot's database (Phase 6 unit U2, 2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-6-design.md, section 1.5 and 5.2.

Sources: csv, tsv, json, ndjson, xlsx and sqlite files, folders and globs inside the bot's own folder,
public https csv or json links, and public Google Sheets (through the csv export link). A file path
may only be inside the bot's folder (data/agents/<bot_id>); anything that resolves outside it, by
`..`, a link or a drive change, is refused. Link downloads accept https only and only public
addresses, and are capped at 25 MB. Column names and values are data: they are cleaned into plain
identifiers and never executed.
"""
from __future__ import annotations

import csv
import glob as globlib
import io
import ipaddress
import json
import os
import re
import socket
import sqlite3
from typing import Iterable, Optional
from urllib.parse import parse_qs, urlsplit

from core.constants import DATA_DIR
from services import bot_data
from services.bot_data import DataError

MAX_FILE_BYTES = 200 * 1024 * 1024
MAX_URL_BYTES = 25 * 1024 * 1024
MAX_TABLES_PER_LOAD = 25
SAMPLE_ROWS = 2000
EXTENSIONS = {".csv": "csv", ".tsv": "tsv", ".json": "json", ".ndjson": "ndjson", ".jsonl": "ndjson",
              ".xlsx": "xlsx", ".sqlite": "sqlite", ".sqlite3": "sqlite", ".db": "sqlite"}
SHEET_URL = re.compile(r"^https://docs\.google\.com/spreadsheets/d/([A-Za-z0-9_-]{10,100})")
MAX_EXPORT_NAME = 80


def bot_folder(bot_id: str) -> str:
    if not re.match(r"^[A-Za-z0-9_-]{1,64}$", str(bot_id)):
        raise DataError("Unknown bot.", 404)
    from services import agent_service
    return os.path.join(agent_service.agents_dir(), bot_id)


def _inside(root: str, path: str) -> bool:
    try:
        return os.path.commonpath([os.path.realpath(root), os.path.realpath(path)]) == os.path.realpath(root)
    except ValueError:  # another drive
        return False


def resolve_path(bot_id: str, raw: str) -> str:
    """A real path inside the bot's folder, or a DataError."""
    root = bot_folder(bot_id)
    if not raw or "\x00" in raw:
        raise DataError("Name a file or folder to load.")
    candidate = raw if os.path.isabs(raw) else os.path.join(root, raw)
    if not _inside(root, candidate):
        raise DataError("That path is outside your own folder, so it cannot be loaded.", 400, None,
                        "Put the file in your own folder first.")
    return os.path.realpath(candidate)


def clean_name(text: str, fallback: str = "data") -> str:
    name = re.sub(r"[^a-z0-9]+", "_", str(text).strip().lower()).strip("_")[:60] or fallback
    if name[0].isdigit():
        name = "t_" + name
    if name.startswith(("sqlite_", "_kairos")):
        name = "t_" + name
    return name


def clean_columns(raw: list) -> list[str]:
    seen: dict[str, int] = {}
    out = []
    for i, value in enumerate(raw):
        name = clean_name(value, f"col_{i + 1}") if str(value or "").strip() else f"col_{i + 1}"
        base = name
        while name in seen:
            seen[base] += 1
            name = f"{base}_{seen[base]}"
        seen.setdefault(name, 1)
        out.append(name)
    return out


def _number(text: str):
    try:
        return int(text)
    except ValueError:
        pass
    try:
        value = float(text)
        return value if value == value and abs(value) != float("inf") else None
    except ValueError:
        return None


def infer_types(sample: list[list]) -> list[str]:
    """INTEGER, REAL or TEXT for each column, from the sample rows."""
    width = max((len(r) for r in sample), default=0)
    types = []
    for i in range(width):
        values = [r[i] for r in sample if i < len(r) and r[i] not in (None, "")]
        if values and all(isinstance(v, int) and not isinstance(v, bool) or (isinstance(v, str) and re.fullmatch(r"-?\d{1,18}", v.strip())) for v in values):
            types.append("INTEGER")
        elif values and all(isinstance(v, (int, float)) and not isinstance(v, bool) or (isinstance(v, str) and _number(v.strip()) is not None and not re.fullmatch(r"-?0\d+", v.strip())) for v in values):
            types.append("REAL")
        else:
            types.append("TEXT")
    return types


def _value(value, kind: str):
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, str):
        if kind != "TEXT":
            text = value.strip()
            return None if text == "" else text
        return value
    return value


def _rows(sample: list[list], rest: Iterable, width: int, types: list[str]):
    def fit(row):
        row = list(row)[:width] + [None] * max(0, width - len(row))
        return tuple(_value(v, t) for v, t in zip(row, types))
    for row in sample:
        yield fit(row)
    for row in rest:
        yield fit(row)


def _take(iterator, count: int) -> list:
    out = []
    for item in iterator:
        out.append(item)
        if len(out) >= count:
            break
    return out


def _build(eng, table: str, header: list, source) -> dict:
    iterator = iter(source)
    sample = _take(iterator, SAMPLE_ROWS)
    columns = clean_columns(header)
    width = len(columns)
    types = infer_types(sample)[:width] + ["TEXT"] * max(0, width - len(infer_types(sample)))
    count = eng.replace_table(table, columns, types, _rows(sample, iterator, width, types))
    return {"table": table, "rows": count, "columns": columns}


# -- file formats ---------------------------------------------------------------------

def _text(data: bytes) -> str:
    if data[:2] in (bytes([0xFF, 0xFE]), bytes([0xFE, 0xFF])):
        return data.decode("utf-16", "replace")
    for encoding in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return data.decode(encoding)
        except (UnicodeDecodeError, UnicodeError):
            continue
    return data.decode("utf-8", "replace")


def _delimited(text: str, delimiter: str):
    csv.field_size_limit(10_000_000)
    reader = csv.reader(io.StringIO(text, newline=""), delimiter=delimiter)
    try:
        header = next(reader)
    except StopIteration:
        raise DataError("That file is empty.")
    return header, reader


def _json_rows(text: str, ndjson: bool):
    if ndjson:
        items = []
        for number, line in enumerate(text.splitlines(), 1):
            if not line.strip():
                continue
            try:
                items.append(json.loads(line))
            except ValueError:
                raise DataError(f"Line {number} is not valid JSON.", 400, number)
    else:
        try:
            data = json.loads(text)
        except ValueError as error:
            raise DataError(f"That is not valid JSON: {str(error)[:120]}")
        if isinstance(data, dict):
            lists = [v for v in data.values() if isinstance(v, list) and v and all(isinstance(x, dict) for x in v)]
            items = lists[0] if len(lists) == 1 else [data]
        elif isinstance(data, list):
            items = data
        else:
            raise DataError("JSON data should be a list of records.")
    if not items:
        raise DataError("That file has no records.")
    if not all(isinstance(x, dict) for x in items):
        items = [{"value": x} for x in items]
    keys: list[str] = []
    for item in items:
        for key in item:
            if key not in keys:
                keys.append(key)
            if len(keys) > 1000:
                raise DataError("Those records have more than 1,000 different fields.")
    return keys, ([item.get(k) for k in keys] for item in items)


def _xlsx(path: str, eng, stem: str, table: Optional[str], sheet: Optional[str]) -> list[dict]:
    import openpyxl
    book = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        names = [s for s in book.sheetnames if sheet in (None, "", s)]
        if not names:
            raise DataError(f"There is no sheet called {sheet}. Sheets: {', '.join(book.sheetnames)}.")
        loaded = []
        for name in names[:MAX_TABLES_PER_LOAD]:
            rows = book[name].iter_rows(values_only=True)
            header = next(rows, None)
            while header is not None and all(v is None for v in header):
                header = next(rows, None)
            if header is None:
                continue
            width = len(header)
            while width and header[width - 1] is None:
                width -= 1
            title = table if (table and len(names) == 1) else (stem if len(names) == 1 else f"{stem}_{name}")
            body = (r for r in (list(r)[:width] for r in rows) if any(v is not None for v in r))
            loaded.append(_build(eng, clean_name(title), ["" if h is None else h for h in header[:width]], body))
        if not loaded:
            raise DataError("That workbook has no data.")
        return loaded
    finally:
        book.close()


def _sqlite(path: str, eng, stem: str) -> list[dict]:
    source = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    try:
        names = [r[0] for r in source.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        if not names:
            raise DataError("That database has no tables.")
        loaded = []
        for name in names[:MAX_TABLES_PER_LOAD]:
            quoted = '"' + name.replace('"', '""') + '"'
            cursor = source.execute(f"SELECT * FROM {quoted}")
            header = [d[0] for d in cursor.description]
            loaded.append(_build(eng, clean_name(name), header, cursor))
        return loaded
    except sqlite3.DatabaseError as error:
        raise DataError(f"That is not a readable SQLite file: {str(error)[:120]}")
    finally:
        source.close()


def _load_bytes(eng, kind: str, data: bytes, stem: str, table: Optional[str]) -> list[dict]:
    name = clean_name(table or stem)
    if kind in ("csv", "tsv"):
        text = _text(data)
        delimiter = "\t" if kind == "tsv" else (";" if text.splitlines()[:1] and text.splitlines()[0].count(";") > text.splitlines()[0].count(",") else ",")
        header, reader = _delimited(text, delimiter)
        return [_build(eng, name, header, reader)]
    if kind in ("json", "ndjson"):
        header, rows = _json_rows(_text(data), kind == "ndjson")
        return [_build(eng, name, header, rows)]
    raise DataError(f"Cannot load a {kind} file here.")


def _load_file(eng, path: str, table: Optional[str], sheet: Optional[str]) -> list[dict]:
    ext = os.path.splitext(path)[1].lower()
    kind = EXTENSIONS.get(ext)
    if not kind:
        raise DataError(f"I cannot load {ext or 'that kind of'} files.", 400, None,
                        "Supported: csv, tsv, json, ndjson, xlsx, sqlite.")
    size = os.path.getsize(path)
    if size > MAX_FILE_BYTES:
        raise DataError("That file is larger than 200 MB.", 400, None, "Split it first.")
    stem = os.path.splitext(os.path.basename(path))[0]
    if kind == "xlsx":
        return _xlsx(path, eng, stem, table, sheet)
    if kind == "sqlite":
        return _sqlite(path, eng, stem)
    with open(path, "rb") as handle:
        return _load_bytes(eng, kind, handle.read(), stem, table)


# -- web sources --------------------------------------------------------------------

def _public_host(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except OSError:
        return False
    for info in infos:
        address = ipaddress.ip_address(info[4][0].split("%")[0])
        if getattr(address, "ipv4_mapped", None):
            address = address.ipv4_mapped
        if not address.is_global or address.is_multicast:
            return False
    return bool(infos)


def sheet_export_url(url: str) -> Optional[str]:
    """The csv export link for a public Google Sheet link, else None."""
    found = SHEET_URL.match(url)
    if not found:
        return None
    parts = urlsplit(url)
    gid = (parse_qs(parts.query).get("gid") or parse_qs(parts.fragment).get("gid") or ["0"])[0]
    if not re.fullmatch(r"\d{1,12}", gid):
        gid = "0"
    return f"https://docs.google.com/spreadsheets/d/{found.group(1)}/export?format=csv&gid={gid}"


def http_get(url: str) -> tuple[bytes, str]:
    """Download one public https page, at most 25 MB, following up to three redirects that stay public
    and https. Returns (bytes, content type). Tests replace this function."""
    import httpx
    current = url
    for _ in range(4):
        parts = urlsplit(current)
        if parts.scheme != "https" or not parts.hostname:
            raise DataError("Only https links can be loaded.")
        if not _public_host(parts.hostname):
            raise DataError("That address is not a public website.")
        with httpx.stream("GET", current, timeout=20, follow_redirects=False, headers={"User-Agent": "Kairos-data/1"}) as response:
            if response.status_code in (301, 302, 303, 307, 308) and response.headers.get("location"):
                current = str(httpx.URL(current).join(response.headers["location"]))
                continue
            if response.status_code != 200:
                raise DataError(f"That link answered with status {response.status_code}.")
            chunks, size = [], 0
            for chunk in response.iter_bytes():
                size += len(chunk)
                if size > MAX_URL_BYTES:
                    raise DataError("That download is larger than 25 MB.")
                chunks.append(chunk)
            return b"".join(chunks), response.headers.get("content-type", "")
    raise DataError("That link redirected too many times.")


def _load_url(eng, url: str, table: Optional[str]) -> list[dict]:
    export = sheet_export_url(url)
    target = export or url
    if len(target) > 2048:
        raise DataError("That link is too long.")
    data, content_type = http_get(target)
    path = urlsplit(url).path.rsplit("/", 1)[-1]
    stem = "google_sheet" if export else os.path.splitext(path)[0] or "web_data"
    kind = EXTENSIONS.get(os.path.splitext(path)[1].lower(), "")
    if export:
        kind = "csv"
    elif kind not in ("csv", "tsv", "json", "ndjson"):
        head = data[:200].lstrip()
        kind = "json" if head[:1] in (b"[", b"{") or "json" in content_type else "csv"
    if len(data) > MAX_URL_BYTES:
        raise DataError("That download is larger than 25 MB.")
    return _load_bytes(eng, kind, data, stem, table)


# -- entry point -----------------------------------------------------------------------

def load(bot_id: str, source: str, table: Optional[str] = None, sheet: Optional[str] = None) -> list[dict]:
    """Load a file, folder, glob, https link or Google Sheet into the bot's database.
    Returns [{table, rows, columns}] for each table made."""
    source = str(source or "").strip()
    if not source:
        raise DataError("Name a file, folder or link to load.")
    if table is not None and (not isinstance(table, str) or not table.strip()):
        table = None
    if sheet is not None and not isinstance(sheet, str):
        sheet = None
    eng = bot_data.engine(bot_id)
    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", source):
        if not source.lower().startswith("https://"):
            raise DataError("Only https links can be loaded.")
        return _load_url(eng, source, table)
    root = bot_folder(bot_id)
    if any(ch in source for ch in "*?["):
        pattern = source if os.path.isabs(source) else os.path.join(root, source)
        if not _inside(root, os.path.dirname(pattern.split("*")[0].split("?")[0].split("[")[0]) or root):
            raise DataError("That path is outside your own folder, so it cannot be loaded.")
        paths = sorted(p for p in globlib.glob(pattern, recursive=True) if os.path.isfile(p) and _inside(root, p)
                       and os.path.splitext(p)[1].lower() in EXTENSIONS)
        if not paths:
            raise DataError("Nothing in your folder matches that pattern.")
        return _load_many(eng, paths)
    path = resolve_path(bot_id, source)
    if os.path.isdir(path):
        paths = sorted(os.path.join(path, n) for n in os.listdir(path)
                       if os.path.isfile(os.path.join(path, n)) and os.path.splitext(n)[1].lower() in EXTENSIONS
                       and not n.startswith(".") and _inside(root, os.path.join(path, n)))
        if not paths:
            raise DataError("That folder has no csv, json, xlsx or sqlite files.")
        return _load_many(eng, paths)
    if not os.path.isfile(path):
        raise DataError("I could not find that file in your folder.", 404)
    return _load_file(eng, path, table, sheet)


def _load_many(eng, paths: list[str]) -> list[dict]:
    if len(paths) > MAX_TABLES_PER_LOAD:
        raise DataError(f"That matches {len(paths)} files; the limit is {MAX_TABLES_PER_LOAD} at a time.", 400, None,
                        "Use a narrower pattern.")
    loaded = []
    for path in paths:
        loaded.extend(_load_file(eng, path, None, None))
    return loaded


def write_export(bot_id: str, requested: Optional[str], default: str, data: bytes) -> str:
    """Write an export under the bot's exports folder; returns the relative path shown to the model."""
    root = os.path.join(bot_folder(bot_id), "exports")
    ext = os.path.splitext(default)[1]
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", os.path.splitext(os.path.basename(str(requested or default)))[0]).strip("-.")[:MAX_EXPORT_NAME] or "result"
    os.makedirs(root, exist_ok=True)
    path, n = os.path.join(root, stem + ext), 1
    while os.path.exists(path):
        n += 1
        path = os.path.join(root, f"{stem}-{n}{ext}")
    if not _inside(bot_folder(bot_id), path):
        raise DataError("That file name is not allowed.")
    with open(path, "wb") as handle:
        handle.write(data)
    return "exports/" + os.path.basename(path)
