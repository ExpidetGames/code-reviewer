# SPDX-License-Identifier: Apache-2.0

"""Command line entry point of the runner image: `code-reviewer-runner [mode]`.

One entry point, four modes (#316, #324), all with the same hardened startup (network rules,
end of `NET_ADMIN`, self-check; `job_loop/service.py`):

| Mode          | What it does                                                                  |
|---------------|-------------------------------------------------------------------------------|
| `legacy`      | The job loop that claims and runs jobs itself. The default.                   |
| `dispatch`    | The Dispatcher. This image carries none yet (#334): refuses with a stable code. |
| `worker-once` | One Worker: `{appUrl, jobId, credential}` on stdin, one job, exit code.       |
| `probe`       | Runs the startup, prints a JSON verdict (engines, stable reasons) and exits.  |

The mode is the argument; without one it is `RUNNER_MODE`; without that it is `legacy`, so an
installation that sets nothing starts the loop as it always did.
"""

import argparse
import logging
import os
import sys
from collections.abc import Mapping, Sequence
from typing import NoReturn, TextIO

from code_reviewer_runner import __version__
from code_reviewer_runner.job_loop.service import (
    LOGGER_NAME,
    configure_logging,
    run_from_environment,
)
from code_reviewer_runner.probe import run_probe
from code_reviewer_runner.worker_cli import run_once as run_worker_once

PROGRAM_NAME = "code-reviewer-runner"
MODE_VARIABLE = "RUNNER_MODE"
MODE_LEGACY = "legacy"
MODE_DISPATCH = "dispatch"
MODE_WORKER_ONCE = "worker-once"
MODE_PROBE = "probe"
MODES = (MODE_LEGACY, MODE_DISPATCH, MODE_WORKER_ONCE, MODE_PROBE)
DISPATCHER_BUNDLE_MISSING = "dispatcher_bundle_missing"


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        # The text of a usage error echoes the offending argument, which may be a secret that was
        # put in the wrong place. Say what is wrong, not what was typed.
        self.print_usage(sys.stderr)
        sys.stderr.write(f"{PROGRAM_NAME}: invalid arguments (one of: {', '.join(MODES)})\n")
        raise SystemExit(2)


def build_parser() -> argparse.ArgumentParser:
    parser = _Parser(
        prog=PROGRAM_NAME,
        description="Picks up review jobs from the Code Reviewer app and runs PR-Agent. "
        f"The mode is the argument or {MODE_VARIABLE}; the default is {MODE_LEGACY} (the job loop, "
        "configured by environment variables, see runner/README.md): RUNNER_API_URL, "
        "RUNNER_TOKEN, RUNNER_CONCURRENCY, RUNNER_POLL_INTERVAL_SECONDS, "
        "RUNNER_JOB_TIMEOUT_SECONDS, RUNNER_SHUTDOWN_GRACE_SECONDS, RUNNER_ID.",
    )
    parser.add_argument("--version", action="version", version=f"{PROGRAM_NAME} {__version__}")
    parser.add_argument(
        "mode",
        nargs="?",
        choices=MODES,
        help=f"{', '.join(MODES)} (default: ${MODE_VARIABLE}, else {MODE_LEGACY})",
    )
    return parser


def run_dispatcher(environment: Mapping[str, str]) -> int:
    """The Dispatcher bundle is added to the self-hosted targets by #334; this image has none."""
    configure_logging()
    logging.getLogger(LOGGER_NAME).error(
        "cannot start: %s: this image carries no Dispatcher bundle", DISPATCHER_BUNDLE_MISSING
    )
    return 2


def main(
    argv: Sequence[str] | None = None,
    *,
    environment: Mapping[str, str] | None = None,
    stdin: TextIO | None = None,
) -> int:
    """Run the command line interface and return the process exit code."""
    parser = build_parser()
    try:
        arguments = parser.parse_args(argv)
    except SystemExit as exit_request:
        # argparse exits for --version (code 0) and for usage errors (code 2).
        return exit_request.code if isinstance(exit_request.code, int) else 1
    env = dict(os.environ if environment is None else environment)
    mode = arguments.mode or env.get(MODE_VARIABLE, "").strip() or MODE_LEGACY
    if mode not in MODES:
        # Names the variable, never its value.
        sys.stderr.write(f"{PROGRAM_NAME}: {MODE_VARIABLE} must be one of: {', '.join(MODES)}\n")
        return 2
    if mode == MODE_WORKER_ONCE:
        return run_worker_once(env, stdin=stdin)
    if mode == MODE_PROBE:
        return run_probe(env)
    if mode == MODE_DISPATCH:
        return run_dispatcher(env)
    return run_from_environment(env)
