# SPDX-License-Identifier: Apache-2.0

"""The cost policy a claim hands a native job (#553): whose key it runs on, the price book the
ledger prices from, and the token cap of an own key.

The runner reads `dynamic.cost` as strictly as the rest of the job (a closed object, no guess): a
managed job without a confirmed book, an own job without a token cap or a book that is not a book
is a refused job, never a run that guesses a price or runs without a bound.
"""

from decimal import Decimal
from typing import Any

import pytest

from code_reviewer_runner.dynamic_review.passthrough.call_usage import CallUsage
from code_reviewer_runner.dynamic_review.passthrough.cost_policy import (
    DEFAULT_OWN_KEY_MAX_TOTAL_TOKENS,
    CostPolicy,
    CostPolicyError,
    KeyMode,
    parse_cost_policy,
    unit_costs_of,
)
from code_reviewer_runner.dynamic_review.passthrough.pricing import call_cost

LEVEL: dict[str, Any] = {
    "input": "3000000",
    "output": "15000000",
    "cacheRead": "300000",
    "cacheWrite5m": "3750000",
    "cacheWrite1h": None,
    "reasoning": None,
    "inputAudio": None,
    "outputAudio": None,
    "contextOver200k": None,
    "tiers": [],
}


def managed(**overrides: Any) -> dict[str, Any]:
    document: dict[str, Any] = {"keyMode": "managed", "priceBook": LEVEL, "maxTotalTokens": None}
    document.update(overrides)
    return document


def own(**overrides: Any) -> dict[str, Any]:
    document: dict[str, Any] = {"keyMode": "own", "priceBook": None, "maxTotalTokens": 4_000_000}
    document.update(overrides)
    return document


# #553-R01
def test_a_managed_policy_carries_the_book_and_ends_the_run_on_an_unknown_cost() -> None:
    policy = parse_cost_policy(managed())
    assert policy.key_mode is KeyMode.MANAGED
    assert policy.book is not None and policy.book.base.input == 3_000_000
    assert policy.max_total_tokens is None
    assert policy.unknown_cost_ends_run is True
    assert policy.priced is True


# #553-R01
def test_an_own_policy_without_a_book_is_unpriced_and_keeps_going_under_the_token_cap() -> None:
    policy = parse_cost_policy(own())
    assert policy.key_mode is KeyMode.OWN
    assert policy.book is None and policy.priced is False
    assert policy.max_total_tokens == 4_000_000
    assert policy.unknown_cost_ends_run is False


# #553-R01
def test_an_own_policy_may_carry_the_price_the_catalog_states() -> None:
    policy = parse_cost_policy(own(priceBook=LEVEL))
    assert policy.priced is True and policy.unknown_cost_ends_run is False


# #553-R02
@pytest.mark.parametrize(
    "document",
    [
        None,
        [],
        "managed",
        {},
        managed(keyMode="operator"),
        managed(keyMode=None),
        # A managed key never runs without a confirmed book, and never under a token cap of ours.
        managed(priceBook=None),
        managed(priceBook={"input": "1"}),
        managed(priceBook={**LEVEL, "input": "3.5"}),
        managed(maxTotalTokens=4_000_000),
        # An own key always has a bound.
        own(maxTotalTokens=None),
        own(maxTotalTokens=0),
        own(maxTotalTokens=-1),
        own(maxTotalTokens=True),
        own(maxTotalTokens=1.5),
        own(maxTotalTokens="4000000"),
        own(maxTotalTokens=10**12),
        own(priceBook={"input": "x"}),
        {**managed(), "surprise": 1},
    ],
)
def test_a_policy_that_is_not_exactly_a_policy_is_refused(document: Any) -> None:
    with pytest.raises(CostPolicyError) as raised:
        parse_cost_policy(document)
    assert raised.value.code == "cost_policy_invalid"


# #553-R03
def test_the_default_token_cap_of_an_own_key_is_four_million() -> None:
    assert DEFAULT_OWN_KEY_MAX_TOTAL_TOKENS == 4_000_000


# #553-R04
def test_a_book_of_the_claim_does_not_price_a_cache_read_as_input() -> None:
    # N4 of the review of PR #569: the claim decides. A confirmed book with no read price makes a
    # call that read from the cache unpriced (unknown), where the descriptor of a legacy job still
    # prices it as input.
    no_read = {**LEVEL, "cacheRead": None}
    policy = parse_cost_policy(managed(priceBook=no_read))
    assert policy.book is not None
    plain = CallUsage(prompt_tokens=1000, completion_tokens=10)
    cached = CallUsage(prompt_tokens=1000, completion_tokens=10, cache_read=400)
    assert call_cost(plain, policy.book) is not None
    assert call_cost(cached, policy.book) is None
    # With a read price it is priced as usual.
    priced = parse_cost_policy(managed()).book
    assert priced is not None
    # 600 plain input tokens at 3, 400 cache reads at 0.3 and 10 output tokens at 15, per million.
    assert call_cost(cached, priced) == Decimal("0.00207")


def test_the_policy_type_is_immutable() -> None:
    policy = CostPolicy(key_mode=KeyMode.OWN, book=None, max_total_tokens=10)
    with pytest.raises(AttributeError):
        policy.max_total_tokens = 11  # type: ignore[misc]


# #553-R06
def test_a_reservation_is_made_with_the_base_level_of_the_book_and_with_no_price_without_one() -> (
    None
):
    priced = parse_cost_policy(managed(priceBook={**LEVEL, "cacheWrite1h": "6000000"}))
    costs = unit_costs_of(priced.book)
    assert costs.input_usd_per_mtok == Decimal(3) and costs.output_usd_per_mtok == Decimal(15)
    assert costs.cache_read_usd_per_mtok == Decimal("0.3")
    assert costs.cache_write_usd_per_mtok == Decimal("3.75")
    assert costs.cache_write_1h_usd_per_mtok == Decimal(6)
    nothing = unit_costs_of(None)
    assert nothing.input_usd_per_mtok == 0 and nothing.output_usd_per_mtok == 0
    assert nothing.cache_read_usd_per_mtok is None
