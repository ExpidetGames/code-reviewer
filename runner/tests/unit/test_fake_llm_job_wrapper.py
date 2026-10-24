# SPDX-License-Identifier: LicenseRef-Proprietary

"""The test-stack wrapper of the job entry point hands the lease descriptor on (#260).

The privileged e2e lane runs the real entry point through `run_job_against_fake_llm.py`. A wrapper
that lets `subprocess` close the descriptor named in `RUNNER_LEASE_CHECK_FD` makes every Dynamic
run end with `lease_lost` (the entry point fails closed), so the wrapper must keep it open.
"""

import json
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


# A stand-in for `code_reviewer_runner.runner` that writes the job it was handed next to itself.
JOB_ECHO = """
import sys
from pathlib import Path
Path(__file__).with_name("job.json").write_text(sys.stdin.read())
"""


# #270-T07
def test_the_wrapper_adds_the_address_of_the_fake_and_asks_for_required_parameters(
    tmp_path: Path,
) -> None:
    package = tmp_path / "code_reviewer_runner"
    package.mkdir()
    (package / "__init__.py").write_text("")
    (package / "runner.py").write_text(JOB_ECHO)
    job = {"llm": {"provider": "openrouter", "model": "a/b", "apiKey": "dummy"}}

    done = subprocess.run(
        [sys.executable, str(WRAPPER), "http://127.0.0.1:1/api/v1"],
        input=json.dumps(job),
        text=True,
        env={"PATH": os.environ.get("PATH", ""), "PYTHONPATH": str(tmp_path)},
        capture_output=True,
        check=False,
    )

    assert done.returncode == 0, done.stderr
    handed_on = json.loads((package / "job.json").read_text())
    assert handed_on["llm"]["baseUrl"] == "http://127.0.0.1:1/api/v1"
    assert handed_on["llm"]["requireParameters"] is True


GUARD = Path(__file__).parents[1] / "engine" / "connect_guard"

# A stand-in that reaches for an address that is not loopback (the guard refuses at the name
# lookup, before any packet) and reports how that ended.
FOREIGN_CONNECTION = """
import socket
from pathlib import Path
try:
    socket.create_connection(("192.0.2.1", 9), timeout=1)
    outcome = "connected"
except OSError as error:
    outcome = f"refused: {error}"
Path(__file__).with_name("outcome.txt").write_text(outcome)
"""


# #332-T10
def test_the_wrapper_puts_the_job_process_behind_the_connect_guard_when_it_is_given_one(
    tmp_path: Path,
) -> None:
    package = tmp_path / "code_reviewer_runner"
    package.mkdir()
    (package / "__init__.py").write_text("")
    (package / "runner.py").write_text(FOREIGN_CONNECTION)
    log = tmp_path / "connections.jsonl"

    done = subprocess.run(
        [sys.executable, str(WRAPPER), "http://127.0.0.1:1/api/v1", str(GUARD), str(log)],
        input="{}",
        text=True,
        env={"PATH": os.environ.get("PATH", ""), "PYTHONPATH": str(tmp_path)},
        capture_output=True,
        check=False,
    )

    assert done.returncode == 0, done.stderr
    assert (package / "outcome.txt").read_text().startswith("refused")
    recorded = [json.loads(line) for line in log.read_text().splitlines()]
    assert recorded == [{"kind": "resolve", "target": "192.0.2.1:9", "allowed": False}]


# #332-T10
def test_the_wrapper_adds_no_guard_unless_it_is_given_both_arguments(tmp_path: Path) -> None:
    done = subprocess.run(
        [sys.executable, str(WRAPPER), "http://127.0.0.1:1/api/v1", str(GUARD)],
        input="{}",
        text=True,
        env={"PATH": os.environ.get("PATH", "")},
        capture_output=True,
        check=False,
    )

    assert done.returncode == 2
    assert "usage" in done.stderr
