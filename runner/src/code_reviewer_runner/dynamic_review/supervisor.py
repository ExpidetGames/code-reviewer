# SPDX-License-Identifier: Apache-2.0
"""The production preparation of one Dynamic job: the root supervisor's side of the boundary (#197).

The job process runs as root in the Dynamic runner container (`compose.dynamic.yml`). For one job it

1. prepares the sanitised, read-only export out of Git objects and seals it for the dedicated
   engine user (`export_isolation.prepared_checkout`, #196), which also takes the exclusive lease
   on that user and its group, and proves with an access probe run as that user that the export
   cannot be written and the private state cannot be read;
2. hands the adapter an `EngineLaunch`: everything it needs to start the engine as that user, with
   the user's own HOME and temporary directories, a config file only that user can read, and the
   user's network rules.

The lifetime stays open until the engine and everything of that user is gone; leaving it removes
the job directory, the leases and the user's files. Nothing here runs without root: a process that
is not the supervisor is refused with `dynamic_isolation_self_check_failed`, never run unconfined.
"""

import os
from collections.abc import Callable, Generator, Mapping
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass
from pathlib import Path

from code_reviewer_runner.job import Job
from code_reviewer_runner.result import ErrorCode

from .checkout import PreparedContent, prepare_job_content
from .engine_user import EngineLaunch, sweep_user
from .export_isolation import AgentIdentity, prepared_checkout
from .limits import CheckoutError
from .netguard import IsolationError
from .static_isolation import slot_ports

ENGINE_UID_VARIABLE = "RUNNER_DYNAMIC_ENGINE_UID"
ENGINE_GID_VARIABLE = "RUNNER_DYNAMIC_ENGINE_GID"
# The dedicated user the runner image creates (#202); numeric and fixed like the runner's own.
DEFAULT_ENGINE_ID = 10101
# The directory of the per-job roots, inside the job process's own working directory (which the
# job loop removes even when this process is killed).
PARENT_NAME = "dynamic"


@dataclass(frozen=True)
class Prepared:
    """One prepared job: the export and, under the supervisor, the way to launch the engine."""

    content: PreparedContent
    launch: EngineLaunch | None = None


# Prepares one claimed job and keeps it for the lifetime of the `with` block.
ContentPreparer = Callable[[Job], AbstractContextManager[Prepared | PreparedContent]]


def _identifier(environment: Mapping[str, str], name: str) -> int:
    raw = environment.get(name, "").strip()
    if not raw:
        return DEFAULT_ENGINE_ID
    if not raw.isascii() or not raw.isdigit() or int(raw) <= 0:
        raise CheckoutError(ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED)
    return int(raw)


def engine_identity(environment: Mapping[str, str]) -> AgentIdentity:
    """The dedicated engine user from trusted runner configuration. Never root, never the runner."""
    uid = _identifier(environment, ENGINE_UID_VARIABLE)
    gid = _identifier(environment, ENGINE_GID_VARIABLE)
    # The job process is not the engine user, and the engine user is not the runner's own.
    if uid in (0, os.getuid(), os.geteuid()) or gid in (0, os.getgid(), os.getegid()):
        raise CheckoutError(ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED)
    return AgentIdentity(uid, gid)


def _sweep_first(identity: AgentIdentity) -> Callable[[], None]:
    """The first thing a job does with the leased user: end what an earlier job left running.

    A job process that was killed outright (SIGKILL, an OOM kill) leaves its engine behind, and
    the lease is free again the moment that process is gone. Nothing of this job exists yet when
    this runs, so the survivor cannot read the export, the config or the capability. If it cannot
    be ended the job does not start.
    """

    def sweep() -> None:
        if not sweep_user(identity.uid, identity.gid):
            raise CheckoutError(ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED)

    return sweep


def production_preparer(
    environment: Mapping[str, str],
    *,
    cancelled: Callable[[], bool] = lambda: False,
    content_for: Callable[..., PreparedContent] = prepare_job_content,
) -> ContentPreparer:
    """The preparer `run_dynamic_job` uses when none is injected.

    `content_for` is the trusted preparation of the Git content (#196); the tests of the
    privileged suite replace it with one that reads local Git objects instead of GitHub.
    """

    @contextmanager
    def prepare(job: Job) -> Generator[Prepared]:
        identity = engine_identity(environment)
        try:
            ports = slot_ports(environment)
        except IsolationError:
            raise CheckoutError(ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED) from None
        parent = Path.cwd().resolve() / PARENT_NAME
        with prepared_checkout(
            job,
            parent,
            identity,
            cancelled=cancelled,
            content_for=content_for,
            on_lease=_sweep_first(identity),
        ) as (content, lifetime):
            yield Prepared(
                content,
                EngineLaunch(
                    uid=identity.uid,
                    gid=identity.gid,
                    home=lifetime.environment["HOME"],
                    tmpdir=lifetime.environment["TMPDIR"],
                    config_dir=lifetime.root,
                    proxy_port=ports.proxy,
                    engine_port=ports.engine,
                ),
            )

    return prepare
