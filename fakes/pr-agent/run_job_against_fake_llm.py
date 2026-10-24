# SPDX-License-Identifier: LicenseRef-Proprietary

"""The real job entry point of the runner, with the address of a fake LLM added to the job.

The app hands a runner a job without `llm.baseUrl` (the app has no setting for it: the model is
always reached at its provider), so a test stack that wants the real PR-Agent to talk to a fake LLM
cannot get the address through the job. This wrapper is set as `PR_AGENT_COMMAND` of the runner. It
reads the job from stdin like the entry point, adds `llm.baseUrl` and hands the job on to the real
entry point (`python -m code_reviewer_runner.runner`), whose strict validation still decides about
it: it accepts the address (and `llm.requireParameters`, which makes the runner send
OpenRouter's `provider.require_parameters` to the fake as it does to OpenRouter) only for loopback,
and every other check of the job (the host of
`prUrl` against `git.baseUrl`, the token, the model) stays untouched.

    python run_job_against_fake_llm.py http://127.0.0.1:<port>/api/v1 \
        [<connect guard directory> <connection log>]

With the two optional arguments the job process runs behind the runner's Python connect guard
(`runner/tests/engine/connect_guard/`): it records every connection, datagram and name lookup it
starts through Python's `socket` module in the log (one JSON line each) and refuses everything that
is not loopback. The hosted lane (#332) uses it, so that a journey can show that the job never left
the machine. Neither is a secret.

The credentials stay on stdin: the address is the only argument and no secret. Test stacks only;
never set `PR_AGENT_COMMAND` on a real runner. Run it with the Python of the runner's environment.
"""

import json
import os
import subprocess
import sys
from typing import Any


def main(argv: list[str]) -> int:
    if len(argv) not in (2, 4):
        sys.stderr.write(
            "usage: run_job_against_fake_llm.py <llm base url> "
            "[<connect guard directory> <connection log>]\n"
        )
        return 2
    raw = sys.stdin.read()
    try:
        job: Any = json.loads(raw)
        job["llm"]["baseUrl"] = argv[1]
        # The fake stands in for OpenRouter, so it asks for what OpenRouter always gets (#270).
        job["llm"]["requireParameters"] = True
        text = json.dumps(job)
    except (ValueError, KeyError, TypeError):
        # Not a job this wrapper can extend: let the real entry point report it, as it would.
        text = raw
    # The job loop hands a Dynamic job one descriptor to ask whether the job is still its own
    # (#260); `subprocess` would close it, and the entry point then never allows the write.
    lease_check = os.environ.get("RUNNER_LEASE_CHECK_FD", "")
    environment = dict(os.environ)
    if len(argv) == 4:
        environment["PYTHONPATH"] = os.pathsep.join(
            [argv[2], *([environment["PYTHONPATH"]] if environment.get("PYTHONPATH") else [])]
        )
        environment["ENGINE_CONNECT_LOG"] = argv[3]
    done = subprocess.run(
        [sys.executable, "-m", "code_reviewer_runner.runner"],
        env=environment,
        input=text,
        text=True,
        pass_fds=(int(lease_check),) if lease_check.isdecimal() else (),
        check=False,
    )
    return done.returncode


if __name__ == "__main__":
    sys.exit(main(sys.argv))
