# SPDX-License-Identifier: Apache-2.0

"""The channel between a real job process and the loop that holds its lease (#260).

The process asks over a descriptor the launcher hands it (named in `RUNNER_LEASE_CHECK_FD`); the
loop answers from the callback of the `ProcessSpec`. Real processes, no network.
"""

import asyncio
import json
import sys
import textwrap

from code_reviewer_runner.job_loop.process import ProcessSpec, SubprocessLauncher
from code_reviewer_runner.lease_check import LeaseState

# What the job process does: build the check the way the entry point does and print the answers.
CHILD = textwrap.dedent(
    """
    import json, os, sys
    from code_reviewer_runner.lease_check import lease_check_from_environment

    check = lease_check_from_environment(os.environ)
    assert check is not None
    answers = [check().value, check().value]
    descriptor = int(os.environ["RUNNER_LEASE_CHECK_FD"])
    print(json.dumps({"answers": answers, "inherited": os.get_inheritable(descriptor)}))
    """
)


async def run_child(spec: ProcessSpec) -> dict[str, object]:
    process = await SubprocessLauncher(terminate_grace=1.0).start(spec)
    outcome = await asyncio.wait_for(process.wait(), 30)
    assert outcome.exit_code == 0, outcome.stderr.decode()
    return json.loads(outcome.stdout.decode().splitlines()[-1])


def spec_with(check: object) -> ProcessSpec:
    return ProcessSpec(
        argv=(sys.executable, "-I", "-c", CHILD),
        env={"PYTHONPATH": ":".join(sys.path)},
        stdin=b"",
        lease_check=check,  # type: ignore[arg-type]
    )


# #260-T01
def test_a_process_is_told_what_the_loop_answers_for_each_question() -> None:
    answers = [LeaseState.HELD, LeaseState.LOST]

    async def check() -> LeaseState:
        return answers.pop(0)

    reply = asyncio.run(run_child(spec_with(check)))

    assert reply["answers"] == ["held", "lost"]
    # The descriptor is the process's own: a program it starts does not inherit it.
    assert reply["inherited"] is False


# #260-T01
def test_a_check_that_breaks_is_unconfirmed_never_held() -> None:
    async def check() -> LeaseState:
        raise RuntimeError("boom")

    reply = asyncio.run(run_child(spec_with(check)))

    assert reply["answers"] == ["unconfirmed", "unconfirmed"]


def test_a_process_without_a_check_has_no_channel() -> None:
    process_spec = ProcessSpec(
        argv=(
            sys.executable,
            "-I",
            "-c",
            "import os; print('RUNNER_LEASE_CHECK_FD' in os.environ)",
        ),
        env={},
        stdin=b"",
    )

    async def go() -> str:
        process = await SubprocessLauncher(terminate_grace=1.0).start(process_spec)
        return (await process.wait()).stdout.decode().strip()

    assert asyncio.run(go()) == "False"
