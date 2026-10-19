# SPDX-License-Identifier: Apache-2.0

"""The runner's copy of the Anthropic model list (#511): it must be the list the app offers and the
contract file records, and every entry must be sane."""

import json
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.anthropic_models import (
    AS_OF,
    DEFAULT_MODELS,
    MODELS,
    ClaudeModel,
    Prices,
    model_for,
)

CONTRACT = Path(__file__).resolve().parents[3] / "contracts" / "anthropic-models.v1.json"


def _contract() -> dict[str, Any]:
    document: dict[str, Any] = json.loads(CONTRACT.read_text(encoding="utf-8"))
    return document


def _prices(entry: Prices) -> dict[str, str]:
    return {
        "input": str(entry.input),
        "output": str(entry.output),
        "cacheRead": str(entry.cache_read),
        "cacheWrite5m": str(entry.cache_write_5m),
        "cacheWrite1h": str(entry.cache_write_1h),
    }


def _as_contract(model: ClaudeModel) -> dict[str, Any]:
    return {
        "id": model.id,
        "displayName": model.display_name,
        "contextWindowTokens": model.context_window_tokens,
        "maxOutputTokens": model.max_output_tokens,
        "retiresNotBefore": model.retires_not_before,
        "supports": {
            "temperature": model.temperature,
            "topP": model.top_p,
            "tools": model.tools,
            "forcedToolChoice": model.forced_tool_choice,
            "thinkingDisabled": model.thinking_disabled,
        },
        "reviewKinds": list(model.review_kinds),
        "pricesUsdPerMTok": _prices(model.prices),
        "longPrompt": None
        if model.long_prompt is None
        else {
            "overInputTokens": model.long_prompt.over_input_tokens,
            "pricesUsdPerMTok": _prices(model.long_prompt.prices),
        },
    }


# #511-T02
def test_the_runner_table_is_the_contract_file_entry_by_entry() -> None:
    contract = _contract()

    # The decimals are compared as numbers: the contract writes "12.50", the table "12.50" too.
    assert [_normalized(_as_contract(m)) for m in MODELS.values()] == [
        _normalized(entry) for entry in contract["models"]
    ]
    assert dict(DEFAULT_MODELS) == contract["defaultModels"]
    assert contract["asOf"] == AS_OF


def _normalized(entry: dict[str, Any]) -> dict[str, Any]:
    def numbers(prices: dict[str, str]) -> dict[str, Decimal]:
        return {name: Decimal(value) for name, value in prices.items()}

    long_prompt = entry["longPrompt"]
    return {
        **entry,
        "pricesUsdPerMTok": numbers(entry["pricesUsdPerMTok"]),
        "longPrompt": None
        if long_prompt is None
        else {**long_prompt, "pricesUsdPerMTok": numbers(long_prompt["pricesUsdPerMTok"])},
    }


# #511-T01
def test_the_table_lists_exactly_the_models_on_offer() -> None:
    assert list(MODELS) == [
        "claude-fable-5-1",
        "claude-opus-5-5",
        "claude-sonnet-5-5",
        "claude-haiku-5-5",
        "claude-fable-5",
        "claude-opus-5",
        "claude-opus-4-8",
        "claude-opus-4-7",
        "claude-opus-4-6",
        "claude-opus-4-5-20251101",
        "claude-sonnet-5",
        "claude-sonnet-4-6",
        "claude-haiku-4-5-20251001",
    ]


# #511-T03
@pytest.mark.parametrize("model", list(MODELS.values()), ids=list(MODELS))
def test_every_entry_has_sane_prices_and_limits(model: ClaudeModel) -> None:
    for prices in [model.prices, *([model.long_prompt.prices] if model.long_prompt else [])]:
        assert prices.input > 0
        assert prices.output > prices.input
        assert 0 < prices.cache_read < prices.input
        # The documented multipliers of the cache writes.
        assert prices.cache_write_5m == prices.input * Decimal("1.25")
        assert prices.cache_write_1h == prices.input * 2
    if model.long_prompt is not None:
        assert model.long_prompt.prices.input > model.prices.input
        assert model.long_prompt.over_input_tokens < model.context_window_tokens
    assert model.context_window_tokens >= model.max_output_tokens
    assert model.top_p == model.temperature
    # #533-T16: Dynamic needs tools; the wire steers a model without a forced choice or with
    # thinking always on, so every model with tools takes both kinds.
    assert model.tools
    assert model.review_kinds == ("diff", "dynamic")


# #511-T03
# #533-T16
def test_the_defaults_are_listed_and_fit_their_review_kind() -> None:
    assert DEFAULT_MODELS == {"diff": "claude-haiku-5-5", "dynamic": "claude-sonnet-5-5"}
    for kind, model_id in DEFAULT_MODELS.items():
        model = model_for(model_id)
        assert model is not None
        assert kind in model.review_kinds


# #511-T06
def test_temperature_and_top_p_are_accepted_by_the_four_older_models_only() -> None:
    assert [m.id for m in MODELS.values() if m.temperature] == [
        "claude-opus-4-6",
        "claude-opus-4-5-20251101",
        "claude-sonnet-4-6",
        "claude-haiku-4-5-20251001",
    ]


# #511-T05
# #533-T16: the four models that were Diff only are the ones the wire steers.
def test_four_models_take_no_forced_tool_choice_or_cannot_run_without_thinking() -> None:
    assert [
        m.id for m in MODELS.values() if not m.forced_tool_choice or not m.thinking_disabled
    ] == [
        "claude-fable-5-1",
        "claude-opus-5-5",
        "claude-sonnet-5-5",
        "claude-fable-5",
    ]
    assert all("dynamic" in m.review_kinds for m in MODELS.values())


# #511-T04
@pytest.mark.parametrize(
    "model_id",
    [
        "",
        "claude-haiku-5-5 ",
        "Claude-Haiku-5-5",
        "anthropic/claude-haiku-5-5",
        "claude-haiku-5.5",
        "claude-haiku-4-5",
        "claude-sonnet-4-5-20250929",
        "claude-haiku-5-5-latest",
        "__class__",
    ],
)
def test_a_model_is_found_by_its_exact_id_only(model_id: str) -> None:
    assert model_for(model_id) is None
