# SPDX-License-Identifier: Apache-2.0

"""Pins down the hard-limit policy and the ledger of one Dynamic Review (#197).

The one budget of a run is an operator cost limit in USD (#290), enforced in the ledger, outside
the engine and its prompt: a call is reserved before it is sent, retries are calls like any other,
and a missing cost or an oversized answer fails closed instead of being counted as zero or ignored.
The technical limits (wall clock, byte caps) stay.
"""

import ast
import math
import re
import threading
import time
from decimal import Decimal, localcontext
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.dynamic_review.budget import (
    DEFAULT_OUTPUT_TOKENS,
    DEFAULT_WINDOW_TOKENS,
    MAX_COST_USD,
    MAX_COST_USD_CEILING,
    BudgetLedger,
    DynamicLimits,
    LimitError,
    UnitCosts,
    exact_cost,
    max_cost_from_environment,
    reserved_tokens,
)
from code_reviewer_runner.result import ErrorCode


class Clock:
    """A monotonic clock a test moves by hand."""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def ledger(**overrides: Any) -> BudgetLedger:
    limits = DynamicLimits(**overrides)
    return BudgetLedger(limits, clock=Clock())


def test_bytes_are_the_proven_upper_bound_on_tokens() -> None:
    # A BPE token is never fewer than one byte, so the byte count bounds what a provider can report.
    assert reserved_tokens("abcd") == 4
    assert reserved_tokens("ä") == 2


def cheap(**overrides: Any) -> BudgetLedger:
    """A ledger with known unit costs, so a reservation has a price."""
    unit_costs = UnitCosts(input_usd_per_mtok=Decimal(1), output_usd_per_mtok=Decimal(4))
    limits = DynamicLimits(**overrides)
    return BudgetLedger(limits, clock=Clock(), unit_costs=unit_costs)


# #290-T03
def test_the_input_estimate_is_bytes_over_three_rounded_up() -> None:
    subject = ledger()

    reservation = subject.reserve_call("x" * 100, output_tokens=50)

    assert reservation.input_tokens == 34
    assert reservation.output_tokens == 50
    assert subject.model_calls == 1


# #290-T03
def test_a_denser_previous_call_tightens_the_estimate_of_the_next_one() -> None:
    subject = ledger()
    first = subject.reserve_call("x" * 6000, output_tokens=10)
    # The provider counted 4000 tokens for 6000 bytes: 1.5 bytes per token, denser than the default.
    subject.settle_call(first, prompt_tokens=4000, completion_tokens=5, cost=Decimal("0.001"))

    second = subject.reserve_call("x" * 6000, output_tokens=10)

    assert second.input_tokens == 4000


# #290-T03
def test_a_sparser_previous_call_never_loosens_the_default_ratio() -> None:
    subject = ledger()
    first = subject.reserve_call("x" * 6000, output_tokens=10)
    subject.settle_call(first, prompt_tokens=600, completion_tokens=5, cost=Decimal("0.001"))

    second = subject.reserve_call("x" * 6000, output_tokens=10)

    assert second.input_tokens == 2000  # 6000 / 3, not 6000 / 10


# #290-T03
def test_a_small_request_says_nothing_about_the_density_of_the_content() -> None:
    subject = ledger()
    first = subject.reserve_call("x" * 600, output_tokens=10)
    subject.settle_call(first, prompt_tokens=600, completion_tokens=5, cost=Decimal("0.001"))

    second = subject.reserve_call("x" * 6000, output_tokens=10)

    assert second.input_tokens == 2000


# #290-T03
def test_the_last_settled_prompt_is_a_lower_bound_for_the_next_prompt() -> None:
    subject = ledger()
    first = subject.reserve_call("x" * 300, output_tokens=10)
    subject.settle_call(first, prompt_tokens=100, completion_tokens=5, cost=Decimal("0.001"))

    # A prompt in a tool loop only grows: a tiny request still reserves the last settled prompt.
    small = subject.reserve_call("a", output_tokens=5)
    subject.settle_call(small, prompt_tokens=1, completion_tokens=1, cost=Decimal("0.001"))
    large = subject.reserve_call("x" * 600, output_tokens=5)

    assert small.input_tokens == 100
    assert large.input_tokens == 200


# #290-T04
def test_usage_above_the_estimate_but_within_the_byte_bound_is_accepted() -> None:
    subject = ledger()
    reservation = subject.reserve_call("x" * 300, output_tokens=50)
    assert reservation.input_tokens == 100

    subject.settle_call(reservation, prompt_tokens=250, completion_tokens=40, cost=Decimal("0.01"))

    assert subject.usage("m").prompt_tokens == 250


# #290-T04
def test_usage_above_the_byte_bound_fails_the_run() -> None:
    subject = ledger()
    reservation = subject.reserve_call("x" * 300, output_tokens=50)

    with pytest.raises(LimitError) as refused:
        subject.settle_call(
            reservation, prompt_tokens=301, completion_tokens=40, cost=Decimal("0.01")
        )
    assert refused.value.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED


# #197-T05
def test_a_missing_usage_counter_fails_the_run_instead_of_counting_zero() -> None:
    subject = ledger()
    reservation = subject.reserve_call("x" * 10, output_tokens=5)

    with pytest.raises(LimitError) as refused:
        subject.settle_call(reservation, prompt_tokens=None, completion_tokens=5)
    assert refused.value.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED


# #197-T05
def test_an_answer_larger_than_its_output_allowance_fails_the_run() -> None:
    subject = ledger()
    reservation = subject.reserve_call("x" * 10, output_tokens=5)

    with pytest.raises(LimitError) as refused:
        subject.settle_call(
            reservation, prompt_tokens=10, completion_tokens=6, cost=Decimal("0.001")
        )
    assert refused.value.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED


# #290-T05
def test_a_request_that_does_not_fit_the_window_is_refused_with_a_value_free_detail() -> None:
    subject = BudgetLedger(DynamicLimits(), window_tokens=100, output_tokens=50)

    with pytest.raises(LimitError) as refused:
        subject.reserve_call("x" * 160, output_tokens=50)  # 54 estimated + 50 > 100
    assert refused.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert refused.value.detail == "the request plus its output allowance exceeds the model window"


# #290-T05
def test_a_request_that_fits_the_window_by_the_realistic_estimate_is_not_refused() -> None:
    # About 92 KB was already "more than 100k tokens" at one token per byte (the production bug).
    subject = BudgetLedger(DynamicLimits(), window_tokens=100_000, output_tokens=8_192)

    subject.reserve_call("x" * 92_000, output_tokens=8_192)


# #290-T07
def test_the_old_cumulative_limits_are_gone() -> None:
    fields = set(DynamicLimits.__dataclass_fields__)
    assert not fields & {"max_total_tokens", "max_model_calls", "max_tool_calls", "max_files"}

    # A long run is bounded by money alone: far more calls than the old 30 fit the cost limit.
    subject = cheap()
    for _ in range(100):
        reservation = subject.reserve_call("x" * 3000, output_tokens=100)
        subject.settle_call(
            reservation, prompt_tokens=900, completion_tokens=50, cost=Decimal("0.001")
        )
    assert subject.model_calls == 100


# #290-T08
def test_with_known_unit_costs_a_call_reserves_its_input_and_output_at_those_costs() -> None:
    # 3000 bytes -> 1000 input tokens at 1 USD per million, 100 output tokens at 4 USD per million.
    subject = cheap(max_cost_usd=Decimal("0.0014"))
    reservation = subject.reserve_call("x" * 3000, output_tokens=100)
    assert reservation.cost == Decimal("0.0014")

    with pytest.raises(LimitError) as refused:  # the first call is still in flight
        subject.reserve_call("a", output_tokens=1)
    assert refused.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert refused.value.detail == "the cost limit is used up"


# #290-T08
def test_spent_cost_reserved_cost_and_the_new_reservation_are_summed() -> None:
    subject = cheap(max_cost_usd=Decimal("0.004"))
    first = subject.reserve_call("x" * 3000, output_tokens=100)  # reserves 0.0014
    subject.settle_call(first, prompt_tokens=900, completion_tokens=100, cost=Decimal("0.0030"))
    # 0.0030 spent + 0.0014 for the next call = 0.0044 > 0.004: refused before sending.
    with pytest.raises(LimitError) as refused:
        subject.reserve_call("x" * 3000, output_tokens=100)
    assert refused.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert subject.model_calls == 1

    exact = cheap(max_cost_usd=Decimal("0.0044"))
    first = exact.reserve_call("x" * 3000, output_tokens=100)
    exact.settle_call(first, prompt_tokens=900, completion_tokens=100, cost=Decimal("0.0030"))
    exact.reserve_call("x" * 3000, output_tokens=100)  # lands exactly on the limit: allowed
    assert exact.model_calls == 2


# #290-T08
def test_without_unit_costs_a_call_reserves_a_floor() -> None:
    subject = ledger(max_cost_usd=Decimal("0.05"))
    subject.reserve_call("a", output_tokens=1)  # the floor is exactly the limit
    with pytest.raises(LimitError):
        subject.reserve_call("a", output_tokens=1)

    too_small = ledger(max_cost_usd=Decimal("0.04"))
    with pytest.raises(LimitError) as refused:
        too_small.reserve_call("a", output_tokens=1)
    assert refused.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED


# #290-T08
def test_without_unit_costs_a_call_reserves_twice_the_dearest_settled_call() -> None:
    subject = ledger(max_cost_usd=Decimal("1"))
    first = subject.reserve_call("a", output_tokens=1)
    subject.settle_call(first, prompt_tokens=1, completion_tokens=1, cost=Decimal("0.2"))
    second = subject.reserve_call("a", output_tokens=1)
    assert second.cost == Decimal("0.4")
    subject.settle_call(second, prompt_tokens=1, completion_tokens=1, cost=Decimal("0.1"))

    third = subject.reserve_call("a", output_tokens=1)

    assert third.cost == Decimal("0.4")  # the dearest call so far was 0.2


# #290-T08
def test_in_flight_reservations_and_settled_cost_are_summed() -> None:
    subject = ledger(max_cost_usd=Decimal("0.12"))
    a = subject.reserve_call("a", output_tokens=1)  # 0.05
    b = subject.reserve_call("a", output_tokens=1)  # 0.05
    with pytest.raises(LimitError):
        subject.reserve_call("a", output_tokens=1)  # 0.15 > 0.12

    subject.settle_call(a, prompt_tokens=1, completion_tokens=1, cost=Decimal("0.001"))
    subject.settle_call(b, prompt_tokens=1, completion_tokens=1, cost=Decimal("0.001"))
    subject.reserve_call("a", output_tokens=1)  # fits again


# #290-T08
def test_a_settled_cost_over_the_limit_ends_the_run() -> None:
    subject = ledger(max_cost_usd=Decimal("0.5"))
    reservation = subject.reserve_call("a", output_tokens=1)

    with pytest.raises(LimitError) as refused:
        subject.settle_call(reservation, prompt_tokens=1, completion_tokens=1, cost=Decimal("0.51"))
    assert refused.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert refused.value.detail == "the cost limit is used up"


# #290-T09
def test_a_call_without_a_reported_cost_fails_the_run_closed() -> None:
    subject = ledger()
    reservation = subject.reserve_call("a", output_tokens=1)

    with pytest.raises(LimitError) as refused:
        subject.settle_call(reservation, prompt_tokens=1, completion_tokens=1, cost=None)
    assert refused.value.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED
    assert refused.value.detail == "the provider did not report the cost of a call"
    # The tokens the provider reported are still on record for the Runs view.
    assert subject.usage("m").total_tokens == 2


# #290-T09
def test_a_call_with_a_cost_of_zero_is_accepted() -> None:
    subject = ledger()
    reservation = subject.reserve_call("a", output_tokens=1)

    subject.settle_call(reservation, prompt_tokens=1, completion_tokens=1, cost=Decimal("0"))

    assert subject.usage("m").cost_usd == 0.0


class SlowCostLimit(DynamicLimits):
    """A cost limit that is slow to read, so a ledger that checks outside its lock is raced."""

    def __getattribute__(self, name: str) -> Any:
        if name == "max_cost_usd":
            time.sleep(0.002)
        return super().__getattribute__(name)


# #290-T08
def test_concurrent_reservations_cannot_together_exceed_the_cost_limit() -> None:
    # Each reservation is the 0.05 floor, so a limit of 0.17 fits three and not a fourth.
    shared = BudgetLedger(SlowCostLimit(max_cost_usd=Decimal("0.17")))
    outcomes: list[bool] = []
    gate = threading.Barrier(16)

    def worker() -> None:
        gate.wait()
        try:
            shared.reserve_call("x" * 100, output_tokens=50)
        except LimitError as refused:
            assert refused.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
            outcomes.append(False)
        else:
            outcomes.append(True)

    threads = [threading.Thread(target=worker) for _ in range(16)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert outcomes.count(True) == 3
    assert shared.model_calls == 3


class TestToolsAndBytes:
    # #197-T05
    def test_tool_calls_are_counted_without_a_limit_and_unknown_attempts_count_too(self) -> None:
        subject = ledger()
        for _ in range(300):
            subject.count_tool_call("read")
        subject.count_tool_call("SomeFutureTool")

        assert subject.tool_calls == 301

    # #197-T05
    def test_a_tool_call_without_a_name_is_a_policy_violation(self) -> None:
        subject = ledger()
        with pytest.raises(LimitError) as refused:
            subject.count_tool_call("")
        assert refused.value.code is ErrorCode.DYNAMIC_POLICY_VIOLATION

    # #197-T05
    def test_distinct_files_are_counted_once_and_without_a_limit(self) -> None:
        subject = ledger()
        subject.count_file("a.ts")
        subject.count_file("a.ts")  # grep reads the same file twice: it is one file
        for index in range(200):
            subject.count_file(f"f{index}.ts")
        assert subject.files == 201

    # #197-T05
    def test_the_per_result_and_cumulative_content_bounds_are_bytes(self) -> None:
        subject = ledger(max_tool_result_bytes=100, max_returned_bytes=150)
        subject.add_result_bytes(100)

        with pytest.raises(LimitError) as refused:
            subject.add_result_bytes(101)
        assert refused.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED

        with pytest.raises(LimitError) as refused:
            subject.add_result_bytes(60)  # fits the per-result bound, not the cumulative one
        assert refused.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED

    # #197-T05
    def test_the_protocol_byte_bounds_are_checked_before_forwarding(self) -> None:
        subject = ledger(max_request_bytes=100, max_response_bytes=50)
        subject.check_request_bytes(100)
        subject.check_response_bytes(50)

        with pytest.raises(LimitError):
            subject.check_request_bytes(101)
        with pytest.raises(LimitError):
            subject.check_response_bytes(51)


# #197-T05
def test_the_whole_job_deadline_is_enforced_by_the_ledger() -> None:
    clock = Clock()
    subject = BudgetLedger(DynamicLimits(deadline_seconds=10.0), clock=clock)
    assert subject.remaining_seconds() == 10.0

    clock.advance(10.0)
    assert subject.expired()
    with pytest.raises(LimitError) as refused:
        subject.reserve_call("a", output_tokens=1)
    assert refused.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED


# #290-T07
def test_the_default_envelope_is_a_cost_limit_a_wall_clock_and_the_byte_caps() -> None:
    limits = DynamicLimits()
    assert limits.deadline_seconds == 600.0
    assert limits.max_cost_usd == MAX_COST_USD == Decimal("1.00")
    assert limits.max_tool_result_bytes == 64 * 1024
    assert limits.max_returned_bytes == 4 * 1024 * 1024
    assert limits.max_input_bytes == 2 * 1024 * 1024
    assert DEFAULT_OUTPUT_TOKENS > 0
    assert DEFAULT_WINDOW_TOKENS > 0
    assert Decimal(0) < MAX_COST_USD <= MAX_COST_USD_CEILING == Decimal("20")


# #290-T10
def test_the_operator_cost_limit_comes_from_the_environment_value() -> None:
    assert max_cost_from_environment(None) == MAX_COST_USD
    assert max_cost_from_environment("") == MAX_COST_USD
    assert max_cost_from_environment("   ") == MAX_COST_USD
    assert max_cost_from_environment("2.50") == Decimal("2.50")
    assert max_cost_from_environment(" 20 ") == Decimal("20")
    assert max_cost_from_environment("0.01") == Decimal("0.01")


# #290-T10
def test_an_unusable_operator_cost_limit_is_a_config_error_never_a_default() -> None:
    for value in ("0", "-1", "abc", "nan", "inf", "-inf", "20.01", "1e3", "1,5", "$1", "0x10"):
        with pytest.raises(LimitError) as refused:
            max_cost_from_environment(value)
        assert refused.value.code is ErrorCode.DYNAMIC_CONFIG_INVALID, value
        assert value.strip() not in refused.value.detail


# #197-T12
def test_the_untrusted_input_over_the_input_bound_is_refused() -> None:
    subject = ledger(max_input_bytes=100)

    subject.check_input_bytes(100)
    with pytest.raises(LimitError) as refused:
        subject.check_input_bytes(101)

    assert refused.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED


def rich() -> BudgetLedger:
    """A ledger whose cost limit never binds, for the tests of how costs are summed and reported."""
    return ledger(max_cost_usd=Decimal(10**500))


def settled(subject: BudgetLedger, cost: Decimal | None, *, prompt: int = 3) -> None:
    reservation = subject.reserve_call("x" * prompt, output_tokens=1)
    subject.settle_call(reservation, prompt_tokens=prompt, completion_tokens=1, cost=cost)


# #267-T02
def test_the_costs_of_all_calls_are_summed_exactly() -> None:
    subject = rich()
    for _ in range(10):
        settled(subject, Decimal("0.1"))

    # Ten times 0.1 is exactly 1.0 here; a float sum would be 0.9999999999999999.
    assert subject.usage("vendor/model").cost_usd == 1.0

    small = rich()
    for cost in ("0.000123", "0.000456", "0.0000001"):
        settled(small, Decimal(cost))
    assert small.usage("vendor/model").cost_usd == 0.0005791


# #290-T09
def test_a_call_without_a_cost_leaves_the_cost_of_the_run_unknown_and_stops_it() -> None:
    subject = rich()
    settled(subject, Decimal("0.25"))
    with pytest.raises(LimitError) as stopped:
        settled(subject, None)
    assert stopped.value.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED

    # Not 0.25: a partial sum would look exact and under-report.
    assert subject.usage("vendor/model").cost_usd is None


# #267-T04
def test_the_cost_is_unknown_when_a_reserved_call_never_settled() -> None:
    subject = rich()
    settled(subject, Decimal("0.25"))
    subject.reserve_call("a call that got no answer", output_tokens=1)

    assert subject.usage("vendor/model").cost_usd is None


# #267-T04
def test_a_run_without_any_call_has_no_cost() -> None:
    assert ledger().usage("vendor/model").cost_usd is None


# #267-T04
def test_a_free_call_costs_zero_and_is_known() -> None:
    subject = rich()
    settled(subject, Decimal("0"))

    assert subject.usage("vendor/model").cost_usd == 0.0


# #267-T04
def test_only_a_finite_non_negative_number_is_an_exact_cost() -> None:
    assert exact_cost(0.0123) == Decimal("0.0123")
    assert exact_cost(0) == Decimal("0")
    assert exact_cost(2) == Decimal("2")
    unusable_values: list[Any] = [None, True, False, "0.5", [], {}, -0.01, math.nan, math.inf]
    for unusable in unusable_values:
        assert exact_cost(unusable) is None


# #267-T04
def test_a_sum_that_does_not_fit_a_float_leaves_the_cost_unknown() -> None:
    # 2 x 1e308 is finite as a decimal and `inf` as a float; `inf` cannot be sent as a result.
    subject = rich()
    for _ in range(2):
        settled(subject, exact_cost(1e308))

    assert subject.usage("vendor/model").cost_usd is None

    huge = rich()
    settled(huge, exact_cost(10**400))
    assert huge.usage("vendor/model").cost_usd is None


# #267-T02
def test_the_sum_is_exact_whatever_precision_the_caller_has_set() -> None:
    # Python rounds decimal sums to 28 significant digits by default; the ledger must not, and it
    # must not depend on the ambient context of the thread that settles the call.
    with localcontext() as ambient:
        ambient.prec = 5
        subject = rich()
        for cost in ("1.00001", "0.000004", "0.0000000007"):
            settled(subject, Decimal(cost))

        assert subject.usage("vendor/model").cost_usd == 1.0000140007

    mixed = rich()
    settled(mixed, Decimal("100000"))
    settled(mixed, Decimal("1e-30"))
    assert mixed.usage("vendor/model").cost_usd == 100000.0


# #267-T04
def test_a_negative_zero_is_a_cost_of_plain_zero() -> None:
    cost = exact_cost(-0.0)

    assert cost == 0 and cost is not None and not cost.is_signed()

    subject = rich()
    settled(subject, cost)
    reported = subject.usage("vendor/model").cost_usd
    assert reported is not None
    assert reported == 0.0 and math.copysign(1.0, reported) == 1.0


# #267-T09
def test_the_cost_is_what_the_provider_reported_whatever_the_token_counts_or_unit_costs_are() -> (
    None
):
    reported = [Decimal("0.0003"), Decimal("0.0002")]
    for prompt in (1, 50, 90):
        for subject in (rich(), cheap(max_cost_usd=Decimal(10**500))):
            for cost in reported:
                settled(subject, cost, prompt=prompt)

            assert subject.usage("vendor/model").cost_usd == 0.0005


# #267-T09
def test_no_module_that_reports_a_dynamic_cost_imports_or_names_a_price_table() -> None:
    # The runner's price tables live in PR-Agent and its model library, so the modules that settle
    # and report a Dynamic Review must not import them. They must not name a table, price or rate
    # of their own either: the only source of the cost is `usage.cost` of the provider's answer.
    # `runner.py` also serves the static path, which uses PR-Agent, so only its names are checked.
    source = Path(__file__).parents[2] / "src" / "code_reviewer_runner"
    modules = [*sorted((source / "dynamic_review").glob("*.py")), source / "runner.py"]
    forbidden_imports = {"litellm", "pr_agent"}
    price_name = re.compile(
        r"(^|_)(price|prices|pricing|tariff)(_|$)|per_token|token_rate|rate_per"
    )
    for module in modules:
        for node in ast.walk(ast.parse(module.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Import):
                imported = {alias.name.split(".")[0] for alias in node.names}
            elif isinstance(node, ast.ImportFrom):
                imported = {(node.module or "").split(".")[0]}
            else:
                imported = set[str]()
            if module.name != "runner.py":
                assert not imported & forbidden_imports, module.name
            if isinstance(node, ast.Name):
                assert not price_name.search(node.id.lower()), (module.name, node.id)
            elif isinstance(node, ast.Attribute):
                assert not price_name.search(node.attr.lower()), (module.name, node.attr)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                assert not price_name.search(node.name.lower()), (module.name, node.name)
            elif isinstance(node, ast.arg):
                assert not price_name.search(node.arg.lower()), (module.name, node.arg)
