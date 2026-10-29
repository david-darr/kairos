"""Bots data panel: what SQL a bot may run (Phase 6 unit U2, 2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-6-design.md, section 5.2.

Two layers, so neither has to be perfect on its own:

1. `parse` tokenizes the text (comments and quotes cannot hide a second
   statement), then allows exactly one statement: a read (SELECT, WITH, VALUES)
   or one `CREATE [OR REPLACE] [TEMP] TABLE|VIEW name AS <read>`.
2. `authorizer` is installed on the SQLite connection. It denies everything but
   reading, functions and (for a create) making the one named object. ATTACH,
   PRAGMA, extension loading, INSERT, UPDATE, DELETE, triggers and indexes are
   refused whatever the text looked like.

The database belongs to one bot, so every object in it is the bot's own; the
authorizer still never lets a statement touch SQLite's own tables.
"""
from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from typing import Callable, Optional

MAX_SQL_BYTES = 100 * 1024
IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
RESERVED_PREFIXES = ("sqlite_", "_kairos")
READ_STARTS = ("select", "with", "values")
# Functions that load code, reach the disk or the process, whatever else is allowed.
DENIED_FUNCTIONS = {"load_extension", "readfile", "writefile", "edit", "fts3_tokenizer", "sqlite_log", "sqlite_source_id"}
MASTER = {"sqlite_master", "sqlite_schema", "sqlite_temp_master", "sqlite_temp_schema"}

OK, DENY = sqlite3.SQLITE_OK, sqlite3.SQLITE_DENY
_READ_ACTIONS = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_RECURSIVE}


class GuardError(ValueError):
    """The text is refused before it reaches the database."""

    def __init__(self, message: str, line: Optional[int] = None, hint: str = ""):
        super().__init__(message)
        self.line, self.hint = line, hint


@dataclass(frozen=True)
class Token:
    kind: str   # word, quoted, string, number, symbol
    text: str
    line: int
    pos: int = 0


@dataclass(frozen=True)
class Parsed:
    kind: str                 # "read" or "create"
    sql: str                  # the statement, without a trailing semicolon
    body: str = ""            # the read part (a read's own text, or the AS clause)
    object_kind: str = ""     # "table" or "view" for a create
    name: str = ""
    replace: bool = False
    temp: bool = False


def tokenize(text: str) -> list[Token]:
    """Words, quoted names, strings, numbers and symbols; comments dropped.
    Raises GuardError for an unterminated quote or comment."""
    tokens: list[Token] = []
    i, n, line = 0, len(text), 1
    while i < n:
        ch = text[i]
        if ch == "\n":
            line += 1
            i += 1
        elif ch.isspace():
            i += 1
        elif text.startswith("--", i):
            j = text.find("\n", i)
            i = n if j < 0 else j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            if j < 0:
                raise GuardError("A comment is never closed.", line, "End it with */")
            line += text.count("\n", i, j)
            i = j + 2
        elif ch in "'\"`":
            j, start = i + 1, line
            while True:
                if j >= n:
                    raise GuardError("A quote is never closed.", start, f"Close it with {ch}")
                if text[j] == ch:
                    if j + 1 < n and text[j + 1] == ch:   # doubled quote is an escape
                        j += 2
                        continue
                    break
                if text[j] == "\n":
                    line += 1
                j += 1
            tokens.append(Token("string" if ch == "'" else "quoted", text[i:j + 1], start, i))
            i = j + 1
        elif ch == "[":
            j = text.find("]", i)
            if j < 0:
                raise GuardError("A [name] is never closed.", line, "Close it with ]")
            tokens.append(Token("quoted", text[i:j + 1], line, i))
            i = j + 1
        elif ch.isalpha() or ch == "_":
            j = i + 1
            while j < n and (text[j].isalnum() or text[j] in "_$"):
                j += 1
            tokens.append(Token("word", text[i:j], line, i))
            i = j
        elif ch.isdigit():
            j = i + 1
            while j < n and (text[j].isalnum() or text[j] == "."):
                j += 1
            tokens.append(Token("number", text[i:j], line, i))
            i = j
        else:
            tokens.append(Token("symbol", ch, line, i))
            i += 1
    return tokens


def _statements(tokens: list[Token]) -> list[list[Token]]:
    out, current = [], []
    for token in tokens:
        if token.kind == "symbol" and token.text == ";":
            if current:
                out.append(current)
            current = []
        else:
            current.append(token)
    if current:
        out.append(current)
    return out


def _is(token: Optional[Token], word: str) -> bool:
    return token is not None and token.kind == "word" and token.text.lower() == word


def _identifier(token: Optional[Token]) -> str:
    if token is None:
        raise GuardError("Name the table or view.", None, "CREATE TABLE name AS SELECT ...")
    text = token.text
    if token.kind == "quoted":
        text = text[1:-1]
    elif token.kind != "word":
        raise GuardError("That is not a table name.", token.line, "Use letters, digits and underscores.")
    if not IDENT.match(text):
        raise GuardError(f"'{text}' is not a usable name.", token.line, "Use letters, digits and underscores, starting with a letter.")
    if text.lower().startswith(RESERVED_PREFIXES):
        raise GuardError(f"Names starting with {text[:7]} are reserved.", token.line, "Pick another name.")
    return text


def parse(sql: str) -> Parsed:
    """One allowed statement, or a GuardError saying why not."""
    if not isinstance(sql, str) or not sql.strip():
        raise GuardError("Write a query first.", None, "For example: SELECT * FROM my_table LIMIT 10")
    if len(sql.encode("utf-8", "replace")) > MAX_SQL_BYTES:
        raise GuardError("That query is too long.", None, "The limit is 100 KB.")
    if "\x00" in sql:
        raise GuardError("That query holds a null character.", None, "Remove it.")
    tokens = tokenize(sql)
    statements = _statements(tokens)
    if not statements:
        raise GuardError("Write a query first.", None, "For example: SELECT * FROM my_table LIMIT 10")
    if len(statements) > 1:
        raise GuardError("Run one statement at a time.", statements[1][0].line, "Remove the extra statement after the semicolon.")
    first = statements[0]
    word = first[0].text.lower() if first[0].kind == "word" else ""
    text = sql.strip()
    while text.endswith(";"):
        text = text[:-1].rstrip()
    if word in READ_STARTS:
        return Parsed("read", text, text)
    if word == "create":
        return _parse_create(first, sql, text)
    raise GuardError(
        f"Only reads and CREATE TABLE or VIEW ... AS are allowed here, not {first[0].text.upper()}.", first[0].line,
        "Use SELECT to look at data, or CREATE TABLE name AS SELECT ... to keep a result.")


def _parse_create(tokens: list[Token], raw: str, text: str) -> Parsed:
    i = 1
    replace = temp = False
    if _is(tokens[i] if i < len(tokens) else None, "or"):
        if not _is(tokens[i + 1] if i + 1 < len(tokens) else None, "replace"):
            raise GuardError("After CREATE OR, write REPLACE.", tokens[i].line)
        replace, i = True, i + 2
    if i < len(tokens) and (_is(tokens[i], "temp") or _is(tokens[i], "temporary")):
        temp, i = True, i + 1
    kind_token = tokens[i] if i < len(tokens) else None
    if not (_is(kind_token, "table") or _is(kind_token, "view")):
        raise GuardError("Only tables and views can be created here.", tokens[0].line,
                         "Use CREATE TABLE name AS SELECT ... or CREATE VIEW name AS SELECT ...")
    object_kind = kind_token.text.lower()
    i += 1
    if _is(tokens[i] if i < len(tokens) else None, "if"):
        if not (_is(tokens[i + 1] if i + 1 < len(tokens) else None, "not") and _is(tokens[i + 2] if i + 2 < len(tokens) else None, "exists")):
            raise GuardError("After IF, write NOT EXISTS.", tokens[i].line)
        i += 3
    name = _identifier(tokens[i] if i < len(tokens) else None)
    i += 1
    if i < len(tokens) and tokens[i].kind == "symbol" and tokens[i].text == ".":
        raise GuardError("Name the table without a schema.", tokens[i].line, "Use a plain name like my_table.")
    if not _is(tokens[i] if i < len(tokens) else None, "as"):
        raise GuardError("Write AS and a SELECT after the name.", tokens[min(i, len(tokens) - 1)].line,
                         "Column lists are not supported; use CREATE TABLE name AS SELECT ...")
    i += 1
    body_tokens = tokens[i:]
    if not body_tokens or not (body_tokens[0].kind == "word" and body_tokens[0].text.lower() in READ_STARTS):
        raise GuardError("A created table or view must come from a SELECT.", tokens[-1].line, "Write AS SELECT ...")
    body = raw[body_tokens[0].pos:].strip()
    while body.endswith(";"):
        body = body[:-1].rstrip()
    return Parsed("create", text, body, object_kind, name, replace, temp)


def quote(name: str) -> str:
    """A checked identifier, double-quoted."""
    if not IDENT.match(name):
        raise GuardError(f"'{name}' is not a usable name.")
    return f'"{name}"'


def authorizer(create: Optional[Parsed] = None, *, drop: Optional[str] = None) -> Callable:
    """The SQLite authorizer for one statement. `create` lets that statement make its one object;
    `drop` lets the replace step remove the named table or view. Everything else but reading is denied."""
    target = (create.name.lower() if create else None)
    dropping = drop.lower() if drop else None

    def check(action, arg1, arg2, dbname, source):
        if action in _READ_ACTIONS:
            return OK  # reading the schema table is harmless too
        if action == sqlite3.SQLITE_FUNCTION:
            return DENY if str(arg2 or "").lower() in DENIED_FUNCTIONS else OK
        name = str(arg1 or "").lower()
        if create is not None or dropping is not None:
            # Creating or replacing touches SQLite's own schema table; allow that and only that.
            if name in MASTER and action in (sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE):
                return OK
            if target and name == target and action in (sqlite3.SQLITE_CREATE_TABLE, sqlite3.SQLITE_CREATE_VIEW,
                                                        sqlite3.SQLITE_CREATE_TEMP_TABLE, sqlite3.SQLITE_CREATE_TEMP_VIEW):
                return OK
            if dropping and name == dropping and action == sqlite3.SQLITE_DELETE:
                return OK
            if dropping and name == dropping and action in (sqlite3.SQLITE_DROP_TABLE, sqlite3.SQLITE_DROP_VIEW,
                                                            sqlite3.SQLITE_DROP_TEMP_TABLE, sqlite3.SQLITE_DROP_TEMP_VIEW):
                return OK
        return DENY

    return check


def locate(sql: str, message: str) -> Optional[int]:
    """The 1-based line a SQLite error points at, when its message names the nearby text."""
    found = re.search(r'near "([^"]+)"', message)
    if not found or not sql:
        return None
    at = sql.find(found.group(1))
    return sql.count("\n", 0, at) + 1 if at >= 0 else None
