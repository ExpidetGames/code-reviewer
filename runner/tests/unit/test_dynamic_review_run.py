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
from decimal import Decimal
from typing import Any

import pytest

from code_reviewer_runner import runner
from code_reviewer_runner.capabilities import ALL_ENGINES, ENGINE_DIFF
from code_reviewer_runner.dynamic_review.budget import LimitError
from code_reviewer_runner.dynamic_review.checkout import PreparedContent
from code_reviewer_runner.dynamic_review.proxy import (
    capabilities_for_job,
    capabilities_from_config,
)
from code_reviewer_runner.job import Job, JobError, parse_job
from code_reviewer_runner.result import ErrorCode

TOKEN = "dummy-installation-token-0123456789"
API_KEY = "dummy-openrouter-key-0123456789"
HEAD = "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01"
# What an operator sets for the model: the features, the output bound and the unit costs.
CAPABILITIES = json.dumps(
    {
        "tool_choice_required": True,
        "structured_output": True,
        "max_output_tokens": 4096,
        "input_usd_per_mtok": 0.5,
        "output_usd_per_mtok": 2,
    }
)
UNPRICED_CAPABILITIES = json.dumps(
    {"tool_choice_required": True, "structured_output": True, "max_output_tokens": 4096}
)


def dynamic_document(**llm: Any) -> dict[str, Any]:
    return {
        "prUrl": "https://github.com/octo/repo/pull/7",
        "command": "review",
        "reviewKind": "dynamic",
        "dynamic": {
            "model": "deepseek/deepseek-v4.1-flash",
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


# #553-R08
def test_a_job_with_a_cost_policy_is_refused_where_nothing_enforces_it() -> None:
    # Only the passthrough path reads the policy. A job that carries one and would reach the legacy
    # wire must not run with a bound it never read: it ends before anything is prepared.
    document = dynamic_document()
    document["dynamic"]["cost"] = {"keyMode": "own", "priceBook": None, "maxTotalTokens": 4_000_000}
    result = runner.run_dynamic_job(
        parse_job(json.dumps(document)),
        None,
        0.0,
        {
            runner.OPENCODE_COMMAND_VARIABLE: "opencode",
            runner.DYNAMIC_CAPABILITIES_VARIABLE: CAPABILITIES,
        },
        engines=ALL_ENGINES,
        prepare=never_prepared,
    )

    assert result.ok is False
    assert result.error_code is ErrorCode.DYNAMIC_CONFIG_INVALID


# #197-T04
def test_a_dynamic_job_without_an_injected_preparer_needs_the_root_supervisor() -> None:
    # The default is the production preparation: it seals the export for the dedicated user, which
    # only the root supervisor can do. Anything else is refused with the isolation code (it used
    # to end `checkout_incomplete` because no preparation existed at all).
    result = runner.run_dynamic_job(
        dynamic_job(),
        None,
        0.0,
        {
            runner.OPENCODE_COMMAND_VARIABLE: "opencode",
            runner.DYNAMIC_CAPABILITIES_VARIABLE: CAPABILITIES,
        },
        engines=ALL_ENGINES,
    )

    assert result.ok is False
    assert result.error_code is ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED


# #290-T02: the Diff "Token budget" of the project is not the model's window.
@pytest.mark.parametrize("project_token_budget", [None, 1_000, 100_000, 5_000_000])
def test_the_window_of_a_dynamic_run_is_the_models_and_never_the_projects_token_budget(
    project_token_budget: int | None,
) -> None:
    extra = {} if project_token_budget is None else {"maxTokens": project_token_budget}
    job = dynamic_job(**extra)
    capabilities = capabilities_from_config(None, model=job.llm.model)

    ledger = runner.dynamic_ledger(capabilities, {}, 600.0)

    assert ledger.window_tokens == capabilities.context_window_tokens == 1_048_576
    # About 92 KB of request is far inside it (it was refused at 100,000 "tokens").
    ledger.reserve_call("x" * 92_000)


# #290-T02
def test_an_operator_descriptor_window_is_the_windows_of_the_run() -> None:
    capabilities = capabilities_from_config(
        json.dumps(
            {
                "tool_choice_required": True,
                "structured_output": True,
                "max_output_tokens": 4096,
                "context_window_tokens": 200_000,
                "input_usd_per_mtok": 0.5,
                "output_usd_per_mtok": 2,
            }
        )
    )

    ledger = runner.dynamic_ledger(capabilities, {}, 600.0)

    assert ledger.window_tokens == 200_000
    assert ledger.output_tokens == 4096


# #290-T08: a cost that cannot be priced cannot be bounded before it is spent, so a model without
# unit costs in its descriptor does not run at all (the built-in default model has them built in).
def test_a_model_without_unit_costs_in_its_descriptor_fails_closed_with_a_clear_detail() -> None:
    for extra in ({}, {"context_window_tokens": 200_000}):
        capabilities = capabilities_from_config(
            json.dumps(
                {
                    "tool_choice_required": True,
                    "structured_output": True,
                    "max_output_tokens": 4096,
                    **extra,
                }
            ),
            model=OTHER_MODEL,
        )

        with pytest.raises(LimitError) as refused:
            runner.dynamic_ledger(capabilities, {}, 600.0)

        assert refused.value.code is ErrorCode.DYNAMIC_CONFIG_INVALID
        assert "input_usd_per_mtok" in refused.value.detail
        assert "output_usd_per_mtok" in refused.value.detail


# #290-T08
def test_a_dynamic_job_of_an_unpriced_model_ends_before_anything_is_prepared() -> None:
    result = runner.run_dynamic_job(
        other_model_job(),
        None,
        0.0,
        {
            runner.OPENCODE_COMMAND_VARIABLE: "opencode",
            runner.DYNAMIC_CAPABILITIES_VARIABLE: UNPRICED_CAPABILITIES,
        },
        engines=ALL_ENGINES,
        prepare=never_prepared,
    )

    assert result.ok is False
    assert result.error_code is ErrorCode.DYNAMIC_CONFIG_INVALID


# #290-T10
def test_the_cost_limit_of_a_run_is_the_default_or_the_operators() -> None:
    capabilities = capabilities_from_config(None, model="deepseek/deepseek-v4.1-flash")

    default = runner.dynamic_ledger(capabilities, {}, 600.0)
    blank = runner.dynamic_ledger(capabilities, {runner.DYNAMIC_MAX_COST_VARIABLE: " "}, 600.0)
    raised = runner.dynamic_ledger(capabilities, {runner.DYNAMIC_MAX_COST_VARIABLE: "5"}, 600.0)

    assert default.limits.max_cost_usd == blank.limits.max_cost_usd == Decimal("1.00")
    assert raised.limits.max_cost_usd == Decimal("5")
    assert raised.limits.deadline_seconds == 600.0


# #290-T10
@pytest.mark.parametrize("value", ["0", "-1", "abc", "nan", "21", "1e9"])
def test_an_unusable_operator_cost_limit_fails_the_job_before_anything_is_prepared(
    value: str,
) -> None:
    result = runner.run_dynamic_job(
        dynamic_job(),
        None,
        0.0,
        {
            runner.OPENCODE_COMMAND_VARIABLE: "opencode",
            runner.DYNAMIC_MAX_COST_VARIABLE: value,
        },
        engines=ALL_ENGINES,
        prepare=never_prepared,
    )

    assert result.ok is False
    assert result.error_code is ErrorCode.DYNAMIC_CONFIG_INVALID


# #290-T10: the claim has no field for the cost limit, so nothing a pull request says can set it.
def test_nothing_in_the_job_can_set_the_cost_limit() -> None:
    document = dynamic_document()
    document["dynamic"]["limits"]["maxCostUsd"] = 1000
    with pytest.raises(JobError):
        parse_job(json.dumps(document))
    extra = dynamic_document()
    extra["llm"]["maxCostUsd"] = 1000
    with pytest.raises(JobError):
        parse_job(json.dumps(extra))


OTHER_MODEL = "anthropic/claude-haiku-5.5"


def other_model_job() -> Job:
    document = dynamic_document()
    document["dynamic"]["model"] = OTHER_MODEL
    document["llm"]["model"] = OTHER_MODEL
    return parse_job(json.dumps(document))


class Reached(Exception):
    """Raised by the preparer: the job passed every check that comes before the checkout."""


@contextmanager
def reaching_the_checkout(job: Job) -> Generator[PreparedContent]:
    raise Reached
    yield  # pragma: no cover


# #197-T11 #264-T11: another model than the shipped default has no built-in descriptor.
def test_a_dynamic_job_of_another_model_without_a_capability_descriptor_is_refused() -> None:
    result = runner.run_dynamic_job(
        other_model_job(),
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


# #264-T11: the shipped default model needs no variable: its descriptor ships with the image.
@pytest.mark.parametrize("variable", [None, ""])
def test_a_dynamic_job_of_the_default_model_without_a_descriptor_variable_is_allowed(
    variable: str | None,
) -> None:
    environment = {runner.OPENCODE_COMMAND_VARIABLE: "opencode"}
    if variable is not None:
        environment[runner.DYNAMIC_CAPABILITIES_VARIABLE] = variable

    with pytest.raises(Reached):
        runner.run_dynamic_job(
            dynamic_job(),
            None,
            0.0,
            environment,
            engines=ALL_ENGINES,
            prepare=reaching_the_checkout,
        )


# #264-T11: an empty variable is no licence for another model, however the job spells the default.
@pytest.mark.parametrize(
    "model",
    ["DeepSeek/deepseek-v4.1-flash", "deepseek/deepseek-v4.1-flash:free", "deepseek-v4.1-flash"],
)
def test_only_the_exact_default_model_id_gets_the_built_in_descriptor(model: str) -> None:
    document = dynamic_document()
    document["dynamic"]["model"] = model
    document["llm"]["model"] = model
    result = runner.run_dynamic_job(
        parse_job(json.dumps(document)),
        None,
        0.0,
        {runner.OPENCODE_COMMAND_VARIABLE: "opencode"},
        engines=ALL_ENGINES,
        prepare=never_prepared,
    )

    assert result.error_code is ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED


# #264-T11: what the operator sets keeps its meaning and wins, also for the default model.
def test_a_descriptor_variable_wins_over_the_built_in_one_for_the_default_model() -> None:
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


# #197-T07
def test_sigterm_unwinds_a_dynamic_job_and_arms_a_backstop_that_ends_the_engines(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import os
    import signal
    import time

    stopped: list[str] = []
    monkeypatch.setattr(runner, "_stop_hard", lambda: stopped.append("hard stop"))
    monkeypatch.setattr(runner, "SIGTERM_BACKSTOP_SECONDS", 0.05)
    before = signal.getsignal(signal.SIGTERM)
    unwound: list[str] = []

    with pytest.raises(KeyboardInterrupt), runner._unwind_on_sigterm():  # pyright: ignore[reportPrivateUsage]
        try:
            os.kill(os.getpid(), signal.SIGTERM)
            time.sleep(1)  # the handler raises before this ends
        finally:
            unwound.append("cleanup ran")

    assert unwound == ["cleanup ran"]
    assert signal.getsignal(signal.SIGTERM) is before  # the previous handler is back
    deadline = time.monotonic() + 2
    while not stopped and time.monotonic() < deadline:
        time.sleep(0.01)
    assert stopped == ["hard stop"]


# #202-T09: the job process takes its engines from the loop alone; with nothing handed to it, a
# Dynamic job entering through the real entry point is refused and no checkout is prepared.
def test_a_dynamic_job_entering_the_entry_point_without_advertised_engines_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("RUNNER_ADVERTISED_ENGINES", raising=False)
    monkeypatch.setenv(runner.OPENCODE_COMMAND_VARIABLE, "opencode")
    out = io.StringIO()

    code = runner.main([], stdin=io.StringIO(json.dumps(dynamic_document())), stdout=out)

    result = json.loads(out.getvalue())
    assert code == 1
    assert result["errorCode"] == ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE.value


# #202-T09: a loop that advertised Diff only hands the job process exactly that.
def test_a_dynamic_job_with_only_the_diff_engine_advertised_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RUNNER_ADVERTISED_ENGINES", ENGINE_DIFF)
    monkeypatch.setenv(runner.OPENCODE_COMMAND_VARIABLE, "opencode")
    out = io.StringIO()

    code = runner.main([], stdin=io.StringIO(json.dumps(dynamic_document())), stdout=out)

    assert code == 1
    assert json.loads(out.getvalue())["errorCode"] == "dynamic_engine_unavailable"


# #202-T01: what the loop advertised is what the job process runs on: with `opencode` handed over
# the job gets past the engine check (and then stops at the next missing piece, the model
# description of a model that has no built-in one, with its own stable code).
def test_a_dynamic_job_with_opencode_advertised_gets_past_the_engine_check(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RUNNER_ADVERTISED_ENGINES", "pr-agent,opencode")
    monkeypatch.setenv(runner.OPENCODE_COMMAND_VARIABLE, "opencode")
    monkeypatch.delenv(runner.DYNAMIC_CAPABILITIES_VARIABLE, raising=False)
    out = io.StringIO()
    document = dynamic_document()
    document["dynamic"]["model"] = OTHER_MODEL
    document["llm"]["model"] = OTHER_MODEL

    code = runner.main([], stdin=io.StringIO(json.dumps(document)), stdout=out)

    assert code == 1
    assert json.loads(out.getvalue())["errorCode"] == "dynamic_model_features_unsupported"


# #264-T12: the built-in descriptor describes the destination the request goes to: it follows the
# upstream model (`llm.model`), not the logical name (`dynamic.model`) that only the engine sees.
def test_the_built_in_descriptor_follows_the_upstream_model_not_the_logical_name() -> None:
    environment = {runner.OPENCODE_COMMAND_VARIABLE: "opencode"}

    spoofed = dynamic_document()
    spoofed["llm"]["model"] = OTHER_MODEL  # logical name is the default, the request is not
    refused = runner.run_dynamic_job(
        parse_job(json.dumps(spoofed)),
        None,
        0.0,
        environment,
        engines=ALL_ENGINES,
        prepare=never_prepared,
    )
    assert refused.error_code is ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED

    alias = dynamic_document()
    alias["dynamic"]["model"] = "my-alias"  # a logical name, the destination is the default model
    with pytest.raises(Reached):
        runner.run_dynamic_job(
            parse_job(json.dumps(alias)),
            None,
            0.0,
            environment,
            engines=ALL_ENGINES,
            prepare=reaching_the_checkout,
        )


# #264-T13: a variable that holds only whitespace is as empty as an empty one (a platform may store
# a blank field as a space); for the default model the built-in descriptor then applies.
@pytest.mark.parametrize("blank", [" ", "  ", "\n", "\t \n"])
def test_a_whitespace_only_descriptor_variable_is_empty(blank: str) -> None:
    with pytest.raises(Reached):
        runner.run_dynamic_job(
            dynamic_job(),
            None,
            0.0,
            {
                runner.OPENCODE_COMMAND_VARIABLE: "opencode",
                runner.DYNAMIC_CAPABILITIES_VARIABLE: blank,
            },
            engines=ALL_ENGINES,
            prepare=reaching_the_checkout,
        )

    result = runner.run_dynamic_job(
        other_model_job(),
        None,
        0.0,
        {
            runner.OPENCODE_COMMAND_VARIABLE: "opencode",
            runner.DYNAMIC_CAPABILITIES_VARIABLE: blank,
        },
        engines=ALL_ENGINES,
        prepare=never_prepared,
    )
    assert result.error_code is ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED


def job_with_capabilities(model: str = OTHER_MODEL, **capabilities: Any) -> Job:
    document = dynamic_document()
    document["dynamic"]["model"] = model
    document["llm"]["model"] = model
    document["dynamic"]["capabilities"] = {
        "toolChoiceRequired": True,
        "structuredOutput": True,
        "maxOutputTokens": 4096,
        "contextWindowTokens": 200_000,
        "inputUsdPerMtok": "0.5",
        "outputUsdPerMtok": "2",
        **capabilities,
    }
    return parse_job(json.dumps(document))


# #279-T02: the app's descriptor is what lets any other model run without operator configuration.
def test_a_dynamic_job_of_another_model_runs_on_the_descriptor_the_app_sent() -> None:
    with pytest.raises(Reached):
        runner.run_dynamic_job(
            job_with_capabilities(),
            None,
            0.0,
            {runner.OPENCODE_COMMAND_VARIABLE: "opencode"},
            engines=ALL_ENGINES,
            prepare=reaching_the_checkout,
        )


# #279-T03: the operator's variable stays a ceiling for the descriptor of the job.
def test_the_operators_descriptor_can_still_refuse_what_the_job_descriptor_claims() -> None:
    result = runner.run_dynamic_job(
        job_with_capabilities(),
        None,
        0.0,
        {
            runner.OPENCODE_COMMAND_VARIABLE: "opencode",
            runner.DYNAMIC_CAPABILITIES_VARIABLE: json.dumps(
                {"tool_choice_required": False, "structured_output": True, "max_output_tokens": 99}
            ),
        },
        engines=ALL_ENGINES,
        prepare=never_prepared,
    )

    assert result.ok is False
    assert result.error_code is ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED


# #279: a model whose metadata has no price still fails closed.
def test_a_job_descriptor_without_unit_prices_fails_closed_before_anything_is_prepared() -> None:
    document = dynamic_document()
    document["dynamic"]["model"] = OTHER_MODEL
    document["llm"]["model"] = OTHER_MODEL
    document["dynamic"]["capabilities"] = {
        "toolChoiceRequired": True,
        "structuredOutput": True,
        "maxOutputTokens": 4096,
        "contextWindowTokens": 200_000,
    }

    result = runner.run_dynamic_job(
        parse_job(json.dumps(document)),
        None,
        0.0,
        {runner.OPENCODE_COMMAND_VARIABLE: "opencode"},
        engines=ALL_ENGINES,
        prepare=never_prepared,
    )

    assert result.ok is False
    assert result.error_code is ErrorCode.DYNAMIC_CONFIG_INVALID


# #279: a model whose metadata says it lacks tool choice does not run, even with a good variable.
def test_a_job_descriptor_without_tool_choice_ends_with_features_unsupported() -> None:
    result = runner.run_dynamic_job(
        job_with_capabilities(toolChoiceRequired=False),
        None,
        0.0,
        {
            runner.OPENCODE_COMMAND_VARIABLE: "opencode",
            runner.DYNAMIC_CAPABILITIES_VARIABLE: CAPABILITIES,
        },
        engines=ALL_ENGINES,
        prepare=never_prepared,
    )

    assert result.ok is False
    assert result.error_code is ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED


# #279: the window of the run is the model's, from the job descriptor.
def test_the_window_and_prices_of_a_run_are_the_job_descriptors_without_a_variable() -> None:
    job = job_with_capabilities()
    assert job.dynamic is not None
    capabilities = capabilities_for_job(None, job.llm.model, job.dynamic.capabilities)

    ledger = runner.dynamic_ledger(capabilities, {}, 600.0)

    assert ledger.window_tokens == 200_000
