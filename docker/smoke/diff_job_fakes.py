# SPDX-License-Identifier: LicenseRef-Proprietary

"""Runs one Diff job through the real PR-Agent of an image, against the engine suite's fakes (#249).

    diff_job_fakes.py <image> [docker run arguments...]

The fake GitHub and the fake LLM of `runner/tests/engine` (Python standard library only) listen on
the loopback of the host; the container shares the host's network namespace, so the job reaches them
and nothing else. The job is the real `code-reviewer-run-job` as the Diff job user 10001, with the
home and working directory the Worker gives it, in the container the extra arguments describe
(the smoke test passes the read-only root filesystem and the three tmpfs of the hardened container spec).
A write to a path the layout does not allow fails the job with `Read-only file system` and fails
this script, instead of the first real Diff job on a Dynamic runner. Today the job writes nothing at
all (it also passes without any tmpfs, checked with temporary mutations in CI and locally with an
unwritable HOME, TMPDIR and working directory), so this is a guard for the day a dependency starts
to write, not proof of a path the tmpfs provide.
"""

import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "runner" / "tests" / "engine"))
import canned
from fake_github import BOT_LOGIN, FakeGithub
from fake_llm import FakeLlm
from harness import API_KEY, MODEL

NO_WRITE = "Read-only file system"


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: diff_job_fakes.py <image> [docker run arguments...]", file=sys.stderr)
        return 2
    image, docker_arguments = argv[0], argv[1:]
    github = FakeGithub()
    llm = FakeLlm(replies={"review": canned.review()})
    github.start()
    llm.start()
    try:
        job = {
            "prUrl": github.pr_url,
            "command": "review",
            "git": {
                "provider": "github",
                "baseUrl": github.base_url,
                "token": github.token,
                "botLogin": BOT_LOGIN,
            },
            "llm": {
                "provider": "openrouter",
                "model": MODEL,
                "apiKey": API_KEY,
                "baseUrl": llm.base_url,
                "maxTokens": 32000,
            },
        }
        done = subprocess.run(
            [
                "docker", "run", "--rm", "-i", "--network", "host",
                "--user", "10001:10001", "--workdir", "/tmp",
                "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                "--env", "HOME=/home/runner",
                *docker_arguments,
                "--entrypoint", "code-reviewer-run-job", image,
            ],
            input=json.dumps(job),
            capture_output=True,
            text=True,
            timeout=300,
            check=False,
        )  # fmt: skip
        problems: list[str] = []
        if NO_WRITE in done.stdout + done.stderr:
            problems.append("the job tried to write where the layout does not allow it")
        try:
            result = json.loads(done.stdout.strip().splitlines()[-1])
        except (IndexError, ValueError):
            result = {}
            problems.append("the job did not print a result line")
        if done.returncode != 0 or result.get("ok") is not True:
            problems.append(f"the job failed ({done.returncode}): {result.get('errorCode')}")
        if len(github.comments) != 1 or github.comments[0].login != BOT_LOGIN:
            problems.append("the review was not posted to the fake GitHub as the bot")
        if problems:
            print("\n".join(problems), file=sys.stderr)
            print(done.stdout[-2000:], file=sys.stderr)
            print(done.stderr[-4000:], file=sys.stderr)
            return 1
        print(f"    review posted as {BOT_LOGIN} by the real PR-Agent")
        return 0
    finally:
        llm.stop()
        github.stop()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
