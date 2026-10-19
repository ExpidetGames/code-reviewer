# SPDX-License-Identifier: Apache-2.0

"""The cache prices of the cost guard come from the provider's own price list (#540).

The descriptor of a job names the input and output price. The cache-read and cache-write price
belong to the provider's list, which only the runner knows (`anthropic_models.py`); a provider the
runner has no list for gets none, and its calls are priced as plain input. The job and the
repository never name them.
"""

import math
from decimal import Decimal

from code_reviewer_runner import runner
from code_reviewer_runner.anthropic_models import MODELS
from code_reviewer_runner.dynamic_review.budget import UnitCosts
from code_reviewer_runner.dynamic_review.proxy import DynamicCapabilities, with_cache_unit_costs
from code_reviewer_runner.llm_providers import ANTHROPIC, OPENROUTER

SONNET = UnitCosts(input_usd_per_mtok=Decimal(2), output_usd_per_mtok=Decimal(10))


def capabilities() -> DynamicCapabilities:
    return DynamicCapabilities(
        tool_choice_required=True,
        structured_output=True,
        max_output_tokens=8_192,
        context_window_tokens=1_000_000,
        unit_costs=SONNET,
    )


# #540-T09
def test_anthropic_prices_the_cache_from_its_list() -> None:
    prices = ANTHROPIC.cache_unit_costs("claude-sonnet-5")

    assert prices == (Decimal("0.20"), Decimal("2.50"))
    assert prices == (
        MODELS["claude-sonnet-5"].prices.cache_read,
        MODELS["claude-sonnet-5"].prices.cache_write_5m,
    )


# #540-T09
def test_an_unlisted_model_and_a_provider_without_a_list_have_no_cache_unit_costs() -> None:
    assert ANTHROPIC.cache_unit_costs("claude-unknown-9") is None
    assert OPENROUTER.cache_unit_costs("deepseek/deepseek-v4.1-flash") is None


# #540-T09
def test_the_descriptor_of_a_job_is_not_changed_apart_from_the_cache_prices() -> None:
    before = capabilities()
    after = with_cache_unit_costs(before, (Decimal("0.2"), Decimal("2.5")))

    assert after.unit_costs is not None and before.unit_costs is not None
    assert after.unit_costs.input_usd_per_mtok == before.unit_costs.input_usd_per_mtok
    assert after.unit_costs.output_usd_per_mtok == before.unit_costs.output_usd_per_mtok
    assert after.max_output_tokens == before.max_output_tokens
    assert with_cache_unit_costs(before, None) is before


# #540-T09
def test_the_ledger_of_a_run_gets_the_cache_unit_costs_of_its_provider() -> None:
    priced = with_cache_unit_costs(capabilities(), ANTHROPIC.cache_unit_costs("claude-sonnet-5"))
    ledger = runner.dynamic_ledger(priced, {}, 600.0)
    first = ledger.reserve_call("x" * 30_000)
    ledger.settle_call(
        first,
        prompt_tokens=10_000,
        completion_tokens=300,
        cost=Decimal("0.03"),
        cache_read_tokens=0,
        cache_write_tokens=10_000,
    )
    second = ledger.reserve_call("x" * 30_000)
    ledger.settle_call(
        second,
        prompt_tokens=10_000,
        completion_tokens=300,
        cost=Decimal("0.005"),
        cache_read_tokens=10_000,
        cache_write_tokens=0,
    )

    third = ledger.reserve_call("x" * 33_000)

    # 10,000 tokens read, 1,000 written, 1,024 of output.
    assert third.cost == Decimal("0.0020") + Decimal("0.0025") + Decimal("0.01024")


# #540-T09
def test_the_ledger_of_a_run_without_cache_unit_costs_prices_the_prompt_as_input() -> None:
    unpriced = with_cache_unit_costs(capabilities(), None)
    ledger = runner.dynamic_ledger(unpriced, {}, 600.0)
    first = ledger.reserve_call("x" * 30_000)
    ledger.settle_call(
        first,
        prompt_tokens=10_000,
        completion_tokens=300,
        cost=Decimal("0.03"),
        cache_read_tokens=10_000,
        cache_write_tokens=0,
    )

    second = ledger.reserve_call("x" * 33_000)

    assert second.cost == SONNET.of_call(11_000, 1_024)
    assert math.isfinite(float(second.cost))
