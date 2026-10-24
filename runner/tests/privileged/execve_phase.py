# SPDX-License-Identifier: LicenseRef-Proprietary

"""Runs the execve phase of the privileged suite as the Dynamic runner is after its startup (#249).

Like `job_phase.py` (the production startup step, then pytest in the same process) but for the tests
in `tests/privileged/execve`, and started WITHOUT `no-new-privileges` by the script: those tests
judge the bounding set, which `no-new-privileges` would otherwise hide.

    execve_phase.py [pytest arguments]
"""

import sys

from job_phase import start_and_run

EXECVE_TESTS = ["-m", "privileged", "-p", "no:cacheprovider", "tests/privileged/execve"]

if __name__ == "__main__":
    sys.exit(start_and_run(EXECVE_TESTS, sys.argv[1:]))
