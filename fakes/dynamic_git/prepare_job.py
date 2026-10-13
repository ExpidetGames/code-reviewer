# SPDX-License-Identifier: Apache-2.0
"""A trusted-preparation stand-in for job-loop process-group and directory cleanup tests."""

import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1])
from code_reviewer_runner.dynamic_review.checkout import prepare_content
from code_reviewer_runner.dynamic_review.transport import HttpTransport
from code_reviewer_runner.job import ClaimBase
from code_reviewer_runner.redaction import Redactor


def main() -> None:
    data = json.loads(sys.stdin.read())
    helper = subprocess.Popen(
        [sys.executable, "-I", "-c", "import signal; signal.pause()"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    print(
        json.dumps({"directory": str(Path.cwd()), "helper": helper.pid, "leader": os.getpid()}),
        flush=True,
    )
    base = ClaimBase("owner/base", "main", data["head"], None, "full")
    prepare_content(
        base,
        196,
        HttpTransport(data["url"], data["token"]),
        Path.cwd() / "prepared",
        Redactor((data["token"],)),
    )
    import signal

    signal.pause()


if __name__ == "__main__":
    main()
