"""Held MCP results: trim what a model reads, keep the whole, query it later (Phase 2, unit U5).

A tool result longer than the server's text budget (default 8,000 characters, 0 to 2,000,000) goes
to the model cut short, with a result id. The full result stays here for 24 hours so the model can
fetch exactly what it needs with a bounded JMESPath query (`query_tool_result`) instead of reading
all of it.

Scope: every result belongs to (owner, bot, thread). A lookup with any other scope finds nothing, so
one bot, thread or person never reads another's results. Total size is capped at 64 MiB; a result
over 128 KiB spills to a file under <data>/bot-tool-results (the folder is cleared at start, since
the index lives in memory), and the oldest results go first when the cap is reached.

Queries use the `jmespath` package when it is installed; otherwise the bounded evaluator below,
which covers the language the model needs (fields, indexes, slices, projections, filters, pipes,
multiselect and the common functions) and refuses anything larger than the limits.
"""
import hashlib
import json
import math
import os
import secrets
import shutil
import threading
import time
from typing import Any, Callable, Optional

DEFAULT_BUDGET = 8_000
MAX_BUDGET = 2_000_000
STORE_LIMIT = 64 * 1024 * 1024
SPILL_ABOVE = 128 * 1024
TTL_SECONDS = 24 * 3600
MAX_QUERY = 500
MAX_QUERY_OUTPUT = 8_000
MAX_STEPS = 200_000
MAX_RESULTS = 2_000


class QueryError(ValueError):
    pass


# -- JMESPath: the bounded evaluator -------------------------------------------------------------

_SYMBOLS = {"||": "or", "&&": "and", "==": "eq", "!=": "ne", "<=": "lte", ">=": "gte", "[?": "filter", "[]": "flatten",
            ".": "dot", "*": "star", "[": "lbracket", "]": "rbracket", ",": "comma", ":": "colon", "{": "lbrace",
            "}": "rbrace", "(": "lparen", ")": "rparen", "|": "pipe", "!": "not", "<": "lt", ">": "gt", "@": "current",
            "&": "expref"}
_BP = {"eof": 0, "unquoted": 0, "quoted": 0, "literal": 0, "rbracket": 0, "rparen": 0, "comma": 0, "rbrace": 0, "number": 0,
       "current": 0, "expref": 0, "colon": 0, "pipe": 1, "or": 2, "and": 3, "eq": 5, "gt": 5, "lt": 5, "gte": 5, "lte": 5,
       "ne": 5, "flatten": 9, "star": 20, "filter": 21, "dot": 40, "not": 45, "lbrace": 50, "lbracket": 55, "lparen": 60}


def _tokens(text: str) -> list[tuple[str, Any, int]]:
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if c in " \t\r\n":
            i += 1
        elif c.isalpha() or c == "_":
            j = i + 1
            while j < n and (text[j].isalnum() or text[j] == "_"):
                j += 1
            out.append(("unquoted", text[i:j], i)); i = j
        elif c == '"':
            j = i + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            if j >= n:
                raise QueryError("unterminated quoted name")
            try:
                out.append(("quoted", json.loads(text[i:j + 1]), i))
            except ValueError as error:
                raise QueryError("bad quoted name") from error
            i = j + 1
        elif c == "'":
            j = i + 1
            while j < n and text[j] != "'":
                j += 2 if text[j] == "\\" else 1
            if j >= n:
                raise QueryError("unterminated string")
            out.append(("literal", text[i + 1:j].replace("\\'", "'"), i)); i = j + 1
        elif c == "`":
            j = i + 1
            while j < n and text[j] != "`":
                j += 2 if text[j] == "\\" else 1
            if j >= n:
                raise QueryError("unterminated literal")
            raw = text[i + 1:j].replace("\\`", "`")
            try:
                value = json.loads(raw)
            except ValueError:
                try:
                    value = json.loads('"' + raw + '"')
                except ValueError as error:
                    raise QueryError("bad literal") from error
            out.append(("literal", value, i)); i = j + 1
        elif c.isdigit() or (c == "-" and i + 1 < n and text[i + 1].isdigit()):
            j = i + 1
            while j < n and text[j].isdigit():
                j += 1
            out.append(("number", int(text[i:j]), i)); i = j
        elif text[i:i + 2] in _SYMBOLS:
            out.append((_SYMBOLS[text[i:i + 2]], text[i:i + 2], i)); i += 2
        elif c in _SYMBOLS:
            out.append((_SYMBOLS[c], c, i)); i += 1
        else:
            raise QueryError(f"unexpected character {c!r} at {i}")
    out.append(("eof", "", n))
    return out


class _Parser:
    def __init__(self, text: str):
        self.tokens, self.pos, self.depth = _tokens(text), 0, 0

    @property
    def kind(self) -> str:
        return self.tokens[self.pos][0]

    def advance(self) -> tuple:
        token = self.tokens[self.pos]
        self.pos += 1
        return token

    def expect(self, kind: str):
        if self.kind != kind:
            raise QueryError(f"expected {kind}, found {self.kind}")
        return self.advance()

    def parse(self):
        node = self.expression(0)
        if self.kind != "eof":
            raise QueryError(f"unexpected {self.kind}")
        return node

    def expression(self, rbp: int):
        self.depth += 1
        if self.depth > 60:
            raise QueryError("expression is nested too deeply")
        left = self.nud(self.advance())
        while rbp < _BP[self.kind]:
            left = self.led(self.advance(), left)
        self.depth -= 1
        return left

    def nud(self, token):
        kind, value, _ = token
        if kind == "literal":
            return ("literal", value)
        if kind == "unquoted":
            if self.kind == "lparen":
                self.advance()
                args = []
                while self.kind != "rparen":
                    args.append(self.expression(0))
                    if self.kind == "comma":
                        self.advance()
                self.expect("rparen")
                return ("function", value, args)
            return ("field", value)
        if kind == "quoted":
            return ("field", value)
        if kind == "star":
            return ("value_projection", ("identity",), self.projection_rhs(_BP["star"]))
        if kind == "filter":
            return self.led_filter(("identity",))
        if kind == "lbrace":
            return self.multiselect_dict()
        if kind == "flatten":
            return ("projection", ("flatten", ("identity",)), self.projection_rhs(_BP["flatten"]))
        if kind == "lbracket":
            if self.kind in ("number", "colon"):
                right = self.index_or_slice()
                return ("index", right[1]) if right[0] == "index" else ("projection", right, self.projection_rhs(_BP["star"]))
            if self.kind == "star" and self.tokens[self.pos + 1][0] == "rbracket":
                self.advance(); self.advance()
                return ("projection", ("identity",), self.projection_rhs(_BP["star"]))
            return self.multiselect_list()
        if kind == "current":
            return ("current",)
        if kind == "expref":
            return ("expref", self.expression(_BP["expref"]))
        if kind == "not":
            return ("not", self.expression(_BP["not"]))
        if kind == "lparen":
            node = self.expression(0)
            self.expect("rparen")
            return node
        raise QueryError(f"unexpected {kind}")

    def led(self, token, left):
        kind = token[0]
        if kind == "dot":
            if self.kind == "star":
                self.advance()
                return ("value_projection", left, self.projection_rhs(_BP["star"]))
            return ("subexpression", left, self.dot_rhs(_BP["dot"]))
        if kind == "pipe":
            return ("pipe", left, self.expression(_BP["pipe"]))
        if kind == "or":
            return ("or", left, self.expression(_BP["or"]))
        if kind == "and":
            return ("and", left, self.expression(_BP["and"]))
        if kind in ("eq", "ne", "lt", "lte", "gt", "gte"):
            return ("compare", kind, left, self.expression(_BP[kind]))
        if kind == "flatten":
            return ("projection", ("flatten", left), self.projection_rhs(_BP["flatten"]))
        if kind == "filter":
            return self.led_filter(left)
        if kind == "lbracket":
            if self.kind in ("number", "colon"):
                right = self.index_or_slice()
                if right[0] == "index":
                    return ("subexpression", left, ("index", right[1]))
                return ("projection", ("slice_of", left, right), self.projection_rhs(_BP["star"]))
            self.expect("star"); self.expect("rbracket")
            return ("projection", left, self.projection_rhs(_BP["star"]))
        raise QueryError(f"unexpected {kind}")

    def led_filter(self, left):
        condition = self.expression(0)
        self.expect("rbracket")
        return ("filter_projection", left, condition, self.projection_rhs(_BP["filter"]))

    def dot_rhs(self, bp: int):
        if self.kind in ("unquoted", "quoted", "star"):
            return self.expression(bp)
        if self.kind == "lbracket":
            self.advance()
            return self.multiselect_list()
        if self.kind == "lbrace":
            self.advance()
            return self.multiselect_dict()
        raise QueryError("expected a name after '.'")

    def projection_rhs(self, bp: int):
        kind = self.kind
        if _BP[kind] < 10:
            return ("identity",)
        if kind == "lbracket" or kind == "filter":
            return self.expression(bp)
        if kind == "dot":
            self.advance()
            return self.dot_rhs(bp)
        raise QueryError("bad projection")

    def index_or_slice(self):
        parts, current = [None, None, None], 0
        while self.kind != "rbracket":
            if self.kind == "colon":
                current += 1
                if current > 2:
                    raise QueryError("too many ':' in a slice")
                self.advance()
            elif self.kind == "number":
                parts[current] = self.advance()[1]
            else:
                raise QueryError("bad index")
        self.expect("rbracket")
        if current == 0:
            return ("index", parts[0])
        if parts[2] == 0:
            raise QueryError("slice step cannot be 0")
        return ("slice", parts[0], parts[1], parts[2])

    def multiselect_list(self):
        nodes = []
        while True:
            nodes.append(self.expression(0))
            if self.kind == "comma":
                self.advance()
                continue
            self.expect("rbracket")
            return ("multiselect_list", nodes)

    def multiselect_dict(self):
        pairs = []
        while True:
            key = self.advance()
            if key[0] not in ("quoted", "unquoted"):
                raise QueryError("expected a key")
            self.expect("colon")
            pairs.append((key[1], self.expression(0)))
            if self.kind == "comma":
                self.advance()
                continue
            self.expect("rbrace")
            return ("multiselect_dict", pairs)


def _truthy(value) -> bool:
    return not (value is None or value is False or value == "" or value == [] or value == {})


def _type(value) -> str:
    if value is None: return "null"
    if isinstance(value, bool): return "boolean"
    if isinstance(value, (int, float)): return "number"
    if isinstance(value, str): return "string"
    if isinstance(value, list): return "array"
    return "object"


def _num(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise QueryError(f"{name} needs numbers")
    return value


class _Evaluator:
    def __init__(self):
        self.steps = 0

    def tick(self):
        self.steps += 1
        if self.steps > MAX_STEPS:
            raise QueryError("the query is too expensive for this result")

    def visit(self, node, value):
        self.tick()
        return getattr(self, "v_" + node[0])(node, value)

    def v_identity(self, node, value): return value
    def v_current(self, node, value): return value
    def v_literal(self, node, value): return node[1]
    def v_field(self, node, value): return value.get(node[1]) if isinstance(value, dict) else None

    def v_index(self, node, value):
        if not isinstance(value, list):
            return None
        try:
            return value[node[1]]
        except IndexError:
            return None

    def v_subexpression(self, node, value):
        return self.visit(node[2], self.visit(node[1], value))

    def v_pipe(self, node, value):
        return self.visit(node[2], self.visit(node[1], value))

    def v_or(self, node, value):
        left = self.visit(node[1], value)
        return left if _truthy(left) else self.visit(node[2], value)

    def v_and(self, node, value):
        left = self.visit(node[1], value)
        return self.visit(node[2], value) if _truthy(left) else left

    def v_not(self, node, value): return not _truthy(self.visit(node[1], value))

    def v_compare(self, node, value):
        op, left, right = node[1], self.visit(node[2], value), self.visit(node[3], value)
        if op == "eq": return left == right and _type(left) == _type(right)
        if op == "ne": return not (left == right and _type(left) == _type(right))
        if not all(_type(v) == "number" for v in (left, right)):
            return None
        return {"lt": left < right, "lte": left <= right, "gt": left > right, "gte": left >= right}[op]

    def v_multiselect_list(self, node, value):
        return None if value is None else [self.visit(n, value) for n in node[1]]

    def v_multiselect_dict(self, node, value):
        return None if value is None else {k: self.visit(n, value) for k, n in node[1]}

    def v_flatten(self, node, value):
        base = self.visit(node[1], value)
        if not isinstance(base, list):
            return None
        out = []
        for item in base:
            out.extend(item) if isinstance(item, list) else out.append(item)
        return out

    def v_slice_of(self, node, value):
        base = self.visit(node[1], value)
        return self.v_slice(node[2], base)

    def v_slice(self, node, value):
        if not isinstance(value, list):
            return None
        return value[slice(node[1], node[2], node[3])]

    def v_projection(self, node, value):
        base = self.visit(node[1], value)
        if not isinstance(base, list):
            return None
        out = []
        for item in base:
            self.tick()
            result = self.visit(node[2], item)
            if result is not None:
                out.append(result)
        return out

    def v_value_projection(self, node, value):
        base = self.visit(node[1], value)
        if not isinstance(base, dict):
            return None
        out = [r for r in (self.visit(node[2], item) for item in base.values()) if r is not None]
        return out

    def v_filter_projection(self, node, value):
        base = self.visit(node[1], value)
        if not isinstance(base, list):
            return None
        out = []
        for item in base:
            self.tick()
            if _truthy(self.visit(node[2], item)):
                result = self.visit(node[3], item)
                if result is not None:
                    out.append(result)
        return out

    def v_expref(self, node, value):
        return ("expref", node[1])

    def v_function(self, node, value):
        name, args = node[1], [self.visit(a, value) if a[0] != "expref" else ("expref", a[1]) for a in node[2]]
        fn = getattr(self, "f_" + name, None)
        if fn is None:
            raise QueryError(f"unknown function {name}")
        return fn(*args)

    # functions
    def f_length(self, v):
        if isinstance(v, (str, list, dict)): return len(v)
        raise QueryError("length needs a string, array or object")
    def f_keys(self, v):
        if isinstance(v, dict): return list(v)
        raise QueryError("keys needs an object")
    def f_values(self, v):
        if isinstance(v, dict): return list(v.values())
        raise QueryError("values needs an object")
    def f_not_null(self, *args): return next((a for a in args if a is not None), None)
    def f_to_string(self, v): return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
    def f_to_number(self, v):
        if isinstance(v, bool): return None
        if isinstance(v, (int, float)): return v
        try: return float(v) if "." in str(v) else int(v)
        except (TypeError, ValueError): return None
    def f_to_array(self, v): return v if isinstance(v, list) else [v]
    def f_type(self, v): return _type(v)
    def f_reverse(self, v):
        if isinstance(v, (list, str)): return v[::-1]
        raise QueryError("reverse needs an array or string")
    def f_contains(self, subject, item):
        if isinstance(subject, (list, str)): return item in subject if isinstance(subject, list) or isinstance(item, str) else False
        raise QueryError("contains needs an array or string")
    def f_starts_with(self, a, b):
        if isinstance(a, str) and isinstance(b, str): return a.startswith(b)
        raise QueryError("starts_with needs strings")
    def f_ends_with(self, a, b):
        if isinstance(a, str) and isinstance(b, str): return a.endswith(b)
        raise QueryError("ends_with needs strings")
    def f_join(self, glue, items):
        if not isinstance(glue, str) or not isinstance(items, list) or not all(isinstance(i, str) for i in items):
            raise QueryError("join needs a string and an array of strings")
        return glue.join(items)
    def f_sum(self, v): return sum(_num(i, "sum") for i in self._array(v))
    def f_avg(self, v):
        items = [_num(i, "avg") for i in self._array(v)]
        return sum(items) / len(items) if items else None
    def f_max(self, v):
        items = self._array(v)
        return max(items) if items else None
    def f_min(self, v):
        items = self._array(v)
        return min(items) if items else None
    def f_sort(self, v):
        items = self._array(v)
        if items and len({_type(i) for i in items}) > 1 or any(_type(i) not in ("number", "string") for i in items):
            raise QueryError("sort needs an array of numbers or of strings")
        return sorted(items)
    def f_abs(self, v): return abs(_num(v, "abs"))
    def f_ceil(self, v): return math.ceil(_num(v, "ceil"))
    def f_floor(self, v): return math.floor(_num(v, "floor"))
    def f_map(self, ref, v):
        return [self.visit(ref[1], item) for item in self._array(v)]
    def _keyed(self, items, ref):
        pairs = [(self.visit(ref[1], i), i) for i in self._array(items)]
        if any(_type(k) not in ("number", "string") for k, _ in pairs) or len({_type(k) for k, _ in pairs}) > 1:
            raise QueryError("the key expression must give numbers or strings")
        return pairs
    def f_sort_by(self, items, ref): return [i for _, i in sorted(self._keyed(items, ref), key=lambda p: p[0])]
    def f_max_by(self, items, ref):
        pairs = self._keyed(items, ref)
        return max(pairs, key=lambda p: p[0])[1] if pairs else None
    def f_min_by(self, items, ref):
        pairs = self._keyed(items, ref)
        return min(pairs, key=lambda p: p[0])[1] if pairs else None
    @staticmethod
    def _array(v):
        if isinstance(v, list): return v
        raise QueryError("this function needs an array")


def evaluate(expression: str, data: Any, *, use_package: bool = True) -> Any:
    """Run `expression` over `data`. QueryError for anything wrong or too large."""
    if not isinstance(expression, str) or not expression.strip():
        raise QueryError("write a query, for example items[0].name")
    if len(expression) > MAX_QUERY:
        raise QueryError(f"a query is at most {MAX_QUERY} characters")
    if use_package:
        try:
            import jmespath  # optional: the bounded evaluator below is the fallback
        except ImportError:
            jmespath = None
        if jmespath is not None:
            try:
                return jmespath.search(expression, data)
            except Exception as error:
                raise QueryError(str(error)[:200]) from error
    tree = _Parser(expression).parse()
    return _Evaluator().visit(tree, data)


# -- the result store ----------------------------------------------------------------------------

def scope_key(owner: str, bot_id: str, thread_id: str) -> str:
    return hashlib.sha256("\0".join((str(owner), str(bot_id), str(thread_id))).encode("utf-8")).hexdigest()[:32]


class ResultStore:
    def __init__(self, root: Optional[str] = None, clock: Callable[[], float] = time.time, limit: int = STORE_LIMIT):
        self.root, self.clock, self.limit = root, clock, limit
        self._lock = threading.RLock()
        self._items: dict[str, dict] = {}
        self._bytes = 0
        if root:
            shutil.rmtree(root, ignore_errors=True)  # the index is memory only, so earlier spill files are orphans

    def _drop(self, rid: str) -> None:
        item = self._items.pop(rid, None)
        if not item:
            return
        self._bytes -= item["size"]
        if item.get("path"):
            try:
                os.remove(item["path"])
            except OSError:
                pass

    def sweep(self) -> int:
        with self._lock:
            now = self.clock()
            stale = [rid for rid, item in self._items.items() if item["expires"] <= now]
            for rid in stale:
                self._drop(rid)
            return len(stale)

    def put(self, owner: str, bot_id: str, thread_id: str, text: str, label: str = "") -> str:
        data = text.encode("utf-8")
        if len(data) > self.limit:
            raise ValueError("this result is larger than the 64 MiB result store")
        with self._lock:
            self.sweep()
            while self._items and (self._bytes + len(data) > self.limit or len(self._items) >= MAX_RESULTS):
                self._drop(next(iter(self._items)))  # the oldest first
            rid = "r_" + secrets.token_hex(8)
            scope = scope_key(owner, bot_id, thread_id)
            item = {"scope": scope, "size": len(data), "expires": self.clock() + TTL_SECONDS, "label": label[:80],
                    "created": self.clock(), "text": None, "path": None}
            if self.root and len(data) > SPILL_ABOVE:
                folder = os.path.join(self.root, scope)
                os.makedirs(folder, exist_ok=True)
                item["path"] = os.path.join(folder, rid + ".txt")
                with open(item["path"], "wb") as f:
                    f.write(data)
            else:
                item["text"] = text
            self._items[rid] = item
            self._bytes += len(data)
            return rid

    def get(self, owner: str, bot_id: str, thread_id: str, rid: str) -> Optional[str]:
        with self._lock:
            self.sweep()
            item = self._items.get(rid)
            if not item or item["scope"] != scope_key(owner, bot_id, thread_id):
                return None
            if item["path"]:
                try:
                    with open(item["path"], "rb") as f:
                        return f.read().decode("utf-8")
                except OSError:
                    self._drop(rid)
                    return None
            return item["text"]

    def query(self, owner: str, bot_id: str, thread_id: str, rid: str, expression: str, max_chars: int = MAX_QUERY_OUTPUT) -> dict:
        text = self.get(owner, bot_id, thread_id, rid)
        if text is None:
            raise KeyError(rid)
        try:
            data = json.loads(text)
        except ValueError:
            data = text  # a plain-text result can still be sliced with length(@) and friends
        found = evaluate(expression, data)
        shown = json.dumps(found, ensure_ascii=False, indent=1) if not isinstance(found, str) else found
        cap = max(100, min(int(max_chars), MAX_QUERY_OUTPUT))
        cut = len(shown) > cap
        return {"text": shown[:cap], "truncated": cut, "length": len(shown)}

    def usage(self) -> dict:
        with self._lock:
            return {"results": len(self._items), "bytes": self._bytes, "limit": self.limit}

    def clear(self) -> None:
        with self._lock:
            for rid in list(self._items):
                self._drop(rid)


def clean_budget(value, default: int = DEFAULT_BUDGET) -> int:
    """A text budget from a record or request: whole, 0 to 2,000,000 (0 holds every result)."""
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_BUDGET:
        raise ValueError("the result budget is a whole number from 0 to 2,000,000")
    return value


def trim(store: "ResultStore", owner: str, bot_id: str, thread_id: str, text: str, budget: int = DEFAULT_BUDGET,
         label: str = "") -> str:
    """What the model reads: `text` itself within the budget; otherwise its start, a note and a result id.
    A budget of 0 means every result is held and the model reads only the note."""
    if budget and len(text) <= budget:
        return text
    rid = store.put(owner, bot_id, thread_id, text, label)
    head = text[:budget] if budget else ""
    return (f"{head}\n[Result cut at {budget} of {len(text)} characters. The whole result is held as {rid} for 24 hours; "
            f"read part of it with query_tool_result using a JMESPath query.]").lstrip("\n")


def _default_root() -> str:
    from core.constants import DATA_DIR
    return os.path.join(DATA_DIR, "bot-tool-results")


_store: Optional[ResultStore] = None
_store_lock = threading.Lock()


def store() -> ResultStore:
    """The process-wide store, made on first use."""
    global _store
    with _store_lock:
        if _store is None:
            _store = ResultStore(_default_root())
        return _store


def reset_store() -> None:
    global _store
    with _store_lock:
        if _store is not None:
            _store.clear()
        _store = None


def run_query_tool(owner: str, bot_id: str, thread_id: str, result_id: str, query: str, max_chars: int = MAX_QUERY_OUTPUT) -> str:
    """The body of the model's `query_tool_result` tool. Identity comes from the turn, never from arguments."""
    from core.untrusted import wrap_untrusted
    try:
        found = store().query(owner, bot_id, thread_id, str(result_id), str(query), max_chars)
    except KeyError:
        return "No held result with that id for this chat. It may have expired (results are kept for 24 hours)."
    except QueryError as error:
        return f"The query did not run: {error}"
    note = " (cut; narrow the query)" if found["truncated"] else ""
    return wrap_untrusted("a held tool result" + note, found["text"])
