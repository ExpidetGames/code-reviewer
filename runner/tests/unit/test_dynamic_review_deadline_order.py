# SPDX-License-Identifier: Apache-2.0

"""Pins down which outcome wins when the whole-job deadline and the engine fail together (#241).

The message call is given the time left to the deadline as its socket timeout, so a hung provider
makes the call fail at the very moment the watch notices the deadline. Both are the same cause, and
the result must not depend on which thread looks first: a failure at or after the deadline is a
budget outcome, only an earlier one is `dynamic_engine_unavailable`. The clock is moved by hand and
the transport is scripted, so nothing here waits or races.
"""

import json
import threading
from collections.abc import Callable, Mapping
from pathlib import Path

import pytest

from code_reviewer_runner.dynamic_review import findings_schema
from code_reviewer_runner.dynamic_review.adapter import (
    DynamicEngine,
    EngineClient,
    EngineError,
)
from code_reviewer_runner.dynamic_review.budget import BudgetLedger, DynamicLimits, LimitError
from code_reviewer_runner.dynamic_review.prompts import ReviewInputs
from code_reviewer_runner.job import Job, parse_job
from code_reviewer_runner.result import ErrorCode

HEAD = "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01"
DEADLINE = 4.0
UNREACHABLE = EngineError(ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "the engine is not reachable")


class Clock:
    """A monotonic clock a test moves by hand."""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def dynamic_job() -> Job:
    return parse_job(
        json.dumps(
            {
                "prUrl": "https://github.com/octo/repo/pull/7",
                "command": "review",
                "reviewKind": "dynamic",
                "dynamic": {
                    "model": "deepseek-v4.1-flash",
                    "skill": "Look for real bugs.",
                    "limits": {"maxFindings": 5},
                },
                "base": {
                    "repository": "octo/repo",
                    "baseRef": "main",
                    "headSha": HEAD,
                    "previousReviewedSha": None,
                    "comparison": "full",
                },
                "git": {
                    "provider": "github",
                    "baseUrl": "https://api.github.com",
                    "token": "dummy-installation-token-0123456789",
                    "botLogin": "code-reviewer[bot]",
                },
                "llm": {
                    "provider": "openrouter",
                    "model": "deepseek/deepseek-v4.1-flash",
                    "apiKey": "dummy-openrouter-key-0123456789",
                },
            }
        )
    )


def engine_with(
    tmp_path: Path, clock: Clock, transport: Callable[..., tuple[int, bytes]]
) -> tuple[DynamicEngine, EngineClient]:
    job = dynamic_job()
    engine = DynamicEngine(
        job,
        ledger=BudgetLedger(DynamicLimits(deadline_seconds=DEADLINE), clock=clock),
        command=["unused"],
        directory=str(tmp_path / "export"),
        proxy_url="http://127.0.0.1:9",
        proxy_capability="capability",
        agent_prompt="prompt",
        model_schema=findings_schema(),
        inputs=ReviewInputs(pr_url=job.pr_url, pr_title="t", pr_body="b", diff=""),
        exported_paths=frozenset(),
        scratch_dir=str(tmp_path / "scratch"),
        require_ripgrep=False,
    )
    # The process is not what these tests are about: it is alive unless a test says otherwise.
    engine._is_running = lambda: True  # type: ignore[method-assign]  # pyright: ignore[reportPrivateUsage]
    return engine, EngineClient("http://127.0.0.1:9", engine.directory, transport=transport)


def failing_message_call(clock: Clock, *, at: float) -> Callable[..., tuple[int, bytes]]:
    """A transport whose message call fails like a socket timeout, with the clock at `at`."""

    def transport(
        method: str, url: str, body: bytes | None, headers: Mapping[str, str], timeout: float
    ) -> tuple[int, bytes]:
        clock.now = at
        raise UNREACHABLE

    return transport


# #241-T02
def test_a_message_call_that_fails_at_the_deadline_is_a_budget_outcome(tmp_path: Path) -> None:
    clock = Clock()
    engine, client = engine_with(tmp_path, clock, failing_message_call(clock, at=DEADLINE))
    with pytest.raises(LimitError) as raised:
        engine._send(client, "session")  # pyright: ignore[reportPrivateUsage]

    assert raised.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED


# #241-T02
def test_a_message_call_that_fails_after_the_deadline_is_a_budget_outcome(tmp_path: Path) -> None:
    clock = Clock()
    engine, client = engine_with(tmp_path, clock, failing_message_call(clock, at=DEADLINE + 0.4))
    with pytest.raises(LimitError) as raised:
        engine._send(client, "session")  # pyright: ignore[reportPrivateUsage]

    assert raised.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED


# #241-T02
def test_a_message_call_that_fails_before_the_deadline_is_the_engine_being_unavailable(
    tmp_path: Path,
) -> None:
    clock = Clock()
    engine, client = engine_with(tmp_path, clock, failing_message_call(clock, at=DEADLINE - 0.5))
    with pytest.raises(EngineError) as raised:
        engine._send(client, "session")  # pyright: ignore[reportPrivateUsage]

    assert not isinstance(raised.value, LimitError)
    assert raised.value.code is ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE


def hung_message_call(release: threading.Event) -> Callable[..., tuple[int, bytes]]:
    def transport(
        method: str, url: str, body: bytes | None, headers: Mapping[str, str], timeout: float
    ) -> tuple[int, bytes]:
        release.wait(10.0)
        raise UNREACHABLE

    return transport


# #241-T02
@pytest.mark.parametrize(
    ("clock_at", "code"),
    [
        (DEADLINE, ErrorCode.DYNAMIC_BUDGET_EXCEEDED),
        (DEADLINE - 0.5, ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE),
    ],
)
def test_an_engine_that_exits_during_the_message_follows_the_deadline_order(
    tmp_path: Path, clock_at: float, code: ErrorCode
) -> None:
    clock = Clock()
    release = threading.Event()
    engine, client = engine_with(tmp_path, clock, hung_message_call(release))
    clock.now = clock_at
    engine._is_running = lambda: False  # type: ignore[method-assign]  # pyright: ignore[reportPrivateUsage]
    try:
        with pytest.raises((EngineError, LimitError)) as raised:
            engine._send(client, "session")  # pyright: ignore[reportPrivateUsage]
    finally:
        release.set()

    assert raised.value.code is code
