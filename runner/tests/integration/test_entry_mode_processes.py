# SPDX-License-Identifier: LicenseRef-Proprietary

"""The installed console scripts of the image as real processes (#324): `code-reviewer-runner`
with each entry mode and `worker-reap`. `worker-once` runs against the fake App of
`fakes/dispatcher-app/`; nothing reaches a network or a model. The same journeys run in the built
images by `docker/smoke/runner.sh`."""

import json
import os
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest
from process_support import FAKE_JOB, reports
from worker_app import FakeAppProcess

pytestmark = pytest.mark.integration


@pytest.fixture
def app() -> Iterator[FakeAppProcess]:
    fake = FakeAppProcess().start()
    yield fake
    fake.stop()


def script(name: str) -> str:
    return str(Path(sys.executable).parent / name)


def run(
    arguments: list[str],
    directory: Path,
    stdin: str = "",
    **environment: str,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        arguments,
        input=stdin,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
        env={"PATH": os.environ["PATH"], "HOME": str(directory), **environment},
    )


def worker_environment(directory: Path) -> dict[str, str]:
    return {
        "PR_AGENT_COMMAND": f"{sys.executable} {FAKE_JOB} ok {directory}",
        "RUNNER_JOB_TIMEOUT_SECONDS": "30",
    }


def start_document(app: FakeAppProcess, job: str, credential: str) -> str:
    return json.dumps({"appUrl": app.url, "jobId": job, "credential": credential})


# #324-T04
def test_worker_once_runs_one_job_against_the_fake_app_and_exits_with_zero(
    app: FakeAppProcess, tmp_path: Path
) -> None:
    job = app.enqueue("diff")
    credential = app.claim(job)

    done = run(
        [script("code-reviewer-runner"), "worker-once"],
        tmp_path,
        start_document(app, job, credential),
        **worker_environment(tmp_path),
    )

    assert done.returncode == 0, done.stderr
    (delivered,) = app.results(job)
    assert delivered["ok"] is True
    (seen,) = reports(tmp_path)
    assert credential not in json.dumps(seen)
    assert credential not in done.stdout + done.stderr


# #324-T04: the exit code of the job is the exit code of the container.
def test_worker_once_exits_with_one_when_the_job_failed(
    app: FakeAppProcess, tmp_path: Path
) -> None:
    job = app.enqueue("diff")
    credential = app.claim(job)

    done = run(
        [script("code-reviewer-runner"), "worker-once"],
        tmp_path,
        start_document(app, job, credential),
        PR_AGENT_COMMAND=f"{sys.executable} {FAKE_JOB} fail {tmp_path}",
        RUNNER_JOB_TIMEOUT_SECONDS="30",
    )

    assert done.returncode == 1
    assert credential not in done.stdout + done.stderr


# #324-T03
def test_probe_of_a_container_without_an_engine_user_prints_pr_agent_only(tmp_path: Path) -> None:
    done = run([script("code-reviewer-runner"), "probe"], tmp_path)

    assert done.returncode == 0, done.stderr
    assert done.stdout.count("\n") == 1
    assert json.loads(done.stdout) == {
        "version": 1,
        "engines": ["pr-agent"],
        "reasons": ["not_a_dynamic_runner"],
    }


# #324-T02: a configured engine user in a container that is no root supervisor, no hardened one.
def test_probe_of_a_dynamic_configuration_that_is_not_root_reports_the_reason_and_no_value(
    tmp_path: Path,
) -> None:
    secret = "dummy-runner-token-0123456789-abcdef"
    done = run(
        [script("code-reviewer-runner"), "probe"],
        tmp_path,
        RUNNER_DIFF_JOB_USER="10001:10001",
        RUNNER_TOKEN=secret,
    )

    assert done.returncode == 0, done.stderr
    verdict = json.loads(done.stdout)
    assert verdict["engines"] == ["pr-agent"]
    assert verdict["reasons"]
    assert secret not in done.stdout + done.stderr


# #324-T08: the mode is required; a retired mode is refused like an unknown one, without echoing it.
@pytest.mark.parametrize("arguments", [[], ["legacy"], ["dispatch"]])
def test_without_a_known_mode_the_entry_point_refuses_to_start(
    tmp_path: Path, arguments: list[str]
) -> None:
    done = run([script("code-reviewer-runner"), *arguments], tmp_path, RUNNER_MODE="worker-once")

    assert done.returncode == 2
    assert "invalid arguments" in done.stderr


# #324-T10
def test_worker_reap_in_a_container_without_an_engine_user_has_nothing_to_do(
    tmp_path: Path,
) -> None:
    done = run([script("worker-reap")], tmp_path)

    assert done.returncode == 0, done.stderr
    assert done.stdout == ""
