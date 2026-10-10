"""Pins down the job loop together with the real job entry point (`code_reviewer_runner.runner`):
the loop starts it as a process, the runner builds its result around PR-Agent's code with
`handle_request` replaced by the double of pr_agent_double.py, and the loop reports that result to
a fake app that checks it against the contract. Nothing reaches a network."""

import asyncio
import json
import os
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest
from fake_app import RUNNER_TOKEN, FakeApp, claim_response
from process_support import API_KEY, TOKEN, job_id, job_input

from code_reviewer_runner.job_loop.api import HttpRunnerApi
from code_reviewer_runner.job_loop.loop import RunnerLoop
from code_reviewer_runner.job_loop.process import SubprocessLauncher
from code_reviewer_runner.job_loop.settings import LoopSettings

DOUBLE = Path(__file__).parent / "pr_agent_double.py"


@pytest.fixture
def app() -> Iterator[FakeApp]:
    fake = FakeApp().start()
    yield fake
    fake.stop()


def run_loop(app: FakeApp, tmp_path: Path, scenario: str, **settings: float) -> None:
    config = LoopSettings(
        api_url=app.url,
        token=RUNNER_TOKEN,
        runner_id="run-job-test",
        concurrency=1,
        poll_interval=0.05,
        job_command=(sys.executable, str(DOUBLE), scenario, str(tmp_path / "report.json")),
        **settings,  # pyright: ignore[reportArgumentType]
    )

    async def go() -> None:
        loop = RunnerLoop(
            config,
            HttpRunnerApi(app.url, RUNNER_TOKEN, "run-job-test", request_timeout=5),
            SubprocessLauncher(1.0),
            environment={"PATH": os.environ["PATH"], "HOME": str(tmp_path)},
        )
        task = asyncio.create_task(loop.run())
        reached = await asyncio.to_thread(app.wait_for, lambda: len(app.completions) >= 1, 90.0)
        loop.request_force()
        await asyncio.wait_for(task, 30)
        assert reached, "the job was not reported in time"

    asyncio.run(go())
    assert app.violations == []


# CR-29-T03
def test_a_review_run_by_the_real_entry_point_is_reported_with_its_comment_link(
    app: FakeApp, tmp_path: Path
) -> None:
    app.queue.append(claim_response(job_id(1), job_input()))

    run_loop(app, tmp_path, "publish")

    result = app.completions[0]["result"]
    assert result["ok"] is True
    assert result["commentUrl"] == "https://github.com/octo/repo/pull/7#c1"
    seen = json.loads((tmp_path / "report.json").read_text())
    assert seen["request"] == ["review"]
    assert seen["secret_in_environ"] is False


def test_a_failure_comment_of_pr_agent_is_reported_as_a_failed_job(
    app: FakeApp, tmp_path: Path
) -> None:
    app.queue.append(claim_response(job_id(1), job_input()))

    run_loop(app, tmp_path, "failure")

    result = app.completions[0]["result"]
    assert result["ok"] is False
    assert result["errorCode"] == "command_failed"


# CR-29-T14
def test_credentials_that_pr_agent_prints_never_reach_the_app(app: FakeApp, tmp_path: Path) -> None:
    app.queue.append(claim_response(job_id(1), job_input()))

    run_loop(app, tmp_path, "leak")

    sent = json.dumps([request["body"] for request in app.requests])
    assert TOKEN not in sent and API_KEY not in sent


# CR-29-T07
def test_the_runner_reports_its_own_timeout_before_the_loop_has_to_end_it(
    app: FakeApp, tmp_path: Path
) -> None:
    app.queue.append(claim_response(job_id(1), job_input()))

    run_loop(app, tmp_path, "slow", job_timeout=2.0, kill_margin=30.0)

    result = app.completions[0]["result"]
    assert (result["ok"], result["errorCode"]) == (False, "timeout")
    assert result["logTail"].startswith("timeout:")  # written by the runner itself
