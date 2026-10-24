# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down the service of the job loop as a real process: it takes jobs from the app, and a real
SIGTERM stops it in an orderly way."""

import json
import os
import signal
import subprocess
import sys
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
from fake_app import RUNNER_TOKEN, FakeApp, Scripted, claim_response
from process_support import FAKE_JOB, gone, job_id, job_input, reports

DOUBLE = Path(__file__).parent / "loop_service_double.py"


@pytest.fixture
def app() -> Iterator[FakeApp]:
    fake = FakeApp().start()
    yield fake
    fake.stop()


def start_service(
    app: FakeApp, directory: Path, scenario: str, **settings: str
) -> subprocess.Popen[str]:
    command = [sys.executable, str(FAKE_JOB), scenario, str(directory)]
    return subprocess.Popen(
        [sys.executable, str(DOUBLE), json.dumps(command)],
        env={
            "PATH": os.environ["PATH"],
            "HOME": str(directory),
            "RUNNER_API_URL": app.url,
            "RUNNER_TOKEN": RUNNER_TOKEN,
            "RUNNER_POLL_INTERVAL_SECONDS": "0.1",
            **settings,
        },
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def finish(service: subprocess.Popen[str], seconds: float = 30.0) -> tuple[int, str]:
    try:
        _, errors = service.communicate(timeout=seconds)
    except subprocess.TimeoutExpired:
        service.kill()
        _, errors = service.communicate()
        pytest.fail(f"the service did not stop in time:\n{errors}")
    return service.returncode, errors


# CR-29-T08
def test_sigterm_lets_the_running_job_finish_claims_nothing_new_and_exits_with_zero(
    app: FakeApp, tmp_path: Path
) -> None:
    app.queue.append(claim_response(job_id(1), job_input()))
    app.queue.append(claim_response(job_id(2), job_input()))
    service = start_service(app, tmp_path, "wait", RUNNER_CONCURRENCY="1")
    try:
        assert app.wait_for(lambda: len(reports(tmp_path)) == 1, 30)
        service.send_signal(signal.SIGTERM)
        time.sleep(1.0)
        assert service.poll() is None, "the service must wait for the running job"
        claims = app.claims
        (tmp_path / "go").write_text("")
        code, errors = finish(service)
    finally:
        if service.poll() is None:
            service.kill()

    assert code == 0, errors
    assert [c["job"] for c in app.completions] == [job_id(1)]
    assert app.completions[0]["result"]["ok"] is True
    assert app.claims == claims
    assert len(app.queue) == 1
    assert RUNNER_TOKEN not in errors


# CR-29-T09
def test_a_job_that_outlasts_the_grace_period_is_ended_and_reported_as_a_shutdown(
    app: FakeApp, tmp_path: Path
) -> None:
    app.queue.append(claim_response(job_id(1), job_input()))
    service = start_service(app, tmp_path, "hang", RUNNER_SHUTDOWN_GRACE_SECONDS="1")
    try:
        assert app.wait_for(lambda: len(reports(tmp_path)) == 1, 30)
        service.send_signal(signal.SIGTERM)
        code, errors = finish(service)
    finally:
        if service.poll() is None:
            service.kill()

    assert code == 0, errors
    result = app.completions[0]["result"]
    assert (result["ok"], result["errorCode"]) == (False, "runner_shutdown")
    (report,) = reports(tmp_path)
    assert gone(report["pid"])


def test_a_second_sigterm_ends_the_running_jobs_at_once(app: FakeApp, tmp_path: Path) -> None:
    app.queue.append(claim_response(job_id(1), job_input()))
    service = start_service(app, tmp_path, "hang", RUNNER_SHUTDOWN_GRACE_SECONDS="600")
    try:
        assert app.wait_for(lambda: len(reports(tmp_path)) == 1, 30)
        service.send_signal(signal.SIGTERM)
        time.sleep(0.5)
        assert service.poll() is None
        service.send_signal(signal.SIGTERM)
        code, errors = finish(service)
    finally:
        if service.poll() is None:
            service.kill()

    assert code == 0, errors
    assert app.completions[0]["result"]["errorCode"] == "runner_shutdown"


def test_the_service_keeps_asking_when_the_app_is_down_and_takes_the_job_when_it_is_back(
    app: FakeApp, tmp_path: Path
) -> None:
    app.script("claim", Scripted(503, {"error": {"code": "RUNNER_INTERNAL_ERROR", "message": "m"}}))
    app.queue.append(claim_response(job_id(1), job_input()))
    service = start_service(
        app, tmp_path, "ok", RUNNER_CONCURRENCY="1", RUNNER_POLL_INTERVAL_SECONDS="0.2"
    )
    try:
        assert app.wait_for(lambda: len(app.completions) == 1, 30)
        service.send_signal(signal.SIGTERM)
        code, errors = finish(service)
    finally:
        if service.poll() is None:
            service.kill()

    assert code == 0, errors
    assert "trying again" in errors
