# SPDX-License-Identifier: Apache-2.0

"""Pins down the realistic cost guard of the Dynamic ledger (#540).

A live run with `claude-sonnet-5` (job `844b81e7`, 55 calls) cost $0.70 and was stopped at
`cost_limit` although the limit is $1.00: the guard priced the whole prompt at the uncached input
price, reserved the full output allowance and a final call with 128 KiB of extra history. The guard
now reserves what the run has shown a call costs: the previous prompt at the cache-read price when
the provider reported cache reads, the growth at the cache-write (or input) price, and the output
the run's own completions show. The cost limit keeps its bound: a call is admitted only while the
spend is within the limit, so the run exceeds it by at most the last call's real cost.
"""

import math
import random
from dataclasses import dataclass
from decimal import Decimal

import pytest

from code_reviewer_runner.dynamic_review.budget import (
    BudgetLedger,
    DynamicLimits,
    LimitError,
    Reservation,
    UnitCosts,
)
from code_reviewer_runner.result import ErrorCode

MILLION = Decimal(1_000_000)
# claude-sonnet-5 (`anthropic_models.py`), USD per million tokens.
READ_USD = Decimal("0.20")
WRITE_USD = Decimal("2.50")
SONNET = UnitCosts(
    input_usd_per_mtok=Decimal(2),
    output_usd_per_mtok=Decimal(10),
    cache_read_usd_per_mtok=READ_USD,
    cache_write_usd_per_mtok=WRITE_USD,
)
# The same model on a provider that states no cache price (an OpenRouter model): input and output.
UNCACHED = UnitCosts(input_usd_per_mtok=Decimal(2), output_usd_per_mtok=Decimal(10))
# The 8,192 tokens the job's descriptor gives Sonnet 5 as its output limit.
ALLOWANCE = 8_192
BYTES_PER_TOKEN = 3.5


@dataclass
class Settled:
    reservation: Reservation
    cost: Decimal


def call_cost(
    prices: UnitCosts, *, uncached: int, read: int, write: int, completion: int
) -> Decimal:
    """What the provider charges for one call: every kind of token at its own price."""
    read_price = prices.cache_read_usd_per_mtok or prices.input_usd_per_mtok
    write_price = prices.cache_write_usd_per_mtok or prices.input_usd_per_mtok
    return (
        Decimal(uncached) * prices.input_usd_per_mtok
        + Decimal(read) * read_price
        + Decimal(write) * write_price
        + Decimal(completion) * prices.output_usd_per_mtok
    ) / MILLION


def request_for(prompt_tokens: int, bytes_per_token: float = BYTES_PER_TOKEN) -> str:
    return "x" * math.ceil(prompt_tokens * bytes_per_token)


def exact(prompt_tokens: int) -> str:
    """A request of exactly the density the ledger assumes (3 bytes per token): the growth it
    prices from the request is then the growth of the prompt, to the token."""
    return request_for(prompt_tokens, 3)


def make_ledger(prices: UnitCosts, limit: str = "1.00") -> BudgetLedger:
    return BudgetLedger(
        DynamicLimits(max_cost_usd=Decimal(limit)),
        window_tokens=1_000_000,
        output_tokens=ALLOWANCE,
        unit_costs=prices,
    )


@dataclass
class Run:
    calls: int
    total: Decimal
    ledger: BudgetLedger
    last_cost: Decimal
    spent_before_last: Decimal


def run_profile(
    prices: UnitCosts,
    *,
    cached: bool,
    first_prompt: int = 14_600,
    growth: int = 780,
    completion: int = 400,
    final_completion: int = 3_000,
    limit: str = "1.00",
) -> Run:
    """A tool loop like the live one: every round re-sends the history plus one more result.

    With `cached` the provider reports what it read from the cache (the previous prompt) and what
    it wrote (the growth); without it the whole prompt is billed and reported as plain input.
    """
    ledger = make_ledger(prices, limit)
    total = Decimal(0)
    previous = 0
    last_cost = Decimal(0)
    spent_before_last = Decimal(0)
    for round_number in range(400):
        prompt = first_prompt + growth * round_number
        reservation = ledger.reserve_call(
            request_for(prompt), output_tokens=ALLOWANCE, can_wrap_up=True
        )
        output = final_completion if reservation.final else completion
        read = previous if cached else 0
        write = prompt - previous if cached else 0
        cost = call_cost(
            prices, uncached=prompt - read - write, read=read, write=write, completion=output
        )
        spent_before_last = total
        ledger.settle_call(
            reservation,
            prompt_tokens=prompt,
            completion_tokens=output,
            cost=cost,
            cache_read_tokens=read if cached else None,
            cache_write_tokens=write if cached else None,
        )
        total += cost
        last_cost = cost
        previous = prompt
        if reservation.final:
            return Run(round_number + 1, total, ledger, last_cost, spent_before_last)
    raise AssertionError("the run never reached its limit")


# #540-T01
def test_the_55_call_sonnet_profile_runs_to_just_under_the_limit() -> None:
    # Before the fix this profile was wrapped up at about $0.55 (the live run: 55 calls, $0.70).
    run = run_profile(SONNET, cached=True)

    assert run.ledger.stopped_early == "cost_limit"
    assert run.calls > 55
    assert Decimal("0.90") <= run.total <= Decimal("1.00")
    assert run.ledger.usage("m").cost_usd == pytest.approx(float(run.total))


# #540-T01
def test_the_limit_is_not_reached_by_a_run_that_stays_below_it() -> None:
    ledger = make_ledger(SONNET)
    previous = 0
    for round_number in range(20):
        prompt = 14_600 + 780 * round_number
        reservation = ledger.reserve_call(
            request_for(prompt), output_tokens=ALLOWANCE, can_wrap_up=True
        )
        assert reservation.final is False
        read, write = previous, prompt - previous
        ledger.settle_call(
            reservation,
            prompt_tokens=prompt,
            completion_tokens=400,
            cost=call_cost(SONNET, uncached=0, read=read, write=write, completion=400),
            cache_read_tokens=read,
            cache_write_tokens=write,
        )
        previous = prompt

    assert ledger.stopped_early is None


# #540-T02
def test_a_provider_without_cache_tokens_is_still_bounded() -> None:
    run = run_profile(UNCACHED, cached=False)

    assert run.ledger.stopped_early == "cost_limit"
    assert run.total <= Decimal("1.00")
    assert run.total >= Decimal("0.70")


# #540-T02
def test_cache_tokens_without_cache_prices_change_nothing() -> None:
    # An OpenRouter model reports cached tokens but the descriptor has no cache price: the whole
    # prompt is still reserved at the uncached input price.
    unaware = make_ledger(UNCACHED)
    aware = make_ledger(UNCACHED)
    for subject, report in ((unaware, False), (aware, True)):
        first = subject.reserve_call(exact(20_000), output_tokens=ALLOWANCE)
        subject.settle_call(
            first,
            prompt_tokens=20_000,
            completion_tokens=400,
            cost=Decimal("0.05"),
            cache_read_tokens=15_000 if report else None,
            cache_write_tokens=0 if report else None,
        )

    next_unaware = unaware.reserve_call(exact(20_780), output_tokens=ALLOWANCE)
    next_aware = aware.reserve_call(exact(20_780), output_tokens=ALLOWANCE)

    assert next_aware.cost == next_unaware.cost
    assert next_aware.cost == UNCACHED.of_call(20_780, 1_024)


def settle_cached_call(ledger: BudgetLedger, prompt: int, read: int, write: int) -> None:
    reservation = ledger.reserve_call(exact(prompt), output_tokens=ALLOWANCE)
    cost = call_cost(SONNET, uncached=prompt - read - write, read=read, write=write, completion=400)
    ledger.settle_call(
        reservation,
        prompt_tokens=prompt,
        completion_tokens=400,
        cost=cost,
        cache_read_tokens=read,
        cache_write_tokens=write,
    )


# #540-T03
def test_the_next_call_reads_the_previous_prompt_at_the_cache_read_price() -> None:
    ledger = make_ledger(SONNET)
    settle_cached_call(ledger, 14_600, read=0, write=14_600)
    settle_cached_call(ledger, 15_380, read=14_600, write=780)

    reservation = ledger.reserve_call(exact(16_160), output_tokens=ALLOWANCE)

    # 15,380 tokens are in the cache and read; the 780 new ones are written; the output is the
    # floor, not the 8,192 allowance.
    expected = (
        Decimal(15_380) * READ_USD
        + Decimal(780) * WRITE_USD
        + Decimal(1_024) * SONNET.output_usd_per_mtok
    ) / MILLION
    assert reservation.cost == expected
    old_style = SONNET.of_call(16_160 * 7 // 6, ALLOWANCE)
    assert reservation.cost < old_style / 5


# #540-T03
def test_without_cache_reads_the_whole_prompt_is_priced_as_input() -> None:
    ledger = make_ledger(SONNET)
    settle_cached_call(ledger, 14_600, read=0, write=0)  # the provider reported no cache use

    reservation = ledger.reserve_call(exact(15_380), output_tokens=ALLOWANCE)

    assert reservation.cost == SONNET.of_call(15_380, 1_024)


# #540-T03
def test_a_cache_miss_is_priced_from_the_next_call_on() -> None:
    ledger = make_ledger(SONNET)
    settle_cached_call(ledger, 14_600, read=0, write=14_600)
    settle_cached_call(ledger, 15_380, read=14_600, write=780)
    settle_cached_call(ledger, 16_160, read=0, write=16_160)  # the cache expired

    reservation = ledger.reserve_call(exact(16_940), output_tokens=ALLOWANCE)

    # No read was reported by the last call: the prompt is reserved as written, not as read.
    expected = (Decimal(16_940) * WRITE_USD + Decimal(1_024) * SONNET.output_usd_per_mtok) / MILLION
    assert reservation.cost == expected


# #540-T04
def test_the_output_reservation_is_the_floor_then_the_p95_of_the_completions() -> None:
    ledger = make_ledger(UNCACHED)
    first = ledger.reserve_call(exact(10_000), output_tokens=ALLOWANCE)
    assert first.cost == UNCACHED.of_call(10_000, 1_024)
    ledger.settle_call(first, prompt_tokens=10_000, completion_tokens=2_500, cost=Decimal("0.03"))

    second = ledger.reserve_call(exact(10_500), output_tokens=ALLOWANCE)

    assert second.cost == UNCACHED.of_call(10_500, 2_500)
    assert second.output_tokens == ALLOWANCE  # the hard cap is untouched


# #540-T04
def test_one_outlier_among_many_completions_does_not_set_the_reservation() -> None:
    ledger = make_ledger(UNCACHED)
    prompt = 10_000
    for index in range(40):
        reservation = ledger.reserve_call(exact(prompt), output_tokens=ALLOWANCE)
        completion = 6_000 if index == 3 else 300
        ledger.settle_call(
            reservation, prompt_tokens=prompt, completion_tokens=completion, cost=Decimal("0.001")
        )
        prompt += 100

    reservation = ledger.reserve_call(exact(prompt), output_tokens=ALLOWANCE)

    assert reservation.cost == UNCACHED.of_call(prompt, 1_024)


# #540-T04
def test_the_output_reservation_never_exceeds_the_allowance() -> None:
    ledger = make_ledger(UNCACHED)

    reservation = ledger.reserve_call(exact(10_000), output_tokens=600)

    assert reservation.cost == UNCACHED.of_call(10_000, 600)


# #540-T04
def test_a_completion_above_the_allowance_is_still_an_accounting_failure() -> None:
    ledger = make_ledger(UNCACHED)
    reservation = ledger.reserve_call(exact(10_000), output_tokens=2_000)

    with pytest.raises(LimitError) as failed:
        ledger.settle_call(
            reservation, prompt_tokens=10_000, completion_tokens=2_001, cost=Decimal("0.03")
        )
    assert failed.value.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED


# #540-T05
def test_the_final_call_is_reserved_with_the_growth_the_run_showed_not_128_kib() -> None:
    # 40,000 tokens of history and a round growth of 780 tokens. The old rule added 128 KiB
    # (43,691 tokens) and the full allowance for the final call, and wrapped up from about 0.55 of
    # a 1 USD limit on. The realistic final call still leaves room for one more normal call.
    ledger = make_ledger(SONNET, limit="0.30")
    previous = 0
    for prompt in (38_000, 38_780, 39_560):
        settle_cached_call(ledger, prompt, read=previous, write=prompt - previous)
        previous = prompt

    reservation = ledger.reserve_call(exact(40_340), output_tokens=ALLOWANCE, can_wrap_up=True)

    assert reservation.final is False


# #540-T05
def test_the_final_call_writes_a_review_so_it_reserves_more_output_than_a_tool_call() -> None:
    clock = [0.0]
    ledger = BudgetLedger(
        DynamicLimits(max_cost_usd=Decimal(1)),
        window_tokens=1_000_000,
        output_tokens=ALLOWANCE,
        unit_costs=UNCACHED,
        clock=lambda: clock[0],
    )
    clock[0] = 500.0  # inside the clock reserve: this call is the final one

    final = ledger.reserve_call(exact(1_000), output_tokens=ALLOWANCE, can_wrap_up=True)

    assert final.final is True
    assert final.cost == UNCACHED.of_call(1_000, 4_096)


# #540-T05
def test_a_final_call_that_does_not_fit_the_limit_is_refused() -> None:
    ledger = make_ledger(UNCACHED, limit="0.04")
    first = ledger.reserve_call(exact(10_000), output_tokens=ALLOWANCE)
    ledger.settle_call(first, prompt_tokens=10_000, completion_tokens=100, cost=Decimal("0.039"))

    with pytest.raises(LimitError) as refused:
        ledger.reserve_call(exact(10_780), output_tokens=ALLOWANCE, can_wrap_up=True)
    assert refused.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert refused.value.detail == "the cost limit is used up"


# #540-T05
def test_the_final_call_is_delivered_even_if_it_costs_more_than_expected() -> None:
    run = run_profile(SONNET, cached=True, final_completion=8_000, limit="0.40")

    assert run.ledger.stopped_early == "cost_limit"
    # The documented bound: the spend was within the limit when the last call started, so the run
    # exceeds it by at most that call's real cost.
    assert run.spent_before_last <= Decimal("0.40")
    assert run.total <= Decimal("0.40") + run.last_cost


# #540-T05
def test_a_normal_call_that_settles_over_the_limit_still_fails_closed() -> None:
    ledger = make_ledger(SONNET, limit="0.12")
    reservation = ledger.reserve_call(exact(10_000), output_tokens=ALLOWANCE)

    with pytest.raises(LimitError) as refused:
        ledger.settle_call(
            reservation, prompt_tokens=10_000, completion_tokens=100, cost=Decimal("0.13")
        )
    assert refused.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED


# #540-T06
def test_the_recovery_call_is_priced_with_the_cached_prefix() -> None:
    # The same two calls, the same 0.0494 spent, the same limit: the recovery call fits when the
    # previous prompt is read from the cache, and does not when it is priced as plain input.
    cached = make_ledger(SONNET, limit="0.10")
    settle_cached_call(cached, 14_600, read=0, write=14_600)
    settle_cached_call(cached, 15_380, read=14_600, write=780)
    assert cached.begin_recovery() is True

    plain = make_ledger(UNCACHED, limit="0.10")
    for prompt, cost in ((14_600, "0.0405"), (15_380, "0.0089")):
        reservation = plain.reserve_call(exact(prompt), output_tokens=ALLOWANCE)
        plain.settle_call(
            reservation, prompt_tokens=prompt, completion_tokens=400, cost=Decimal(cost)
        )
    assert plain.begin_recovery() is False


# #540-T06
def test_the_retry_of_a_final_call_is_priced_with_the_cached_prefix() -> None:
    clock = [0.0]
    ledger = BudgetLedger(
        DynamicLimits(max_cost_usd=Decimal("0.20")),
        window_tokens=1_000_000,
        output_tokens=ALLOWANCE,
        unit_costs=SONNET,
        clock=lambda: clock[0],
    )
    settle_cached_call(ledger, 14_600, read=0, write=14_600)
    settle_cached_call(ledger, 15_380, read=14_600, write=780)
    clock[0] = 500.0  # inside the clock reserve: the next call is the final one
    final = ledger.reserve_call(
        exact(16_160), output_tokens=ALLOWANCE, can_wrap_up=True, wrap_up_text="w"
    )
    assert final.final is True
    ledger.settle_call(
        final,
        prompt_tokens=16_160,
        completion_tokens=500,
        cost=Decimal("0.009"),
        cache_read_tokens=15_380,
        cache_write_tokens=780,
    )

    retry = ledger.try_reserve_final_retry(exact(16_900), output_tokens=ALLOWANCE)

    # The prefix is read, the output is a review's: about 0.046, where the plain price of the
    # prompt and the full allowance would be 0.116.
    assert retry is not None
    assert retry.cost < Decimal("0.05")


# #540-T07
@pytest.mark.parametrize("seed", range(40))
def test_the_run_never_exceeds_the_limit_by_more_than_the_last_calls_cost(seed: int) -> None:
    rng = random.Random(seed)
    prices = rng.choice([SONNET, UNCACHED])
    limit = Decimal(rng.choice(["0.05", "0.20", "1.00"]))
    ledger = make_ledger(prices, str(limit))
    total = Decimal(0)
    previous = 0
    prompt = rng.randint(2_000, 30_000)
    for _ in range(300):
        prompt += rng.choice([300, 800, 800, 2_000, 21_000])  # now and then a 64 KiB result
        try:
            reservation = ledger.reserve_call(
                request_for(prompt), output_tokens=ALLOWANCE, can_wrap_up=True
            )
        except LimitError as refused:
            assert refused.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
            assert total <= limit
            return
        miss = prices.cache_read_usd_per_mtok is not None and rng.random() < 0.15
        read = 0 if miss or prices is UNCACHED else previous
        write = 0 if prices is UNCACHED else prompt - read
        completion = rng.choice([100, 400, 400, 2_000, 4_000])
        if reservation.final:
            completion = rng.choice([1_000, 4_000, 8_000])
        cost = call_cost(
            prices, uncached=prompt - read - write, read=read, write=write, completion=completion
        )
        spent_before = total
        try:
            ledger.settle_call(
                reservation,
                prompt_tokens=prompt,
                completion_tokens=completion,
                cost=cost,
                cache_read_tokens=read if prices is not UNCACHED else None,
                cache_write_tokens=write if prices is not UNCACHED else None,
            )
        except LimitError as failed:
            assert failed.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
            assert not reservation.final
            total += cost
            assert spent_before <= limit
            assert total <= limit + cost
            return
        total += cost
        # Admission: the spend was within the limit when this call started.
        assert spent_before <= limit
        if reservation.final:
            assert total <= limit + cost
            return
        assert total <= limit
        previous = prompt
    raise AssertionError("the run never ended")
