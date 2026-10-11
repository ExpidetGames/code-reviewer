"""The real job entry point of the runner, with the address of a fake LLM added to the job.

The app hands a runner a job without `llm.baseUrl` (the app has no setting for it: the model is
always reached at its provider), so a test stack that wants the real PR-Agent to talk to a fake LLM
cannot get the address through the job. This wrapper is set as `PR_AGENT_COMMAND` of the runner. It
reads the job from stdin like the entry point, adds `llm.baseUrl` and hands the job on to the real
entry point (`python -m code_reviewer_runner.runner`), whose strict validation still decides about
it: it accepts the address only for loopback, and every other check of the job (the host of
`prUrl` against `git.baseUrl`, the token, the model) stays untouched.

    python run_job_against_fake_llm.py http://127.0.0.1:<port>/api/v1

The credentials stay on stdin: the address is the only argument and no secret. Test stacks only;
never set `PR_AGENT_COMMAND` on a real runner. Run it with the Python of the runner's environment.
"""

import json
import subprocess
import sys
from typing import Any


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        sys.stderr.write("usage: run_job_against_fake_llm.py <llm base url>\n")
        return 2
    raw = sys.stdin.read()
    try:
        job: Any = json.loads(raw)
        job["llm"]["baseUrl"] = argv[1]
        text = json.dumps(job)
    except (ValueError, KeyError, TypeError):
        # Not a job this wrapper can extend: let the real entry point report it, as it would.
        text = raw
    done = subprocess.run(
        [sys.executable, "-m", "code_reviewer_runner.runner"],
        input=text,
        text=True,
        check=False,
    )
    return done.returncode


if __name__ == "__main__":
    sys.exit(main(sys.argv))
