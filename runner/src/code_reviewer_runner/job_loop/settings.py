# SPDX-License-Identifier: Apache-2.0

"""What the operator configures for the job loop, read from environment variables.

| Variable                        | Meaning                                         | Default |
|---------------------------------|-------------------------------------------------|---------|
| `RUNNER_API_URL`                | Base URL of the app (`http://app:3000`)         | required |
| `RUNNER_TOKEN`                  | The shared token of the runner API              | required |
| `RUNNER_ID`                     | Free-form id sent as `X-Runner-Id`              | runner-HOST |
| `RUNNER_CONCURRENCY`            | Jobs that run at the same time (1 to 32)        | 3 |
| `RUNNER_POLL_INTERVAL_SECONDS`  | Wait between two claims when nothing is waiting | 5 |
| `RUNNER_JOB_TIMEOUT_SECONDS`    | Hard timeout of one job                         | 1200 |
| `RUNNER_SHUTDOWN_GRACE_SECONDS` | How long running jobs may finish after SIGTERM  | 60 |
| `PR_AGENT_COMMAND`              | Command that runs one job (test stacks only)    | run-job |

A refusal names the variable and never the value: the token is one of them.
"""

import re
import shlex
import socket
import sys
from collections.abc import Mapping
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from code_reviewer_runner.capabilities import (
    ALL_ENGINES,
    advertised_engines,
    fail_closed_self_check,
)

DEFAULT_CONCURRENCY = 3
DEFAULT_POLL_INTERVAL_SECONDS = 5.0
DEFAULT_JOB_TIMEOUT_SECONDS = 20 * 60.0
DEFAULT_SHUTDOWN_GRACE_SECONDS = 60.0
MAX_CONCURRENCY = 32
MAX_JOB_TIMEOUT_SECONDS = 6 * 60 * 60.0
MAX_SHUTDOWN_GRACE_SECONDS = 60 * 60.0
_RUNNER_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}")


class SettingsError(Exception):
    """A variable is missing or unusable. The message names the variable, never its value."""


def default_job_command() -> tuple[str, ...]:
    """One PR-Agent process per job: the entry point of CR-10 (`code-reviewer-run-job`)."""
    return (sys.executable, "-m", "code_reviewer_runner.runner")


@dataclass(frozen=True)
class LoopSettings:
    api_url: str
    token: str = field(repr=False)
    runner_id: str
    concurrency: int = DEFAULT_CONCURRENCY
    poll_interval: float = DEFAULT_POLL_INTERVAL_SECONDS
    job_timeout: float = DEFAULT_JOB_TIMEOUT_SECONDS
    shutdown_grace: float = DEFAULT_SHUTDOWN_GRACE_SECONDS
    # The job process gets the timeout as its own soft limit (it reports `timeout` with its log);
    # the loop ends it this much later if it still runs, which covers the process's own watchdog.
    kill_margin: float = 10.0
    # Time a process gets between SIGTERM and SIGKILL.
    terminate_grace: float = 5.0
    backoff_max: float = 60.0
    request_timeout: float = 30.0
    # How long a finished job's result is retried when the app cannot be reached.
    complete_retry_window: float = 600.0
    # #195: the engines this runner may claim for. Default is Diff only; `opencode` is added only
    # after the fail-closed startup self-check proved the isolation (capabilities.py).
    engines: tuple[str, ...] = (ALL_ENGINES[0],)
    job_command: tuple[str, ...] = field(default_factory=default_job_command)
    # (uid, gid) of the user every non-Dynamic job process drops to. Set only for a loop that runs
    # as root (the Dynamic runner, #197); unset, jobs run as the loop's own user.
    diff_job_user: tuple[int, int] | None = None


def _number(
    environment: Mapping[str, str], name: str, default: float, low: float, high: float
) -> float:
    raw = environment.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        raise SettingsError(f"{name} must be a number") from None
    if not low <= value <= high:
        raise SettingsError(f"{name} must be between {low:g} and {high:g}")
    return value


def _api_url(raw: str) -> str:
    try:
        parts = urlsplit(raw)
        _ = parts.port
    except ValueError:
        raise SettingsError("RUNNER_API_URL is not a valid URL") from None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise SettingsError("RUNNER_API_URL must be an http or https URL")
    if parts.username or parts.password or parts.query or parts.fragment:
        raise SettingsError("RUNNER_API_URL must not contain credentials, a query or a fragment")
    return raw.rstrip("/")


def _runner_id(environment: Mapping[str, str]) -> str:
    raw = environment.get("RUNNER_ID", "").strip()
    if raw:
        if not _RUNNER_ID.fullmatch(raw):
            raise SettingsError("RUNNER_ID may only hold letters, digits and ._:@- (64 at most)")
        return raw
    host = re.sub(r"[^A-Za-z0-9._:@-]", "-", socket.gethostname())
    return f"runner-{host}"[:64]


def _job_command(environment: Mapping[str, str]) -> tuple[str, ...]:
    """`PR_AGENT_COMMAND` replaces the job entry point, for test stacks with a fake PR-Agent."""
    raw = environment.get("PR_AGENT_COMMAND", "").strip()
    if not raw:
        return default_job_command()
    try:
        parts = shlex.split(raw)
    except ValueError:
        raise SettingsError("PR_AGENT_COMMAND is not a valid command line") from None
    return tuple(parts)


def _diff_job_user(environment: Mapping[str, str]) -> tuple[int, int] | None:
    """`RUNNER_DIFF_JOB_USER` as `uid:gid` (numeric, neither root)."""
    raw = environment.get("RUNNER_DIFF_JOB_USER", "").strip()
    if not raw:
        return None
    uid, separator, gid = raw.partition(":")
    if not separator or not (uid.isascii() and uid.isdigit() and gid.isascii() and gid.isdigit()):
        raise SettingsError("RUNNER_DIFF_JOB_USER must be uid:gid, both numbers")
    if int(uid) == 0 or int(gid) == 0:
        raise SettingsError("RUNNER_DIFF_JOB_USER must not be root")
    return int(uid), int(gid)


def settings_from_environment(environment: Mapping[str, str]) -> LoopSettings:
    api_url = environment.get("RUNNER_API_URL", "").strip()
    if not api_url:
        raise SettingsError("RUNNER_API_URL is required")
    token = environment.get("RUNNER_TOKEN", "").strip()
    if not token:
        raise SettingsError("RUNNER_TOKEN is required")
    if any(char.isspace() or not char.isprintable() for char in token):
        raise SettingsError("RUNNER_TOKEN must not contain white space or control characters")
    concurrency = _number(
        environment, "RUNNER_CONCURRENCY", DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY
    )
    if concurrency != int(concurrency):
        raise SettingsError("RUNNER_CONCURRENCY must be a whole number")
    return LoopSettings(
        job_command=_job_command(environment),
        diff_job_user=_diff_job_user(environment),
        engines=advertised_engines(fail_closed_self_check()),
        api_url=_api_url(api_url),
        token=token,
        runner_id=_runner_id(environment),
        concurrency=int(concurrency),
        poll_interval=_number(
            environment,
            "RUNNER_POLL_INTERVAL_SECONDS",
            DEFAULT_POLL_INTERVAL_SECONDS,
            0.1,
            300,
        ),
        job_timeout=_number(
            environment,
            "RUNNER_JOB_TIMEOUT_SECONDS",
            DEFAULT_JOB_TIMEOUT_SECONDS,
            1,
            MAX_JOB_TIMEOUT_SECONDS,
        ),
        shutdown_grace=_number(
            environment,
            "RUNNER_SHUTDOWN_GRACE_SECONDS",
            DEFAULT_SHUTDOWN_GRACE_SECONDS,
            0,
            MAX_SHUTDOWN_GRACE_SECONDS,
        ),
    )
