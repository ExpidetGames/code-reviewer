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

from code_reviewer_runner.capabilities import ENGINE_DIFF
from code_reviewer_runner.dynamic_review.netguard import IsolationError
from code_reviewer_runner.dynamic_review.static_isolation import SlotPorts, slot_ports
from code_reviewer_runner.dynamic_review.supervisor import (
    DEFAULT_ENGINE_ID,
    ENGINE_GID_VARIABLE,
    ENGINE_UID_VARIABLE,
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
    # by the startup self-check once it proved the isolation (`service.advertise_engines`, #202),
    # together with the verified engine command that the Dynamic job process is handed.
    engines: tuple[str, ...] = (ENGINE_DIFF,)
    dynamic_command: tuple[str, ...] | None = None
    dynamic_ripgrep: str | None = None
    job_command: tuple[str, ...] = field(default_factory=default_job_command)
    # (uid, gid) of the user every non-Dynamic job process drops to. Set only for a loop that runs
    # as root (the Dynamic runner, #197); unset, jobs run as the loop's own user.
    diff_job_user: tuple[int, int] | None = None
    # (uid, gid) of the dedicated engine user of Dynamic Review. Set together with `diff_job_user`
    # (a root loop, the Dynamic runner): after every Dynamic job process the loop ends whatever
    # that user still runs, which a job killed outright could not.
    dynamic_engine_user: tuple[int, int] | None = None
    # The fixed proxy and engine ports of the single Dynamic slot, set with `dynamic_engine_user`:
    # the engine user's nft rules are installed once at startup for exactly these (#244).
    dynamic_ports: SlotPorts | None = None


@dataclass(frozen=True)
class WorkerSettings:
    """What a Worker (`code-reviewer-worker --once`, #323) reads from its environment.

    The same job-process settings as the loop, and none of its claiming: no token, no app URL (the
    start document has the URL and the per-job credential), no slots, no polling.
    """

    job_timeout: float = DEFAULT_JOB_TIMEOUT_SECONDS
    kill_margin: float = 10.0
    terminate_grace: float = 5.0
    backoff_max: float = 60.0
    request_timeout: float = 30.0
    complete_retry_window: float = 600.0
    engines: tuple[str, ...] = (ENGINE_DIFF,)
    dynamic_command: tuple[str, ...] | None = None
    dynamic_ripgrep: str | None = None
    job_command: tuple[str, ...] = field(default_factory=default_job_command)
    diff_job_user: tuple[int, int] | None = None
    dynamic_engine_user: tuple[int, int] | None = None
    dynamic_ports: SlotPorts | None = None


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


def _dynamic_engine_user(
    environment: Mapping[str, str], diff_job_user: tuple[int, int] | None
) -> tuple[int, int] | None:
    """The engine user of a root loop; it must be nobody a Diff job runs as."""
    if diff_job_user is None:
        return None
    uid, gid = (
        _identifier(environment, ENGINE_UID_VARIABLE),
        _identifier(environment, ENGINE_GID_VARIABLE),
    )
    # One user for both would make the drop of Diff jobs and the engine's boundary meaningless.
    if uid == diff_job_user[0] or gid == diff_job_user[1]:
        raise SettingsError(
            f"{ENGINE_UID_VARIABLE} and {ENGINE_GID_VARIABLE} must differ from RUNNER_DIFF_JOB_USER"
        )
    return uid, gid


def _dynamic_ports(
    environment: Mapping[str, str], diff_job_user: tuple[int, int] | None
) -> SlotPorts | None:
    if diff_job_user is None:
        return None
    try:
        return slot_ports(environment)
    except IsolationError as error:
        raise SettingsError(error.detail) from None


def _identifier(environment: Mapping[str, str], name: str) -> int:
    raw = environment.get(name, "").strip()
    if not raw:
        return DEFAULT_ENGINE_ID
    if not raw.isascii() or not raw.isdigit() or int(raw) == 0:
        raise SettingsError(f"{name} must be a number other than 0")
    return int(raw)


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
    diff_job_user = _diff_job_user(environment)
    return LoopSettings(
        job_command=_job_command(environment),
        diff_job_user=diff_job_user,
        dynamic_engine_user=_dynamic_engine_user(environment, diff_job_user),
        dynamic_ports=_dynamic_ports(environment, diff_job_user),
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


def worker_settings_from_environment(environment: Mapping[str, str]) -> WorkerSettings:
    """The Worker's settings: `RUNNER_JOB_TIMEOUT_SECONDS`, `PR_AGENT_COMMAND` (test stacks only),
    `RUNNER_DIFF_JOB_USER` and the Dynamic slot's variables, exactly as the loop reads them."""
    diff_job_user = _diff_job_user(environment)
    return WorkerSettings(
        job_command=_job_command(environment),
        diff_job_user=diff_job_user,
        dynamic_engine_user=_dynamic_engine_user(environment, diff_job_user),
        dynamic_ports=_dynamic_ports(environment, diff_job_user),
        job_timeout=_number(
            environment,
            "RUNNER_JOB_TIMEOUT_SECONDS",
            DEFAULT_JOB_TIMEOUT_SECONDS,
            1,
            MAX_JOB_TIMEOUT_SECONDS,
        ),
    )
