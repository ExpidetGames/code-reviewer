# SPDX-License-Identifier: LicenseRef-Proprietary

"""The cost of an Anthropic call, worked out from the usage it reports (#511).

Anthropic states token counts and no charge, and billing charges what the call really cost, so the
number must be exact: every kind of token at its own price, the higher tier of Haiku 5.5, and an
unknown cost (never zero) for everything that cannot be priced."""

import json
import logging
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

import pytest
from anthropic_usage import real_anthropic_usage

from code_reviewer_runner.anthropic_cost import cost_of_usage
from code_reviewer_runner.anthropic_models import MODELS
from code_reviewer_runner.anthropic_wire import AnthropicMessagesWire


def usage(
    prompt: int = 0,
    completion: int = 0,
    *,
    cache_read: int = 0,
    cache_write: int = 0,
    write_5m: int | None = None,
    write_1h: int | None = None,
    **extra: Any,
) -> dict[str, Any]:
    """A usage in LiteLLM's shape, the one the runner works with: `prompt_tokens` has the cache."""
    document: dict[str, Any] = {
        "prompt_tokens": prompt + cache_read + cache_write,
        "completion_tokens": completion,
        "cache_read_input_tokens": cache_read,
        "cache_creation_input_tokens": cache_write,
        **extra,
    }
    if write_5m is not None or write_1h is not None:
        document["prompt_tokens_details"] = {
            "cache_creation_token_details": {
                "ephemeral_5m_input_tokens": write_5m or 0,
                "ephemeral_1h_input_tokens": write_1h or 0,
            }
        }
    return document


# #511-T14
def test_a_small_call_costs_what_the_list_price_says_to_the_last_decimal() -> None:
    # Haiku 5.5: $0.10 in, $0.50 out per million tokens.
    assert cost_of_usage("claude-haiku-5-5", usage(1000, 500)) == Decimal("0.00035")
    # Sonnet 4.6: $3 in, $15 out.
    assert cost_of_usage("claude-sonnet-4-6", usage(2_000_000, 1_000_000)) == Decimal("21")
    # One token each at the dearest prices (Fable: $10 / $50): 0.00006 exactly.
    assert cost_of_usage("claude-fable-5-1", usage(1, 1)) == Decimal("0.00006")


# #511-T14
def test_every_kind_of_token_is_priced_on_its_own() -> None:
    # Sonnet 4.6: input 3, output 15, cache read 0.30, 5m write 3.75, 1h write 6.
    call = usage(
        1_234_567,
        345_678,
        cache_read=2_000_000,
        cache_write=150_000,
        write_5m=100_000,
        write_1h=50_000,
    )

    expected = (
        Decimal(1_234_567) * Decimal("3")
        + Decimal(345_678) * Decimal("15")
        + Decimal(2_000_000) * Decimal("0.30")
        + Decimal(100_000) * Decimal("3.75")
        + Decimal(50_000) * Decimal("6")
    ) / Decimal(1_000_000)

    assert cost_of_usage("claude-sonnet-4-6", call) == expected
    assert expected == Decimal("3.703701") + Decimal("5.18517") + Decimal("0.6") + Decimal(
        "0.375"
    ) + Decimal("0.3")


# #511-T14
@pytest.mark.parametrize(
    ("model_id", "read_price"),
    [
        ("claude-fable-5-1", "0.25"),  # 0.025x of the input price
        ("claude-fable-5", "1"),
        ("claude-opus-5-5", "0.20"),  # 0.05x
        ("claude-sonnet-5-5", "0.10"),  # 0.05x
        ("claude-sonnet-5", "0.20"),
        ("claude-opus-4-6", "0.50"),
        ("claude-haiku-4-5-20251001", "0.10"),
    ],
)
def test_a_cache_read_is_priced_at_the_models_own_multiplier(
    model_id: str, read_price: str
) -> None:
    assert cost_of_usage(model_id, usage(cache_read=1_000_000)) == Decimal(read_price)


# #511-T14
def test_cache_writes_are_priced_by_their_lifetime() -> None:
    # Opus 5.5: 5m write $5, 1h write $8.
    assert cost_of_usage(
        "claude-opus-5-5", usage(cache_write=1_000_000, write_5m=1_000_000, write_1h=0)
    ) == Decimal("5")
    assert cost_of_usage(
        "claude-opus-5-5", usage(cache_write=1_000_000, write_5m=0, write_1h=1_000_000)
    ) == Decimal("8")
    # No split reported: the requests of the runner never ask for the longer lifetime.
    assert cost_of_usage("claude-opus-5-5", usage(cache_write=1_000_000)) == Decimal("5")


# #511-T14
@pytest.mark.parametrize("model_id", list(MODELS))
def test_every_listed_model_is_priced_by_its_own_table(model_id: str) -> None:
    model = MODELS[model_id]
    # Under the long-prompt threshold for every model, so the base prices apply.
    call = usage(
        10_000, 3_000, cache_read=20_000, cache_write=5_000, write_5m=3_000, write_1h=2_000
    )

    prices = model.prices
    expected = (
        10_000 * prices.input
        + 3_000 * prices.output
        + 20_000 * prices.cache_read
        + 3_000 * prices.cache_write_5m
        + 2_000 * prices.cache_write_1h
    ) / 1_000_000

    assert cost_of_usage(model_id, call) == expected


# #511-T15
def test_haiku_5_5_charges_the_higher_tier_for_a_prompt_over_100000_tokens() -> None:
    at_limit = usage(100_000, 1000)
    over = usage(100_001, 1000)

    # $0.10 / $0.50 up to and including 100000 input tokens, $0.50 / $2.50 above.
    assert cost_of_usage("claude-haiku-5-5", at_limit) == Decimal("0.0105")
    assert cost_of_usage("claude-haiku-5-5", over) == Decimal("0.0500005") + Decimal("0.0025")


# #511-T15
def test_the_prompt_length_counts_cache_tokens_and_the_whole_request_is_on_the_higher_tier() -> (
    None
):
    # 60000 uncached + 30000 read + 10001 written = 100001 tokens.
    call = usage(60_000, 2_000, cache_read=30_000, cache_write=10_001)

    expected = (
        Decimal(60_000) * Decimal("0.50")
        + Decimal(2_000) * Decimal("2.50")
        + Decimal(30_000) * Decimal("0.05")
        + Decimal(10_001) * Decimal("0.625")
    ) / Decimal(1_000_000)

    assert cost_of_usage("claude-haiku-5-5", call) == expected


# #511-T15
def test_no_other_model_has_a_higher_tier() -> None:
    # The other models charge one price at every length (the full window is at standard pricing).
    assert cost_of_usage("claude-sonnet-5", usage(900_000)) == Decimal("1.8")
    assert cost_of_usage("claude-opus-5", usage(900_000)) == Decimal("4.5")


# #511-T16: an answer always has input and output tokens, so no token at all is a usage that was
# left out (LiteLLM fills a missing usage with zeros): not a call that cost nothing.
def test_a_usage_of_no_token_at_all_is_not_a_cost_of_zero() -> None:
    assert cost_of_usage("claude-haiku-5-5", usage(0, 0)) is None
    assert cost_of_usage("claude-haiku-5-5", {"prompt_tokens": 0, "completion_tokens": 0}) is None


# #511-T16: the smallest real answer still costs something exact.
def test_one_output_token_is_a_cost() -> None:
    assert cost_of_usage("claude-haiku-5-5", usage(0, 1)) == Decimal("0.0000005")


# #511-T16
@pytest.mark.parametrize(
    "model_id",
    ["", "claude-haiku-5-5-latest", "anthropic/claude-haiku-5-5", "claude-haiku-4-5", "gpt-5"],
)
def test_an_unlisted_model_has_no_cost(model_id: str) -> None:
    assert cost_of_usage(model_id, usage(1000, 500)) is None


# #511-T16
@pytest.mark.parametrize(
    "broken",
    [
        None,
        {},
        "usage",
        {"prompt_tokens": 10},
        {"completion_tokens": 10},
        {"prompt_tokens": None, "completion_tokens": 5},
        {"prompt_tokens": -1, "completion_tokens": 5},
        {"prompt_tokens": 10, "completion_tokens": -5},
        {"prompt_tokens": True, "completion_tokens": 5},
        {"prompt_tokens": 10.5, "completion_tokens": 5},
        {"prompt_tokens": "10", "completion_tokens": 5},
        {"prompt_tokens": 10**12, "completion_tokens": 5},
        # More cache tokens than the prompt holds.
        {"prompt_tokens": 10, "completion_tokens": 5, "cache_read_input_tokens": 11},
        {"prompt_tokens": 10, "completion_tokens": 5, "cache_creation_input_tokens": -1},
        {"prompt_tokens": 10, "completion_tokens": 5, "cache_read_input_tokens": "3"},
    ],
)
def test_a_usage_that_cannot_be_read_has_no_cost(broken: object) -> None:
    assert cost_of_usage("claude-haiku-5-5", broken) is None


# #511-T16
def test_a_cache_write_split_that_does_not_add_up_has_no_cost() -> None:
    call = usage(cache_write=100, write_5m=60, write_1h=30)

    assert cost_of_usage("claude-sonnet-4-6", call) is None


# #511-T16
@pytest.mark.parametrize(
    "extra",
    [
        {"service_tier": "priority"},
        {"service_tier": "batch"},
        {"speed": "fast"},
        {"inference_geo": "us"},
        {"inference_geo": "somewhere"},
        {"server_tool_use": {"web_search_requests": 1}},
        {"server_tool_use": {"code_execution_requests": 3}},
        {"server_tool_use": {"an_unheard_of_tool_requests": 1}},
        {"server_tool_use": {"web_search_requests": 0, "code_execution_requests": 2}},
        {"server_tool_use": {"web_search_requests": None, "mystery": "yes"}},
        {"iterations": [{"input_tokens": 1, "output_tokens": 1}]},
    ],
)
def test_a_call_with_a_surcharge_the_table_does_not_know_has_no_cost(extra: dict[str, Any]) -> None:
    assert cost_of_usage("claude-sonnet-5", usage(1000, 500, **extra)) is None


# #511-T16: server tools are denied by default; a tool Anthropic adds later is never priced as free.
def test_an_unknown_server_tool_key_is_an_unknown_cost_not_a_standard_price() -> None:
    standard = usage(1000, 500)

    assert cost_of_usage("claude-sonnet-5", standard) == Decimal("0.007")
    unknown_tool = usage(1000, 500, server_tool_use={"code_execution_requests": 3})
    assert cost_of_usage("claude-sonnet-5", unknown_tool) is None


# #511-T16: so is every field of the usage the list of standard token fields does not name.
@pytest.mark.parametrize(
    "extra",
    [
        {"code_execution_tokens": 7},
        {"a_new_charge": {"units": 1}},
        {"another_new_charge": "yes"},
    ],
)
def test_a_usage_key_outside_the_standard_token_fields_has_no_cost(extra: dict[str, Any]) -> None:
    assert cost_of_usage("claude-sonnet-5", usage(1000, 500, **extra)) is None
    holder = SimpleNamespace(**usage(1000, 500, **extra))
    assert cost_of_usage("claude-sonnet-5", holder) is None


# #511-T16: the check must not turn away what LiteLLM itself makes of a plain Claude answer.
def test_the_usage_litellm_builds_from_a_plain_answer_is_priced() -> None:
    from litellm.llms.anthropic.chat.transformation import AnthropicConfig

    answer = {
        "input_tokens": 1000,
        "output_tokens": 500,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 0,
        "server_tool_use": {"web_search_requests": 0},
        "service_tier": "standard",
        "inference_geo": "global",
    }
    built = AnthropicConfig().calculate_usage(answer, None)  # pyright: ignore[reportUnknownMemberType]

    assert cost_of_usage("claude-sonnet-5", built) == Decimal("0.007")


# #511-T16: an unknown key that holds nothing (None, zero, empty) charges nothing.
def test_an_unknown_usage_key_that_holds_nothing_changes_nothing() -> None:
    quiet = usage(1000, 500, total_tokens=1500, brand_new=None, other=0, empty={}, none_at_all=[])

    assert cost_of_usage("claude-sonnet-5", quiet) == Decimal("0.007")


# #511-T16
@pytest.mark.parametrize(
    "extra",
    [
        {"service_tier": "standard"},
        {"service_tier": None},
        {"speed": "standard"},
        {"inference_geo": "global"},
        {"inference_geo": "not_available"},
        {"inference_geo": None},
        {"server_tool_use": None},
        {"server_tool_use": {}},
        {"server_tool_use": {"web_search_requests": 0}},
        {"server_tool_use": {"web_search_requests": 0, "web_fetch_requests": 0}},
        {"iterations": None},
        {"iterations": []},
    ],
)
def test_the_standard_values_of_those_fields_change_nothing(extra: dict[str, Any]) -> None:
    assert cost_of_usage("claude-sonnet-5", usage(1000, 500, **extra)) == Decimal("0.007")


# #511-T14
def test_a_litellm_usage_object_is_priced_like_the_same_usage_as_a_mapping() -> None:
    details = SimpleNamespace(
        cache_creation_token_details=SimpleNamespace(
            ephemeral_5m_input_tokens=3000, ephemeral_1h_input_tokens=2000
        )
    )
    call = SimpleNamespace(
        prompt_tokens=35_000,
        completion_tokens=3000,
        cache_read_input_tokens=20_000,
        cache_creation_input_tokens=5000,
        prompt_tokens_details=details,
        service_tier=None,
        speed=None,
        inference_geo="global",
        server_tool_use=None,
        iterations=None,
    )

    as_mapping = usage(
        10_000, 3000, cache_read=20_000, cache_write=5000, write_5m=3000, write_1h=2000
    )

    assert cost_of_usage("claude-sonnet-4-6", call) == cost_of_usage(
        "claude-sonnet-4-6", as_mapping
    )
    assert cost_of_usage("claude-sonnet-4-6", call) is not None


# #511-T14
def test_the_cost_survives_the_float_of_the_result_unchanged() -> None:
    # The result carries `costUsd` as a JSON number: a dear call must read back exactly.
    cost = cost_of_usage(
        "claude-fable-5-1",
        usage(987_654, 128_000, cache_read=500_000, cache_write=12_345, write_5m=12_345),
    )

    assert cost is not None
    assert Decimal(repr(float(cost))) == cost


def priced_through_the_wire(model_id: str, real_usage: dict[str, Any]) -> Decimal | None:
    """What the Dynamic proxy does: the Messages answer is translated, then its usage is priced."""
    answer = {
        "type": "message",
        "id": "msg_1",
        "model": model_id,
        "role": "assistant",
        "content": [{"type": "text", "text": "ok"}],
        "stop_reason": "end_turn",
        "usage": real_usage,
    }
    decoded = json.loads(
        AnthropicMessagesWire(model_id).decode_response(json.dumps(answer).encode())
    )
    return cost_of_usage(model_id, decoded["usage"])


# #534-T01: the usage the first real Dynamic run got (every field the API returns) was unknown.
def test_the_usage_a_real_answer_carries_is_priced_exactly() -> None:
    # Sonnet 5: $2 in, $10 out per million tokens.
    assert priced_through_the_wire("claude-sonnet-5", real_anthropic_usage(14_641, 492)) == Decimal(
        "0.034202"
    )


# #534-T03
@pytest.mark.parametrize("thinking", [0, 100, 492])
def test_the_breakdown_of_the_output_tokens_changes_no_price(thinking: int) -> None:
    details = {"thinking_tokens": thinking}
    real = real_anthropic_usage(14_641, 492, output_tokens_details=details)

    assert priced_through_the_wire("claude-sonnet-5", real) == Decimal("0.034202")
    assert cost_of_usage("claude-sonnet-5", usage(1000, 500, output_tokens_details=details)) == (
        Decimal("0.007")
    )
    assert cost_of_usage("claude-sonnet-5", usage(1000, 500, output_tokens_details=None)) == (
        Decimal("0.007")
    )


# #534-T04
@pytest.mark.parametrize(
    "details",
    [
        {"thinking_tokens": 501},
        {"thinking_tokens": -1},
        {"thinking_tokens": "3"},
        {"thinking_tokens": 1.5},
        {"thinking_tokens": 0, "tool_tokens": 7},
        {"a_new_category": {"tokens": 1}},
        "thinking",
        7,
    ],
)
def test_an_output_breakdown_this_table_does_not_know_has_no_cost(details: object) -> None:
    assert cost_of_usage("claude-sonnet-5", usage(1000, 500, output_tokens_details=details)) is None


# #534-T05
def test_the_cache_write_split_alone_is_priced_from_the_split() -> None:
    split = {"ephemeral_5m_input_tokens": 3000, "ephemeral_1h_input_tokens": 2000}
    real = real_anthropic_usage(10_000, 3000, cache_creation=split)
    del real["cache_creation_input_tokens"]

    # Sonnet 5: 10000 x 2 + 3000 x 10 + 3000 x 2.50 + 2000 x 4, per million tokens.
    assert priced_through_the_wire("claude-sonnet-5", real) == Decimal("0.0655")


# #534-T05
def test_a_split_that_disagrees_with_the_flat_write_count_has_no_cost() -> None:
    split = {"ephemeral_5m_input_tokens": 3000, "ephemeral_1h_input_tokens": 2000}
    real = real_anthropic_usage(
        10_000, 3000, cache_creation=split, cache_creation_input_tokens=4000
    )

    assert priced_through_the_wire("claude-sonnet-5", real) is None


# #534-T06, T07, T08: deny by default still holds for the real shape.
@pytest.mark.parametrize(
    "extra",
    [
        {"service_tier": "priority"},
        {"service_tier": "batch"},
        {"service_tier": "flex"},
        {"speed": "fast"},
        {"inference_geo": "us"},
        {"server_tool_use": {"web_fetch_requests": 0, "web_search_requests": 2}},
        {"a_new_charge": {"units": 1}},
    ],
)
def test_a_real_answer_with_a_charge_the_table_does_not_know_has_no_cost(
    extra: dict[str, Any],
) -> None:
    assert (
        priced_through_the_wire("claude-sonnet-5", real_anthropic_usage(1000, 500, **extra)) is None
    )


# #534-T09: the field that made a cost unknown is named in the log, and its value is not.
def test_the_field_that_made_a_cost_unknown_is_logged_without_its_value(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.WARNING, logger="code_reviewer_runner.anthropic_cost"):
        assert cost_of_usage("claude-sonnet-5", usage(1000, 500, service_tier="priority")) is None
        assert cost_of_usage("claude-sonnet-5", usage(1000, 500, a_new_charge="s3cret")) is None

    messages = [record.getMessage() for record in caplog.records]
    assert any("service_tier" in message for message in messages)
    assert any("a_new_charge" in message for message in messages)
    assert not any("priority" in message or "s3cret" in message for message in messages)
