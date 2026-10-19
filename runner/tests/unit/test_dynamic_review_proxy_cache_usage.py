# SPDX-License-Identifier: Apache-2.0

"""The cache tokens of a provider answer reach the cost guard (#540).

The ledger prices the next call from what the previous one read from and wrote to the provider's
cache, so the proxy hands over what the provider reported: Anthropic's counts (translated by the
wire to the names `cache_read_input_tokens` and `cache_creation_input_tokens`) and the chat
protocol's `prompt_tokens_details` (`cached_tokens`, `cache_write_tokens`). A value that is not a
count is no signal; the ledger then prices the call as plain input.
"""

import json
from decimal import Decimal
from typing import Any

import pytest
from anthropic_usage import real_anthropic_usage

from code_reviewer_runner.cache_usage import Counts, counts_of
from code_reviewer_runner.dynamic_review.budget import BudgetLedger, DynamicLimits, UnitCosts
from code_reviewer_runner.dynamic_review.config import new_proxy_capability
from code_reviewer_runner.dynamic_review.proxy import (
    ModelProxy,
    ProxyResponse,
    capabilities_from_config,
)
from code_reviewer_runner.llm_providers import ANTHROPIC, OPENROUTER, LlmProviderSpec

CAPABILITY = new_proxy_capability()
CAPABILITIES = json.dumps(
    {"tool_choice_required": True, "structured_output": True, "max_output_tokens": 4096}
)
UNIT_COSTS = UnitCosts(input_usd_per_mtok=Decimal(2), output_usd_per_mtok=Decimal(10))


class SpyLedger(BudgetLedger):
    """A ledger that remembers what the proxy settled each call with."""

    def __init__(self) -> None:
        super().__init__(DynamicLimits(), unit_costs=UNIT_COSTS)
        self.settled: list[dict[str, Any]] = []

    def settle_call(self, reservation: Any, **settled: Any) -> None:
        self.settled.append(settled)
        super().settle_call(reservation, **settled)


def answer(provider: LlmProviderSpec, usage: dict[str, Any]) -> dict[str, Any]:
    if provider is ANTHROPIC:
        return {
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "model": "claude-sonnet-5",
            "content": [{"type": "text", "text": "ok"}],
            "stop_reason": "end_turn",
            "usage": real_anthropic_usage(**usage),
        }
    return {
        "id": "chatcmpl-1",
        "choices": [{"message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
        "usage": {"cost": 0.0001, **usage},
    }


def settle_one(provider: LlmProviderSpec, usage: dict[str, Any]) -> dict[str, Any]:
    model = "claude-sonnet-5" if provider is ANTHROPIC else "deepseek/deepseek-v4.1-flash"

    def upstream(url: str, body: bytes, headers: dict[str, str], limit: int) -> tuple[int, bytes]:
        return 200, json.dumps(answer(provider, usage)).encode("utf-8")

    ledger = SpyLedger()
    subject = ModelProxy(
        ledger=ledger,
        base_path="/v1",
        model=model,
        upstream_url="https://provider.invalid/v1/chat/completions",
        upstream_api_key="dummy-workspace-key-0123456789",
        upstream_model=model,
        capabilities=capabilities_from_config(CAPABILITIES),
        capability=CAPABILITY,
        post=upstream,
        provider=provider,
    )
    request: dict[str, Any] = {
        "model": model,
        "messages": [{"role": "user", "content": "review " + "x" * 400}],
        "tools": [{"type": "function", "function": {"name": "StructuredOutput", "parameters": {}}}],
        "tool_choice": "auto",
    }
    response: ProxyResponse = subject.handle(
        "POST",
        "/v1/chat/completions",
        json.dumps(request).encode("utf-8"),
        {"Authorization": f"Bearer {CAPABILITY}"},
    )
    assert response.status == 200, response.body
    return ledger.settled[0]


# #540-T08
def test_the_anthropic_cache_counts_reach_the_ledger() -> None:
    settled = settle_one(
        ANTHROPIC,
        {
            "input_tokens": 10,
            "output_tokens": 5,
            "cache_read_input_tokens": 40,
            "cache_creation_input_tokens": 20,
            "cache_creation": {"ephemeral_5m_input_tokens": 20, "ephemeral_1h_input_tokens": 0},
        },
    )

    assert settled["prompt_tokens"] == 70
    assert settled["cache_read_tokens"] == 40
    assert settled["cache_write_tokens"] == 20


# #540-T08
def test_the_chat_protocol_cache_details_reach_the_ledger() -> None:
    settled = settle_one(
        OPENROUTER,
        {
            "prompt_tokens": 70,
            "completion_tokens": 5,
            "prompt_tokens_details": {"cached_tokens": 40, "cache_write_tokens": 20},
        },
    )

    assert (settled["cache_read_tokens"], settled["cache_write_tokens"]) == (40, 20)


# #540-T08
def test_an_answer_without_cache_tokens_settles_without_them() -> None:
    settled = settle_one(OPENROUTER, {"prompt_tokens": 70, "completion_tokens": 5})

    assert settled["cache_read_tokens"] == 0
    assert settled["cache_write_tokens"] == 0


@pytest.mark.parametrize("bad", [-1, True, "40", 1.5, None, [40]])
# #540-T08
def test_a_value_that_is_not_a_count_is_no_cache_signal(bad: Any) -> None:
    usage = {"prompt_tokens_details": {"cached_tokens": bad, "cache_write_tokens": bad}}

    # The one reader of #539: such a call is counted as paid in full, never as cheaper.
    anthropic = {"cache_read_input_tokens": bad, "cache_creation_input_tokens": bad}
    assert counts_of({"prompt_tokens": 70, **anthropic}) == Counts(0, 0, 70)
    assert counts_of({"prompt_tokens": 70, **usage}) == Counts(0, 0, 70)


# #540-T08
def test_cache_tokens_above_the_prompt_are_no_cache_signal_for_the_ledger() -> None:
    settled = settle_one(
        OPENROUTER,
        {
            "prompt_tokens": 70,
            "completion_tokens": 5,
            "prompt_tokens_details": {"cached_tokens": 900},
        },
    )

    # More cached tokens than the prompt cannot be true: the reader of #539 counts the call as paid
    # in full, so the ledger prices the next call as plain input.
    assert settled["cache_read_tokens"] == 0
    assert settled["cache_write_tokens"] == 0


# #540-T08
def test_the_provider_names_win_over_the_details_when_both_are_there() -> None:
    usage = {
        "prompt_tokens": 70,
        "cache_read_input_tokens": 30,
        "prompt_tokens_details": {"cached_tokens": 40},
    }

    assert counts_of(usage) == Counts(30, 0, 40)


# #540-T08
def test_litellms_cache_creation_name_in_the_details_is_read_too() -> None:
    settled = settle_one(
        OPENROUTER,
        {
            "prompt_tokens": 70,
            "completion_tokens": 5,
            "prompt_tokens_details": {"cached_tokens": 40, "cache_creation_tokens": 20},
        },
    )

    assert (settled["cache_read_tokens"], settled["cache_write_tokens"]) == (40, 20)
