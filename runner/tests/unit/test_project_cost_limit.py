# SPDX-License-Identifier: Apache-2.0

"""The per-project cost limit (#666): `llm.maxCostUsd` of a job, enforced next to the operator's.

The effective limit of a Dynamic run is the smaller of the operator's
(`RUNNER_DYNAMIC_MAX_COST_USD`, default 1.00) and the project's. A run stopped by the project's
limit ends like the operator's stop (a wrapped-up review, `stoppedEarly`), but names the project's
limit as the reason. A Diff run sends no further model request once what it cost has reached the
limit.
"""

import asyncio
import json
import time
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

import pytest
from native_job_support import MANAGED_COST, native_document
from test_dynamic_review_run import dynamic_document, dynamic_job
from test_runner import API_KEY, TOKEN, job_json, provider, use_double

from code_reviewer_runner import runner
from code_reviewer_runner.diff_cost import (
    CostLimitReachedError,
    DiffCostMeter,
    install_cost_meter,
)
from code_reviewer_runner.dynamic_review.budget import (
    STOPPED_EARLY_COST,
    STOPPED_EARLY_PROJECT_COST,
    BudgetLedger,
    DynamicLimits,
    UnitCosts,
    effective_cost_limit,
)
from code_reviewer_runner.dynamic_review.native_job import build_native_job
from code_reviewer_runner.dynamic_review.proxy import capabilities_from_config
from code_reviewer_runner.job import JobError, parse_job
from code_reviewer_runner.job_loop.api import CLAIM_FEATURES
from code_reviewer_runner.job_loop.reporting import STOPPED_EARLY_REASONS
from code_reviewer_runner.job_loop.worker_api import WORKER_FEATURES
from code_reviewer_runner.log_capture import LogCapture
from code_reviewer_runner.redaction import Redactor
from code_reviewer_runner.result import ErrorCode

LEGACY_MODEL = "deepseek/deepseek-v4.1-flash"
PRICES = UnitCosts(input_usd_per_mtok=Decimal(2), output_usd_per_mtok=Decimal(10))


def legacy_capabilities() -> Any:
    return capabilities_from_config(None, model=LEGACY_MODEL)


def drive_to_the_limit(ledger: BudgetLedger) -> None:
    """A tool loop that settles every call at a dollar until the guard asks the run to finish."""
    for round_number in range(40):
        reservation = ledger.reserve_call(
            "x" * (60_000 + 3_000 * round_number), output_tokens=1_000, can_wrap_up=True
        )
        ledger.settle_call(
            reservation,
            prompt_tokens=20_000,
            completion_tokens=500,
            cost=Decimal("0.30"),
        )
        if reservation.final:
            return
    raise AssertionError("the guard never made a final call")


# ----- the limit in the job -------------------------------------------------------------------


# #666-T01
@pytest.mark.parametrize(
    ("value", "expected"),
    [(0.01, Decimal("0.01")), (0.5, Decimal("0.5")), (2, Decimal(2)), (100, Decimal(100))],
)
def test_a_job_carries_the_project_cost_limit_in_its_llm_access(
    value: float, expected: Decimal
) -> None:
    job = dynamic_job(maxCostUsd=value)

    assert job.llm.max_cost_usd == expected


# #666-T02
def test_a_job_without_a_project_cost_limit_has_none() -> None:
    assert dynamic_job().llm.max_cost_usd is None


# #666-T01
@pytest.mark.parametrize(
    "value", [0, -1, 100.01, "1", True, None, float("nan"), float("inf"), [1], {"usd": 1}]
)
def test_an_unusable_project_cost_limit_refuses_the_job(value: Any) -> None:
    document = dynamic_document()
    document["llm"]["maxCostUsd"] = value

    with pytest.raises(JobError) as refused:
        parse_job(json.dumps(document))

    assert "maxCostUsd" in str(refused.value)


# #666-T01
def test_a_diff_job_carries_the_project_cost_limit_too() -> None:
    document = job_json()
    document["llm"]["maxCostUsd"] = 0.25

    assert parse_job(json.dumps(document)).llm.max_cost_usd == Decimal("0.25")


# #666-T03
def test_the_runner_names_the_cost_limit_feature_where_it_claims_and_where_a_worker_fetches() -> (
    None
):
    assert "cost_limit" in CLAIM_FEATURES
    assert "cost_limit" in WORKER_FEATURES


# ----- the effective limit --------------------------------------------------------------------


# #666-T01
@pytest.mark.parametrize(
    ("operator", "project", "limit", "reason"),
    [
        ("1.00", "0.25", "0.25", STOPPED_EARLY_PROJECT_COST),
        ("1.00", "1.00", "1.00", STOPPED_EARLY_PROJECT_COST),
        ("0.10", "0.25", "0.10", STOPPED_EARLY_COST),
        ("5", "100", "5", STOPPED_EARLY_COST),
    ],
)
def test_the_effective_limit_is_the_smaller_of_the_operators_and_the_projects(
    operator: str, project: str, limit: str, reason: str
) -> None:
    assert effective_cost_limit(Decimal(operator), Decimal(project)) == (Decimal(limit), reason)


# #666-T02
def test_without_a_project_limit_the_operators_limit_applies_unchanged() -> None:
    assert effective_cost_limit(Decimal("1.00"), None) == (Decimal("1.00"), STOPPED_EARLY_COST)


# #666-T01: the legacy Dynamic path
def test_the_legacy_ledger_takes_the_projects_limit_below_the_operators() -> None:
    ledger = runner.dynamic_ledger(
        legacy_capabilities(),
        {runner.DYNAMIC_MAX_COST_VARIABLE: "2"},
        600.0,
        project_max_cost_usd=Decimal("0.25"),
    )

    assert ledger.limits.max_cost_usd == Decimal("0.25")
    assert ledger.limits.cost_stop_reason == STOPPED_EARLY_PROJECT_COST


# #666-T01
def test_the_legacy_ledger_keeps_the_operators_limit_when_it_is_the_smaller() -> None:
    ledger = runner.dynamic_ledger(
        legacy_capabilities(),
        {runner.DYNAMIC_MAX_COST_VARIABLE: "0.10"},
        600.0,
        project_max_cost_usd=Decimal("0.25"),
    )

    assert ledger.limits.max_cost_usd == Decimal("0.10")
    assert ledger.limits.cost_stop_reason == STOPPED_EARLY_COST


# #666-T02
def test_the_legacy_ledger_without_a_project_limit_is_unchanged() -> None:
    ledger = runner.dynamic_ledger(legacy_capabilities(), {}, 600.0)

    assert ledger.limits.max_cost_usd == Decimal("1.00")
    assert ledger.limits.cost_stop_reason == STOPPED_EARLY_COST


# #666-T01: the native path
def test_the_native_job_takes_the_projects_limit_below_the_operators() -> None:
    document = native_document(cost=MANAGED_COST)
    document["llm"]["maxCostUsd"] = 0.4

    native = build_native_job(
        parse_job(json.dumps(document)),
        deadline=600.0,
        environment={runner.DYNAMIC_MAX_COST_VARIABLE: "3"},
    )

    assert native.ledger.limits.max_cost_usd == Decimal("0.4")
    assert native.ledger.limits.cost_stop_reason == STOPPED_EARLY_PROJECT_COST


# #666-T02
def test_the_native_job_without_a_project_limit_keeps_the_operators() -> None:
    native = build_native_job(
        parse_job(json.dumps(native_document(cost=MANAGED_COST))),
        deadline=600.0,
        environment={runner.DYNAMIC_MAX_COST_VARIABLE: "3"},
    )

    assert native.ledger.limits.max_cost_usd == Decimal(3)
    assert native.ledger.limits.cost_stop_reason == STOPPED_EARLY_COST


# ----- the stop -------------------------------------------------------------------------------


def ledger_with(limit: Decimal, reason: str) -> BudgetLedger:
    return BudgetLedger(
        DynamicLimits(max_cost_usd=limit, cost_stop_reason=reason),
        window_tokens=1_000_000,
        output_tokens=8_192,
        unit_costs=PRICES,
    )


# #666-T01
def test_a_run_that_reaches_the_projects_limit_wraps_up_and_names_that_limit() -> None:
    ledger = ledger_with(Decimal("0.70"), STOPPED_EARLY_PROJECT_COST)

    drive_to_the_limit(ledger)

    assert ledger.stopped_early == STOPPED_EARLY_PROJECT_COST


# #666-T02
def test_a_run_that_reaches_the_operators_limit_still_says_cost_limit() -> None:
    ledger = ledger_with(Decimal("0.70"), STOPPED_EARLY_COST)

    drive_to_the_limit(ledger)

    assert ledger.stopped_early == STOPPED_EARLY_COST


# #666-T01
def test_the_projects_limit_is_a_reason_a_result_may_carry() -> None:
    assert STOPPED_EARLY_PROJECT_COST in STOPPED_EARLY_REASONS
    assert STOPPED_EARLY_COST in STOPPED_EARLY_REASONS


# ----- a Diff run -----------------------------------------------------------------------------


class Boundary:
    """Stands for PR-Agent's handler module: it has the one name the meter wraps."""

    def __init__(self, charges: list[float]) -> None:
        self.sent = 0
        self._charges = charges
        self.acompletion = self._completion

    async def _completion(self, *args: Any, **kwargs: Any) -> Any:
        charge = self._charges[self.sent]
        self.sent += 1
        usage = SimpleNamespace(
            prompt_tokens=100, completion_tokens=50, total_tokens=150, cost=charge
        )
        return SimpleNamespace(choices=[], usage=usage)


def ask(boundary: Boundary) -> Any:
    return boundary.acompletion(model="openrouter/vendor/model", messages=[])


def metered(charges: list[float], limit: str | None) -> tuple[Boundary, DiffCostMeter]:
    boundary = Boundary(charges)
    meter, _undo = install_cost_meter(
        boundary, max_cost_usd=None if limit is None else Decimal(limit)
    )
    return boundary, meter


# #666-T04
def test_a_diff_run_sends_no_further_request_once_the_limit_is_reached() -> None:
    boundary, meter = metered([0.06, 0.05, 0.05], "0.10")

    async def run() -> None:
        await ask(boundary)
        await ask(boundary)
        with pytest.raises(CostLimitReachedError):
            await ask(boundary)

    asyncio.run(run())

    assert boundary.sent == 2
    assert meter.limit_reached is True
    # The two answers are billed in full: the stop costs what the calls cost, never a hold.
    assert meter.cost_usd() == Decimal("0.11")


# #666-T04
def test_a_diff_run_below_the_limit_sends_every_request() -> None:
    boundary, meter = metered([0.02, 0.03], "0.10")

    async def run() -> None:
        await ask(boundary)
        await ask(boundary)

    asyncio.run(run())

    assert boundary.sent == 2
    assert meter.limit_reached is False
    assert meter.cost_usd() == Decimal("0.05")


# #666-T04: one call is never cut short; the limit decides about the next one only.
def test_a_single_call_above_the_limit_is_delivered_and_the_next_one_is_refused() -> None:
    boundary, meter = metered([0.50, 0.01], "0.10")

    async def run() -> None:
        await ask(boundary)
        with pytest.raises(CostLimitReachedError):
            await ask(boundary)

    asyncio.run(run())

    assert boundary.sent == 1
    assert meter.cost_usd() == Decimal("0.50")


# #666-T02
def test_a_diff_run_without_a_project_limit_is_never_refused() -> None:
    boundary, meter = metered([5.0, 5.0, 5.0], None)

    async def run() -> None:
        for _ in range(3):
            await ask(boundary)

    asyncio.run(run())

    assert boundary.sent == 3
    assert meter.limit_reached is False


# #666-T04, #666-T05
def test_a_diff_job_stopped_by_the_limit_ends_with_the_limit_code_and_is_billed_what_it_used(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # PR-Agent swallows the refusal like any failure of a call and goes on to the next model, then
    # posts nothing: the limit is still what the job ends with.
    ask = provider(monkeypatch, 0.08, 0.08, 0.08)

    async def double() -> bool:
        await ask()
        return True

    use_double(monkeypatch, double)
    document = job_json()
    document["llm"]["maxCostUsd"] = 0.10
    capture = LogCapture(Redactor([TOKEN, API_KEY]))
    result = runner.run_job(parse_job(json.dumps(document)), capture, time.monotonic())

    assert result.ok is False
    assert result.error_code is ErrorCode.COST_LIMIT_REACHED
    assert result.usage is not None
    assert result.usage.ai_calls == 2
    assert result.usage.cost_usd == 0.16


# #666-T02
def test_a_diff_job_without_a_project_limit_is_not_stopped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ask = provider(monkeypatch, 0.08, 0.08, 0.08)

    async def double() -> bool:
        await ask()
        return True

    use_double(monkeypatch, double)
    capture = LogCapture(Redactor([TOKEN, API_KEY]))
    result = runner.run_job(parse_job(json.dumps(job_json())), capture, time.monotonic())

    assert result.error_code is not ErrorCode.COST_LIMIT_REACHED
    assert result.usage is not None
    assert result.usage.ai_calls == 3
