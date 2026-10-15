# SPDX-License-Identifier: Apache-2.0

"""`worker-reap` (#324): ends what the engine user still runs. For the launchers of the image.

The Worker host sweeps the engine user after a Dynamic job process (`JobHost._after_process`). A
launcher that kills a Worker from outside (the deadline of the Dispatcher, the end of a Sandbox
job) cannot rely on the Worker for it: a SIGKILLed Worker cleans up nothing, and a helper may have
left the process group with `setsid()`. The launcher ends the Worker's group itself, while it still
holds the group's leader (`process_group.py`: never signal a group id that is no longer yours), and
then runs this: a `kill(-1, SIGKILL)` made as the engine user, so the kernel signals exactly that
user's processes and nothing else.

It takes no argument that names a process or a group, and signals no group itself: a pid or group
id is exactly what may belong to somebody else by the time a second process uses it.

| Exit | Meaning                                                              |
|------|----------------------------------------------------------------------|
| 0    | Nothing of the engine user runs any more (or this container has none). |
| 1    | A process of the engine user survived the sweep.                       |
| 2    | The sweep could not be made (not root, unusable settings).            |
"""

import argparse
import logging
import os
import sys
from collections.abc import Callable, Mapping, Sequence
from typing import NoReturn

from code_reviewer_runner import __version__
from code_reviewer_runner.dynamic_review.engine_user import sweep_user
from code_reviewer_runner.dynamic_review.self_check import SelfCheckReason
from code_reviewer_runner.job_loop.service import LOGGER_NAME, configure_logging
from code_reviewer_runner.job_loop.settings import SettingsError, worker_settings_from_environment

PROGRAM_NAME = "worker-reap"
REAPED = 0
SURVIVORS = 1
SETUP_ERROR = 2


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        self.print_usage(sys.stderr)
        sys.stderr.write(f"{PROGRAM_NAME}: invalid arguments (it takes none)\n")
        raise SystemExit(SETUP_ERROR)


def build_parser() -> argparse.ArgumentParser:
    parser = _Parser(
        prog=PROGRAM_NAME,
        description="Ends every process of the engine user. Takes no target; the engine user is "
        "the one the runner is configured with (RUNNER_DIFF_JOB_USER and the engine uid and gid "
        "variables).",
    )
    parser.add_argument("--version", action="version", version=f"{PROGRAM_NAME} {__version__}")
    return parser


def run(
    environment: Mapping[str, str],
    *,
    sweeper: Callable[[int, int], bool] = sweep_user,
    euid: Callable[[], int] = os.geteuid,
) -> int:
    """Sweep the engine user of this container; returns the exit code."""
    configure_logging()
    log = logging.getLogger(LOGGER_NAME)
    try:
        settings = worker_settings_from_environment(environment)
    except SettingsError as error:
        log.error("worker-reap cannot run: %s", error)
        return SETUP_ERROR
    user = settings.dynamic_engine_user
    if user is None:
        return REAPED  # a Diff-only container has no engine user and nothing to end
    if euid() != 0:
        log.error(
            "worker-reap cannot run: %s: only the root supervisor may become the engine user",
            SelfCheckReason.NOT_ROOT_SUPERVISOR.value,
        )
        return SETUP_ERROR
    if sweeper(*user):
        return REAPED
    log.warning("a process of the engine user survived the sweep")
    return SURVIVORS


def main(argv: Sequence[str] | None = None, *, environment: Mapping[str, str] | None = None) -> int:
    try:
        build_parser().parse_args(argv)
    except SystemExit as exit_request:
        return exit_request.code if isinstance(exit_request.code, int) else 1
    return run(dict(os.environ if environment is None else environment))


if __name__ == "__main__":
    sys.exit(main())
