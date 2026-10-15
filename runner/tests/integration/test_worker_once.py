# SPDX-License-Identifier: Apache-2.0

"""`code-reviewer-worker --once` and the Worker host against the fake App of `fakes/dispatcher-app/`
(#323): real processes, real HTTP on loopback, the Worker API with the bodies of the contract
examples. The job process is a stand-in (`fake_job.py`); nothing reaches a network or a model."""

import asyncio
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest
from process_support import FAKE_JOB, gone, reports
from worker_app import FakeAppProcess

from code_reviewer_runner.capabilities import ALL_ENGINES
from code_reviewer_runner.job_loop.settings import WorkerSettings
from code_reviewer_runner.job_loop.worker import WorkerRequest, run_worker
from code_reviewer_runner.job_loop.worker_errors import WorkerExit

pytestmark = pytest.mark.integration


@pytest.fixture
def app() -> Iterator[FakeAppProcess]:
    fake = FakeAppProcess().start()
    yield fake
    fake.stop()


class ScaledClock:
    """Real time, shortened: a pause of `seconds` takes `seconds * factor`. The heartbeat interval
    of the fake App (30 s) becomes a few hundredths of a second without any code knowing."""

    def __init__(self, factor: float) -> None:
        self._factor = factor

    def monotonic(self) -> float:
        return time.monotonic() / self._factor

    async def sleep(self, seconds: float) -> None:
        await asyncio.sleep(seconds * self._factor)


class RecordingClock:
    """Remembers every pause; the first `instant` of them (all, by default) take no time, later
    ones (the host's heartbeat and timeout, once the job runs) are real."""

    def __init__(self, instant: int | None = None) -> None:
        self.now = 0.0
        self.pauses: list[float] = []
        self._instant = instant

    def monotonic(self) -> float:
        return self.now + time.monotonic()

    async def sleep(self, seconds: float) -> None:
        self.pauses.append(seconds)
        if self._instant is None or len(self.pauses) <= self._instant:
            self.now += seconds
            await asyncio.sleep(0)
            return
        await asyncio.sleep(seconds)


def settings_for(directory: Path, scenario: str, **overrides: Any) -> WorkerSettings:
    values: dict[str, Any] = {
        "job_timeout": 30.0,
        "kill_margin": 0.3,
        "terminate_grace": 0.5,
        "backoff_max": 1.0,
        "request_timeout": 5.0,
        "job_command": (sys.executable, str(FAKE_JOB), scenario, str(directory)),
    }
    values.update(overrides)
    return WorkerSettings(**values)


def environment_for(directory: Path) -> dict[str, str]:
    return {"PATH": os.environ["PATH"], "HOME": str(directory)}


def worker_run(
    app: FakeAppProcess,
    job: str,
    credential: str,
    settings: WorkerSettings,
    directory: Path,
    **options: Any,
) -> WorkerExit:
    request = WorkerRequest(app_url=app.url, job_id=job, credential=credential)
    return asyncio.run(run_worker(request, settings, environment_for(directory), **options))


def start_cli(
    app_url: str, job: str, credential: str, directory: Path, scenario: str, **extra_env: str
) -> subprocess.Popen[bytes]:
    """The real entry point, as the Dispatcher would start it: the start document on stdin."""
    environment = {
        **environment_for(directory),
        "PR_AGENT_COMMAND": f"{sys.executable} {FAKE_JOB} {scenario} {directory}",
        "RUNNER_JOB_TIMEOUT_SECONDS": "30",
        **extra_env,
    }
    process = subprocess.Popen(
        [sys.executable, "-m", "code_reviewer_runner.worker_cli", "--once"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=environment,
    )
    assert process.stdin is not None
    process.stdin.write(
        json.dumps({"appUrl": app_url, "jobId": job, "credential": credential}).encode()
    )
    process.stdin.close()
    return process


def wait_until(condition: Callable[[], bool], seconds: float = 30.0) -> bool:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if condition():
            return True
        time.sleep(0.05)
    return False


def routes(app: FakeAppProcess, job: str) -> list[tuple[str, int]]:
    return [(entry["route"], entry["status"]) for entry in app.requests() if entry["jobId"] == job]


# #323-T01
def test_a_diff_job_through_worker_once_is_delivered_and_the_worker_exits_with_zero(
    app: FakeAppProcess, tmp_path: Path
) -> None:
    job = app.enqueue("diff")
    credential = app.claim(job)

    process = start_cli(app.url, job, credential, tmp_path, "ok")
    stdout, stderr = process.communicate(timeout=60)

    assert process.returncode == 0, stderr.decode()
    (delivered,) = app.results(job)
    assert delivered["ok"] is True
    assert delivered["commentUrl"] == "https://github.com/octo/repo/pull/7#c1"
    # The job process got the job (the secrets of the fetch) on stdin and no credential anywhere.
    (seen,) = reports(tmp_path)
    assert json.loads(seen["stdin"])["prUrl"]
    assert credential not in json.dumps(seen)
    assert credential.encode() not in stdout + stderr
    assert ("job", 200) in routes(app, job) and ("result", 200) in routes(app, job)


# #323-T01
def test_a_failed_job_is_delivered_as_a_failure_and_the_worker_exits_with_one(
    app: FakeAppProcess, tmp_path: Path
) -> None:
    job = app.enqueue("diff")
    credential = app.claim(job)

    process = start_cli(app.url, job, credential, tmp_path, "fail")
    process.communicate(timeout=60)

    assert process.returncode == 1
    (delivered,) = app.results(job)
    assert delivered["ok"] is False


# #323-T02
def test_a_dynamic_job_writes_its_summary_only_after_the_lease_check_over_the_worker_api(
    app: FakeAppProcess, tmp_path: Path
) -> None:
    job = app.enqueue("dynamic")
    credential = app.claim(job, ALL_ENGINES)
    settings = settings_for(tmp_path, "summary", engines=ALL_ENGINES)

    code = worker_run(app, job, credential, settings, tmp_path)

    assert code is WorkerExit.OK
    assert (tmp_path / "summary").read_text() == "the summary"
    # The check was a heartbeat of the Worker API, and it came before the result.
    sequence = [route for route, _ in routes(app, job)]
    assert sequence == ["job", "heartbeat", "result"]
    (delivered,) = app.results(job)
    assert delivered["ok"] is True


# #323-T02
def test_a_dynamic_job_whose_lease_is_lost_writes_no_summary(
    app: FakeAppProcess, tmp_path: Path
) -> None:
    job = app.enqueue("dynamic")
    credential = app.claim(job, ALL_ENGINES)
    app.script("heartbeat", [{"status": 409}])
    settings = settings_for(tmp_path, "summary", engines=ALL_ENGINES)

    code = worker_run(app, job, credential, settings, tmp_path)

    assert not (tmp_path / "summary").exists()
    assert code is WorkerExit.FAILED
    assert app.results(job) == [] or app.results(job)[0]["ok"] is False


# #323-T02: the engine is not advertised, so nothing is started and the existing code is delivered
def test_a_dynamic_job_without_an_advertised_engine_is_refused_with_the_stable_code(
    app: FakeAppProcess, tmp_path: Path
) -> None:
    job = app.enqueue("dynamic")
    credential = app.claim(job, ALL_ENGINES)

    code = worker_run(app, job, credential, settings_for(tmp_path, "ok"), tmp_path)

    assert code is WorkerExit.FAILED
    (delivered,) = app.results(job)
    assert delivered["ok"] is False
    assert delivered["errorCode"] == "dynamic_engine_unavailable"
    assert reports(tmp_path) == []  # no job process was started


# #323-T04
def test_a_heartbeat_answered_with_409_ends_the_process_group_and_delivers_nothing(
    app: FakeAppProcess, tmp_path: Path
) -> None:
    job = app.enqueue("diff")
    credential = app.claim(job)
    app.script("heartbeat", [{"status": 409}])
    settings = settings_for(tmp_path, "stubborn", job_timeout=600.0)

    code = worker_run(app, job, credential, settings, tmp_path, clock=ScaledClock(0.01))

    assert code is WorkerExit.FAILED
    assert app.results(job) == []
    (seen,) = reports(tmp_path)
    helper = int((tmp_path / "helper.pid").read_text())
    assert gone(seen["pid"]) and gone(helper)
    assert ("result", 200) not in routes(app, job)


# #323-T05
def test_an_app_that_cannot_be_reached_at_fetch_is_a_stable_failure_after_bounded_retries(
    tmp_path: Path,
) -> None:
    with socket.socket() as closed:
        closed.bind(("127.0.0.1", 0))
        url = f"http://127.0.0.1:{closed.getsockname()[1]}"
    clock = RecordingClock()
    request = WorkerRequest(
        app_url=url,
        job_id="00000000-0000-4000-8000-000000000001",
        credential="crj_" + "A" * 43,
    )

    code = asyncio.run(
        run_worker(request, settings_for(tmp_path, "ok"), environment_for(tmp_path), clock=clock)
    )

    assert code is WorkerExit.SETUP_ERROR
    assert reports(tmp_path) == []
    # Bounded: a few pauses that grow, then it gives up (it does not wait forever).
    assert 1 <= len(clock.pauses) <= 6
    assert clock.pauses == sorted(clock.pauses)


# #323-T05
def test_the_fetch_is_tried_again_after_a_server_error_and_then_succeeds(
    app: FakeAppProcess, tmp_path: Path
) -> None:
    job = app.enqueue("diff")
    credential = app.claim(job)
    app.script("job", [{"status": 500}, {"status": 429, "retryAfterSeconds": 2}])
    clock = RecordingClock(instant=2)

    code = worker_run(app, job, credential, settings_for(tmp_path, "ok"), tmp_path, clock=clock)

    assert code is WorkerExit.OK
    assert len(clock.pauses) >= 2
    assert max(clock.pauses) >= 2  # Retry-After is honoured


# #323-T05: an invalid credential is final: asking again cannot help
def test_a_credential_the_app_does_not_know_is_not_retried(
    app: FakeAppProcess, tmp_path: Path
) -> None:
    job = app.enqueue("diff")
    app.claim(job)
    clock = RecordingClock()

    code = worker_run(
        app, job, "crj_" + "B" * 43, settings_for(tmp_path, "ok"), tmp_path, clock=clock
    )

    assert code is WorkerExit.SETUP_ERROR
    assert clock.pauses == []
    assert [status for route, status in routes(app, job) if route == "job"] == [401]


# #323-T05: the App has given the job back (it could not mint the git token): nothing to run
def test_a_job_the_app_gave_back_at_fetch_is_not_retried(
    app: FakeAppProcess, tmp_path: Path
) -> None:
    job = app.enqueue("diff")
    credential = app.claim(job)
    app.script("job", [{"status": 503, "retryAfterSeconds": 30}])
    clock = RecordingClock()

    code = worker_run(app, job, credential, settings_for(tmp_path, "ok"), tmp_path, clock=clock)

    assert code is WorkerExit.SETUP_ERROR
    assert clock.pauses == []
    assert reports(tmp_path) == []


# #323-T05: the app ended the job (for example a permanent access failure): nothing to run
def test_a_job_the_app_ended_is_not_retried_and_nothing_runs(
    app: FakeAppProcess, tmp_path: Path
) -> None:
    job = app.enqueue("diff")
    credential = app.claim(job)
    ended = {"error": {"code": "RUNNER_JOB_ENDED", "message": "The job was ended."}}
    app.script("job", [{"status": 409, "body": ended}])
    clock = RecordingClock()

    code = worker_run(app, job, credential, settings_for(tmp_path, "ok"), tmp_path, clock=clock)

    assert code is WorkerExit.SETUP_ERROR
    assert clock.pauses == []
    assert reports(tmp_path) == []


# #323-T06
def test_sigterm_during_the_job_delivers_runner_shutdown_and_exits_with_zero(
    app: FakeAppProcess, tmp_path: Path
) -> None:
    job = app.enqueue("diff")
    credential = app.claim(job)
    process = start_cli(app.url, job, credential, tmp_path, "wait")
    assert wait_until(lambda: len(reports(tmp_path)) == 1), "the job process did not start"
    (seen,) = reports(tmp_path)

    process.send_signal(signal.SIGTERM)
    _, stderr = process.communicate(timeout=60)

    assert process.returncode == 0, stderr.decode()
    assert gone(seen["pid"])
    # The App took the job back (a result with runner_shutdown is a release, nothing is stored).
    assert app.results(job) == []
    assert ("result", 200) in routes(app, job)
    assert app.claim(job) is not None  # claimable again: it is queued


# #323-T07
def test_the_hard_timeout_delivers_timeout_and_kills_the_helper_processes(
    app: FakeAppProcess, tmp_path: Path
) -> None:
    job = app.enqueue("diff")
    credential = app.claim(job)
    settings = settings_for(tmp_path, "stubborn", job_timeout=1.0)

    code = worker_run(app, job, credential, settings, tmp_path)

    assert code is WorkerExit.FAILED
    (delivered,) = app.results(job)
    assert delivered["ok"] is False and delivered["errorCode"] == "timeout"
    (seen,) = reports(tmp_path)
    helper = int((tmp_path / "helper.pid").read_text())
    assert gone(seen["pid"]) and gone(helper)


# #323-T10
def test_the_engine_user_is_swept_after_a_dynamic_job_that_was_killed_outright(
    app: FakeAppProcess, tmp_path: Path
) -> None:
    job = app.enqueue("dynamic")
    credential = app.claim(job, ALL_ENGINES)
    sweeps: list[tuple[int, int]] = []

    def sweeper(uid: int, gid: int) -> bool:
        sweeps.append((uid, gid))
        return True

    settings = settings_for(
        tmp_path,
        "kill",
        engines=ALL_ENGINES,
        diff_job_user=None,
        dynamic_engine_user=(10101, 10102),
    )

    code = worker_run(app, job, credential, settings, tmp_path, sweeper=sweeper)

    assert code is WorkerExit.FAILED
    assert sweeps == [(10101, 10102)]
    (delivered,) = app.results(job)
    assert delivered["ok"] is False


class OldApp:
    """An App from before the hosted deployment (or one that says it has no Worker API): the
    Worker's routes do not exist (a plain 404, as the framework answers), `/version` is missing or
    lists no `worker_api`."""

    def __init__(self, version_features: list[str] | None) -> None:
        self.paths: list[str] = []
        features = version_features
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                owner.paths.append(self.path)
                if features is not None and self.path.startswith("/api/runners/v1/version"):
                    body = json.dumps({"version": 1, "appVersion": "0.0.1", "features": features})
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(body.encode())
                    return
                self.send_response(404)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(b"<html>This page could not be found.</html>")

            do_POST = do_GET

            def log_message(self, format: str, *args: Any) -> None:
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def __enter__(self) -> "OldApp":
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(10)


# #323-T09
@pytest.mark.parametrize("version_features", [None, ["release", "claim_by_job_id"]])
def test_an_app_without_the_worker_api_is_refused_with_a_clear_message_and_nothing_runs(
    tmp_path: Path, version_features: list[str] | None
) -> None:
    credential = "crj_" + "C" * 43
    job = "00000000-0000-4000-8000-000000000001"
    with OldApp(version_features) as old:
        process = start_cli(old.url, job, credential, tmp_path, "ok")
        _, stderr = process.communicate(timeout=60)
        asked = list(old.paths)

    assert process.returncode == 2
    assert b"worker_app_unsupported" in stderr
    assert credential.encode() not in stderr
    assert reports(tmp_path) == []
    if version_features is not None:
        # The version answer was enough: the Worker API was never asked.
        assert not any(path.startswith("/api/workers/") for path in asked)


# #323-T03
def test_the_credential_is_not_in_the_arguments_or_the_environment_of_the_running_worker(
    app: FakeAppProcess, tmp_path: Path
) -> None:
    job = app.enqueue("diff")
    credential = app.claim(job)
    process = start_cli(app.url, job, credential, tmp_path, "wait")
    assert wait_until(lambda: len(reports(tmp_path)) == 1), "the job process did not start"
    (seen,) = reports(tmp_path)

    arguments = Path(f"/proc/{process.pid}/cmdline").read_bytes()
    environment = Path(f"/proc/{process.pid}/environ").read_bytes()
    (tmp_path / "go").write_text("")
    stdout, stderr = process.communicate(timeout=60)

    assert process.returncode == 0, stderr.decode()
    for place in (arguments, environment, stdout, stderr, json.dumps(seen).encode()):
        assert credential.encode() not in place
    # The job input is not in the Worker's arguments or environment either.
    for place in (arguments, environment, stdout, stderr):
        assert b"example-git-token" not in place and b"example-llm-key" not in place
    assert "example-git-token" in seen["stdin"]  # it went to the job process, on stdin only
