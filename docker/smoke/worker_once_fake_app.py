# SPDX-License-Identifier: LicenseRef-Proprietary

"""Runs `worker-once` of an image against the fake App of `fakes/dispatcher-app/` (#324).

    worker_once_fake_app.py <image> [docker run arguments...]

The fake App (Node, the same one the Dispatcher and the Worker tests use) listens on the host; the
container reaches it through the host gateway on the bridge network, never through the host's own
network namespace (a container with `NET_ADMIN` would install its nft rules there). The Worker
fetches its job, runs a stand-in for the job process (`PR_AGENT_COMMAND`, a test-stack setting; no
GitHub, no model) and delivers the result with its per-job credential. The extra arguments describe
the container (the smoke test passes the flags of the hardened container spec).

Checks, for a succeeding and a failing job: exit code 0 and 1, exactly one delivered result with
the right outcome, and the credential in neither output of the container.
"""

import json
import shlex
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "runner" / "tests" / "integration"))
from worker_app import FakeAppProcess

HOST_NAME = "host.docker.internal"
RESULT = (
    "import json, sys; sys.stdin.read(); "
    "print(json.dumps(dict(ok={ok}, durationMs=5, commentUrl={url}, errorCode={code}, "
    "logTail='smoke job', logTruncated=False, usage=None)))"
)


def job_command(ok: bool) -> str:
    code = RESULT.format(
        ok=ok,
        url="'https://github.com/octo/repo/pull/7#c1'" if ok else "None",
        code="None" if ok else "'command_failed'",
    )
    return f"python -c {shlex.quote(code)}"


def run_worker(
    image: str, docker_arguments: list[str], app: FakeAppProcess, ok: bool
) -> tuple[int, str, str, str, list[dict[str, object]]]:
    job = app.enqueue("diff")
    credential = app.claim(job)
    port = app.url.rsplit(":", 1)[1]
    document = {"appUrl": f"http://{HOST_NAME}:{port}", "jobId": job, "credential": credential}
    command = [
        "docker", "run", "--rm", "--interactive",
        "--add-host", f"{HOST_NAME}:host-gateway",
        "--env", f"PR_AGENT_COMMAND={job_command(ok)}",
        "--env", "RUNNER_JOB_TIMEOUT_SECONDS=120",
        *docker_arguments, image, "worker-once",
    ]  # fmt: skip
    done = subprocess.run(
        command,
        input=json.dumps(document),
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    return done.returncode, done.stdout, done.stderr, credential, app.results(job)


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: worker_once_fake_app.py <image> [docker run arguments...]", file=sys.stderr)
        return 2
    image, docker_arguments = argv[0], argv[1:]
    app = FakeAppProcess(host="0.0.0.0").start()
    try:
        for ok, expected_code in ((True, 0), (False, 1)):
            code, out, err, credential, results = run_worker(image, docker_arguments, app, ok)
            label = "succeeding" if ok else "failing"
            if code != expected_code:
                print(
                    f"a {label} job exited with {code}, expected {expected_code}:\n{err}",
                    file=sys.stderr,
                )
                return 1
            if len(results) != 1 or results[0].get("ok") is not ok:
                print(f"a {label} job delivered {results!r}", file=sys.stderr)
                return 1
            if credential in out + err:
                print("the per-job credential is in the output of the container", file=sys.stderr)
                return 1
            print(f"    a {label} job: exit {code}, one result delivered")
        return 0
    finally:
        app.stop()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
