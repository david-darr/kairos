"""A small incremental Server-Sent Events parser for the live feed.

Only what the Kairos backend sends: `data:` lines (joined with newlines when
there are several), blank-line dispatch, and `:` comment keepalives, which
are reported so a reader can tell the connection is alive.
"""
from __future__ import annotations

import json


class SSEParser:
    def __init__(self):
        self._buffer = ""
        self._data: list[str] = []
        self._event = "message"

    def feed(self, chunk: str) -> list[dict]:
        """Returns the events completed by this chunk: {"event", "data"} with
        data parsed as JSON when it is, or {"event": "keepalive"}."""
        self._buffer += chunk.replace("\r\n", "\n").replace("\r", "\n")
        out: list[dict] = []
        while "\n" in self._buffer:
            line, self._buffer = self._buffer.split("\n", 1)
            if line == "":
                if self._data:
                    raw = "\n".join(self._data)
                    try:
                        data = json.loads(raw)
                    except ValueError:
                        data = raw
                    out.append({"event": self._event, "data": data})
                self._data, self._event = [], "message"
            elif line.startswith(":"):
                out.append({"event": "keepalive"})
            else:
                field, _, value = line.partition(":")
                if value.startswith(" "):
                    value = value[1:]
                if field == "data":
                    self._data.append(value)
                elif field == "event":
                    self._event = value or "message"
        return out
