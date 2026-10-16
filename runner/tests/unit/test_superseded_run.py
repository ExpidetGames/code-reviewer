# SPDX-License-Identifier: Apache-2.0

"""A run that a newer push replaced (#396): Diff and Dynamic.

It lets the model requests in flight finish (so their cost is measured), sends no further request,
publishes nothing, and ends `superseded` with the usage it measured. A run that is not superseded is
exactly what it was; the existing tests keep pinning that."""

import asyncio
import time
from collections.abc import Generator
from contextlib import contextmanager
from decimal import Decimal
from importlib import import_module
from pathlib import Path
from typing import Any

import pytest
from loguru import logger
from pr_agent.agent.pr_agent import PRAgent
from test_dynamic_review_run import dynamic_job
from test_failed_run_usage import (
    ENVIRONMENT,
    THREE_PRICED,
    FakeProxy,
    ScriptedEngine,
    findings,
    prepared_content,
    script,
)
from test_runner import (
    HANDLER_MODULE,
    REVIEW_MARKER,
    make_job,
    provider_with_pull,
)

from code_reviewer_runner import runner
from code_reviewer_runner.capabilities import ALL_ENGINES
from code_reviewer_runner.dynamic_review.adapter import EngineAnswer
from code_reviewer_runner.dynamic_review.checkout import PreparedContent
from code_reviewer_runner.dynamic_review.publish import Published
from code_reviewer_runner.job import Job
from code_reviewer_runner.lease_check import LeaseState
from code_reviewer_runner.log_capture import LogCapture
from code_reviewer_runner.redaction import Redactor
from code_reviewer_runner.result import ErrorCode, JobResult
from code_reviewer_runner.supersede import SupersedeSignal

pytestmark = pytest.mark.unit


@pytest.fixture(autouse=True)
def stubbed_boundary(monkeypatch: pytest.MonkeyPatch) -> None:
    """The proxy and the engine are stubbed, as in the tests of the usage of a failed run."""
    monkeypatch.setattr(runner, "ModelProxy", FakeProxy)
    monkeypatch.setattr(runner, "DynamicEngine", ScriptedEngine)


def spy_on_comments(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Records the comments that reach the provider's method (before the guard would block them)."""
    from pr_agent.git_providers.github_provider import GithubProvider

    published: list[str] = []
    original: Any = GithubProvider.publish_comment

    def publish_comment(self: Any, body: str, is_temporary: bool = False) -> Any:
        published.append(body)
        return original(self, body)

    monkeypatch.setattr(GithubProvider, "publish_comment", publish_comment)
    return published


def noting(written: list[str], what: str) -> Any:
    def write(*args: Any) -> None:
        written.append(what)

    return write


# -- Diff ---------------------------------------------------------------------------------------


def run_diff(signal: SupersedeSignal) -> JobResult:
    capture = LogCapture(Redactor(["dummy-installation-token-0123456789"]))
    logger.remove()
    sink = logger.add(capture, level="INFO", format="{message}")
    try:
        return runner.run_job(make_job(), capture, time.monotonic(), superseded=signal)
    finally:
        logger.remove(sink)


def use_double(monkeypatch: pytest.MonkeyPatch, double: Any) -> None:
    async def handle_request(
        self: Any, pr_url: str, request: Any, *args: Any, **kwargs: Any
    ) -> bool:
        return await double()

    monkeypatch.setattr(PRAgent, "handle_request", handle_request)


class Provider:
    """The model provider of a Diff run: the first request is held until the test lets it go."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.requests = 0
        self.release = asyncio.Event()
        outer = self

        async def acompletion(*args: Any, **kwargs: Any) -> Any:
            outer.requests += 1
            await outer.release.wait()
            return {
                "choices": [],
                "usage": {
                    "prompt_tokens": 600,
                    "completion_tokens": 150,
                    "total_tokens": 750,
                    "cost": 0.0042,
                },
            }

        monkeypatch.setattr(import_module(HANDLER_MODULE), "acompletion", acompletion)

    async def ask(self) -> None:
        from pr_agent.algo.run_details import get_run_details

        details = get_run_details()
        assert details is not None
        module = import_module(HANDLER_MODULE)
        await module.acompletion(model="openrouter/deepseek/deepseek-chat", messages=[])
        details.model_used = "openrouter/deepseek/deepseek-chat"
        details.prompt_tokens += 600
        details.completion_tokens += 150
        details.total_tokens += 750
        details.num_ai_calls += 1
        details.known_cost_call_count += 1


# #396-T08
def test_a_diff_run_superseded_with_a_request_in_flight_measures_it_and_publishes_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    signal = SupersedeSignal()
    model = Provider(monkeypatch)
    published = spy_on_comments(monkeypatch)

    async def double() -> bool:
        first = asyncio.ensure_future(model.ask())
        await asyncio.sleep(0.05)  # the request is out and not answered
        signal.set()
        # The newer push is known now: a second request is refused at once, and the first still
        # runs.
        with pytest.raises(Exception, match="superseded"):
            await model.ask()
        assert not first.done()
        model.release.set()
        await first
        # PR-Agent now writes its review and, failing that, a notice: neither may reach the pull
        # request.
        provider = provider_with_pull()
        provider.publish_comment(f"## PR Reviewer Guide\n\n{REVIEW_MARKER}\n\nbody")
        provider.publish_comment("Failed to review PR: boom")
        provider.publish_labels(["x"])
        return True

    use_double(monkeypatch, double)

    result = run_diff(signal)

    assert model.requests == 1
    assert published == []
    assert result.ok is False
    assert result.error_code is ErrorCode.SUPERSEDED
    assert result.comment_url is None
    # The request that was in flight is measured: exact cost, tokens, one call.
    assert result.usage is not None
    assert result.usage.ai_calls == 1
    assert result.usage.total_tokens == 750
    assert result.usage.cost_usd == pytest.approx(0.0042)
    assert result.to_json()["errorCode"] == "superseded"
    assert result.log_tail.startswith("superseded: ")


# #396-T08
def test_a_diff_run_that_is_not_superseded_publishes_as_before(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    signal = SupersedeSignal()

    async def double() -> bool:
        provider_with_pull().publish_comment(f"## PR Reviewer Guide\n\n{REVIEW_MARKER}\n\nbody")
        return True

    use_double(monkeypatch, double)

    result = run_diff(signal)

    assert result.ok is True and result.error_code is None
    assert result.comment_url == "https://github.com/octo/repo/pull/7#c1"


# #396-T08: a run that had published before it heard of it keeps its review.
def test_a_diff_run_that_published_before_the_signal_stays_a_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    signal = SupersedeSignal()

    async def double() -> bool:
        provider_with_pull().publish_comment(f"## PR Reviewer Guide\n\n{REVIEW_MARKER}\n\nbody")
        signal.set()
        return True

    use_double(monkeypatch, double)

    result = run_diff(signal)

    assert result.ok is True
    assert result.error_code is None


# -- Dynamic ------------------------------------------------------------------------------------


@contextmanager
def _prepare(tmp_path: Path) -> Generator[PreparedContent]:
    yield prepared_content(tmp_path)


def run_dynamic(
    tmp_path: Path,
    signal: SupersedeSignal,
    *,
    lease: LeaseState = LeaseState.HELD,
    publish: Any = None,
    note: Any = None,
) -> JobResult:
    return runner.run_dynamic_job(
        dynamic_job(),
        None,
        0.0,
        ENVIRONMENT,
        None,
        engines=ALL_ENGINES,
        prepare=lambda job: _prepare(tmp_path),
        publish=publish or (lambda job, found: Published("https://github.test/c/1", True)),
        lease_check=lambda: lease,
        publish_failure=note or (lambda job, code, reason: None),
        superseded=signal,
    )


class SupersededMidRun(ScriptedEngine):
    """Makes two calls, hears that the run was superseded, and still comes back with an answer."""

    signal: SupersedeSignal

    def run(self) -> EngineAnswer:
        for cost in self.costs[:2]:
            reservation = self.ledger.reserve_call("x" * 400, output_tokens=10)
            self.ledger.settle_call(reservation, prompt_tokens=100, completion_tokens=10, cost=cost)
        self.signal.set()
        return EngineAnswer(findings(), None)


# #396-T10
def test_a_dynamic_run_superseded_before_it_would_publish_writes_nothing_and_reports_the_ledger(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    signal = SupersedeSignal()
    monkeypatch.setattr(SupersededMidRun, "signal", signal, raising=False)
    monkeypatch.setattr(runner, "DynamicEngine", SupersededMidRun)
    script(monkeypatch, costs=THREE_PRICED)
    written: list[str] = []

    def publish(job: Job, found: Any) -> Published:
        written.append("summary")
        return Published("https://github.test/c/1", True)

    def note(job: Job, code: ErrorCode, reason: str | None) -> None:
        written.append("note")

    result = run_dynamic(tmp_path, signal, publish=publish, note=note)

    assert written == []
    assert result.ok is False
    assert result.error_code is ErrorCode.SUPERSEDED
    assert result.comment_url is None
    assert result.usage is not None and result.usage.ai_calls == 2
    assert result.usage.cost_usd == pytest.approx(0.003, rel=0, abs=1e-12)


# #396-T11
def test_a_lease_check_that_says_superseded_ends_the_run_superseded_and_writes_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    script(monkeypatch, costs=THREE_PRICED)
    written: list[str] = []

    result = run_dynamic(
        tmp_path,
        SupersedeSignal(),
        lease=LeaseState.SUPERSEDED,
        publish=noting(written, "summary"),
        note=noting(written, "note"),
    )

    assert written == []
    assert result.error_code is ErrorCode.SUPERSEDED
    assert result.usage is not None and result.usage.ai_calls == 3


# #396-T10: the engine failed because the proxy refused a request after the signal.
def test_a_dynamic_run_whose_engine_failed_after_the_signal_ends_superseded_without_a_note(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from code_reviewer_runner.dynamic_review.adapter import EngineError

    signal = SupersedeSignal()

    class FailsAfterSignal(ScriptedEngine):
        def run(self) -> EngineAnswer:
            reservation = self.ledger.reserve_call("x" * 400, output_tokens=10)
            self.ledger.settle_call(
                reservation, prompt_tokens=100, completion_tokens=10, cost=Decimal("0.001")
            )
            signal.set()
            return EngineAnswer(None, EngineError(ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "ended"))

    monkeypatch.setattr(runner, "DynamicEngine", FailsAfterSignal)
    written: list[str] = []

    result = run_dynamic(tmp_path, signal, note=noting(written, "note"))

    assert written == []
    assert result.error_code is ErrorCode.SUPERSEDED
    assert result.usage is not None and result.usage.cost_usd == pytest.approx(0.001)


# #396-T10
def test_a_dynamic_run_that_is_not_superseded_publishes_as_before(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    script(monkeypatch, costs=THREE_PRICED)

    result = run_dynamic(tmp_path, SupersedeSignal())

    assert result.ok is True


# -- the entry point ----------------------------------------------------------------------------


# #396-T08: the whole way in one process: the signal reaches `main()`, which turns it into the end
# of the run.
def test_a_signal_during_a_diff_run_through_main_ends_it_superseded_and_prints_one_line(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import io
    import json
    import os
    import signal

    from code_reviewer_runner.supersede import PROCESS_SIGNAL

    model = Provider(monkeypatch)
    published = spy_on_comments(monkeypatch)

    async def double() -> bool:
        first = asyncio.ensure_future(model.ask())
        await asyncio.sleep(0.05)
        os.kill(os.getpid(), signal.SIGUSR1)  # what the job host does when the app says superseded
        await asyncio.sleep(0.05)
        with pytest.raises(Exception, match="superseded"):
            await model.ask()
        model.release.set()
        await first
        provider_with_pull().publish_comment(f"## PR Reviewer Guide\n\n{REVIEW_MARKER}\n\nbody")
        return True

    use_double(monkeypatch, double)
    from test_runner import job_json

    PROCESS_SIGNAL.clear()
    out = io.StringIO()
    try:
        code = runner.main([], stdin=io.StringIO(json.dumps(job_json())), stdout=out)
    finally:
        PROCESS_SIGNAL.clear()

    lines = out.getvalue().splitlines()
    assert len(lines) == 1
    result = json.loads(lines[0])
    assert code == 1
    assert result["errorCode"] == "superseded"
    assert result["usage"]["costUsd"] == pytest.approx(0.0042)
    assert result["commentUrl"] is None
    assert published == []
