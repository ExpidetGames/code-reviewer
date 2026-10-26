# SPDX-License-Identifier: LicenseRef-Proprietary

"""The operator's maximum cost per review (#689): `llm.operatorMaxCostUsd` of a job.

The operator sets the most one review may cost in the admin portal; the app sends it with every
job to a runner that names the claim feature `operator_cost_limit`. A review is held to the smaller
of it and the customer's own limit (`llm.maxCostUsd`, #666), Diff and Dynamic alike. A job that
carries it ignores `RUNNER_DYNAMIC_MAX_COST_USD`, which stays the limit of a job from an app that
does not send it (and a Diff review then has no operator limit, as before).
"""

import asyncio
import json
import time
from decimal import Decimal
from typing import Any

import pytest
from native_job_support import MANAGED_COST, native_document
from test_dynamic_review_run import dynamic_document, dynamic_job
from test_project_cost_limit import Boundary, ask, legacy_capabilities
from test_runner import API_KEY, TOKEN, job_json, provider, use_double

from code_reviewer_runner import runner
from code_reviewer_runner.diff_cost import CostLimitReachedError, install_cost_meter
from code_reviewer_runner.dynamic_review.budget import (
    STOPPED_EARLY_COST,
    STOPPED_EARLY_PROJECT_COST,
    diff_cost_limit,
    operator_cost_limit,
)
from code_reviewer_runner.dynamic_review.native_job import build_native_job
from code_reviewer_runner.job import JobError, parse_job
from code_reviewer_runner.job_loop.worker_api import WORKER_FEATURES
from code_reviewer_runner.log_capture import LogCapture
from code_reviewer_runner.redaction import Redactor
from code_reviewer_runner.result import ErrorCode

# ----- the limit in the job -------------------------------------------------------------------


# #689-T20
@pytest.mark.parametrize(
    ("value", "expected"),
    [(0.01, Decimal("0.01")), (1, Decimal(1)), (2.5, Decimal("2.5")), (100, Decimal(100))],
)
def test_a_job_carries_the_operators_maximum_in_its_llm_access(
    value: float, expected: Decimal
) -> None:
    assert dynamic_job(operatorMaxCostUsd=value).llm.operator_max_cost_usd == expected
    document = job_json()
    document["llm"]["operatorMaxCostUsd"] = value
    assert parse_job(json.dumps(document)).llm.operator_max_cost_usd == expected


# #689-T20
def test_a_job_without_the_operators_maximum_has_none() -> None:
    assert dynamic_job().llm.operator_max_cost_usd is None
    assert parse_job(json.dumps(job_json())).llm.operator_max_cost_usd is None


# #689-T20
@pytest.mark.parametrize(
    "value", [0, -1, 100.01, "1", True, None, float("nan"), float("inf"), [1], {"usd": 1}]
)
def test_an_unusable_operator_maximum_refuses_the_job_without_echoing_it(value: Any) -> None:
    document = dynamic_document()
    document["llm"]["operatorMaxCostUsd"] = value

    with pytest.raises(JobError) as refused:
        parse_job(json.dumps(document))

    assert "operatorMaxCostUsd" in str(refused.value)


# #689-T21
def test_the_runner_names_the_operator_cost_limit_feature_in_worker_fetches() -> None:
    assert "operator_cost_limit" in WORKER_FEATURES
    # The feature of the release before stays: an app of that release sends the customer's limit.
    assert "cost_limit" in WORKER_FEATURES


# ----- which operator limit applies -----------------------------------------------------------


# #689-T22
def test_the_job_value_wins_over_the_environment_even_when_the_environment_is_unusable() -> None:
    assert operator_cost_limit("garbage", Decimal("2.5")) == Decimal("2.5")
    assert operator_cost_limit("0.10", Decimal("5")) == Decimal(5)
    assert operator_cost_limit(None, Decimal("30")) == Decimal(30)


# #689-T22
def test_without_a_job_value_the_environment_applies_as_before() -> None:
    assert operator_cost_limit(None, None) == Decimal("1.00")
    assert operator_cost_limit("  ", None) == Decimal("1.00")
    assert operator_cost_limit("2.5", None) == Decimal("2.5")


# #689-T22
def test_an_unusable_environment_is_still_a_configuration_error_without_a_job_value() -> None:
    from code_reviewer_runner.dynamic_review.budget import LimitError

    with pytest.raises(LimitError):
        operator_cost_limit("free", None)


# #689-T23
@pytest.mark.parametrize(
    ("project", "operator", "limit"),
    [
        (None, None, None),
        (Decimal("0.25"), None, Decimal("0.25")),
        (None, Decimal("1"), Decimal(1)),
        (Decimal("0.25"), Decimal("1"), Decimal("0.25")),
        (Decimal("5"), Decimal("1"), Decimal(1)),
    ],
)
def test_a_diff_review_is_held_to_the_smaller_of_the_two(
    project: Decimal | None, operator: Decimal | None, limit: Decimal | None
) -> None:
    assert diff_cost_limit(project, operator) == limit


# ----- a Dynamic review -----------------------------------------------------------------------


# #689-T24
def test_the_legacy_ledger_takes_the_operators_maximum_of_the_job_and_names_it_when_it_stops() -> (
    None
):
    ledger = runner.dynamic_ledger(
        legacy_capabilities(),
        {runner.DYNAMIC_MAX_COST_VARIABLE: "0.10"},
        600.0,
        project_max_cost_usd=Decimal("5"),
        operator_max_cost_usd=Decimal("2.5"),
    )

    # The environment would have said 0.10: the job's value replaces it.
    assert ledger.limits.max_cost_usd == Decimal("2.5")
    assert ledger.limits.cost_stop_reason == STOPPED_EARLY_COST


# #689-T24
def test_the_legacy_ledger_still_takes_the_customers_limit_below_the_operators() -> None:
    ledger = runner.dynamic_ledger(
        legacy_capabilities(),
        {},
        600.0,
        project_max_cost_usd=Decimal("0.25"),
        operator_max_cost_usd=Decimal("2.5"),
    )

    assert ledger.limits.max_cost_usd == Decimal("0.25")
    assert ledger.limits.cost_stop_reason == STOPPED_EARLY_PROJECT_COST


# #689-T25
def test_the_legacy_ledger_without_the_job_value_is_the_ledger_of_before() -> None:
    ledger = runner.dynamic_ledger(
        legacy_capabilities(), {runner.DYNAMIC_MAX_COST_VARIABLE: "2"}, 600.0
    )

    assert ledger.limits.max_cost_usd == Decimal(2)
    assert ledger.limits.cost_stop_reason == STOPPED_EARLY_COST


# #689-T24
def test_the_native_job_takes_the_operators_maximum_of_the_job_over_the_environment() -> None:
    document = native_document(cost=MANAGED_COST)
    document["llm"]["operatorMaxCostUsd"] = 4

    native = build_native_job(
        parse_job(json.dumps(document)),
        deadline=600.0,
        environment={runner.DYNAMIC_MAX_COST_VARIABLE: "3"},
    )

    assert native.ledger.limits.max_cost_usd == Decimal(4)
    assert native.ledger.limits.cost_stop_reason == STOPPED_EARLY_COST


# #689-T24
def test_the_native_job_holds_to_the_smaller_of_the_customers_limit_and_the_operators_maximum() -> (
    None
):
    document = native_document(cost=MANAGED_COST)
    document["llm"]["operatorMaxCostUsd"] = 4
    document["llm"]["maxCostUsd"] = 6

    native = build_native_job(
        parse_job(json.dumps(document)),
        deadline=600.0,
        environment={},
    )

    assert native.ledger.limits.max_cost_usd == Decimal(4)
    assert native.ledger.limits.cost_stop_reason == STOPPED_EARLY_COST


# #689-T25
def test_the_native_job_without_the_job_value_keeps_the_environment() -> None:
    native = build_native_job(
        parse_job(json.dumps(native_document(cost=MANAGED_COST))),
        deadline=600.0,
        environment={runner.DYNAMIC_MAX_COST_VARIABLE: "3"},
    )

    assert native.ledger.limits.max_cost_usd == Decimal(3)


# ----- a Diff review --------------------------------------------------------------------------


# #689-T23
def test_a_diff_run_stops_at_the_operators_maximum_when_the_customer_set_no_limit() -> None:
    boundary = Boundary([0.06, 0.05, 0.05])
    _meter, _undo = install_cost_meter(
        boundary, max_cost_usd=diff_cost_limit(None, Decimal("0.10"))
    )

    async def run() -> None:
        await ask(boundary)
        await ask(boundary)
        with pytest.raises(CostLimitReachedError):
            await ask(boundary)

    asyncio.run(run())

    assert boundary.sent == 2


# #689-T23
def test_a_diff_job_stopped_by_the_operators_maximum_ends_with_the_limit_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ask_model = provider(monkeypatch, 0.08, 0.08, 0.08)

    async def double() -> bool:
        await ask_model()
        return True

    use_double(monkeypatch, double)
    document = job_json()
    document["llm"]["operatorMaxCostUsd"] = 0.10
    capture = LogCapture(Redactor([TOKEN, API_KEY]))
    result = runner.run_job(parse_job(json.dumps(document)), capture, time.monotonic())

    assert result.ok is False
    assert result.error_code is ErrorCode.COST_LIMIT_REACHED
    assert result.usage is not None
    assert result.usage.ai_calls == 2
    # The customer set no limit: the operator's maximum is the one that stopped it.
    assert result.usage.stopped_early == STOPPED_EARLY_COST


# #689-T27
@pytest.mark.parametrize(
    ("customer", "operator", "expected"),
    [
        (0.10, 0.50, STOPPED_EARLY_PROJECT_COST),
        (0.50, 0.10, STOPPED_EARLY_COST),
        (0.10, 0.10, STOPPED_EARLY_PROJECT_COST),
    ],
)
def test_a_diff_job_stopped_by_a_limit_names_the_limit_that_bound(
    monkeypatch: pytest.MonkeyPatch, customer: float, operator: float, expected: str
) -> None:
    ask_model = provider(monkeypatch, 0.08, 0.08, 0.08)

    async def double() -> bool:
        await ask_model()
        return True

    use_double(monkeypatch, double)
    document = job_json()
    document["llm"]["maxCostUsd"] = customer
    document["llm"]["operatorMaxCostUsd"] = operator
    capture = LogCapture(Redactor([TOKEN, API_KEY]))
    result = runner.run_job(parse_job(json.dumps(document)), capture, time.monotonic())

    assert result.error_code is ErrorCode.COST_LIMIT_REACHED
    assert result.usage is not None
    assert result.usage.stopped_early == expected
    assert result.usage.to_json()["stoppedEarly"] == expected


# #689-T28
def test_a_diff_job_that_reaches_no_limit_reports_no_stop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ask_model = provider(monkeypatch, 0.01)

    async def double() -> bool:
        await ask_model()
        return True

    use_double(monkeypatch, double)
    document = job_json()
    document["llm"]["operatorMaxCostUsd"] = 5
    capture = LogCapture(Redactor([TOKEN, API_KEY]))
    result = runner.run_job(parse_job(json.dumps(document)), capture, time.monotonic())

    assert result.usage is not None
    assert result.usage.stopped_early is None


# #689-T25
def test_a_diff_job_without_either_limit_is_not_stopped(monkeypatch: pytest.MonkeyPatch) -> None:
    ask_model = provider(monkeypatch, 0.08, 0.08, 0.08)

    async def double() -> bool:
        await ask_model()
        return True

    use_double(monkeypatch, double)
    capture = LogCapture(Redactor([TOKEN, API_KEY]))
    result = runner.run_job(parse_job(json.dumps(job_json())), capture, time.monotonic())

    assert result.error_code is not ErrorCode.COST_LIMIT_REACHED
    assert result.usage is not None
    assert result.usage.ai_calls == 3
