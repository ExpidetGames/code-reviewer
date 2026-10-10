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
import time
from collections.abc import Sequence
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
from code_reviewer_runner.job import MAX_JOB_BYTES, Job, JobError, parse_job
from code_reviewer_runner.log_capture import (
    MAX_TAIL_BYTES,
    LogCapture,
    StdlibLogHandler,
    fit_to_bytes,
)
from code_reviewer_runner.pr_agent_config import build_environment
from code_reviewer_runner.pr_agent_runtime import execute
from code_reviewer_runner.redaction import REDACTED, RedactingStream, Redactor
from code_reviewer_runner.result import ErrorCode, JobResult

PROGRAM_NAME = "code-reviewer-run-job"
_ERROR_LEVEL = 40


def _elapsed_ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)


def _failure(code: ErrorCode, detail: str, started: float, capture: LogCapture | None) -> JobResult:
    tail = capture.tail() if capture is not None else ""
    log_tail = f"{code.value}: {detail}" + (f"\n{tail}" if tail else "")
    return JobResult(
        ok=False,
        duration_ms=_elapsed_ms(started),
        comment_url=None,
        error_code=code,
        log_tail=fit_to_bytes(log_tail, MAX_TAIL_BYTES),
    )


def run_job(job: Job, capture: LogCapture, started: float) -> JobResult:
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
    try:
        try:
            handled, failed_flag, usage = asyncio.run(execute(job))
        except Exception as error:
            capture.add(_ERROR_LEVEL, "ERROR", "handle_request raised", error)
            code = classify_failure(capture.exceptions, capture.error_messages)
            return _failure(code or ErrorCode.UNKNOWN, "the command raised", started, capture)
    finally:
        undo_recorder()
        undo_patch()

    failure_comment = recorder.failure_comment_posted()
    ok = handled and not failed_flag and not failure_comment
    error_code: ErrorCode | None = None
    if not ok:
        error_code = classify_failure(capture.exceptions, capture.error_messages)
        if error_code in (None, ErrorCode.UNKNOWN) and (failed_flag or failure_comment):
            error_code = ErrorCode.COMMAND_FAILED
        error_code = error_code or ErrorCode.UNKNOWN
    return JobResult(
        ok=ok,
        duration_ms=_elapsed_ms(started),
        comment_url=recorder.comment_url(job.command) if not failure_comment else None,
        error_code=error_code,
        log_tail=capture.tail(),
        usage=usage,
    )


def _ensure_clean(result: JobResult, secrets: Sequence[str]) -> JobResult:
    """Last line of defence: no secret of the job may be in the line that is printed."""
    line = result.to_line()
    if not any(secret and secret in line for secret in secrets):
        return result
    return replace(result, log_tail=REDACTED, comment_url=None)


def _emit(result: JobResult, out: TextIO, secrets: Sequence[str] = ()) -> int:
    result = _ensure_clean(result, secrets)
    out.write(result.to_line() + "\n")
    out.flush()
    return result.exit_code


def _read_stdin(stdin: TextIO) -> str:
    return stdin.read(MAX_JOB_BYTES + 1)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=PROGRAM_NAME,
        description="Runs one PR-Agent command. The job is read as JSON from stdin; the result "
        "is printed as one line of JSON on stdout.",
    )
    parser.add_argument("--version", action="version", version=f"{PROGRAM_NAME} {__version__}")
    return parser


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

    real_stdout = stdout or sys.stdout
    real_stderr = sys.stderr
    # loguru's default handler writes DEBUG records (prompts, diffs) to stderr unredacted.
    logger.remove()

    try:
        job = parse_job(_read_stdin(stdin or sys.stdin))
    except JobError as error:
        return _emit(_failure(error.code, error.detail, started, None), real_stdout)

    redactor = Redactor(job.secrets)
    capture = LogCapture(redactor)
    saved_env = dict(os.environ)
    saved_streams: tuple[Any, Any] = (sys.stdout, sys.stderr)
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
            result = run_job(job, capture, started)
        except Exception as error:
            capture.add(_ERROR_LEVEL, "ERROR", "unexpected runner error", error)
            result = _failure(ErrorCode.RUNNER_ERROR, "unexpected runner error", started, capture)
    finally:
        logging.getLogger().removeHandler(stdlib_handler)
        logger.remove(sink_id)
        guarded.close()
        sys.stdout, sys.stderr = saved_streams
        os.environ.clear()
        os.environ.update(saved_env)
    return _emit(result, real_stdout, job.secrets)


if __name__ == "__main__":
    sys.exit(main())
