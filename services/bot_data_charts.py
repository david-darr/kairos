"""Bots data panel: chart specs and their reduction SQL (Phase 6 unit U2, 2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-6-design.md, sections 1.6 and 5.2.

A chart spec is a small description (type, columns, aggregate, sort, limit, stack,
time unit, bins). It is compiled to one reduction query over the card's own result, so the
browser only ever receives at most MAX_MARKS points: top-N plus "Other" for bars and pies,
M4 downsampling for lines and areas, a random sample for scatter, equal-width bins for a
histogram. The drawing itself is client-side (static/js/botsDataChart.js).
"""
from __future__ import annotations

from typing import Optional

MAX_MARKS = 10_000
TYPES = ("bar", "line", "area", "scatter", "histogram", "pie", "heatmap")
AGGS = ("sum", "avg", "min", "max", "count")
TIME_UNITS = ("year", "month", "day", "hour")
SORTS = ("x", "-x", "y", "-y", "none")
FIELDS = ("type", "x", "y", "value", "series", "agg", "sort", "limit", "stack", "time_unit", "bins", "title")
_TIME_FORMAT = {"year": "%Y", "month": "%Y-%m", "day": "%Y-%m-%d", "hour": "%Y-%m-%d %H:00"}
M4_BUCKETS = 500
DEFAULT_LIMIT = {"bar": 20, "pie": 8, "heatmap": 20, "line": 0, "area": 0, "scatter": 0, "histogram": 0}


class ChartError(ValueError):
    pass


def _column(value, label: str, required: bool = False) -> Optional[str]:
    if value in (None, ""):
        if required:
            raise ChartError(f"A {label} column is needed for this chart.")
        return None
    if not isinstance(value, str) or not value or len(value) > 128 or "\x00" in value:
        raise ChartError(f"The {label} column name is not usable.")
    return value


def validate(spec: dict) -> dict:
    """A clean copy of the spec, or a ChartError saying what is wrong."""
    if not isinstance(spec, dict):
        raise ChartError("A chart spec is an object.")
    unknown = set(spec) - set(FIELDS)
    if unknown:
        raise ChartError(f"A chart spec cannot hold: {', '.join(sorted(unknown))}.")
    kind = spec.get("type")
    if kind not in TYPES:
        raise ChartError(f"The chart type is one of: {', '.join(TYPES)}.")
    out: dict = {"type": kind}
    out["x"] = _column(spec.get("x"), "x", required=True)
    needs_y = kind in ("scatter",)
    out["y"] = _column(spec.get("y"), "y", required=needs_y or kind == "heatmap")
    out["value"] = _column(spec.get("value"), "value")
    out["series"] = _column(spec.get("series"), "series") if kind in ("bar", "line", "area", "scatter") else None
    agg = spec.get("agg", "sum" if out["y"] and kind != "heatmap" else "count")
    if agg not in AGGS:
        raise ChartError(f"The aggregate is one of: {', '.join(AGGS)}.")
    out["agg"] = agg
    sort = spec.get("sort", "none" if kind in ("line", "area", "scatter", "histogram") else "-y")
    if sort not in SORTS:
        raise ChartError(f"The sort is one of: {', '.join(SORTS)}.")
    out["sort"] = sort
    limit = spec.get("limit", DEFAULT_LIMIT[kind])
    if isinstance(limit, bool) or not isinstance(limit, int) or not 0 <= limit <= 1000:
        raise ChartError("The limit is a whole number from 0 to 1000.")
    out["limit"] = limit
    stack = spec.get("stack", False)
    if not isinstance(stack, bool):
        raise ChartError("stack is true or false.")
    out["stack"] = stack
    unit = spec.get("time_unit")
    if unit is not None and unit not in TIME_UNITS:
        raise ChartError(f"The time unit is one of: {', '.join(TIME_UNITS)}.")
    out["time_unit"] = unit
    bins = spec.get("bins", 20)
    if isinstance(bins, bool) or not isinstance(bins, int) or not 2 <= bins <= 200:
        raise ChartError("bins is a whole number from 2 to 200.")
    out["bins"] = bins
    title = spec.get("title")
    out["title"] = " ".join(str(title).split())[:120] if title else None
    return out


def _q(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _agg(agg: str, expr: Optional[str]) -> str:
    if agg == "count" or not expr:
        return "COUNT(*)"
    return {"sum": "SUM", "avg": "AVG", "min": "MIN", "max": "MAX"}[agg] + f"(CAST({expr} AS REAL))"


def _x_expr(spec: dict) -> str:
    x = f"b.{_q(spec['x'])}"
    if spec.get("time_unit"):
        return f"strftime('{_TIME_FORMAT[spec['time_unit']]}', {x})"
    if spec["type"] in ("line", "area", "scatter"):
        return x
    return f"CAST({x} AS TEXT)"


def _order(spec: dict, x: str = "x", y: str = "y") -> str:
    sort = spec["sort"]
    if sort == "none":
        return ""
    col = x if sort.lstrip("-") == "x" else y
    return f" ORDER BY {col}{' DESC' if sort.startswith('-') else ''}"


def compile_chart(spec: dict, base: str, columns: list[str]) -> dict:
    """The reduction queries for a validated spec over `base` (a read query whose result has `columns`).

    Returns {"type", "fields", "sql", "count_sql"?, "downsample_sql"?, "note"?}. Run `count_sql` first when
    present: above MAX_MARKS use `downsample_sql` instead of `sql`. Every query is capped at MAX_MARKS rows."""
    spec = validate(spec)
    for key in ("x", "y", "value", "series"):
        if spec.get(key) and spec[key] not in columns:
            raise ChartError(f"The {key} column '{spec[key]}' is not in this result.")
    kind = spec["type"]
    src = f"({base}) AS b"
    y_expr = f"b.{_q(spec['y'])}" if spec.get("y") else None
    series = f"CAST(b.{_q(spec['series'])} AS TEXT)" if spec.get("series") else None
    x = _x_expr(spec)
    agg = spec["agg"]
    plan: dict = {"type": kind}
    cap = f" LIMIT {MAX_MARKS}"

    if kind in ("bar", "pie"):
        limit = spec["limit"]
        a = _agg(agg if kind == "bar" else (agg if agg in ("sum", "count") else "sum"), y_expr)
        total = f"SELECT {x} AS x, {a} AS y FROM {src} GROUP BY 1"
        sel_x = f"CASE WHEN {x} IN (SELECT x FROM top) THEN {x} ELSE 'Other' END" if limit else x
        cols = f"{sel_x} AS x" + (f", {series} AS series" if series else "") + f", {a} AS y"
        group = "1" + (", 2" if series else "")
        body = f"SELECT {cols} FROM {src} GROUP BY {group}"
        if limit:
            top = f"WITH top AS (SELECT x FROM ({total}) ORDER BY y DESC LIMIT {limit}) "
            body = top + body
            plan["note"] = f"Top {limit} shown; the rest are grouped as Other."
        order = _order(spec)
        # An outer select keeps ORDER BY on the output names.
        plan["sql"] = f"SELECT * FROM ({body}){order}{cap}" if not limit else f"SELECT * FROM ({body}){order}{cap}"
        plan["fields"] = ["x"] + (["series"] if series else []) + ["y"]
        return plan

    if kind in ("line", "area"):
        a = _agg(agg, y_expr)
        cols = f"{x} AS x" + (f", {series} AS series" if series else "") + f", {a} AS y"
        group = "1" + (", 2" if series else "")
        base_q = f"SELECT {cols} FROM {src} WHERE {x} IS NOT NULL GROUP BY {group}"
        plan["fields"] = ["x"] + (["series"] if series else []) + ["y"]
        plan["sql"] = f"SELECT * FROM ({base_q}) ORDER BY x{cap}"
        plan["count_sql"] = f"SELECT COUNT(*) FROM ({base_q})"
        part = "PARTITION BY series " if series else ""
        sel_series = "series, " if series else ""
        join_series = " AND r.series IS m.series" if series else ""
        plan["downsample_sql"] = (
            f"WITH g AS ({base_q}), "
            f"r AS (SELECT x, {sel_series}y, NTILE({M4_BUCKETS}) OVER ({part}ORDER BY x) AS bk FROM g), "
            f"m AS (SELECT bk, {sel_series}MIN(x) AS minx, MAX(x) AS maxx, MIN(y) AS miny, MAX(y) AS maxy FROM r GROUP BY bk{', series' if series else ''}) "
            f"SELECT DISTINCT r.x, {'r.series, ' if series else ''}r.y FROM r JOIN m ON r.bk = m.bk{join_series} "
            f"WHERE r.x IN (m.minx, m.maxx) OR r.y IN (m.miny, m.maxy) ORDER BY r.x{cap}")
        plan["note_downsampled"] = "Drawn from a reduced set of points that keeps the peaks and dips."
        return plan

    if kind == "scatter":
        cols = f"{x} AS x, CAST({y_expr} AS REAL) AS y" + (f", {series} AS series" if series else "")
        base_q = f"SELECT {cols} FROM {src} WHERE {x} IS NOT NULL AND {y_expr} IS NOT NULL"
        plan["fields"] = ["x", "y"] + (["series"] if series else [])
        plan["sql"] = f"SELECT * FROM ({base_q}) ORDER BY RANDOM(){cap}"
        plan["count_sql"] = f"SELECT COUNT(*) FROM ({base_q})"
        plan["downsample_sql"] = plan["sql"]
        plan["note_downsampled"] = f"A random sample of {MAX_MARKS:,} points is drawn."
        return plan

    if kind == "histogram":
        n = spec["bins"]
        xv = f"CAST(b.{_q(spec['x'])} AS REAL)"
        plan["fields"] = ["x0", "x1", "y"]
        plan["sql"] = (
            f"WITH s AS (SELECT {xv} AS v FROM {src} WHERE {xv} IS NOT NULL), "
            f"r AS (SELECT MIN(v) AS lo, MAX(v) AS hi FROM s), "
            f"k AS (SELECT CASE WHEN r.hi = r.lo THEN 0 ELSE MIN({n - 1}, CAST((s.v - r.lo) / (r.hi - r.lo) * {n} AS INTEGER)) END AS bk, "
            f"r.lo AS lo, r.hi AS hi FROM s, r) "
            f"SELECT lo + bk * (CASE WHEN hi = lo THEN 1 ELSE (hi - lo) / {n} END) AS x0, "
            f"lo + (bk + 1) * (CASE WHEN hi = lo THEN 1 ELSE (hi - lo) / {n} END) AS x1, COUNT(*) AS y "
            f"FROM k GROUP BY bk ORDER BY bk{cap}")
        return plan

    # heatmap
    limit = spec["limit"] or 20
    value = f"b.{_q(spec['value'])}" if spec.get("value") else None
    a = _agg(agg, value)
    xs = f"CAST(b.{_q(spec['x'])} AS TEXT)"
    ys = f"CAST(b.{_q(spec['y'])} AS TEXT)"
    plan["fields"] = ["x", "y", "v"]
    plan["sql"] = (
        f"WITH tx AS (SELECT {xs} AS k FROM {src} GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT {limit}), "
        f"ty AS (SELECT {ys} AS k FROM {src} GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT {limit}) "
        f"SELECT {xs} AS x, {ys} AS y, {a} AS v FROM {src} "
        f"WHERE {xs} IN (SELECT k FROM tx) AND {ys} IN (SELECT k FROM ty) GROUP BY 1, 2{cap}")
    plan["note"] = f"The {limit} most common values on each axis are shown."
    return plan
