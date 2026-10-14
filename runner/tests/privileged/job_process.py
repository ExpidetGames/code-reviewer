# SPDX-License-Identifier: Apache-2.0

"""One Dynamic job in a process of its own, the way the entry point runs it (#197).

The privileged suite starts this as root (the supervisor) inside a job working directory, so that
SIGTERM, which is how the job loop ends a job on lease loss, shutdown and timeout, reaches a real
job process with a real engine user, real network rules and a real helper. The preparation is the
production one over a local Git repository; the engine is the stand-in of `stub_engine.py`.

    job_process.py REPOSITORY_PATH HEAD_SHA TOOLS_DIRECTORY
"""

import sys
import time
from pathlib import Path

from privileged_support import (
    CAPABILITIES,
    ENGINE_GID,
    ENGINE_UID,
    Repo,
    dynamic_job,
    python3,
    ripgrep,
)

from code_reviewer_runner import runner
from code_reviewer_runner.capabilities import ALL_ENGINES
from code_reviewer_runner.dynamic_review.supervisor import (
    ENGINE_GID_VARIABLE,
    ENGINE_UID_VARIABLE,
    production_preparer,
)


def main(argv: list[str]) -> int:
    repository, head, tools = argv
    repo = Repo.existing(Path(repository), head)
    environment = {
        runner.OPENCODE_COMMAND_VARIABLE: f"{python3()} {tools}/stub_engine.py --escape-helper",
        runner.DYNAMIC_CAPABILITIES_VARIABLE: CAPABILITIES,
        runner.RIPGREP_PATH_VARIABLE: ripgrep(),
        ENGINE_UID_VARIABLE: str(ENGINE_UID),
        ENGINE_GID_VARIABLE: str(ENGINE_GID),
    }
    with runner._unwind_on_sigterm():  # pyright: ignore[reportPrivateUsage]
        result = runner.run_dynamic_job(
            dynamic_job(head),
            None,
            time.monotonic(),
            environment,
            120.0,
            engines=ALL_ENGINES,
            prepare=production_preparer(environment, content_for=repo.content_for),
        )
    print(result.to_line())
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
