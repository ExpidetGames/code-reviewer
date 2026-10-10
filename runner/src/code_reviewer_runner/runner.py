"""Runs one PR-Agent command for one job. One process per job.

Reads the job (JSON) from stdin, runs `PRAgent().handle_request` in user mode with the installation
token of the job, and prints exactly one line of result JSON on stdout. Everything else (PR-Agent's
own prints, log lines, tracebacks) goes through a redacting filter to stderr or into the log tail of
the result. Exit code 0 means the command succeeded, 1 means it did not.

Order matters here and is why the PR-Agent imports sit inside `run_job`:

1. validate the job (a refused job never loads PR-Agent and opens no connection),
2. replace the process environment with the minimal one built from the job (PR-Agent's settings
   are read from the environment when it is first imported),
3. install the log sink (before the import, so import-time warnings are captured too),
4. import PR-Agent, apply the identity patch and the comment recorder, run the command.
"""

import argparse
import asyncio
import logging
import os
import sys
import threading
import time
from collections.abc import Mapping, Sequence
from dataclasses import replace
from typing import Any, TextIO

from loguru import logger

from code_reviewer_runner import __version__
from code_reviewer_runner.comment_recorder import CommentRecorder, install_comment_recorder
from code_reviewer_runner.error_mapping import classify_failure
from code_reviewer_runner.identity_patch import (
    IdentityPatchError,
    apply_identity_patch,
    check_pr_agent_version,
)
from code_reviewer_runner.job import MAX_JOB_BYTES, Command, Job, JobError, parse_job
from code_reviewer_runner.log_capture import (
    MAX_TAIL_BYTES,
    LogCapture,
    StdlibLogHandler,
    fit_to_bytes,
)
from code_reviewer_runner.pr_agent_config import build_environment
from code_reviewer_runner.pr_agent_runtime import JobTimeout, execute
from code_reviewer_runner.redaction import REDACTED, RedactingStream, Redactor
from code_reviewer_runner.repo_settings_guard import install_repo_settings_guard
from code_reviewer_runner.result import ErrorCode, JobResult

PROGRAM_NAME = "code-reviewer-run-job"
_ERROR_LEVEL = 40
TIMEOUT_VARIABLE = "RUNNER_JOB_TIMEOUT_SECONDS"
# How long the watchdog waits after the soft timeout before it ends a command that does not react.
HARD_TIMEOUT_GRACE_SECONDS = 3.0


def _elapsed_ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)


def _failure(code: ErrorCode, detail: str, started: float, capture: LogCapture | None) -> JobResult:
    tail, truncated = capture.snapshot() if capture is not None else ("", False)
    # The code and the detail are the most important part: they stay, the old log lines make room.
    header = f"{code.value}: {detail}"
    room = max(MAX_TAIL_BYTES - len(header.encode("utf-8")) - 1, 0)
    fitted = fit_to_bytes(tail, room)
    return JobResult(
        ok=False,
        duration_ms=_elapsed_ms(started),
        comment_url=None,
        error_code=code,
        log_tail=fit_to_bytes(header + (f"\n{fitted}" if fitted else ""), MAX_TAIL_BYTES),
        log_truncated=truncated or fitted != tail,
    )


def run_job(
    job: Job, capture: LogCapture, started: float, timeout_seconds: float | None = None
) -> JobResult:
    """Run the job's command with PR-Agent. Never raises: every failure becomes a result."""
    try:
        check_pr_agent_version()
        import litellm

        litellm.suppress_debug_info = True
        undo_patch = apply_identity_patch(job.git.bot_login)
    except IdentityPatchError as error:
        return _failure(error.code, error.detail, started, capture)
    except Exception as error:
        capture.add(_ERROR_LEVEL, "ERROR", "cannot load PR-Agent", error)
        return _failure(ErrorCode.RUNNER_ERROR, "cannot load PR-Agent", started, capture)

    recorder: CommentRecorder
    recorder, undo_recorder = install_comment_recorder()
    guard, undo_guard = install_repo_settings_guard()
    try:
        try:
            handled, failed_flag, usage = asyncio.run(execute(job, guard, timeout_seconds))
        except JobTimeout:
            return _failure(
                ErrorCode.TIMEOUT, "the command did not finish in time", started, capture
            )
        except KeyboardInterrupt:
            raise
        except BaseException as error:  # SystemExit and friends from a library included
            capture.add(_ERROR_LEVEL, "ERROR", "handle_request raised", error)
            code = classify_failure(capture.exceptions, capture.error_messages)
            return _failure(code or ErrorCode.UNKNOWN, "the command raised", started, capture)
    finally:
        undo_guard()
        undo_recorder()
        undo_patch()

    failure_comment = recorder.failure_comment_posted()
    comment_url = None if failure_comment else recorder.comment_url(job.command)
    ok = handled and not failed_flag and not failure_comment
    error_code: ErrorCode | None = None
    if ok and job.command is Command.REVIEW and comment_url is None:
        # handle_request returned normally but nothing was posted: a failure the caller must see.
        ok = False
        error_code = ErrorCode.REVIEW_NOT_PUBLISHED
    elif not ok:
        messages = [*capture.error_messages, *recorder.failure_comment_texts()]
        error_code = classify_failure(capture.exceptions, messages)
        if error_code in (None, ErrorCode.UNKNOWN) and (failed_flag or failure_comment):
            error_code = ErrorCode.COMMAND_FAILED
        error_code = error_code or ErrorCode.UNKNOWN
    log_tail, log_truncated = capture.snapshot()
    return JobResult(
        ok=ok,
        duration_ms=_elapsed_ms(started),
        comment_url=comment_url,
        error_code=error_code,
        log_tail=log_tail,
        log_truncated=log_truncated,
        usage=usage,
    )


def _ensure_clean(result: JobResult, secrets: Sequence[str]) -> JobResult:
    """Last line of defence: no secret of the job may be in the line that is printed."""
    line = result.to_line()
    if not any(secret and secret in line for secret in secrets):
        return result
    return replace(result, log_tail=REDACTED, log_truncated=True, comment_url=None)


class _ResultChannel:
    """Writes the result line exactly once, however the normal path and the watchdog race."""

    def __init__(self, out: TextIO) -> None:
        self._out = out
        self._lock = threading.Lock()
        self._written = False

    def write(self, result: JobResult, secrets: Sequence[str] = ()) -> int | None:
        """Print the result. Returns the exit code, or None if a result was printed before."""
        with self._lock:
            if self._written:
                return None
            self._written = True
            result = _ensure_clean(result, secrets)
            self._out.write(result.to_line() + "\n")
            self._out.flush()
            return result.exit_code


def _read_stdin(stdin: TextIO) -> str:
    return stdin.read(MAX_JOB_BYTES + 1)


def _timeout_from(environment: Mapping[str, str]) -> float | None:
    """RUNNER_JOB_TIMEOUT_SECONDS of the parent process; missing or unusable means no timeout."""
    raw = environment.get(TIMEOUT_VARIABLE, "").strip()
    try:
        seconds = float(raw)
    except ValueError:
        return None
    return seconds if 0 < seconds < float("inf") else None


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=PROGRAM_NAME,
        description="Runs one PR-Agent command. The job is read as JSON from stdin; the result "
        "is printed as one line of JSON on stdout.",
    )
    parser.add_argument("--version", action="version", version=f"{PROGRAM_NAME} {__version__}")
    return parser


def _start_watchdog(
    seconds: float,
    channel: _ResultChannel,
    started: float,
    capture: LogCapture,
    secrets: Sequence[str],
) -> threading.Timer:
    """Last resort for a command that blocks the event loop and so ignores the soft timeout."""

    def fire() -> None:
        try:
            result = _failure(
                ErrorCode.TIMEOUT, "the command did not stop in time", started, capture
            )
        except Exception:
            result = JobResult(
                ok=False,
                duration_ms=_elapsed_ms(started),
                comment_url=None,
                error_code=ErrorCode.TIMEOUT,
                log_tail="timeout: the command did not stop in time",
                log_truncated=True,
            )
        try:
            written = channel.write(result, secrets)
        except Exception:
            written = 1
        if written is not None:
            os._exit(1)

    timer = threading.Timer(seconds + HARD_TIMEOUT_GRACE_SECONDS, fire)
    timer.daemon = True
    timer.start()
    return timer


def main(
    argv: Sequence[str] | None = None,
    *,
    stdin: TextIO | None = None,
    stdout: TextIO | None = None,
) -> int:
    """Entry point of the console script. Returns the process exit code."""
    started = time.monotonic()
    try:
        _build_parser().parse_args(argv)
    except SystemExit as exit_request:
        return exit_request.code if isinstance(exit_request.code, int) else 1

    channel = _ResultChannel(stdout or sys.stdout)
    real_stderr = sys.stderr
    # loguru's default handler writes DEBUG records (prompts, diffs) to stderr unredacted.
    logger.remove()

    try:
        job = parse_job(_read_stdin(stdin or sys.stdin))
    except JobError as error:
        return _exit_code(channel.write(_failure(error.code, error.detail, started, None)))
    except UnicodeDecodeError:
        return _exit_code(
            channel.write(_failure(ErrorCode.INVALID_JOB, "stdin is not UTF-8 text", started, None))
        )
    except Exception:
        return _exit_code(
            channel.write(_failure(ErrorCode.RUNNER_ERROR, "cannot read the job", started, None))
        )

    redactor = Redactor(job.secrets)
    capture = LogCapture(redactor)
    saved_env = dict(os.environ)
    saved_streams: tuple[Any, Any] = (sys.stdout, sys.stderr)
    timeout_seconds = _timeout_from(saved_env)
    watchdog = (
        _start_watchdog(timeout_seconds, channel, started, capture, job.secrets)
        if timeout_seconds
        else None
    )
    # Anything that prints (PR-Agent, LiteLLM, a library) must neither pollute stdout, which carries
    # the result, nor leak a secret to stderr.
    guarded = RedactingStream(real_stderr, redactor)
    sys.stdout = guarded  # type: ignore[assignment]
    sys.stderr = guarded  # type: ignore[assignment]
    sink_id = logger.add(capture, level="INFO", format="{message}")
    stdlib_handler = StdlibLogHandler(capture)
    logging.getLogger().addHandler(stdlib_handler)
    try:
        os.environ.clear()
        os.environ.update(build_environment(job, saved_env))
        try:
            result = run_job(job, capture, started, timeout_seconds)
        except KeyboardInterrupt:
            raise
        except BaseException as error:
            capture.add(_ERROR_LEVEL, "ERROR", "unexpected runner error", error)
            result = _failure(ErrorCode.RUNNER_ERROR, "unexpected runner error", started, capture)
    finally:
        if watchdog is not None:
            watchdog.cancel()
        logging.getLogger().removeHandler(stdlib_handler)
        logger.remove(sink_id)
        guarded.close()
        sys.stdout, sys.stderr = saved_streams
        os.environ.clear()
        os.environ.update(saved_env)
    return _exit_code(channel.write(result, job.secrets))


def _exit_code(written: int | None) -> int:
    # None: the watchdog printed the result first and ends the process itself.
    return 1 if written is None else written


if __name__ == "__main__":
    sys.exit(main())
