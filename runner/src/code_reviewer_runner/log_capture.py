"""The runner's own log sink.

PR-Agent logs through loguru and, left alone, writes everything (down to DEBUG: prompts and diffs)
to stderr or stdout. The runner removes loguru's handlers and installs this sink instead. It keeps
a redacted tail for the result JSON and collects the exceptions that error records carry, which is
the only way to see why PR-Agent failed, because PR-Agent swallows its own exceptions.
"""

import logging
from collections import deque
from typing import Any

from code_reviewer_runner.redaction import Redactor

MAX_TAIL_BYTES = 4096
_MAX_LINES = 400
_MAX_LINE_CHARS = 600
_MAX_IMPORTANT_LINES = 100
_MAX_COLLECTED = 20
_ERROR_LEVEL = 40
_WARNING_LEVEL = 30
# Share of the tail kept for warnings and errors so a flood of INFO lines cannot push them out.
_IMPORTANT_SHARE = 0.5
_NOISE = ("Settings file not found",)


class LogCapture:
    """A loguru sink. Use `logger.add(capture, level="INFO")`."""

    def __init__(self, redactor: Redactor, max_tail_bytes: int = MAX_TAIL_BYTES) -> None:
        self._redactor = redactor
        self._max_tail_bytes = max_tail_bytes
        self._lines: deque[tuple[int, int, str]] = deque(maxlen=_MAX_LINES)
        self._important: deque[tuple[int, int, str]] = deque(maxlen=_MAX_IMPORTANT_LINES)
        self._sequence = 0
        self.exceptions: list[BaseException] = []
        # Raw (unredacted) messages of error records. Only for classification, never printed.
        self.error_messages: list[str] = []

    def __call__(self, message: Any) -> None:
        record = message.record
        if record["extra"].get("analytics"):
            return
        self.add(record["level"].no, record["level"].name, record["message"], _exception(record))

    def add(
        self, level_no: int, level_name: str, text: str, exception: BaseException | None = None
    ) -> None:
        if any(text.startswith(noise) for noise in _NOISE):
            return
        if level_no >= _ERROR_LEVEL:
            if exception is not None and len(self.exceptions) < _MAX_COLLECTED:
                self.exceptions.append(exception)
            if len(self.error_messages) < _MAX_COLLECTED:
                self.error_messages.append(text)
        line = f"{level_name} {text}"
        if exception is not None:
            line += f" [{type(exception).__name__}: {exception}]"
        line = " ".join(self._redactor.redact(line).split())[:_MAX_LINE_CHARS]
        self._sequence += 1
        entry = (self._sequence, level_no, line)
        self._lines.append(entry)
        if level_no >= _WARNING_LEVEL:
            self._important.append(entry)

    def tail(self) -> str:
        """The newest lines that fit the byte limit; warnings and errors get priority."""
        budget = self._max_tail_bytes
        chosen: dict[int, str] = {}
        used = 0
        for sequence, _, line in reversed(self._important):
            size = len(line.encode("utf-8")) + 1
            if used + size > budget * _IMPORTANT_SHARE:
                break
            chosen[sequence] = line
            used += size
        for sequence, _, line in reversed(self._lines):
            if sequence in chosen:
                continue
            size = len(line.encode("utf-8")) + 1
            if used + size > budget:
                break
            chosen[sequence] = line
            used += size
        text = "\n".join(chosen[sequence] for sequence in sorted(chosen))
        return fit_to_bytes(text, budget)


def _exception(record: Any) -> BaseException | None:
    exception = record["exception"]
    return exception.value if exception is not None else None


def fit_to_bytes(text: str, max_bytes: int) -> str:
    """Cut from the front to `max_bytes` on a character boundary (the end is the newest)."""
    data = text.encode("utf-8")
    if len(data) <= max_bytes:
        return text
    return data[-max_bytes:].decode("utf-8", errors="ignore")


class StdlibLogHandler(logging.Handler):
    """Routes warnings of standard library loggers (httpx, urllib3, litellm) into the capture."""

    def __init__(self, capture: LogCapture) -> None:
        super().__init__(level=logging.WARNING)
        self._capture = capture

    def emit(self, record: logging.LogRecord) -> None:
        exception = record.exc_info[1] if record.exc_info else None
        self._capture.add(
            record.levelno, record.levelname, f"{record.name}: {record.getMessage()}", exception
        )
