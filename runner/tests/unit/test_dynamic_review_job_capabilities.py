# SPDX-License-Identifier: Apache-2.0

"""The capability descriptor of a Dynamic job and the operator's (#279).

The app sends the descriptor it read from the provider's model metadata with the job. The runner
combines it with `RUNNER_DYNAMIC_CAPABILITIES` and can only narrow: the operator's value is a
ceiling, a job cannot claim what the operator's configuration lacks, and a model without unit prices
is still refused.
"""

import json
from decimal import Decimal
from typing import Any

import pytest

from code_reviewer_runner.dynamic_review.budget import (
    DEFAULT_WINDOW_TOKENS,
    LimitError,
    UnitCosts,
)
from code_reviewer_runner.dynamic_review.proxy import (
    DEFAULT_DYNAMIC_MODEL,
    DEFAULT_MODEL_CAPABILITIES,
    capabilities_for_job,
    capabilities_from_config,
)
from code_reviewer_runner.job import JobCapabilities
from code_reviewer_runner.result import ErrorCode
from code_reviewer_runner.runner import dynamic_ledger

MODEL = "acme/large"


def operator(**overrides: Any) -> str:
    document: dict[str, Any] = {
        "tool_choice_required": True,
        "structured_output": True,
        "max_output_tokens": 8192,
        "input_usd_per_mtok": 1,
        "output_usd_per_mtok": 4,
    }
    document.update(overrides)
    return json.dumps(document)


def from_app(**overrides: Any) -> JobCapabilities:
    fields: dict[str, Any] = {
        "tool_choice_required": True,
        "structured_output": True,
        "max_output_tokens": 8192,
        "context_window_tokens": 500_000,
        "input_usd_per_mtok": Decimal("0.5"),
        "output_usd_per_mtok": Decimal("2"),
    }
    fields.update(overrides)
    return JobCapabilities(**fields)


# #279-T02
def test_a_job_descriptor_with_a_smaller_output_limit_than_the_operators_is_used() -> None:
    capabilities = capabilities_for_job(
        operator(max_output_tokens=8192), MODEL, from_app(max_output_tokens=4096)
    )

    assert capabilities.max_output_tokens == 4096


# #279-T03
def test_a_job_cannot_widen_what_the_operators_descriptor_allows() -> None:
    narrow = operator(tool_choice_required=False, structured_output=False, max_output_tokens=2048)

    capabilities = capabilities_for_job(narrow, MODEL, from_app(max_output_tokens=65_536))

    assert capabilities.tool_choice_required is False
    assert capabilities.structured_output is False
    assert capabilities.max_output_tokens == 2048
    with pytest.raises(LimitError) as refused:
        capabilities.check_required()
    assert refused.value.code is ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED


# #279-T03
def test_the_operators_window_is_a_ceiling_only_when_it_names_one() -> None:
    named = capabilities_for_job(operator(context_window_tokens=200_000), MODEL, from_app())
    unnamed = capabilities_for_job(operator(), MODEL, from_app())

    assert named.context_window_tokens == 200_000
    # An operator that says nothing about the window does not cap the model's real one at the
    # conservative default.
    assert unnamed.context_window_tokens == 500_000
    assert unnamed.context_window_tokens != DEFAULT_WINDOW_TOKENS


# #279-T03: the cost of the reservation is never lowered by the app.
def test_the_higher_unit_price_of_the_two_descriptors_prices_the_reservation() -> None:
    cheaper_job = capabilities_for_job(
        operator(input_usd_per_mtok=3, output_usd_per_mtok=1),
        MODEL,
        from_app(input_usd_per_mtok=Decimal("0.5"), output_usd_per_mtok=Decimal("2")),
    )

    assert cheaper_job.unit_costs == UnitCosts(Decimal("3"), Decimal("2"))


# #279: the point of the change: no operator configuration needed for a tool-capable model.
def test_a_job_descriptor_alone_runs_any_model_without_operator_configuration() -> None:
    for blank in (None, "", "  "):
        capabilities = capabilities_for_job(blank, MODEL, from_app())

        capabilities.check_required()
        assert capabilities.max_output_tokens == 8192
        assert capabilities.context_window_tokens == 500_000
        assert capabilities.unit_costs == UnitCosts(Decimal("0.5"), Decimal("2"))


# #279: the prices of the job are the model's when the operator named none.
def test_a_descriptor_without_prices_takes_the_operators_prices() -> None:
    capabilities = capabilities_for_job(
        operator(), MODEL, from_app(input_usd_per_mtok=None, output_usd_per_mtok=None)
    )

    assert capabilities.unit_costs == UnitCosts(Decimal(1), Decimal(4))


# #279: fail closed on a missing price, whichever way the descriptor came.
def test_a_model_without_any_unit_price_is_refused_by_the_ledger() -> None:
    unpriced = from_app(input_usd_per_mtok=None, output_usd_per_mtok=None)

    capabilities = capabilities_for_job(None, MODEL, unpriced)

    assert capabilities.unit_costs is None
    with pytest.raises(LimitError) as refused:
        dynamic_ledger(capabilities, {}, deadline=600.0)
    assert refused.value.code is ErrorCode.DYNAMIC_CONFIG_INVALID


# #279: the one built-in price stays the default model's.
def test_the_default_model_without_prices_in_the_descriptor_gets_its_built_in_ones() -> None:
    unpriced = from_app(input_usd_per_mtok=None, output_usd_per_mtok=None)

    capabilities = capabilities_for_job(None, DEFAULT_DYNAMIC_MODEL, unpriced)

    assert capabilities.unit_costs == DEFAULT_MODEL_CAPABILITIES.unit_costs
    assert capabilities.context_window_tokens == 500_000


# #279: the descriptor says what the app read; a model without tool choice is not run.
def test_a_job_descriptor_without_a_required_feature_is_refused() -> None:
    for missing in ({"tool_choice_required": False}, {"structured_output": False}):
        capabilities = capabilities_for_job(None, MODEL, from_app(**missing))
        with pytest.raises(LimitError) as refused:
            capabilities.check_required()
        assert refused.value.code is ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED


# #279-T04
def test_without_a_job_descriptor_the_runner_behaves_exactly_as_before() -> None:
    for raw, model in (
        (operator(), MODEL),
        (operator(), DEFAULT_DYNAMIC_MODEL),
        (None, DEFAULT_DYNAMIC_MODEL),
        ("  ", DEFAULT_DYNAMIC_MODEL),
    ):
        assert capabilities_for_job(raw, model, None) == capabilities_from_config(raw, model=model)

    for raw in (None, "", "not json", "[]"):
        with pytest.raises(LimitError) as before:
            capabilities_from_config(raw, model=MODEL)
        with pytest.raises(LimitError) as now:
            capabilities_for_job(raw, MODEL, None)
        assert now.value.code is before.value.code


# #279: an operator who set a descriptor wrongly learns it, whatever the app sends.
def test_an_unusable_operator_descriptor_still_fails_with_a_job_descriptor() -> None:
    for broken in (
        "not json",
        "[]",
        operator(max_output_tokens="big"),
        operator(context_window_tokens=0),
    ):
        with pytest.raises(LimitError) as refused:
            capabilities_for_job(broken, MODEL, from_app())
        assert refused.value.code is ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED
