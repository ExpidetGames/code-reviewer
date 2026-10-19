# SPDX-License-Identifier: Apache-2.0

"""A Dynamic Review's tool loop against a provider that caches (#539).

The proxy, the Anthropic wire and the cost rule run for real; the Claude API is the fake that keeps
the cache rules of the docs (`fakes/llm/anthropic_cache.py`). The conversation is the engine's: a
system prompt, the task, and then a tool call and its result per turn, the whole history sent again
with every call. What must hold: from the second call on the call reads everything the previous
call wrote, the cost of every call is the exact price of what it read, wrote and did not cache, and
the run costs a fraction of the same run without breakpoints."""

import json
import sys
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from anthropic_usage import real_anthropic_usage

from code_reviewer_runner.anthropic_models import model_for
from code_reviewer_runner.dynamic_review.budget import BudgetLedger, DynamicLimits, UnitCosts
from code_reviewer_runner.dynamic_review.config import new_proxy_capability
from code_reviewer_runner.dynamic_review.proxy import ModelProxy, capabilities_from_config
from code_reviewer_runner.llm_providers import ANTHROPIC

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.llm.anthropic_cache import CacheRequestRejected, PromptCache

KEY = "dummy-anthropic-api03-workspace-key-0123456789"
CAPABILITY = new_proxy_capability()
MODEL = "claude-sonnet-5"
URL = "https://api.anthropic.com/v1/messages"
CAPABILITIES = json.dumps(
    {"tool_choice_required": True, "structured_output": True, "max_output_tokens": 8192}
)
UNIT_COSTS = UnitCosts(input_usd_per_mtok=Decimal(2), output_usd_per_mtok=Decimal(10))
OUTPUT_TOKENS = 50
# The run of the live job that made the cost visible: 55 model calls.
CALLS = 55
MARK = {"type": "ephemeral"}

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "read",
            "description": "Read a file of the checkout. " + "It takes a path. " * 40,
            "parameters": {"type": "object", "properties": {"path": {"type": "string"}}},
        },
    },
    {
        "type": "function",
        "function": {"name": "StructuredOutput", "parameters": {"type": "object"}},
    },
]
SYSTEM = "You review code. " + "Report only what the code shows. " * 150


class CachingClaude:
    """The Claude API with a prompt cache: it asks the tool each time, and answers the usage the
    cache rules give. With `ignore_marks` it behaves as if no request carried a breakpoint."""

    def __init__(self, ignore_marks: bool = False) -> None:
        self.cache = PromptCache()
        self.ignore_marks = ignore_marks
        self.bodies: list[dict[str, Any]] = []
        self.usages: list[dict[str, Any]] = []

    def __call__(
        self, url: str, body: bytes, headers: dict[str, str], limit: int
    ) -> tuple[int, bytes]:
        sent: dict[str, Any] = json.loads(body)
        self.bodies.append(sent)
        seen = without_marks(sent) if self.ignore_marks else sent
        try:
            usage = self.cache.usage(seen, real_anthropic_usage(output_tokens=OUTPUT_TOKENS))
        except CacheRequestRejected as rejected:
            error = {
                "type": "error",
                "error": {"type": "invalid_request_error", "message": str(rejected)},
            }
            return 400, json.dumps(error).encode()
        self.usages.append(usage)
        call_id = f"toolu_{len(self.bodies)}"
        answer = {
            "id": f"msg_{len(self.bodies)}",
            "type": "message",
            "role": "assistant",
            "model": MODEL,
            "content": [
                {"type": "tool_use", "id": call_id, "name": "read", "input": {"path": "a.py"}}
            ],
            "stop_reason": "tool_use",
            "usage": usage,
        }
        return 200, json.dumps(answer).encode()


def without_marks(value: Any) -> Any:
    if isinstance(value, dict):
        fields: dict[str, Any] = value  # pyright: ignore[reportUnknownVariableType]
        return {key: without_marks(item) for key, item in fields.items() if key != "cache_control"}
    if isinstance(value, list):
        items: list[Any] = value  # pyright: ignore[reportUnknownVariableType]
        return [without_marks(item) for item in items]
    return value


def proxy_for(upstream: CachingClaude) -> ModelProxy:
    return ModelProxy(
        ledger=BudgetLedger(DynamicLimits(max_cost_usd=Decimal(100)), unit_costs=UNIT_COSTS),
        base_path="/v1",
        model=MODEL,
        upstream_url=URL,
        upstream_api_key=KEY,
        upstream_model=MODEL,
        capabilities=capabilities_from_config(CAPABILITIES),
        capability=CAPABILITY,
        post=upstream,
        provider=ANTHROPIC,
    )


def history(turns: int, engine_marks: bool) -> list[dict[str, Any]]:
    """What the engine sends after `turns` tool calls. With `engine_marks` it marks its system
    message and its last two messages, as the pinned OpenCode does for a Claude model."""
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": "Review this change. " + "The diff is below. " * 60},
    ]
    for turn in range(turns):
        call = f"call_{turn}"
        arguments = json.dumps({"path": f"src/file{turn}.py"})
        messages.append(
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": call,
                        "type": "function",
                        "function": {"name": "read", "arguments": arguments},
                    }
                ],
            }
        )
        messages.append(
            {
                "role": "tool",
                "tool_call_id": call,
                "content": f"file {turn}: " + "def handler(user):\n    return query(user)\n" * 25,
            }
        )
    if engine_marks:
        messages[0] = {**messages[0], "cache_control": MARK}
        for index in (len(messages) - 2, len(messages) - 1):
            messages[index] = {**messages[index], "cache_control": MARK}
    return messages


def run(upstream: CachingClaude, calls: int = CALLS, engine_marks: bool = False) -> list[Decimal]:
    """The run: `calls` model calls through the proxy. Returns the running total after each."""
    proxy = proxy_for(upstream)
    totals: list[Decimal] = []
    for turns in range(calls):
        body = {
            "model": MODEL,
            "messages": history(turns, engine_marks),
            "tools": TOOLS,
            "tool_choice": "auto",
        }
        response = proxy.handle(
            "POST",
            "/v1/chat/completions",
            json.dumps(body).encode(),
            {"Authorization": f"Bearer {CAPABILITY}"},
        )
        assert response.status == 200, response.body
        cost = proxy.ledger.usage(MODEL).cost_usd
        assert cost is not None
        totals.append(Decimal(repr(cost)))
    return totals


def price_of(usage: dict[str, Any]) -> Decimal:
    """The price of one call by the list, worked out by hand from what the cache reported."""
    entry = model_for(MODEL)
    assert entry is not None
    prices = entry.prices
    return (
        Decimal(usage["input_tokens"]) * prices.input
        + Decimal(usage["cache_read_input_tokens"]) * prices.cache_read
        + Decimal(usage["cache_creation"]["ephemeral_5m_input_tokens"]) * prices.cache_write_5m
        + Decimal(usage["cache_creation"]["ephemeral_1h_input_tokens"]) * prices.cache_write_1h
        + Decimal(usage["output_tokens"]) * prices.output
    ) / Decimal(1_000_000)


# #539-T07
def test_from_the_second_call_on_a_call_reads_everything_the_previous_call_wrote() -> None:
    upstream = CachingClaude()
    run(upstream, calls=12)

    first = upstream.usages[0]
    assert first["cache_read_input_tokens"] == 0
    assert first["cache_creation_input_tokens"] > 1024
    for before, now in zip(upstream.usages, upstream.usages[1:], strict=False):
        assert now["cache_read_input_tokens"] == (
            before["cache_read_input_tokens"] + before["cache_creation_input_tokens"]
        )
        assert now["cache_creation_input_tokens"] > 0
        assert now["cache_creation_input_tokens"] < now["cache_read_input_tokens"]
        assert now["input_tokens"] == 0


# #539-T07
def test_no_call_of_the_loop_is_refused_for_its_breakpoints() -> None:
    upstream = CachingClaude()
    run(upstream, calls=12, engine_marks=True)
    assert len(upstream.usages) == 12


# #539-T18
def test_the_marks_the_engine_put_on_its_messages_change_nothing_on_the_wire() -> None:
    plain, engine = CachingClaude(), CachingClaude()
    run(plain, calls=8)
    run(engine, calls=8, engine_marks=True)
    assert plain.bodies == engine.bodies
    assert plain.usages == engine.usages
    for body in engine.bodies:
        for message in body["messages"]:
            assert set(message) == {"role", "content"}


# #539-T07
def test_a_run_of_55_calls_costs_a_fraction_of_the_same_run_without_breakpoints(
    capsys: pytest.CaptureFixture[str],
) -> None:
    cached, uncached = CachingClaude(), CachingClaude(ignore_marks=True)
    cached_total = run(cached)[-1]
    uncached_total = run(uncached)[-1]

    assert all(usage["cache_read_input_tokens"] == 0 for usage in uncached.usages)
    assert cached_total < uncached_total / 4
    reads = sum(usage["cache_read_input_tokens"] for usage in cached.usages)
    prompt = sum(
        usage["input_tokens"]
        + usage["cache_read_input_tokens"]
        + usage["cache_creation_input_tokens"]
        for usage in cached.usages
    )
    assert reads / prompt > 0.9
    with capsys.disabled():
        print(
            f"\n[#539] {CALLS} calls: {prompt} prompt tokens, {reads} read from the cache; "
            f"cost {cached_total} cached against {uncached_total} uncached "
            f"({(1 - cached_total / uncached_total) * 100:.1f} % saved)"
        )


# #539-T08
def test_the_cost_of_every_call_is_the_exact_price_of_what_it_read_wrote_and_did_not_cache() -> (
    None
):
    upstream = CachingClaude()
    totals = run(upstream, calls=20)
    previous = Decimal(0)
    for total, usage in zip(totals, upstream.usages, strict=True):
        assert total - previous == price_of(usage)
        previous = total
    # A write costs more than a read, so the first call is the dearest of the cached ones.
    first, second = price_of(upstream.usages[0]), price_of(upstream.usages[1])
    assert first > second


# #539-T08
def test_the_uncached_run_is_priced_at_the_input_price() -> None:
    upstream = CachingClaude(ignore_marks=True)
    totals = run(upstream, calls=6)
    previous = Decimal(0)
    for total, usage in zip(totals, upstream.usages, strict=True):
        assert usage["cache_creation_input_tokens"] == 0
        assert total - previous == price_of(usage)
        previous = total
