# SPDX-License-Identifier: Apache-2.0

"""What `build_native_job` hands to the ledger, the proxy and the engine (#578), pinned one value at
a time: each of these is a number or a switch that decides what a run may spend, and a mutation of
any of them used to leave the tests green (review of PR #580).

The engine is the double of `test_native_job.py`; the provider is the strict double of the
passthrough tests; the requests are real ones through the production proxy.
"""

import http.client
import json
import sys
from decimal import Decimal
from pathlib import Path
from typing import Any, ClassVar

import pytest
from native_job_support import (
    CHAT_ENTRY,
    CHAT_MODEL,
    ENTRY,
    MANAGED_COST,
    MODEL,
    OWN_COST,
    native_job,
)
from test_native_job import FakeEngine, content_at, proxy_address, started, upstream_for

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fakes.wire.formats import Turn, stream
from passthrough_support import FAKE, Scripted, ScriptedUpstream, failing
from passthrough_support import MODEL as FAKE_MODEL

from code_reviewer_runner.dynamic_review.adapter import EngineAnswer
from code_reviewer_runner.dynamic_review.budget import (
    REASONING_OUTPUT_FLOOR_TOKENS,
    BudgetLedger,
    LimitError,
)
from code_reviewer_runner.dynamic_review.finalization_log import FinalizationRecord
from code_reviewer_runner.dynamic_review.native_job import (
    NativeJob,
    build_native_job,
    run_native_engine,
)
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily, spec_of
from code_reviewer_runner.job import Job
from code_reviewer_runner.result import ErrorCode

TOOL = Turn(tool="read", args={"filePath": "/x"})


@pytest.fixture(autouse=True)
def _forget_engines() -> None:
    FakeEngine.made.clear()


class Driver(FakeEngine):
    """An engine double that makes `requests` calls, the way the real one asks the proxy, and ends
    the way the real finalization does."""

    requests: ClassVar[int] = 1

    def __init__(self, job: Job, **options: Any) -> None:
        super().__init__(job, **options)
        self.statuses: list[int] = []

    def run(self) -> EngineAnswer:
        entry = self.job.dynamic.model_entry if self.job.dynamic else None
        assert entry is not None
        spec = spec_of(WireFamily(entry.family))
        host, port = proxy_address(self.options["proxy_url"])
        headers = {
            spec.key_header: spec.key_value(self.options["proxy_capability"]),
            "content-type": "application/json",
        }
        if entry.family == "anthropic-messages":
            headers["anthropic-version"] = "2023-06-01"
        body = json.dumps(
            {
                "model": entry.model_id,
                "stream": True,
                "max_tokens": 1000,
                "messages": [{"role": "user", "content": "x" * 6000}],
            }
        ).encode()
        for _ in range(self.requests):
            connection = http.client.HTTPConnection(host, port, timeout=10)
            connection.request("POST", spec.engine_target(entry.model_id), body, headers)
            response = connection.getresponse()
            response.read()
            self.statuses.append(response.status)
            connection.close()
        self.finalization = FinalizationRecord()
        return EngineAnswer(findings=None, error=None)


def scripted(family: WireFamily, *turns: Turn) -> ScriptedUpstream:
    return ScriptedUpstream(
        *[
            Scripted(chunks=list(stream(FAKE[family], turn, call, FAKE_MODEL)))
            for call, turn in enumerate(turns, start=1)
        ]
    )


def drive(
    native: NativeJob, job: Job, tmp_path: Path, calls: int, **options: Any
) -> tuple[Any, Driver]:
    export = tmp_path / "export"
    export.mkdir(exist_ok=True)
    Driver.requests = calls
    outcome = run_native_engine(
        native,
        job,
        command=["unused"],
        content=content_at(export),
        launch=None,
        node_bin=None,
        ripgrep=None,
        superseded=options.pop("superseded", lambda: False),
        engine_factory=Driver,  # type: ignore[arg-type]
        **options,
    )
    engine = FakeEngine.made[0]
    assert isinstance(engine, Driver)
    return outcome, engine


def engine_at(index: int) -> Driver:
    engine = FakeEngine.made[index]
    assert isinstance(engine, Driver)
    return engine


def call_entries(native: NativeJob) -> list[dict[str, Any]]:
    trace = native.ledger.trace.to_json()
    assert trace is not None
    return trace["modelCalls"]


JOBS = {
    WireFamily.ANTHROPIC_MESSAGES: (ENTRY, MODEL, "anthropic"),
    WireFamily.OPENAI_CHAT: (CHAT_ENTRY, CHAT_MODEL, "openrouter"),
}


def job_of(family: WireFamily, **options: Any) -> Job:
    entry, model, provider = JOBS[family]
    return native_job(entry=entry, model=model, provider=provider, **options)


# -- 1. why a call ended ----------------------------------------


# #578-T19
@pytest.mark.parametrize(
    ("family", "last", "expected"),
    [
        (WireFamily.ANTHROPIC_MESSAGES, Turn(text="done"), "stop"),
        (WireFamily.ANTHROPIC_MESSAGES, Turn(text="cut", finish="max_tokens"), "length"),
        (WireFamily.OPENAI_CHAT, Turn(text="done"), "stop"),
        (WireFamily.OPENAI_CHAT, Turn(text="cut", finish="length"), "length"),
    ],
)
def test_the_trace_and_the_finalization_line_say_why_the_last_call_ended(
    tmp_path: Path, family: WireFamily, last: Turn, expected: str
) -> None:
    job = job_of(family)
    upstream = scripted(family, TOOL, last)
    with started(tmp_path, job, upstream) as (native, job, _upstream):
        outcome, engine = drive(native, job, tmp_path, calls=2)

    assert engine.statuses == [200, 200]
    calls = call_entries(native)
    assert [call["finishReason"] for call in calls] == ["tool_calls", expected]
    assert f"finish={expected} " in outcome.finalization


# -- 2. superseded ----------------------------------------


# #578-T20
@pytest.mark.parametrize("family", list(JOBS))
def test_a_superseded_native_run_sends_nothing_more_to_the_provider(
    tmp_path: Path, family: WireFamily
) -> None:
    job = job_of(family)
    upstream = scripted(family, Turn(text="done"))
    native = build_native_job(
        job,
        deadline=600.0,
        environment={},
        superseded=lambda: True,
        upstream_for=upstream_for(upstream),
    )

    _outcome, engine = drive(native, job, tmp_path, calls=3, superseded=lambda: True)

    assert engine.statuses == [403, 403, 403]
    assert upstream.requests == []
    assert native.ledger.model_calls == 0
    failure = native.ledger.failure
    assert failure is not None and failure.code is ErrorCode.SUPERSEDED


# #578-T20
def test_the_signal_that_ends_the_run_is_seen_by_the_next_request_and_not_the_one_before(
    tmp_path: Path,
) -> None:
    flag = [False]
    job = job_of(WireFamily.ANTHROPIC_MESSAGES)
    upstream = scripted(WireFamily.ANTHROPIC_MESSAGES, Turn(text="done"))
    native = build_native_job(
        job,
        deadline=600.0,
        environment={},
        superseded=lambda: flag[0],
        upstream_for=upstream_for(upstream),
    )

    drive(native, job, tmp_path, calls=1)
    flag[0] = True
    drive(native, job, tmp_path, calls=1)

    assert engine_at(0).statuses == [200]
    assert engine_at(1).statuses == [403]
    assert len(upstream.requests) == 1


# #578-T20
def test_the_engine_is_given_the_signal_the_runner_gave_and_the_server_is_drained(
    tmp_path: Path,
) -> None:
    asked: list[str] = []

    def signal() -> bool:
        asked.append("asked")
        return True

    with started(tmp_path) as (native, job, _upstream):
        drive(native, job, tmp_path, calls=0, superseded=signal)

    assert FakeEngine.made[0].options["superseded"] is signal
    assert asked, "the run asked whether it was superseded when the server stopped"


# -- 3. what the engine is told about the provider ----------------------------------------


# #578-T21
def test_the_engine_can_ask_the_proxy_why_the_provider_failed(tmp_path: Path) -> None:
    upstream = ScriptedUpstream(failing(WireFamily.ANTHROPIC_MESSAGES, 503))
    with started(tmp_path, upstream=upstream) as (native, job, _upstream):
        drive(native, job, tmp_path, calls=1)

    ask = FakeEngine.made[0].options["provider_error"]
    assert native.run.proxy.last_upstream_error is not None
    assert ask() is native.run.proxy.last_upstream_error


# -- 4. the limits of the model ----------------------------------------


# #578-T22
def test_the_ledger_has_the_window_and_the_output_limit_of_the_entry() -> None:
    ledger: BudgetLedger = build_native_job(
        native_job(), deadline=600.0, environment={}, upstream_for=upstream_for(scripted_none())
    ).ledger

    assert ledger.window_tokens == ENTRY["model"]["limit"]["context"]
    assert ledger.output_tokens == ENTRY["model"]["limit"]["output"]
    assert ledger.window_tokens != ledger.output_tokens


def scripted_none() -> ScriptedUpstream:
    return ScriptedUpstream(Scripted())


# #578-T22
def test_a_prompt_the_window_of_the_entry_cannot_hold_is_refused_before_the_provider() -> None:
    small = {**ENTRY, "model": {**ENTRY["model"], "limit": {"context": 4000, "output": 1000}}}
    job = native_job(entry=small)
    upstream = scripted(WireFamily.ANTHROPIC_MESSAGES, Turn(text="done"))
    native = build_native_job(
        job, deadline=600.0, environment={}, upstream_for=upstream_for(upstream)
    )

    with pytest.raises(LimitError):
        native.ledger.reserve_call("x" * 40_000, output_tokens=1000)

    assert native.ledger.window_tokens == 4000
    assert upstream.requests == []


# #578-T22
def test_a_model_that_thinks_reserves_the_reasoning_floor_and_one_that_does_not_does_not() -> None:
    thinking_entry = {**ENTRY, "model": {**ENTRY["model"], "reasoning": True}}

    def reserved(job: Job) -> Decimal:
        native = build_native_job(
            job, deadline=600.0, environment={}, upstream_for=upstream_for(scripted_none())
        )
        return native.ledger.reserve_call("hello", output_tokens=8192).cost

    # The output a call is expected to use, at the output price of the book (15 USD per Mtok).
    floor = Decimal(REASONING_OUTPUT_FLOOR_TOKENS) * 15 / 1_000_000
    assert reserved(native_job(entry=thinking_entry)) >= floor
    assert reserved(native_job()) < floor


# -- 5. the line about the cache ----------------------------------------


# #578-T24
def test_the_outcome_carries_the_line_about_the_prompt_cache(tmp_path: Path) -> None:
    with started(tmp_path, upstream=scripted(WireFamily.ANTHROPIC_MESSAGES, Turn(text="x"))) as (
        native,
        job,
        _upstream,
    ):
        outcome, _engine = drive(native, job, tmp_path, calls=1)

    assert outcome.cache_line is not None
    assert outcome.cache_line.startswith("prompt cache: 1 call, ")


# #578-T24
def test_a_run_without_a_priced_call_has_no_cache_line(tmp_path: Path) -> None:
    with started(tmp_path, upstream=ScriptedUpstream(Scripted())) as (native, job, _upstream):
        outcome, _engine = drive(native, job, tmp_path, calls=0)

    assert outcome.cache_line is None


# -- 6. the policy of the key ----------------------------------------


# #578-T14
def test_an_own_key_is_booked_by_tokens_and_a_managed_one_by_the_book(tmp_path: Path) -> None:
    own = job_of(WireFamily.ANTHROPIC_MESSAGES, cost=OWN_COST)
    managed = job_of(WireFamily.ANTHROPIC_MESSAGES, cost=MANAGED_COST)
    with started(tmp_path, own, scripted(WireFamily.ANTHROPIC_MESSAGES, Turn(text="x"))) as (
        native_own,
        job_own,
        _u,
    ):
        drive(native_own, job_own, tmp_path, calls=1)
    FakeEngine.made.clear()
    with started(tmp_path, managed, scripted(WireFamily.ANTHROPIC_MESSAGES, Turn(text="x"))) as (
        native_managed,
        job_managed,
        _u,
    ):
        drive(native_managed, job_managed, tmp_path, calls=1)

    assert call_entries(native_own)[0]["costUsd"] is None
    assert call_entries(native_managed)[0]["costUsd"] is not None
