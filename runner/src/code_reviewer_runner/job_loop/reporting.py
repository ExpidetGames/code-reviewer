"""Turns what a job process did into the `result` of a `complete` request.

The job process prints one line of JSON (`JobResult`) and exits with 0 or 1. The loop does not
trust it blindly: the line is checked field by field against the contract, the log tail is
redacted again with the secrets of this job and cut to the limit, and a process that did not
produce a usable line (it crashed, was killed, printed nothing) becomes a failure with a stable
code and the end of its stderr. The request must stay under the 64 KiB the app accepts, so the
result is shrunk before it is sent, never after a 413.
"""

import json
import math
import re
from collections.abc import Mapping
from typing import Any, Protocol

from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.job_loop.process import ProcessOutcome
from code_reviewer_runner.redaction import Redactor
from code_reviewer_runner.result import ErrorCode

MAX_LOG_TAIL_CHARS = 4096
MAX_ERROR_MESSAGE_CHARS = 500
MAX_COMMENT_URL_CHARS = 2048
MAX_DURATION_MS = 604_800_000
# The app refuses a body over 65,536 bytes; stay well under it (the lease token is in the body too).
MAX_REQUEST_BYTES = 48 * 1024
RUNNER_SHUTDOWN = "runner_shutdown"
_ERROR_CODE = re.compile(r"[a-z][a-z0-9_]{0,63}")
_COMMENT_URL = re.compile(r"https?://\S+")
_ESCAPE_SEQUENCE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")

Result = dict[str, Any]


class TextRedactor(Protocol):
    def redact(self, text: str) -> str: ...


def clean_text(text: str, redactor: TextRedactor, limit: int) -> str:
    """Printable, redacted text, the newest `limit` characters of it."""
    text = _ESCAPE_SEQUENCE.sub("", text.replace("\r\n", "\n"))
    text = _CONTROL.sub(" ", text)
    # A lone surrogate (from a broken byte sequence) cannot be encoded; it must not poison the body.
    text = text.encode("utf-8", errors="replace").decode("utf-8")
    text = redactor.redact(text)
    return text[-limit:] if len(text) > limit else text


def failure_result(
    code: str,
    message: str,
    *,
    duration_ms: int,
    log_tail: str = "",
    log_truncated: bool = False,
    redactor: TextRedactor | None = None,
) -> Result:
    """A failure the loop itself reports (invalid job, timeout, shutdown, crashed process)."""
    redactor = redactor or Redactor(())
    return {
        "ok": False,
        "durationMs": _duration(duration_ms),
        "commentUrl": None,
        "errorCode": code,
        "errorMessage": clean_text(message, redactor, MAX_ERROR_MESSAGE_CHARS),
        "logTail": clean_text(log_tail, redactor, MAX_LOG_TAIL_CHARS),
        "logTruncated": log_truncated,
        "usage": None,
    }


def _duration(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return 0
    return max(0, min(int(value), MAX_DURATION_MS))


def _last_line(raw: bytes) -> str | None:
    for line in reversed(raw.decode("utf-8", errors="replace").splitlines()):
        if line.strip():
            return line
    return None


def _parse_line(raw: bytes) -> dict[str, Any] | None:
    line = _last_line(raw)
    if line is None:
        return None
    try:
        value = as_object(json.loads(line))
    except (ValueError, RecursionError):
        return None
    return value if value is not None and isinstance(value.get("ok"), bool) else None


def _count(usage: Mapping[str, Any], name: str) -> int | None:
    item = usage.get(name)
    return item if isinstance(item, int) and not isinstance(item, bool) and item >= 0 else None


def _usage(value: object) -> dict[str, Any] | None:
    usage = as_object(value)
    if usage is None:
        return None
    model = usage.get("model")
    cost = usage.get("costUsd")
    fallback = usage.get("fallbackUsed")
    names = ("promptTokens", "completionTokens", "totalTokens", "aiCalls")
    numbers = [_count(usage, name) for name in names]
    cost_ok = cost is None or (
        isinstance(cost, (int, float))
        and not isinstance(cost, bool)
        and math.isfinite(cost)
        and cost >= 0
    )
    if (
        any(number is None for number in numbers)
        or not isinstance(fallback, bool)
        or not (model is None or (isinstance(model, str) and len(model) <= 200))
        or not cost_ok
    ):
        return None
    return {
        "model": model,
        "promptTokens": numbers[0],
        "completionTokens": numbers[1],
        "totalTokens": numbers[2],
        "aiCalls": numbers[3],
        "fallbackUsed": fallback,
        "costUsd": cost,
    }


def _sanitize(line: Mapping[str, Any], redactor: TextRedactor, measured_ms: int) -> Result:
    ok = line["ok"] is True
    code: Any = line.get("errorCode")
    error_code: str | None = None
    if not ok:
        error_code = code if isinstance(code, str) and _ERROR_CODE.fullmatch(code) else "unknown"
    url: Any = line.get("commentUrl")
    comment_url: str | None = None
    if (
        isinstance(url, str)
        and len(url) <= MAX_COMMENT_URL_CHARS
        and _COMMENT_URL.fullmatch(url)
        and redactor.redact(url) == url
    ):
        comment_url = url
    tail: Any = line.get("logTail")
    return {
        "ok": ok,
        "durationMs": _duration(line.get("durationMs", measured_ms)),
        "commentUrl": comment_url,
        "errorCode": error_code,
        "logTail": clean_text(tail if isinstance(tail, str) else "", redactor, MAX_LOG_TAIL_CHARS),
        "logTruncated": line.get("logTruncated") is True,
        "usage": _usage(line.get("usage")),
    }


def result_from_outcome(
    outcome: ProcessOutcome, redactor: TextRedactor, measured_ms: int
) -> Result:
    """The result of a process that ended by itself."""
    line = _parse_line(outcome.stdout)
    stderr_tail = outcome.stderr.decode("utf-8", errors="replace")
    if line is not None and outcome.exit_code in (0, 1) and (outcome.exit_code == 0) == line["ok"]:
        return _sanitize(line, redactor, measured_ms)
    # No usable line, or a line and an exit code that disagree: the process did not do its job.
    if outcome.exit_code < 0:
        message = f"the job process was ended by signal {-outcome.exit_code}"
    elif line is None:
        message = f"the job process exited with code {outcome.exit_code} without a result"
    else:
        message = "the job process result and exit code disagree"
    return failure_result(
        ErrorCode.RUNNER_ERROR.value,
        message,
        duration_ms=measured_ms,
        log_tail=stderr_tail,
        log_truncated=outcome.stderr_truncated,
        redactor=redactor,
    )


def fit_request(result: Result) -> Result:
    """Shrink the log tail until the `complete` body is small enough; never loses the verdict."""
    current = dict(result)
    while len(json.dumps(current)) > MAX_REQUEST_BYTES:
        tail = current["logTail"]
        if not tail:
            current["errorMessage"] = ""
            current["usage"] = None
            break
        current["logTail"] = tail[len(tail) // 2 :]
        current["logTruncated"] = True
    return current


def minimal(result: Mapping[str, Any]) -> Result:
    """Only the verdict: the fallback when the app refuses the full result (400 or 413)."""
    return {
        "ok": result["ok"],
        "durationMs": result["durationMs"],
        "commentUrl": result.get("commentUrl"),
        "errorCode": result["errorCode"],
        "logTail": "",
        "logTruncated": True,
        "usage": None,
    }
