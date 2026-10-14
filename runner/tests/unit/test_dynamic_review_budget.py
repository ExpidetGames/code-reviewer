# SPDX-License-Identifier: Apache-2.0

"""Pins down the hard-limit policy and the ledger of one Dynamic Review (#197).

Every bound of the epic is enforced in the ledger, outside the engine and its prompt: a call is
reserved before it is sent, retries are calls like any other, tool calls/files/bytes are counted
from what the engine reports, and a missing or oversized answer fails closed instead of being
counted as zero or ignored.
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
    BudgetLedger,
    DynamicLimits,
    LimitError,
    exact_cost,
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


def test_bytes_are_an_upper_bound_on_tokens() -> None:
    # A BPE token is never fewer than one byte, so the byte count is a proven reservation.
    assert reserved_tokens("abcd") == 4
    assert reserved_tokens("ä") == 2


# #197-T05
def test_a_call_is_reserved_before_it_is_sent_and_settled_with_the_provider_usage() -> None:
    subject = ledger(max_total_tokens=1000)

    reservation = subject.reserve_call("x" * 100, output_tokens=50)
    assert reservation.input_tokens == 100
    assert reservation.output_tokens == 50
    assert subject.model_calls == 1

    subject.settle_call(reservation, prompt_tokens=90, completion_tokens=40)
    usage = subject.usage("vendor/model")

    assert usage.prompt_tokens == 90
    assert usage.completion_tokens == 40
    assert usage.total_tokens == 130
    assert usage.ai_calls == 1
    assert usage.cost_usd is None


# #197-T05
def test_the_call_budget_fails_closed_before_the_call_after_it() -> None:
    subject = ledger(max_model_calls=2, max_total_tokens=10_000)

    reservation = subject.reserve_call("a", output_tokens=1)
    subject.settle_call(reservation, prompt_tokens=1, completion_tokens=1)
    second = subject.reserve_call("a", output_tokens=1)
    subject.settle_call(second, prompt_tokens=1, completion_tokens=1)

    with pytest.raises(LimitError) as refused:
        subject.reserve_call("a", output_tokens=1)
    assert refused.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED


# #197-T05
def test_a_retry_is_a_call_like_any_other() -> None:
    subject = ledger(max_model_calls=1, max_total_tokens=10_000)

    first = subject.reserve_call("a", output_tokens=1)
    subject.settle_call(first, prompt_tokens=1, completion_tokens=1)

    with pytest.raises(LimitError) as refused:
        subject.reserve_call("a", output_tokens=1)  # the retry
    assert refused.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED


# #197-T05
def test_the_token_budget_counts_the_reservation_before_the_call() -> None:
    subject = ledger(max_total_tokens=100)

    with pytest.raises(LimitError) as refused:
        subject.reserve_call("x" * 90, output_tokens=20)
    assert refused.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED


# #231-T01
def test_settled_usage_counts_against_the_cap_before_the_next_call() -> None:
    subject = ledger(max_total_tokens=299)
    first = subject.reserve_call("x" * 100, output_tokens=50)
    subject.settle_call(first, prompt_tokens=100, completion_tokens=50)

    # 150 settled + 100 request + 50 allowance = 300: one over the cap, refused before sending.
    with pytest.raises(LimitError) as refused:
        subject.reserve_call("x" * 100, output_tokens=50)
    assert refused.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert subject.model_calls == 1


# #231-T01
def test_a_call_that_lands_exactly_on_the_cap_is_allowed() -> None:
    subject = ledger(max_total_tokens=300)
    first = subject.reserve_call("x" * 100, output_tokens=50)
    subject.settle_call(first, prompt_tokens=100, completion_tokens=50)

    second = subject.reserve_call("x" * 100, output_tokens=50)

    assert second.input_tokens == 100
    assert subject.model_calls == 2


# #231-T02
def test_the_last_settled_prompt_is_a_lower_bound_for_the_next_prompt() -> None:
    subject = ledger(max_total_tokens=299)
    first = subject.reserve_call("x" * 100, output_tokens=50)
    subject.settle_call(first, prompt_tokens=100, completion_tokens=50)

    # The request is 1 byte, but a prompt in a tool loop only grows: it is at least the last
    # settled prompt (100 tokens). 150 settled + 100 + 50 = 300 > 299.
    with pytest.raises(LimitError) as refused:
        subject.reserve_call("a", output_tokens=50)
    assert refused.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED


# #231-T02
def test_the_lower_bound_raises_the_reservation_but_never_lowers_it() -> None:
    subject = ledger(max_total_tokens=10_000)
    first = subject.reserve_call("x" * 100, output_tokens=50)
    subject.settle_call(first, prompt_tokens=60, completion_tokens=10)

    small = subject.reserve_call("a", output_tokens=5)
    subject.settle_call(small, prompt_tokens=1, completion_tokens=1)
    large = subject.reserve_call("x" * 500, output_tokens=5)

    assert small.input_tokens == 60  # the last settled prompt
    assert large.input_tokens == 500  # the byte bound still binds when it is larger


# #231-T03
def test_in_flight_reservations_and_settled_usage_are_summed() -> None:
    subject = ledger(max_total_tokens=400)
    first = subject.reserve_call("x" * 100, output_tokens=50)
    subject.settle_call(first, prompt_tokens=100, completion_tokens=50)
    in_flight = subject.reserve_call("x" * 100, output_tokens=50)  # 150 settled + 150 in flight

    with pytest.raises(LimitError) as refused:
        subject.reserve_call("x" * 100, output_tokens=50)  # would be 450
    assert refused.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED

    subject.settle_call(in_flight, prompt_tokens=10, completion_tokens=10)
    subject.reserve_call("x" * 100, output_tokens=50)  # 170 settled + 150: fits again


class SlowTokenCap(DynamicLimits):
    """A token cap that is slow to read, so a ledger that checks outside its lock is raced."""

    def __getattribute__(self, name: str) -> Any:
        if name == "max_total_tokens":
            time.sleep(0.002)
        return super().__getattribute__(name)


# #231-T06
def test_concurrent_reservations_cannot_together_exceed_the_cap() -> None:
    # Each reservation is 100 + 50 tokens, so a cap of 460 fits three and not a fourth.
    shared = BudgetLedger(SlowTokenCap(max_total_tokens=460))
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


# #197-T05
def test_a_request_that_does_not_fit_the_window_is_refused() -> None:
    subject = BudgetLedger(
        DynamicLimits(max_total_tokens=10_000), window_tokens=100, output_tokens=50
    )

    with pytest.raises(LimitError) as refused:
        subject.reserve_call("x" * 60, output_tokens=50)
    assert refused.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED


# #197-T05
def test_a_missing_usage_counter_fails_the_run_instead_of_counting_zero() -> None:
    subject = ledger(max_total_tokens=1000)
    reservation = subject.reserve_call("x" * 10, output_tokens=5)

    with pytest.raises(LimitError) as refused:
        subject.settle_call(reservation, prompt_tokens=None, completion_tokens=5)
    assert refused.value.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED


# #197-T05
def test_an_answer_larger_than_its_reservation_fails_the_run() -> None:
    subject = ledger(max_total_tokens=1000)
    reservation = subject.reserve_call("x" * 10, output_tokens=5)

    with pytest.raises(LimitError) as refused:
        subject.settle_call(reservation, prompt_tokens=10, completion_tokens=6)
    assert refused.value.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED


class TestToolsFilesBytes:
    # #197-T05
    def test_the_tool_call_budget_covers_failed_and_unknown_attempts(self) -> None:
        subject = ledger(max_tool_calls=2)
        subject.count_tool_call("read")
        subject.count_tool_call("SomeFutureTool")

        with pytest.raises(LimitError) as refused:
            subject.count_tool_call("read")
        assert refused.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED

    # #197-T05
    def test_a_tool_call_without_a_name_is_a_policy_violation(self) -> None:
        subject = ledger()
        with pytest.raises(LimitError) as refused:
            subject.count_tool_call("")
        assert refused.value.code is ErrorCode.DYNAMIC_POLICY_VIOLATION

    # #197-T05
    def test_distinct_files_are_counted_once_and_bounded(self) -> None:
        subject = ledger(max_files=2)
        subject.count_file("a.ts")
        subject.count_file("a.ts")  # grep reads the same file twice: it is one file
        subject.count_file("b.ts")
        assert subject.files == 2

        with pytest.raises(LimitError) as refused:
            subject.count_file("c.ts")
        assert refused.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED

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


def test_the_default_envelope_is_the_epics() -> None:
    limits = DynamicLimits()
    assert limits.deadline_seconds == 600.0
    assert limits.max_model_calls == 30
    assert limits.max_total_tokens == 120_000
    assert limits.max_tool_calls == 200
    assert limits.max_files == 100
    assert limits.max_tool_result_bytes == 64 * 1024
    assert limits.max_returned_bytes == 4 * 1024 * 1024
    assert limits.max_input_bytes == 2 * 1024 * 1024
    assert DEFAULT_OUTPUT_TOKENS > 0
    assert DEFAULT_WINDOW_TOKENS > 0


class SlowLimits(DynamicLimits):
    """Limits whose bounds are slow to read: every check-then-update gets a wide window in which
    other threads run, so a ledger that does not guard its counters is overshot reliably."""

    def __getattribute__(self, name: str) -> Any:
        if name in ("max_model_calls", "max_tool_calls", "max_files"):
            time.sleep(0.002)
        return super().__getattribute__(name)


# #197-T05
def test_concurrent_calls_cannot_overshoot_the_call_and_tool_budgets() -> None:
    # The proxy serves from a threaded server, so the ledger is shared between threads.
    calls, tools, files = 5, 7, 9
    shared = BudgetLedger(SlowLimits(max_model_calls=calls, max_tool_calls=tools, max_files=files))
    outcomes: list[str] = []
    gate = threading.Barrier(16)

    def worker(index: int) -> None:
        gate.wait()
        for round_ in range(3):
            for action in (
                lambda: shared.reserve_call("hello"),
                lambda: shared.count_tool_call("read"),
                lambda name=f"file-{index}-{round_}": shared.count_file(name),
            ):
                try:
                    action()
                except LimitError:
                    outcomes.append("refused")
                else:
                    outcomes.append("allowed")

    threads = [threading.Thread(target=worker, args=(index,)) for index in range(16)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert shared.model_calls == calls
    assert shared.tool_calls == tools
    assert shared.files == files
    assert outcomes.count("allowed") == calls + tools + files


# #197-T12
def test_the_untrusted_input_over_the_input_bound_is_refused() -> None:
    subject = ledger(max_input_bytes=100)

    subject.check_input_bytes(100)
    with pytest.raises(LimitError) as refused:
        subject.check_input_bytes(101)

    assert refused.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED


def settled(subject: BudgetLedger, cost: Decimal | None, *, prompt: int = 3) -> None:
    reservation = subject.reserve_call("x" * prompt, output_tokens=1)
    subject.settle_call(reservation, prompt_tokens=prompt, completion_tokens=1, cost=cost)


# #267-T02
def test_the_costs_of_all_calls_are_summed_exactly() -> None:
    subject = ledger()
    for _ in range(10):
        settled(subject, Decimal("0.1"))

    # Ten times 0.1 is exactly 1.0 here; a float sum would be 0.9999999999999999.
    assert subject.usage("vendor/model").cost_usd == 1.0

    small = ledger()
    for cost in ("0.000123", "0.000456", "0.0000001"):
        settled(small, Decimal(cost))
    assert small.usage("vendor/model").cost_usd == 0.0005791


# #267-T04
def test_the_cost_is_unknown_when_any_call_reported_none() -> None:
    subject = ledger()
    settled(subject, Decimal("0.25"))
    settled(subject, None)
    settled(subject, Decimal("0.5"))

    # Not 0.75: a partial sum would look exact and under-report.
    assert subject.usage("vendor/model").cost_usd is None


# #267-T04
def test_the_cost_is_unknown_when_a_reserved_call_never_settled() -> None:
    subject = ledger()
    settled(subject, Decimal("0.25"))
    subject.reserve_call("a call that got no answer", output_tokens=1)

    assert subject.usage("vendor/model").cost_usd is None


# #267-T04
def test_a_run_without_any_call_has_no_cost() -> None:
    assert ledger().usage("vendor/model").cost_usd is None


# #267-T04
def test_a_free_call_costs_zero_and_is_known() -> None:
    subject = ledger()
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
    subject = ledger()
    for _ in range(2):
        settled(subject, exact_cost(1e308))

    assert subject.usage("vendor/model").cost_usd is None

    huge = ledger()
    settled(huge, exact_cost(10**400))
    assert huge.usage("vendor/model").cost_usd is None


# #267-T02
def test_the_sum_is_exact_whatever_precision_the_caller_has_set() -> None:
    # Python rounds decimal sums to 28 significant digits by default; the ledger must not, and it
    # must not depend on the ambient context of the thread that settles the call.
    with localcontext() as ambient:
        ambient.prec = 5
        subject = ledger()
        for cost in ("1.00001", "0.000004", "0.0000000007"):
            settled(subject, Decimal(cost))

        assert subject.usage("vendor/model").cost_usd == 1.0000140007

    mixed = ledger()
    settled(mixed, Decimal("100000"))
    settled(mixed, Decimal("1e-30"))
    assert mixed.usage("vendor/model").cost_usd == 100000.0


# #267-T04
def test_a_negative_zero_is_a_cost_of_plain_zero() -> None:
    cost = exact_cost(-0.0)

    assert cost == 0 and cost is not None and not cost.is_signed()

    subject = ledger()
    settled(subject, cost)
    reported = subject.usage("vendor/model").cost_usd
    assert reported is not None
    assert reported == 0.0 and math.copysign(1.0, reported) == 1.0


# #267-T10
def test_the_cost_changes_nothing_about_the_token_accounting_or_the_bounds() -> None:
    with_cost = ledger(max_total_tokens=100, max_model_calls=2)
    without_cost = ledger(max_total_tokens=100, max_model_calls=2)
    for subject, cost in ((with_cost, Decimal("0.01")), (without_cost, None)):
        settled(subject, cost, prompt=30)
        settled(subject, cost, prompt=40)

    assert with_cost.usage("m").total_tokens == without_cost.usage("m").total_tokens == 72
    assert with_cost.model_calls == without_cost.model_calls == 2
    for subject in (with_cost, without_cost):
        with pytest.raises(LimitError) as refused:
            subject.reserve_call("a", output_tokens=1)
        assert refused.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED


# #267-T09
def test_the_cost_is_what_the_provider_reported_whatever_the_token_counts_are() -> None:
    reported = [Decimal("0.0003"), Decimal("0.0002")]
    for prompt in (1, 50, 90):
        subject = ledger()
        for cost in reported:
            settled(subject, cost, prompt=prompt)

        assert subject.usage("vendor/model").cost_usd == 0.0005

    # Tokens without a reported cost give no cost; there is nothing to derive one from.
    unpriced = ledger()
    settled(unpriced, None, prompt=90)
    settled(unpriced, None, prompt=90)
    assert unpriced.usage("vendor/model").total_tokens == 182
    assert unpriced.usage("vendor/model").cost_usd is None


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
