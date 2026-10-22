"""A small terminal screen for tests: feed it the bytes a full-screen app
wrote and read back the text grid. Handles what prompt_toolkit emits:
cursor moves, erases, the alternate screen, SGR (ignored), OSC (skipped).
Not a full emulator; scripts/test_kairos_cli_live.py uses it to read the
Kairos CLI's screen through a pseudo-terminal."""
import re

from prompt_toolkit.utils import get_cwidth

_CSI = re.compile(r"\x1b\[([?>=]?)([0-9;]*)([ -/]*)([@-~])")
_OSC = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")


class Screen:
    def __init__(self, columns: int, rows: int):
        self.columns, self.rows = columns, rows
        self.main = self._blank()
        self.alt = self._blank()
        self.grid = self.main
        self.alternate = False
        self.ever_alternate = False
        self.x = self.y = 0

    def _blank(self):
        return [[" "] * self.columns for _ in range(self.rows)]

    def text(self) -> str:
        return "\n".join("".join(c for c in row if c is not None).rstrip() for row in self.grid)

    def feed(self, data: str) -> None:
        index = 0
        while index < len(data):
            char = data[index]
            if char == "\x1b":
                osc = _OSC.match(data, index)
                if osc:
                    index = osc.end()
                    continue
                csi = _CSI.match(data, index)
                if csi:
                    self._csi(*csi.groups())
                    index = csi.end()
                    continue
                index += 2
                continue
            if char == "\r":
                self.x = 0
            elif char == "\n":
                self._down()
            elif char == "\b":
                self.x = max(0, self.x - 1)
            elif char >= " ":
                self._put(char)
            index += 1

    def _down(self):
        if self.y < self.rows - 1:
            self.y += 1
        else:
            self.grid.pop(0)
            self.grid.append([" "] * self.columns)

    def _put(self, char):
        width = get_cwidth(char)
        if width == 0:
            return
        if self.x + width > self.columns:
            self.x = 0
            self._down()
        self.grid[self.y][self.x] = char
        if width == 2 and self.x + 1 < self.columns:
            self.grid[self.y][self.x + 1] = None
        self.x += width

    def _csi(self, private, params, _inter, final):
        numbers = [int(p) if p else 0 for p in params.split(";")] if params else []

        def n(i=0, default=1):
            return numbers[i] if len(numbers) > i and numbers[i] else default
        if private == "?":
            if final in "hl" and 1049 in numbers:
                self.alternate = final == "h"
                self.ever_alternate |= self.alternate
                self.grid = self.alt if self.alternate else self.main
                if self.alternate:
                    self.alt[:] = self._blank()
            return
        if final in "Hf":
            self.y, self.x = min(self.rows - 1, n(0) - 1), min(self.columns - 1, n(1) - 1)
        elif final == "A":
            self.y = max(0, self.y - n())
        elif final == "B":
            self.y = min(self.rows - 1, self.y + n())
        elif final == "C":
            self.x = min(self.columns - 1, self.x + n())
        elif final == "D":
            self.x = max(0, self.x - n())
        elif final == "G":
            self.x = min(self.columns - 1, n() - 1)
        elif final == "d":
            self.y = min(self.rows - 1, n() - 1)
        elif final == "K":
            mode = n(0, 0)
            row = self.grid[self.y]
            span = range(self.x, self.columns) if mode == 0 else range(0, self.x + 1) if mode == 1 else range(self.columns)
            for i in span:
                row[i] = " "
        elif final == "J":
            mode = n(0, 0)
            if mode == 2 or mode == 3:
                self.grid[:] = self._blank()
            elif mode == 0:
                for i in range(self.x, self.columns):
                    self.grid[self.y][i] = " "
                for r in range(self.y + 1, self.rows):
                    self.grid[r] = [" "] * self.columns
