# SPDX-License-Identifier: LicenseRef-Proprietary

"""`run_dynamic_job` with a native claim (#578): the checks before the engine, the conclusion after
it, and the line of the finalization in the result are the legacy path's; the engine's side is the
double of `test_native_job.py`. A job without an entry is a job of today."""

import json
import sys
from collections.abc import Callable, Generator
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from native_job_support import API_KEY, ENTRY, MANAGED_COST, OWN_COST, native_document, native_job
from test_native_job import FakeEngine, content_at, upstream_for

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from passthrough_support import ScriptedUpstream, streamed

from code_reviewer_runner import runner
from code_reviewer_runner.capabilities import ALL_ENGINES
from code_reviewer_runner.dynamic_findings import DynamicFindings
from code_reviewer_runner.dynamic_review.adapter import EngineAnswer
from code_reviewer_runner.dynamic_review.checkout import PreparedContent
from code_reviewer_runner.dynamic_review.finalization_log import FinalizationRecord
from code_reviewer_runner.dynamic_review.native_job import NativeSeams
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily
from code_reviewer_runner.dynamic_review.publish import Published
from code_reviewer_runner.job import Job, parse_job
from code_reviewer_runner.llm_providers import ANTHROPIC, PROVIDERS
from code_reviewer_runner.result import ErrorCode


class Publisher:
    URL = "https://github.com/octo/repo/pull/7#issuecomment-4001"

    def __init__(self) -> None:
        self.calls: list[DynamicFindings] = []

    def __call__(
        self, job: Job, found: DynamicFindings, may_write: Callable[[], bool] | None = None
    ) -> Published:
        self.calls.append(found)
        return Published(comment_url=self.URL, created=True)


def prepare_in(tmp_path: Path) -> Callable[[Job], Any]:
    @contextmanager
    def prepare(job: Job) -> Generator[PreparedContent]:
        export = tmp_path / "export"
        export.mkdir(exist_ok=True)
        yield content_at(export)

    return prepare


def environment(tmp_path: Path) -> dict[str, str]:
    ripgrep = tmp_path / "tools" / "rg"
    ripgrep.parent.mkdir(exist_ok=True)
    ripgrep.write_text("#!/bin/sh\n", encoding="utf-8")
    ripgrep.chmod(0o755)
    return {
        runner.OPENCODE_COMMAND_VARIABLE: "opencode",
        runner.RIPGREP_PATH_VARIABLE: str(ripgrep),
    }


def run(
    tmp_path: Path,
    job: Job | None = None,
    *,
    upstream: ScriptedUpstream | None = None,
    engine_factory: Any = FakeEngine,
    seen: list[str] | None = None,
    env: dict[str, str] | None = None,
) -> tuple[Any, Publisher]:
    publisher = Publisher()
    result = runner.run_dynamic_job(
        job or native_job(),
        None,
        0.0,
        {**environment(tmp_path), **(env or {})},
        engines=ALL_ENGINES,
        prepare=prepare_in(tmp_path),
        publish=publisher,
        native=NativeSeams(
            upstream_for=upstream_for(upstream or ScriptedUpstream(streamed_family()), seen),
            engine_factory=engine_factory,
        ),
    )
    return result, publisher


def streamed_family() -> Any:
    return streamed(WireFamily.ANTHROPIC_MESSAGES)


@pytest.fixture(autouse=True)
def _forget_engines() -> None:
    FakeEngine.made.clear()


class RecordingEngine(FakeEngine):
    """A `FakeEngine` that also finishes the way the real finalization does."""

    def run(self) -> EngineAnswer:
        answer = super().run()
        self.finalization = FinalizationRecord()
        return answer


# #578-T11
def test_a_native_job_runs_through_the_passthrough_and_is_published(tmp_path: Path) -> None:
    result, publisher = run(tmp_path, engine_factory=RecordingEngine)

    assert result.ok, result.log_tail
    assert result.comment_url == Publisher.URL
    assert len(publisher.calls) == 1
    assert FakeEngine.made[0].options["plain_final"] is True
    assert result.usage is not None
    assert result.usage.ai_calls == 1


# #578-T17
def test_the_result_carries_the_finalization_line(tmp_path: Path) -> None:
    result, _publisher = run(tmp_path, engine_factory=RecordingEngine)

    assert "finalization first=ok repaired=false second=none" in result.log_tail


# #578-T10
def test_a_native_job_never_builds_the_legacy_proxy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def refuse(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("the legacy proxy must not be built for a native job")

    monkeypatch.setattr(runner, "ModelProxy", refuse)

    result, _publisher = run(tmp_path, engine_factory=RecordingEngine)

    assert result.ok, result.log_tail


# #578-T10
def test_a_job_without_an_entry_still_takes_the_legacy_path(tmp_path: Path) -> None:
    # No entry and no policy: the job of today. Without a capability descriptor it ends at once, as
    # it did before, which proves the native branch was not taken.
    document = native_document()
    del document["dynamic"]["modelEntry"]
    del document["dynamic"]["cost"]

    result, _publisher = run(tmp_path, parse_job(json.dumps(document)))

    assert result.ok is False
    assert FakeEngine.made == []
    assert result.error_code in (
        ErrorCode.DYNAMIC_CONFIG_INVALID,
        ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED,
    )


# #578-T13
def test_an_address_the_guard_refuses_ends_the_job_before_anything_is_prepared(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # See T13 in `test_native_job.py`: the registry names the refused address so that the guard of
    # the address is what ends the job.
    monkeypatch.setitem(
        PROVIDERS, "anthropic", replace(ANTHROPIC, default_api_base="https://10.0.0.5")
    )
    job = native_job(entry={**ENTRY, "upstreamBaseUrl": "https://10.0.0.5"})
    prepared: list[str] = []

    @contextmanager
    def prepare(_job: Job) -> Generator[PreparedContent]:
        prepared.append("prepared")
        yield content_at(tmp_path)

    result = runner.run_dynamic_job(
        job,
        None,
        0.0,
        environment(tmp_path),
        engines=ALL_ENGINES,
        prepare=prepare,
        publish=Publisher(),
    )

    assert result.ok is False
    assert result.error_code is ErrorCode.DYNAMIC_CONFIG_INVALID
    assert prepared == []
    assert FakeEngine.made == []
    assert "10.0.0.5" not in result.log_tail


# #578-T12
def test_the_real_key_is_in_no_line_of_the_result(tmp_path: Path) -> None:
    result, _publisher = run(tmp_path, engine_factory=RecordingEngine)

    assert API_KEY not in result.to_line()


# #578-T14
def test_the_managed_run_is_priced_by_the_book_of_the_claim(tmp_path: Path) -> None:
    result, _publisher = run(
        tmp_path, native_job(cost=MANAGED_COST), engine_factory=RecordingEngine
    )

    assert result.ok, result.log_tail
    assert result.usage is not None
    assert result.usage.cost_usd is not None and result.usage.cost_usd > 0


# #578-T14
def test_an_own_key_without_a_price_reports_no_cost_and_still_runs(tmp_path: Path) -> None:
    result, _publisher = run(tmp_path, native_job(cost=OWN_COST), engine_factory=RecordingEngine)

    assert result.ok, result.log_tail
    assert result.usage is not None
    assert result.usage.ai_calls == 1
    assert result.usage.cost_usd is None


# #578-T11
def test_a_failed_review_keeps_the_usage_and_the_finalization_line(tmp_path: Path) -> None:
    class Failing(RecordingEngine):
        def run(self) -> EngineAnswer:
            super().run()
            from code_reviewer_runner.dynamic_review.adapter import EngineError

            return EngineAnswer(
                findings=None, error=EngineError(ErrorCode.LLM_OUTPUT_INVALID, "after one repair")
            )

    result, publisher = run(tmp_path, engine_factory=Failing)

    assert result.ok is False
    assert result.error_code is ErrorCode.LLM_OUTPUT_INVALID
    assert publisher.calls == []
    assert result.usage is not None
    assert "finalization first=ok" in result.log_tail
