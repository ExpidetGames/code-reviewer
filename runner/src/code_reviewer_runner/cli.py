"""Command line entry point of the runner: without arguments it runs the job loop."""

import argparse
from collections.abc import Mapping, Sequence

from code_reviewer_runner import __version__
from code_reviewer_runner.job_loop.service import run_from_environment

PROGRAM_NAME = "code-reviewer-runner"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=PROGRAM_NAME,
        description="Picks up review jobs from the Code Reviewer app and runs PR-Agent. "
        "Configured by environment variables (see runner/README.md): RUNNER_API_URL, "
        "RUNNER_TOKEN, RUNNER_CONCURRENCY, RUNNER_POLL_INTERVAL_SECONDS, "
        "RUNNER_JOB_TIMEOUT_SECONDS, RUNNER_SHUTDOWN_GRACE_SECONDS, RUNNER_ID.",
    )
    parser.add_argument("--version", action="version", version=f"{PROGRAM_NAME} {__version__}")
    return parser


def main(argv: Sequence[str] | None = None, *, environment: Mapping[str, str] | None = None) -> int:
    """Run the command line interface and return the process exit code."""
    parser = build_parser()
    try:
        parser.parse_args(argv)
    except SystemExit as exit_request:
        # argparse exits for --version (code 0) and for usage errors (code 2).
        return exit_request.code if isinstance(exit_request.code, int) else 1
    return run_from_environment(environment)
