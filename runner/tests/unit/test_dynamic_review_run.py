# SPDX-License-Identifier: Apache-2.0

"""Pins down the runner-side wiring of a Dynamic Review (#197).

A Dynamic job never falls back to PR-Agent and never starts an engine without trusted runner
configuration: without an engine command, without a prepared checkout or without a usable model
capability descriptor the run ends with a stable code before any process or credential is touched.
"""

import io
import json
from collections.abc import Generator
from contextlib import contextmanager
from typing import Any

import pytest

from code_reviewer_runner import runner
from code_reviewer_runner.capabilities import ALL_ENGINES, ENGINE_DIFF
from code_reviewer_runner.dynamic_review.checkout import PreparedContent
from code_reviewer_runner.job import Job, parse_job
from code_reviewer_runner.result import ErrorCode

TOKEN = "dummy-installation-token-0123456789"
API_KEY = "dummy-openrouter-key-0123456789"
HEAD = "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01"
CAPABILITIES = json.dumps(
    {"tool_choice_required": True, "structured_output": True, "max_output_tokens": 4096}
)


def dynamic_document(**llm: Any) -> dict[str, Any]:
    return {
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
            "token": TOKEN,
            "botLogin": "code-reviewer[bot]",
        },
        "llm": {
            "provider": "openrouter",
            "model": "deepseek/deepseek-v4.1-flash",
            "apiKey": API_KEY,
            **llm,
        },
    }


def dynamic_job(**llm: Any) -> Job:
    return parse_job(json.dumps(dynamic_document(**llm)))


@contextmanager
def never_prepared(job: Job) -> Generator[PreparedContent]:
    raise AssertionError("a refused job must not prepare a checkout")
    yield  # pragma: no cover


# #197-T11
def test_a_dynamic_job_without_an_engine_is_refused_and_pr_agent_is_never_used() -> None:
    result = runner.run_dynamic_job(dynamic_job(), None, 0.0, {}, engines=ALL_ENGINES)

    assert result.ok is False
    assert result.error_code is ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE


# #197-T11
def test_a_dynamic_job_without_a_prepared_checkout_is_refused() -> None:
    result = runner.run_dynamic_job(
        dynamic_job(),
        None,
        0.0,
        {runner.OPENCODE_COMMAND_VARIABLE: "opencode"},
        engines=ALL_ENGINES,
    )

    assert result.ok is False
    assert result.error_code is ErrorCode.CHECKOUT_INCOMPLETE


# #197-T11
def test_a_dynamic_job_without_a_capability_descriptor_is_refused() -> None:
    result = runner.run_dynamic_job(
        dynamic_job(),
        None,
        0.0,
        {
            runner.OPENCODE_COMMAND_VARIABLE: "opencode",
        },
        engines=ALL_ENGINES,
        prepare=never_prepared,
    )

    assert result.ok is False
    assert result.error_code is ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED


# #197-T11
def test_an_unusable_capability_descriptor_is_refused_before_the_engine_starts() -> None:
    result = runner.run_dynamic_job(
        dynamic_job(),
        None,
        0.0,
        {
            runner.OPENCODE_COMMAND_VARIABLE: "opencode",
            runner.DYNAMIC_CAPABILITIES_VARIABLE: json.dumps(
                {"tool_choice_required": False, "structured_output": True, "max_output_tokens": 1}
            ),
        },
        engines=ALL_ENGINES,
        prepare=never_prepared,
    )

    assert result.ok is False
    assert result.error_code is ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED


# #197-T11
def test_a_dynamic_job_is_refused_when_the_runner_did_not_advertise_the_engine() -> None:
    # Fully configured, but the runner only advertises PR-Agent: the engine is never started. A
    # nonexistent command proves nothing was launched (it would fail differently).
    environment = {
        runner.OPENCODE_COMMAND_VARIABLE: "/nonexistent/opencode",
        runner.DYNAMIC_CAPABILITIES_VARIABLE: CAPABILITIES,
    }

    for engines in ((), (ENGINE_DIFF,)):
        result = runner.run_dynamic_job(
            dynamic_job(), None, 0.0, environment, engines=engines, prepare=never_prepared
        )

        assert result.ok is False
        assert result.error_code is ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE
        assert result.log_tail is not None and "not advertised" in result.log_tail


# #197-T11
def test_the_runner_process_never_runs_a_dynamic_job_while_the_isolation_check_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Production advertises only what the self-check proved; until #202 supplies the probes that is
    # never `opencode`, so even a fully configured environment cannot start the stock engine.
    monkeypatch.setenv(runner.OPENCODE_COMMAND_VARIABLE, "/nonexistent/opencode")
    monkeypatch.setenv(runner.DYNAMIC_CAPABILITIES_VARIABLE, CAPABILITIES)

    def must_not_start(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("the engine must not be created")

    monkeypatch.setattr(runner, "DynamicEngine", must_not_start)
    out = io.StringIO()

    code = runner.main([], stdin=io.StringIO(json.dumps(dynamic_document())), stdout=out)

    result = json.loads(out.getvalue())
    assert code == 1
    assert result["errorCode"] == ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE.value
