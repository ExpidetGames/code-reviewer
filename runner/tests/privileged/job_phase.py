# SPDX-License-Identifier: Apache-2.0

"""Runs the job phase of the privileged suite as the Dynamic runner is after its startup (#244).

The script starts this as root with the capabilities the container is created with. It does what
the entry point does before its event loop (`prepare_dynamic_runtime`: the engine user's static nft
rules, then `NET_ADMIN` and `SETPCAP` dropped from every set and from the bounding set), and only
then runs pytest in the same process. Every test of the job phase therefore runs as a job process
would see the container: no way to read or change the rules, which are nevertheless in place.

    job_phase.py [pytest arguments]
"""

import sys

import pytest
from privileged_support import RUNNER_ENVIRONMENT

from code_reviewer_runner.job_loop import service
from code_reviewer_runner.job_loop.settings import settings_from_environment

PYTEST_ARGUMENTS = [
    "-m",
    "privileged",
    "-p",
    "no:cacheprovider",
    "tests/privileged",
    "--ignore=tests/privileged/startup",
]


def main(argv: list[str]) -> int:
    if not service.prepare_dynamic_runtime(settings_from_environment(RUNNER_ENVIRONMENT)):
        print("the static network rules could not be installed", file=sys.stderr)
        return 1
    return int(pytest.main([*PYTEST_ARGUMENTS, *argv]))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
