# SPDX-License-Identifier: Apache-2.0

"""Pins down the hard-limit policy and the ledger of one Dynamic Review (#197).

Every bound of the epic is enforced in the ledger, outside the engine and its prompt: a call is
reserved before it is sent, retries are calls like any other, tool calls/files/bytes are counted
from what the engine reports, and a missing or oversized answer fails closed instead of being
counted as zero or ignored.
"""

import threading
import time
from typing import Any

import pytest

from code_reviewer_runner.dynamic_review.limits import (
    DEFAULT_OUTPUT_TOKENS,
    DEFAULT_WINDOW_TOKENS,
    BudgetLedger,
    DynamicLimits,
    LimitError,
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
                lambda: shared.count_file(f"file-{index}-{round_}"),
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
