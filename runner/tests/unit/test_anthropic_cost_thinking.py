# SPDX-License-Identifier: Apache-2.0

"""The cost of a call on a model that thinks (#533).

Thinking tokens are output tokens: Anthropic bills them at the output price and counts them in
`output_tokens`; `output_tokens_details.thinking_tokens` is a breakdown of that number, not a
charge on top. The thinking blocks the wire sends back with the next call are input and show up in
the input and cache counts. So the price of a call does not change with the breakdown: it is
checked, never added, and a breakdown that does not fit the output makes the cost unknown instead
of a guess."""

from decimal import Decimal
from typing import Any

import pytest

from code_reviewer_runner.anthropic_cost import cost_of_usage

MODEL = "claude-sonnet-5-5"
# Sonnet 5.5: $2 in and $10 out per million tokens.
PRICED = {"prompt_tokens": 10_000, "completion_tokens": 3000, "total_tokens": 13_000}
EXPECTED = Decimal("0.05")  # 10000 x 2 + 3000 x 10 = 50000 per million


# #533-T09
def test_the_thinking_tokens_inside_the_output_tokens_are_priced_once_at_the_output_price() -> None:
    plain = cost_of_usage(MODEL, PRICED)
    thinking = cost_of_usage(
        MODEL, {**PRICED, "completion_tokens_details": {"reasoning_tokens": 2400}}
    )

    assert plain == EXPECTED
    assert thinking == EXPECTED


# #533-T09
@pytest.mark.parametrize("reasoning", [0, 3000])
def test_none_and_all_of_the_output_may_be_thinking(reasoning: int) -> None:
    usage = {**PRICED, "completion_tokens_details": {"reasoning_tokens": reasoning}}

    assert cost_of_usage(MODEL, usage) == EXPECTED


# #533-T10
@pytest.mark.parametrize("reasoning", [3001, 10**6, -1, 2.5, True, "600"])
def test_a_thinking_count_that_does_not_fit_the_output_is_an_unknown_cost_not_a_sum(
    reasoning: Any,
) -> None:
    usage = {**PRICED, "completion_tokens_details": {"reasoning_tokens": reasoning}}

    assert cost_of_usage(MODEL, usage) is None


# #533-T10
def test_a_breakdown_the_cost_rule_does_not_read_is_still_refused_by_default() -> None:
    usage = {**PRICED, "output_tokens_details": {"thinking_tokens": 600}}

    assert cost_of_usage(MODEL, usage) is None
