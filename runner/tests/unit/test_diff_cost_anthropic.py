# SPDX-License-Identifier: Apache-2.0

"""The cost meter of a Diff run with a provider that states no charge (#511).

Anthropic returns token counts only, so the meter prices every answer with the provider's rule
(`llm_providers.ANTHROPIC`): the model that the request named, the counts of the answer, the price
list. The sum is exact, and a call that cannot be priced makes the cost unknown, never zero."""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

import pytest
from litellm.exceptions import APIError

from code_reviewer_runner.diff_cost import DiffCostMeter, install_cost_meter
from code_reviewer_runner.llm_providers import ANTHROPIC, OPENROUTER

Completion = Callable[..., Awaitable[Any]]


class Boundary:
    def __init__(self, completion: Completion) -> None:
        self.acompletion = completion


def answer(prompt: int = 1000, completion: int = 500, **extra: Any) -> SimpleNamespace:
    """A non-streaming answer as LiteLLM returns one for Anthropic: counts, no charge."""
    usage: dict[str, Any] = {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": prompt + completion,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 0,
    }
    usage.update(extra)
    return SimpleNamespace(choices=[], usage=SimpleNamespace(**usage))


def replying(*replies: Any) -> Completion:
    pending = list(replies)

    async def completion(*args: Any, **kwargs: Any) -> Any:
        reply = pending.pop(0)
        if isinstance(reply, BaseException):
            raise reply
        return reply

    return completion


@pytest.fixture
def installed() -> Iterator[Callable[[Completion], tuple[Boundary, DiffCostMeter]]]:
    undos: list[Callable[[], None]] = []

    def install(completion: Completion) -> tuple[Boundary, DiffCostMeter]:
        boundary = Boundary(completion)
        meter, undo = install_cost_meter(boundary, provider=ANTHROPIC)
        undos.append(undo)
        return boundary, meter

    yield install
    for undo in reversed(undos):
        undo()


Install = Callable[[Completion], tuple[Boundary, DiffCostMeter]]


async def call(boundary: Boundary, model: str = "anthropic/claude-haiku-5-5") -> Any:
    return await boundary.acompletion(model=model, messages=[])


# #511-T17
def test_an_answer_is_priced_from_its_counts_and_the_price_list_of_the_model(
    installed: Install,
) -> None:
    boundary, meter = installed(replying(answer(1000, 500)))

    asyncio.run(call(boundary))

    # Haiku 5.5: $0.10 in, $0.50 out per million tokens.
    assert meter.cost_usd() == Decimal("0.00035")


# #511-T17
def test_the_cost_of_several_calls_is_their_exact_sum(installed: Install) -> None:
    boundary, meter = installed(replying(answer(1000, 500), answer(2000, 100), answer(7, 3)))

    async def run() -> None:
        for _ in range(3):
            await call(boundary)

    asyncio.run(run())

    # 0.00035 + 0.00025 + 0.0000022 (each call: input x 0.1 + output x 0.5, per million tokens)
    assert meter.cost_usd() == Decimal("0.0006022")


# #511-T17
def test_cache_tokens_are_priced_at_their_own_prices(installed: Install) -> None:
    reply = answer(
        35_000,
        3000,
        cache_read_input_tokens=20_000,
        cache_creation_input_tokens=5000,
        prompt_tokens_details=SimpleNamespace(
            cache_creation_token_details=SimpleNamespace(
                ephemeral_5m_input_tokens=3000, ephemeral_1h_input_tokens=2000
            )
        ),
    )
    boundary, meter = installed(replying(reply))

    asyncio.run(call(boundary, "anthropic/claude-sonnet-4-6"))

    # Sonnet 4.6: 10000 x 3 + 3000 x 15 + 20000 x 0.30 + 3000 x 3.75 + 2000 x 6, per million.
    assert meter.cost_usd() == Decimal("0.104250")


# #511-T17
def test_each_call_is_priced_by_the_model_its_request_named(installed: Install) -> None:
    boundary, meter = installed(replying(answer(100_000, 0), answer(100_000, 0)))

    async def run() -> None:
        await call(boundary, "anthropic/claude-haiku-5-5")
        await call(boundary, "anthropic/claude-sonnet-4-6")

    asyncio.run(run())

    # 100000 tokens in: Haiku 5.5 at $0.10 and Sonnet 4.6 at $3 per million.
    assert meter.cost_usd() == Decimal("0.31")


# #511-T17
def test_a_model_that_is_not_listed_makes_the_cost_unknown(installed: Install) -> None:
    boundary, meter = installed(replying(answer(), answer()))

    async def run() -> None:
        await call(boundary, "anthropic/claude-haiku-5-5")
        await call(boundary, "anthropic/claude-haiku-5-5-latest")

    asyncio.run(run())

    assert meter.cost_usd() is None


# #511-T17
def test_a_request_without_a_model_makes_the_cost_unknown(installed: Install) -> None:
    boundary, meter = installed(replying(answer()))

    async def run() -> None:
        await boundary.acompletion(messages=[])

    asyncio.run(run())

    assert meter.cost_usd() is None


# #511-T17
@pytest.mark.parametrize(
    "reply",
    [
        SimpleNamespace(choices=[], usage=None),
        SimpleNamespace(choices=[], usage=SimpleNamespace(prompt_tokens=10)),
        SimpleNamespace(choices=[], usage=SimpleNamespace(prompt_tokens=-1, completion_tokens=5)),
        {"usage": {}},
    ],
    ids=repr,
)
def test_an_answer_without_usable_counts_makes_the_cost_unknown(
    installed: Install, reply: Any
) -> None:
    boundary, meter = installed(replying(answer(), reply))

    async def run() -> None:
        await call(boundary)
        await call(boundary)

    asyncio.run(run())

    assert meter.cost_usd() is None


# #511-T17
def test_a_charge_the_answer_claims_is_not_what_anthropic_charged(installed: Install) -> None:
    boundary, meter = installed(replying(answer(1000, 500, cost=99.0, response_cost=98.0)))

    asyncio.run(call(boundary))

    assert meter.cost_usd() == Decimal("0.00035")


# #511-T17
def test_a_request_the_provider_refused_is_left_out_and_the_fallback_is_priced(
    installed: Install,
) -> None:
    refused = APIError(429, "slow down", "anthropic", "claude-haiku-5-5")
    boundary, meter = installed(replying(refused, answer(1000, 500)))

    async def run() -> None:
        with pytest.raises(APIError):
            await call(boundary)
        await call(boundary)

    asyncio.run(run())

    assert meter.cost_usd() == Decimal("0.00035")


# #511-T17
def test_a_request_that_may_have_been_billed_makes_the_cost_unknown(installed: Install) -> None:
    broken = APIError(529, "overloaded", "anthropic", "claude-haiku-5-5")
    boundary, meter = installed(replying(broken, answer(1000, 500)))

    async def run() -> None:
        with pytest.raises(APIError):
            await call(boundary)
        await call(boundary)

    asyncio.run(run())

    assert meter.cost_usd() is None
    assert meter.may_have_used_the_model


# #511-T17
def test_a_streamed_answer_is_priced_from_its_last_usage(installed: Install) -> None:
    async def chunks() -> AsyncIterator[Any]:
        yield SimpleNamespace(usage=None)
        yield SimpleNamespace(
            usage=SimpleNamespace(
                prompt_tokens=1000,
                completion_tokens=500,
                cache_read_input_tokens=0,
                cache_creation_input_tokens=0,
            )
        )

    async def completion(*args: Any, **kwargs: Any) -> Any:
        return chunks()

    boundary, meter = installed(completion)

    async def run() -> None:
        stream = await call(boundary)
        async for _ in stream:
            pass

    asyncio.run(run())

    assert meter.cost_usd() == Decimal("0.00035")


# #511-T17: nothing changes for the provider that states its charge.
def test_a_provider_that_states_its_charge_is_read_as_before() -> None:
    boundary = Boundary(replying(SimpleNamespace(choices=[], usage=SimpleNamespace(cost=0.25))))
    meter, undo = install_cost_meter(boundary, provider=OPENROUTER)
    try:
        asyncio.run(call(boundary, "openrouter/vendor/model"))
    finally:
        undo()

    assert meter.cost_usd() == Decimal("0.25")
