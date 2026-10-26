# SPDX-License-Identifier: LicenseRef-Proprietary

"""Runs the job phase of the privileged suite as the Dynamic runner is after its startup (#244).

The script starts this as root with the capabilities the container is created with. It does what
the entry point does before its event loop (`prepare_dynamic_runtime`: the engine user's static nft
rules, then `NET_ADMIN` and `SETPCAP` dropped from every set and from the bounding set), and only
then runs pytest in the same process. Every test of the job phase therefore runs as a job process
would see the container: no way to read or change the rules, which are nevertheless in place.

    job_phase.py [pytest arguments]

With `CR_PRIVILEGED_EGRESS_MODE=fallback` (the second pass of `privileged_phases.sh`, #345) the
startup step is told through its `detect` seam that the kernel has no `inet` table or no `reject`,
installs the `ip`-family rules and switches IPv6 off, and the pass runs the files that depend on the
ruleset (`FALLBACK_TESTS`). That variable is read here, in the harness, and nowhere in the runner.
"""

import sys
from typing import Any

import pytest
from privileged_support import EGRESS_MODE, RUNNER_ENVIRONMENT

from code_reviewer_runner.dynamic_review.netguard import EgressMode
from code_reviewer_runner.dynamic_review.static_isolation import EgressSetup, secure_startup
from code_reviewer_runner.job_loop import service
from code_reviewer_runner.job_loop.settings import worker_settings_from_environment

PYTEST_ARGUMENTS = [
    "-m",
    "privileged",
    "-p",
    "no:cacheprovider",
    "tests/privileged",
    "--ignore=tests/privileged/startup",
    "--ignore=tests/privileged/execve",
]
# What depends on the ruleset: the rules as the job phase sees them, the self-check, the launch and
# the kill of a job's leftovers (all of which confine the engine user), and the fallback's own
# tests.
FALLBACK_TESTS = [
    "-m",
    "privileged",
    "-p",
    "no:cacheprovider",
    "tests/privileged/test_static_rules.py",
    "tests/privileged/test_self_check.py",
    "tests/privileged/test_engine_launch.py",
    "tests/privileged/test_job_termination.py",
    "tests/privileged/test_fallback_egress.py",
]


def startup_step() -> Any:
    """The production step; in the fallback pass the kernel's answer is forced through the seam."""
    if EGRESS_MODE is EgressMode.FULL:
        return secure_startup

    def forced(uid: int, ports: Any) -> EgressSetup:
        return secure_startup(uid, ports, detect=lambda: EgressMode.FALLBACK)

    return forced


def start_and_run(pytest_arguments: list[str], argv: list[str]) -> int:
    """The production startup step, then pytest in the same process."""
    setup = service.prepare_dynamic_runtime(
        worker_settings_from_environment(RUNNER_ENVIRONMENT), startup=startup_step()
    )
    if not setup.rules_installed:
        print("the static network rules could not be installed", file=sys.stderr)
        return 1
    # The full pass proves the real detection: a complete kernel gets the full ruleset.
    if setup.mode is not EGRESS_MODE:
        print(f"the startup step chose {setup.mode.value}, this pass is {EGRESS_MODE.value}")
        return 1
    return int(pytest.main([*pytest_arguments, *argv]))


def main(argv: list[str]) -> int:
    fallback = EGRESS_MODE is EgressMode.FALLBACK
    return start_and_run(FALLBACK_TESTS if fallback else PYTEST_ARGUMENTS, argv)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
