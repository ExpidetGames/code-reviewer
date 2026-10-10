"""Command line entry point of the runner."""

import argparse
from collections.abc import Sequence

from code_reviewer_runner import __version__

PROGRAM_NAME = "code-reviewer-runner"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=PROGRAM_NAME,
        description="Picks up review jobs from the Code Reviewer app and runs PR-Agent.",
    )
    parser.add_argument("--version", action="version", version=f"{PROGRAM_NAME} {__version__}")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the command line interface and return the process exit code."""
    parser = build_parser()
    try:
        parser.parse_args(argv)
    except SystemExit as exit_request:
        # argparse exits for --version (code 0) and for usage errors (code 2).
        return exit_request.code if isinstance(exit_request.code, int) else 1
    return 0
