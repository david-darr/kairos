# Modified by Kairos (2026-11-10) from faster-qwen3-tts 0.5.4 (MIT, Copyright (c) 2026 Andres Marafioti);
# see ../NOTICE.md and ../LICENSE-faster-qwen3-tts.txt.
import contextlib
import sys


class _FilteredStdout:
    def __init__(self, stream, suppress_substrings):
        self._stream = stream
        self._suppress = suppress_substrings

    def write(self, data):
        if any(s in data for s in self._suppress):
            return len(data)
        return self._stream.write(data)

    def flush(self):
        return self._stream.flush()


@contextlib.contextmanager
def suppress_flash_attn_warning():
    filtered = _FilteredStdout(
        sys.stdout,
        suppress_substrings=(
            "flash-attn is not installed",
            "manual PyTorch version",
            "Please install flash-attn",
        ),
    )
    with contextlib.redirect_stdout(filtered):
        yield
