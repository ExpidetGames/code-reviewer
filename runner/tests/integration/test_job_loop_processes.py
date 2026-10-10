"""Pins down the job loop with real processes and a real HTTP server on loopback: the loop starts
`fake_job.py` (a stand-in for `code-reviewer-run-job`) once per job, with a minimal environment and
the job on stdin, and reports to a fake app that checks every request against the contract."""

import asyncio
import json
import logging
import os
import resource
import sys
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from fake_app import RUNNER_TOKEN, FakeApp, RawServer, claim_response
from process_support import API_KEY, FAKE_JOB, TOKEN, gone, job_id, job_input, reports

from code_reviewer_runner.job_loop.api import HttpRunnerApi
from code_reviewer_runner.job_loop.loop import RunnerLoop
from code_reviewer_runner.job_loop.process import SubprocessLauncher
from code_reviewer_runner.job_loop.settings import LoopSettings
from code_reviewer_runner.pr_agent_config import PASSTHROUGH_VARIABLES


@pytest.fixture
def app() -> Iterator[FakeApp]:
    fake = FakeApp().start()
    yield fake
    fake.stop()


def drive(
    app: FakeApp,
    directory: Path,
    scenario: str,
    until: Callable[[], bool],
    *,
    during: Callable[[], None] | None = None,
    **overrides: Any,
) -> None:
    """Run the real loop against the fake app until `until()` holds, then stop it."""
    settings = LoopSettings(
        api_url=app.url,
        token=RUNNER_TOKEN,
        runner_id="process-test",
        concurrency=overrides.pop("concurrency", 1),
        poll_interval=0.05,
        job_timeout=overrides.pop("job_timeout", 30.0),
        shutdown_grace=overrides.pop("shutdown_grace", 5.0),
        kill_margin=overrides.pop("kill_margin", 0.3),
        terminate_grace=overrides.pop("terminate_grace", 0.5),
        backoff_max=1.0,
        job_command=(sys.executable, str(FAKE_JOB), scenario, str(directory)),
    )
    assert not overrides, f"unknown settings {overrides}"
    environment = {
        "PATH": os.environ["PATH"],
        "HOME": str(directory),
        "RUNNER_TOKEN": RUNNER_TOKEN,
        "OPENROUTER__KEY": "parent-secret-must-not-pass",
    }

    async def go() -> None:
        loop = RunnerLoop(
            settings,
            HttpRunnerApi(app.url, RUNNER_TOKEN, "process-test", request_timeout=5),
            SubprocessLauncher(settings.terminate_grace),
            environment=environment,
        )
        task = asyncio.create_task(loop.run())
        waiting = asyncio.create_task(asyncio.to_thread(app.wait_for, until, 40.0))
        if during is not None:
            await asyncio.to_thread(during)
        satisfied = await waiting
        loop.request_force()
        await asyncio.wait_for(task, 30)
        assert satisfied, "the expected state was not reached in time"

    asyncio.run(go())
    assert app.violations == []


def completed(app: FakeApp, count: int = 1) -> Callable[[], bool]:
    return lambda: len(app.completions) >= count


def test_a_job_runs_in_its_own_process_and_its_result_reaches_the_app(
    app: FakeApp, tmp_path: Path
) -> None:
    app.queue.append(claim_response(job_id(1), job_input()))

    drive(app, tmp_path, "ok", completed(app))

    (done,) = app.completions
    assert done["job"] == job_id(1) and done["lease"] == f"lease-{job_id(1)}"
    assert done["result"]["ok"] is True
    assert done["result"]["commentUrl"] == "https://github.com/octo/repo/pull/7#c1"
    assert len(reports(tmp_path)) == 1


# CR-29-T02
def test_heartbeats_go_out_while_the_process_runs_and_stop_when_it_ends(
    app: FakeApp, tmp_path: Path
) -> None:
    app.queue.append(claim_response(job_id(1), job_input(), interval=1))

    def release_after_two_beats() -> None:
        app.wait_for(lambda: len(app.heartbeats) >= 2, 20)
        (tmp_path / "go").write_text("")

    drive(app, tmp_path, "wait", completed(app), during=release_after_two_beats)
    beats = len(app.heartbeats)
    time.sleep(2.5)

    assert beats >= 2
    assert len(app.heartbeats) == beats


# CR-29-T04
def test_a_process_that_crashes_is_reported_with_the_end_of_its_stderr(
    app: FakeApp, tmp_path: Path
) -> None:
    app.queue.append(claim_response(job_id(1), job_input()))

    drive(app, tmp_path, "fail", completed(app))

    result = app.completions[0]["result"]
    assert (result["ok"], result["errorCode"]) == (False, "runner_error")
    assert "exited with code 3" in result["errorMessage"]
    assert len(result["logTail"]) <= 4096
    assert "stderr line 01999" in result["logTail"]
    assert "stderr line 00000" not in result["logTail"]


# CR-29-T07
@pytest.mark.parametrize("scenario", ["hang", "stubborn"])
def test_a_job_that_hangs_is_ended_with_its_helper_and_reported_as_a_timeout(
    app: FakeApp, tmp_path: Path, scenario: str
) -> None:
    app.queue.append(claim_response(job_id(1), job_input()))

    drive(
        app,
        tmp_path,
        scenario,
        completed(app),
        job_timeout=0.5,
        kill_margin=0.3,
        terminate_grace=0.5,
    )

    result = app.completions[0]["result"]
    assert (result["ok"], result["errorCode"]) == (False, "timeout")
    (report,) = reports(tmp_path)
    assert gone(report["pid"])
    if scenario == "stubborn":
        # It ignored SIGTERM and started a helper: the whole group was ended.
        assert gone(int((tmp_path / "helper.pid").read_text()))


# CR-29-T08
def test_after_sigterm_style_stop_the_running_job_finishes_and_no_new_job_is_claimed(
    app: FakeApp, tmp_path: Path
) -> None:
    app.queue.append(claim_response(job_id(1), job_input()))
    app.queue.append(claim_response(job_id(2), job_input()))
    stopped_at_claims: list[int] = []

    async def go() -> None:
        settings = LoopSettings(
            api_url=app.url,
            token=RUNNER_TOKEN,
            runner_id="process-test",
            concurrency=1,
            poll_interval=0.05,
            shutdown_grace=20.0,
            job_command=(sys.executable, str(FAKE_JOB), "wait", str(tmp_path)),
        )
        loop = RunnerLoop(
            settings,
            HttpRunnerApi(app.url, RUNNER_TOKEN, "process-test", request_timeout=5),
            SubprocessLauncher(1.0),
            environment={"PATH": os.environ["PATH"]},
        )
        task = asyncio.create_task(loop.run())
        await asyncio.to_thread(app.wait_for, lambda: len(reports(tmp_path)) == 1, 20)
        loop.request_stop()
        stopped_at_claims.append(app.claims)
        await asyncio.sleep(0.5)
        (tmp_path / "go").write_text("")
        await asyncio.wait_for(task, 20)

    asyncio.run(go())

    assert [c["job"] for c in app.completions] == [job_id(1)]
    assert app.completions[0]["result"]["ok"] is True
    assert app.claims == stopped_at_claims[0]
    assert len(app.queue) == 1  # the second job was never claimed


# CR-29-T10
def test_a_lost_lease_ends_the_real_process_and_nothing_is_reported(
    app: FakeApp, tmp_path: Path
) -> None:
    app.queue.append(claim_response(job_id(1), job_input(), interval=1))
    app.lost.add(job_id(1))

    drive(app, tmp_path, "hang", lambda: len(app.requests) >= 2 and _has_report(tmp_path))
    time.sleep(0.5)

    (report,) = reports(tmp_path)
    assert gone(report["pid"])
    assert app.completions == []


def _has_report(directory: Path) -> bool:
    return len(list(directory.glob("[0-9]*.json"))) >= 1


# CR-29-T13
def test_parallel_jobs_see_only_their_own_job_and_never_the_runner_token(
    app: FakeApp, tmp_path: Path
) -> None:
    first_token = "first-installation-token-0123456789-aaaa"
    second_token = "second-installation-token-9876543210-bbbb"
    for number, token in ((1, first_token), (2, second_token)):
        git = {**job_input()["git"], "token": token}
        app.queue.append(claim_response(job_id(number), job_input(git=git)))

    def release_when_both_run() -> None:
        app.wait_for(lambda: len(reports(tmp_path)) == 2, 20)
        (tmp_path / "go").write_text("")

    drive(app, tmp_path, "wait", completed(app, 2), concurrency=2, during=release_when_both_run)

    seen = reports(tmp_path)
    assert len(seen) == 2 and seen[0]["pid"] != seen[1]["pid"]
    for report in seen:
        names = set(report["environ"])
        # The interpreter itself adds two variables on macOS (locale coercion).
        interpreter = {"__CF_USER_TEXT_ENCODING", "LC_CTYPE"}
        assert names <= {*PASSTHROUGH_VARIABLES, "RUNNER_JOB_TIMEOUT_SECONDS", *interpreter}
        text = json.dumps(report["environ"])
        for secret in (RUNNER_TOKEN, "parent-secret-must-not-pass", first_token, second_token):
            assert secret not in text
    tokens_in_stdin = {
        token: [token in report["stdin"] for report in seen]
        for token in (first_token, second_token)
    }
    assert sorted(map(sum, tokens_in_stdin.values())) == [1, 1]


# CR-29-T14
def test_credentials_a_process_prints_are_masked_in_the_result_and_in_the_runner_log(
    app: FakeApp, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    app.queue.append(claim_response(job_id(1), job_input()))

    drive(app, tmp_path, "leak", completed(app))

    result = app.completions[0]["result"]
    assert (result["ok"], result["errorCode"]) == (False, "command_failed")
    assert "[REDACTED]" in result["logTail"]
    bodies = json.dumps([request["body"] for request in app.requests])
    for secret in (TOKEN, API_KEY):
        assert secret not in json.dumps(app.completions)
        assert secret not in caplog.text
    assert TOKEN in json.dumps(job_input())  # the secret really was in the job
    assert bodies  # and the requests were recorded


# CR-29-T15
def test_the_command_line_of_the_process_holds_no_token_and_no_key(
    app: FakeApp, tmp_path: Path
) -> None:
    app.queue.append(claim_response(job_id(1), job_input()))

    drive(app, tmp_path, "ok", completed(app))

    (report,) = reports(tmp_path)
    assert report["argv"] == [str(FAKE_JOB), "ok", str(tmp_path)]
    for secret in (TOKEN, API_KEY, RUNNER_TOKEN):
        assert secret not in report["command_line"]
        assert secret not in json.dumps(report["environ"])
    assert TOKEN in report["stdin"] and API_KEY in report["stdin"]


# CR-29-T16
def test_a_question_full_of_shell_characters_is_one_value_on_stdin_and_nothing_runs(
    app: FakeApp, tmp_path: Path
) -> None:
    canary = tmp_path / "canary"
    question = f"; rm -rf / $(touch {canary}) `touch {canary}`\n&& id"
    app.queue.append(claim_response(job_id(1), job_input(command="ask", args=[question])))

    drive(app, tmp_path, "ok", completed(app))

    (report,) = reports(tmp_path)
    assert json.loads(report["stdin"])["args"] == [question]
    assert report["argv"] == [str(FAKE_JOB), "ok", str(tmp_path)]
    assert not canary.exists()


# CR-29-T16
def test_a_pull_request_url_full_of_shell_characters_is_refused_and_starts_nothing(
    app: FakeApp, tmp_path: Path
) -> None:
    canary = tmp_path / "canary"
    url = f"https://github.com/octo/repo/pull/7;touch {canary}$(id)"
    app.queue.append(claim_response(job_id(1), job_input(prUrl=url)))

    drive(app, tmp_path, "ok", completed(app))

    result = app.completions[0]["result"]
    assert (result["ok"], result["errorCode"]) == (False, "invalid_job")
    assert reports(tmp_path) == []
    assert not canary.exists()


def test_each_process_starts_in_an_empty_directory_of_its_own_that_is_removed_afterwards(
    app: FakeApp, tmp_path: Path
) -> None:
    app.queue.append(claim_response(job_id(1), job_input()))

    drive(app, tmp_path, "ok", completed(app))

    (report,) = reports(tmp_path)
    assert report["cwd_files"] == []
    assert not Path(report["cwd"]).exists()


# CR-29-T18
def test_two_hundred_megabytes_of_output_stay_bounded_and_the_result_is_cut(
    app: FakeApp, tmp_path: Path
) -> None:
    app.queue.append(claim_response(job_id(1), job_input()))
    before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss

    drive(app, tmp_path, "flood", completed(app))

    after = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    grown_mb = (after - before) / (1024 * 1024 if sys.platform == "darwin" else 1024)
    result = app.completions[0]["result"]
    assert result["ok"] is True
    assert len(result["logTail"]) <= 4096
    assert grown_mb < 100


# CR-29-T11: an app (or a proxy in front of it) that answers nonsense is just an app that is down.
def test_an_app_that_answers_garbage_makes_the_loop_wait_instead_of_dying(tmp_path: Path) -> None:
    server = RawServer(b"GARBAGE\r\n\r\n")
    settings = LoopSettings(
        api_url=server.url,
        token=RUNNER_TOKEN,
        runner_id="garbage-test",
        poll_interval=0.05,
        job_command=(sys.executable, str(FAKE_JOB), "ok", str(tmp_path)),
    )

    async def go() -> None:
        loop = RunnerLoop(
            settings,
            HttpRunnerApi(server.url, RUNNER_TOKEN, "garbage-test", request_timeout=5),
            SubprocessLauncher(1.0),
            environment={"PATH": os.environ["PATH"]},
        )
        task = asyncio.create_task(loop.run())
        await asyncio.sleep(1.0)
        survived = not task.done()
        loop.request_force()
        await asyncio.wait_for(task, 10)
        assert survived, "the loop must keep running"

    try:
        asyncio.run(go())
        assert server.connections == 1  # then it waits at least five seconds before the next try
    finally:
        server.close()
