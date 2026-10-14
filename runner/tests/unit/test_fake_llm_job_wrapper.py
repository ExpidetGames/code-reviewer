# SPDX-License-Identifier: Apache-2.0

"""The test-stack wrapper of the job entry point hands the lease descriptor on (#260).

The privileged e2e lane runs the real entry point through `run_job_against_fake_llm.py`. A wrapper
that lets `subprocess` close the descriptor named in `RUNNER_LEASE_CHECK_FD` makes every Dynamic
run end with `lease_lost` (the entry point fails closed), so the wrapper must keep it open.
"""

import os
import socket
import subprocess
import sys
from pathlib import Path

WRAPPER = Path(__file__).parents[3] / "fakes" / "pr-agent" / "run_job_against_fake_llm.py"

# A stand-in for `code_reviewer_runner.runner` that answers on the descriptor it was handed.
STAND_IN = """
import os, socket
channel = socket.socket(fileno=int(os.environ["RUNNER_LEASE_CHECK_FD"]))
channel.sendall(b"alive\\n")
"""


# #260-T03
def test_the_wrapper_keeps_the_lease_descriptor_open_for_the_real_entry_point(
    tmp_path: Path,
) -> None:
    package = tmp_path / "code_reviewer_runner"
    package.mkdir()
    (package / "__init__.py").write_text("")
    (package / "runner.py").write_text(STAND_IN)
    process_end, loop_end = socket.socketpair()
    with process_end, loop_end:
        os.set_inheritable(process_end.fileno(), True)
        done = subprocess.run(
            [sys.executable, str(WRAPPER), "http://127.0.0.1:1/api/v1"],
            input="{}",
            text=True,
            env={
                "PATH": os.environ.get("PATH", ""),
                "PYTHONPATH": str(tmp_path),
                "RUNNER_LEASE_CHECK_FD": str(process_end.fileno()),
            },
            pass_fds=(process_end.fileno(),),
            capture_output=True,
            check=False,
        )
        loop_end.settimeout(5)
        assert done.returncode == 0, done.stderr
        assert loop_end.recv(16) == b"alive\n"
