# SPDX-License-Identifier: Apache-2.0

"""The runner's own log sink.

PR-Agent logs through loguru and, left alone, writes everything (down to DEBUG: prompts and diffs)
to stderr or stdout. The runner removes loguru's handlers and installs this sink instead. It keeps
a redacted tail for the result JSON and collects the exceptions that error records carry, which is
the only way to see why PR-Agent failed, because PR-Agent swallows its own exceptions.
"""

import logging
import re
import threading
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
_FINAL_FAILURE = "Failed to process the command"
_NOISE = ("Settings file not found",)
# Terminal escape sequences (colors, cursor moves, window titles) and control characters. The log
# comes from a library and from text of the pull request; neither may send commands to the
# terminal of whoever reads the tail later.
_ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")  # replaced by a space


class LogCapture:
    """A loguru sink. Use `logger.add(capture, level="INFO")`."""

    def __init__(self, redactor: Redactor, max_tail_bytes: int = MAX_TAIL_BYTES) -> None:
        self._redactor = redactor
        self._max_tail_bytes = max_tail_bytes
        self._lines: deque[tuple[int, int, str]] = deque(maxlen=_MAX_LINES)
        self._important: deque[tuple[int, int, str]] = deque(maxlen=_MAX_IMPORTANT_LINES)
        self._sequence = 0
        # The newest error records (message, exception); the final failure is what matters most.
        self._errors: deque[tuple[str, BaseException | None]] = deque(maxlen=_MAX_COLLECTED)
        # Set as soon as something of the log could not be kept: an evicted line, a shortened line.
        self._lost_text = False
        # The watchdog thread may read while the main thread still logs.
        self._lock = threading.RLock()

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
            self._errors.append((text, exception))
        line = f"{level_name} {text}"
        if exception is not None:
            line += f" [{type(exception).__name__}: {exception}]"
        # Clean first, then redact: a secret that an escape sequence or a control character cut
        # in two is joined by the cleaning and must be found afterwards, not before.
        line = self._redactor.redact(_clean(line))
        with self._lock:
            if len(line) > _MAX_LINE_CHARS:
                line = line[:_MAX_LINE_CHARS]
                self._lost_text = True
            self._sequence += 1
            entry = (self._sequence, level_no, line)
            if len(self._lines) == self._lines.maxlen:
                self._lost_text = True
            self._lines.append(entry)
            if level_no >= _WARNING_LEVEL:
                self._important.append(entry)

    @property
    def exceptions(self) -> list[BaseException]:
        """Exceptions of error records, most relevant first: those of PR-Agent's final "Failed to
        process the command" record, then the others, newest first. Early errors are often
        benign (a repository without the optional context file, for example)."""
        records = [(text, error) for text, error in reversed(self._errors) if error is not None]
        final = [error for text, error in records if text.startswith(_FINAL_FAILURE)]
        others = [error for text, error in records if not text.startswith(_FINAL_FAILURE)]
        return final + others

    @property
    def error_messages(self) -> list[str]:
        """Raw (unredacted) messages of error records, oldest first. Only for classification,
        never printed."""
        return [text for text, _ in self._errors]

    def tail(self) -> str:
        """The newest lines that fit the byte limit; warnings and errors get priority."""
        return self.snapshot()[0]

    @property
    def truncated(self) -> bool:
        """True if the log held more than `tail()` returns (older lines or characters were cut)."""
        return self.snapshot()[1]

    def snapshot(self) -> tuple[str, bool]:
        """The tail and whether the log held more than it, taken together from one state."""
        with self._lock:
            return self._select()

    def _select(self) -> tuple[str, bool]:
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
        fitted = fit_to_bytes(text, budget)
        kept = {sequence for sequence, _, _ in self._lines} | {
            sequence for sequence, _, _ in self._important
        }
        truncated = self._lost_text or len(chosen) < len(kept) or fitted != text
        return fitted, truncated


def _clean(text: str) -> str:
    """One line: escape sequences removed, control characters turned into spaces (so a progress
    line with carriage returns stays readable), white space collapsed."""
    return " ".join(_CONTROL.sub(" ", _ANSI.sub("", text)).split())


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
