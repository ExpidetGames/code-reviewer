# SPDX-License-Identifier: Apache-2.0

"""Pins down how the cost of a Diff run is measured (#274).

PR-Agent prices a call with a price table when the provider says nothing, and its own sum counts
only the calls it accepted. The runner meters the one function PR-Agent calls LiteLLM through, reads
the charge the provider states in `usage.cost` of every answer (the figure the Dynamic Review reads
from its proxy), and reports the sum all or nothing: any answer without a stated charge, and any
request that ended without an answer, makes the cost unknown. Nothing here is derived from a price
table or from token counts."""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

import pytest
from litellm.exceptions import APIConnectionError, Timeout

from code_reviewer_runner.diff_cost import (
    MAX_CALL_COST_USD,
    MAX_RUN_COST_USD,
    CostMeterError,
    DiffCostMeter,
    install_cost_meter,
)

Completion = Callable[..., Awaitable[Any]]


class Boundary:
    """Stands for PR-Agent's handler module: it has the one name the meter wraps."""

    def __init__(self, completion: Completion) -> None:
        self.acompletion = completion


def answer(cost: Any = None, **usage: Any) -> SimpleNamespace:
    """A non-streaming answer as LiteLLM returns it: `usage.cost` is the provider's charge."""
    fields: dict[str, Any] = {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150}
    if cost is not None:
        fields["cost"] = cost
    fields.update(usage)
    return SimpleNamespace(choices=[], usage=SimpleNamespace(**fields))


def replying(*replies: Any) -> Completion:
    """A completion function that gives the next reply (or raises it, when it is an exception)."""
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
        meter, undo = install_cost_meter(boundary)
        undos.append(undo)
        return boundary, meter

    yield install
    for undo in reversed(undos):
        undo()


Install = Callable[[Completion], tuple[Boundary, DiffCostMeter]]


async def call(boundary: Boundary) -> Any:
    return await boundary.acompletion(model="openrouter/vendor/model", messages=[])


# #274-T01
def test_the_cost_of_three_calls_is_their_exact_decimal_sum(installed: Install) -> None:
    # 0.1 + 0.2 + 0.3 is 0.6000000000000001 as floats; the decimals add up exactly.
    boundary, meter = installed(replying(answer(0.1), answer(0.2), answer(0.3)))

    async def run() -> None:
        for _ in range(3):
            await call(boundary)

    asyncio.run(run())

    assert meter.cost_usd() == Decimal("0.6")


# #274-T01
def test_the_answer_itself_is_handed_on_unchanged(installed: Install) -> None:
    reply = answer(0.01)
    boundary, _ = installed(replying(reply))

    assert asyncio.run(call(boundary)) is reply


# #274-T06: the meter only watches; the request goes where and how PR-Agent built it.
def test_the_request_is_handed_on_exactly_as_pr_agent_built_it(installed: Install) -> None:
    seen: list[tuple[tuple[Any, ...], dict[str, Any]]] = []

    async def completion(*args: Any, **kwargs: Any) -> Any:
        seen.append((args, dict(kwargs)))
        return answer(0.01)

    boundary, _ = installed(completion)
    request: dict[str, Any] = {
        "model": "openrouter/vendor/model",
        "messages": [{"role": "user", "content": "review this"}],
        "api_base": "https://openrouter.ai/api/v1",
        "api_key": "dummy-key",
        "extra_body": {"provider": {"require_parameters": True}},
    }

    async def send() -> None:
        await boundary.acompletion(**request)

    asyncio.run(send())

    assert seen == [((), request)]


# #274-T03: LiteLLM may send the request again inside one call; only the last answer would be seen.
@pytest.mark.parametrize(
    "options",
    [{"num_retries": 2}, {"max_retries": 3}, {"num_retries": "2"}, {"max_retries": True}],
    ids=repr,
)
def test_a_call_that_carries_a_retry_count_is_not_counted_and_keeps_the_cost_unknown(
    installed: Install, options: dict[str, Any]
) -> None:
    seen: list[dict[str, Any]] = []

    async def completion(*args: Any, **kwargs: Any) -> Any:
        seen.append(dict(kwargs))
        return answer(0.01)

    boundary, meter = installed(completion)

    async def run() -> None:
        await boundary.acompletion(model="m", messages=[], **options)
        await boundary.acompletion(model="m", messages=[])

    asyncio.run(run())

    assert seen == [{"model": "m", "messages": [], **options}, {"model": "m", "messages": []}]
    assert meter.cost_usd() is None


@pytest.mark.parametrize(
    "options", [{}, {"num_retries": 0, "max_retries": 0}, {"num_retries": None}]
)
def test_a_call_without_a_retry_count_is_counted(
    installed: Install, options: dict[str, Any]
) -> None:
    boundary, meter = installed(replying(answer(0.01)))

    async def run() -> None:
        await boundary.acompletion(model="m", messages=[], **options)

    asyncio.run(run())

    assert meter.cost_usd() == Decimal("0.01")


# #274-T02: a charge no provider states is not a cost, and a sum that is no number is not reported.
def test_a_huge_stated_charge_is_not_a_cost(installed: Install) -> None:
    boundary, meter = installed(replying(answer(1e308)))

    asyncio.run(call(boundary))

    assert meter.cost_usd() is None


def test_a_run_whose_sum_is_above_the_ceiling_has_no_cost(installed: Install) -> None:
    # Every charge is plausible for one call, the sum of them is not for a run.
    count = int(MAX_RUN_COST_USD / MAX_CALL_COST_USD) + 1
    boundary, meter = installed(replying(*[answer(float(MAX_CALL_COST_USD)) for _ in range(count)]))

    async def run() -> None:
        for _ in range(count):
            await call(boundary)

    asyncio.run(run())

    assert meter.cost_usd() is None


def test_a_charge_just_inside_the_ceiling_is_a_cost(installed: Install) -> None:
    boundary, meter = installed(replying(answer(float(MAX_CALL_COST_USD))))

    asyncio.run(call(boundary))

    assert meter.cost_usd() == MAX_CALL_COST_USD


# #274-T02
def test_one_call_without_a_stated_cost_makes_the_cost_unknown(installed: Install) -> None:
    boundary, meter = installed(replying(answer(0.01), answer(), answer(0.02)))

    async def run() -> None:
        for _ in range(3):
            await call(boundary)

    asyncio.run(run())

    assert meter.cost_usd() is None


# #274-T02
@pytest.mark.parametrize(
    "stated", [None, True, "0.01", float("nan"), float("inf"), -0.01], ids=repr
)
def test_a_charge_that_is_not_a_finite_non_negative_number_is_not_a_cost(
    installed: Install, stated: Any
) -> None:
    reply = answer(**({} if stated is None else {"cost": stated}))
    boundary, meter = installed(replying(reply))

    asyncio.run(call(boundary))

    assert meter.cost_usd() is None


# A free model states a charge of zero: that is a known cost, not a missing one.
def test_a_stated_charge_of_zero_is_a_known_cost(installed: Install) -> None:
    boundary, meter = installed(replying(answer(0), answer(0.0)))

    async def run() -> None:
        await call(boundary)
        await call(boundary)

    asyncio.run(run())

    assert meter.cost_usd() == Decimal(0)


def test_a_run_without_any_answer_has_no_cost(installed: Install) -> None:
    _, meter = installed(replying())

    assert meter.cost_usd() is None


def test_an_answer_with_no_usage_at_all_makes_the_cost_unknown(installed: Install) -> None:
    boundary, meter = installed(replying(SimpleNamespace(choices=[], usage=None)))

    asyncio.run(call(boundary))

    assert meter.cost_usd() is None


def test_a_dictionary_answer_is_read_like_an_object(installed: Install) -> None:
    boundary, meter = installed(replying({"usage": {"cost": 0.25}}))

    asyncio.run(call(boundary))

    assert meter.cost_usd() == Decimal("0.25")


# #274-T08
def test_a_cost_that_litellm_worked_out_itself_is_never_used(installed: Install) -> None:
    # `response_cost` (usage and hidden parameters) is what LiteLLM derives from its price table
    # when the provider states nothing; it is not the provider's charge.
    reply = answer(response_cost=0.5)
    reply._hidden_params = {"response_cost": 0.5}  # pyright: ignore[reportAttributeAccessIssue]
    boundary, meter = installed(replying(reply))

    asyncio.run(call(boundary))

    assert meter.cost_usd() is None


# #274-T08
def test_the_stated_charge_wins_over_anything_litellm_derived(installed: Install) -> None:
    reply = answer(0.0123, response_cost=9.0)
    reply._hidden_params = {"response_cost": 9.0}  # pyright: ignore[reportAttributeAccessIssue]
    boundary, meter = installed(replying(reply))

    asyncio.run(call(boundary))

    assert meter.cost_usd() == Decimal("0.0123")


def status_error(status: int) -> Exception:
    """An exception that carries this status, like LiteLLM's. The integration test of the meter
    (`tests/integration/test_diff_cost_litellm.py`) gets the real ones from LiteLLM."""
    from litellm.exceptions import APIError

    return APIError(status, "the provider answered", "openrouter", "vendor/model")


# #274-T03: only an error that comes before any generation costs nothing.
@pytest.mark.parametrize("status", [400, 401, 403, 404, 422, 429])
def test_a_request_rejected_before_any_generation_costs_nothing_and_keeps_the_cost_known(
    installed: Install, status: int
) -> None:
    # The primary model is refused, the fallback model answers.
    error = status_error(status)
    assert getattr(error, "status_code") == status  # noqa: B009
    boundary, meter = installed(replying(error, answer(0.02)))

    async def run() -> None:
        with pytest.raises(type(error)):
            await call(boundary)
        await call(boundary)

    asyncio.run(run())

    assert meter.cost_usd() == Decimal("0.02")


# #274-T03: LiteLLM's status is not always the provider's (an HTTP 200 with an error body is raised
# as a 502), and a server or gateway error may come while the provider is still working.
@pytest.mark.parametrize("status", [500, 502, 503, 504, 524, 599, 418])
def test_a_server_error_or_a_status_nobody_knows_leaves_the_cost_unknown(
    installed: Install, status: int
) -> None:
    error = status_error(status)
    assert getattr(error, "status_code") == status  # noqa: B009
    boundary, meter = installed(replying(error, answer(0.02)))

    async def run() -> None:
        with pytest.raises(type(error)):
            await call(boundary)
        await call(boundary)

    asyncio.run(run())

    assert meter.cost_usd() is None


# #274-T03: an exception without a status of the provider is not a refusal.
def test_an_exception_without_a_status_leaves_the_cost_unknown(installed: Install) -> None:
    boundary, meter = installed(replying(RuntimeError("something"), answer(0.02)))

    async def run() -> None:
        with pytest.raises(RuntimeError):
            await call(boundary)
        await call(boundary)

    asyncio.run(run())

    assert meter.cost_usd() is None


# #274-T03
def test_an_answer_that_pr_agent_throws_away_afterwards_is_still_counted(
    installed: Install,
) -> None:
    # An empty reply is billed. PR-Agent raises on it and tries the fallback model, but the
    # answer came back through the metered function first.
    boundary, meter = installed(replying(answer(0.01), answer(0.02)))

    async def run() -> None:
        first = await call(boundary)
        del first  # rejected by the caller
        await call(boundary)

    asyncio.run(run())

    assert meter.cost_usd() == Decimal("0.03")


# #274-T03
@pytest.mark.parametrize(
    "error",
    [
        Timeout("no answer in time", "vendor/model", "openrouter"),
        APIConnectionError("connection lost", "openrouter", "vendor/model", request=None),
    ],
    ids=["timeout", "connection lost"],
)
def test_a_request_that_ended_without_an_answer_makes_the_cost_unknown(
    installed: Install, error: Exception
) -> None:
    # The provider may have processed and charged it: nobody can say, so the sum is not exact.
    boundary, meter = installed(replying(error, answer(0.02)))

    async def run() -> None:
        with pytest.raises(type(error)):
            await call(boundary)
        await call(boundary)

    asyncio.run(run())

    assert meter.cost_usd() is None


# #274-T03
def test_a_request_that_is_cancelled_makes_the_cost_unknown(installed: Install) -> None:
    async def never_answers(*args: Any, **kwargs: Any) -> Any:
        await asyncio.sleep(30)

    boundary, meter = installed(never_answers)

    async def run() -> None:
        with pytest.raises(TimeoutError):
            async with asyncio.timeout(0.05):
                await call(boundary)

    asyncio.run(run())

    assert meter.cost_usd() is None


# #274-T04
def test_every_call_of_a_chunked_review_is_counted_also_when_they_run_together(
    installed: Install,
) -> None:
    boundary, meter = installed(
        replying(answer(0.001), answer(0.002), answer(0.004), answer(0.008), answer(0.016))
    )

    async def run() -> None:
        await asyncio.gather(*(call(boundary) for _ in range(5)))

    asyncio.run(run())

    assert meter.cost_usd() == Decimal("0.031")


# #274-T04
def test_a_call_that_has_not_answered_yet_keeps_the_cost_unknown(installed: Install) -> None:
    release = asyncio.Event()
    states: list[Decimal | None] = []

    async def slow(*args: Any, **kwargs: Any) -> Any:
        await release.wait()
        return answer(0.02)

    boundary, meter = installed(slow)

    async def run() -> None:
        task = asyncio.ensure_future(call(boundary))
        await asyncio.sleep(0)
        states.append(meter.cost_usd())
        release.set()
        await task
        states.append(meter.cost_usd())

    asyncio.run(run())

    assert states == [None, Decimal("0.02")]


def stream_of(*chunks: Any, then: BaseException | None = None) -> Completion:
    async def chunks_of() -> AsyncIterator[Any]:
        for chunk in chunks:
            yield chunk
        if then is not None:
            raise then

    async def completion(*args: Any, **kwargs: Any) -> Any:
        return chunks_of()

    return completion


def text_chunk() -> SimpleNamespace:
    return SimpleNamespace(choices=[SimpleNamespace()], usage=None)


async def drain(stream: Any) -> list[Any]:
    return [chunk async for chunk in stream]


# #274-T04
def test_the_charge_of_a_streamed_answer_is_read_from_its_last_chunk(installed: Install) -> None:
    boundary, meter = installed(
        stream_of(text_chunk(), text_chunk(), SimpleNamespace(choices=[], usage=answer(0.03).usage))
    )

    async def run() -> list[Any]:
        return await drain(await call(boundary))

    chunks = asyncio.run(run())

    assert len(chunks) == 3
    assert meter.cost_usd() == Decimal("0.03")


def test_the_usage_of_a_streamed_answer_may_sit_in_the_hidden_parameters(
    installed: Install,
) -> None:
    last = SimpleNamespace(choices=[], usage=None, _hidden_params={"usage": answer(0.04).usage})
    boundary, meter = installed(stream_of(text_chunk(), last))

    async def run() -> None:
        await drain(await call(boundary))

    asyncio.run(run())

    assert meter.cost_usd() == Decimal("0.04")


def test_a_streamed_answer_without_a_stated_charge_makes_the_cost_unknown(
    installed: Install,
) -> None:
    boundary, meter = installed(stream_of(text_chunk(), text_chunk()))

    async def run() -> None:
        await drain(await call(boundary))

    asyncio.run(run())

    assert meter.cost_usd() is None


def test_a_stream_that_is_not_read_to_its_end_keeps_the_cost_unknown(installed: Install) -> None:
    boundary, meter = installed(
        stream_of(text_chunk(), SimpleNamespace(choices=[], usage=answer(0.03).usage))
    )

    async def run() -> None:
        stream = await call(boundary)
        async for _ in stream:
            break  # the consumer stops early and leaves the stream suspended

    asyncio.run(run())

    assert meter.cost_usd() is None


def test_a_stream_that_fails_half_way_keeps_the_cost_unknown(installed: Install) -> None:
    boundary, meter = installed(stream_of(text_chunk(), then=RuntimeError("cut off")))

    async def run() -> None:
        with pytest.raises(RuntimeError):
            await drain(await call(boundary))

    asyncio.run(run())

    assert meter.cost_usd() is None


# The patch itself.
def test_undo_puts_the_original_function_back() -> None:
    original = replying()
    boundary = Boundary(original)

    _, undo = install_cost_meter(boundary)
    assert boundary.acompletion is not original
    undo()

    assert boundary.acompletion is original


def test_installing_twice_does_not_meter_a_call_twice() -> None:
    boundary = Boundary(replying(answer(0.01)))
    install_cost_meter(boundary)
    meter, _ = install_cost_meter(boundary)

    asyncio.run(call(boundary))

    assert meter.cost_usd() == Decimal("0.01")


def test_a_module_without_the_function_is_refused() -> None:
    with pytest.raises(CostMeterError):
        install_cost_meter(SimpleNamespace())


def test_a_function_that_is_not_a_coroutine_function_is_refused() -> None:
    def blocking(*args: Any, **kwargs: Any) -> Any:
        return answer(0.01)

    with pytest.raises(CostMeterError):
        install_cost_meter(SimpleNamespace(acompletion=blocking))


def test_the_real_pr_agent_still_has_the_function_the_meter_wraps() -> None:
    from importlib import import_module

    module: Any = import_module("pr_agent.algo.ai_handlers.litellm_ai_handler")
    original = module.acompletion

    meter, undo = install_cost_meter()
    try:
        assert module.acompletion is not original
        assert meter.cost_usd() is None
    finally:
        undo()

    assert module.acompletion is original


# #363-T03: no request was sent, so the model was not used.
def test_a_run_that_sent_no_request_did_not_use_the_model(installed: Install) -> None:
    _, meter = installed(replying())

    assert meter.may_have_used_the_model is False


# #363-T01: a request in flight may have been billed.
def test_a_request_in_flight_may_have_used_the_model(installed: Install) -> None:
    release = asyncio.Event()

    async def waits(*args: Any, **kwargs: Any) -> Any:
        await release.wait()
        return answer(0.01)

    boundary, meter = installed(waits)

    async def run() -> tuple[bool, bool]:
        asking = asyncio.ensure_future(call(boundary))
        await asyncio.sleep(0.01)
        in_flight = meter.may_have_used_the_model
        release.set()
        await asking
        return in_flight, meter.may_have_used_the_model

    assert asyncio.run(run()) == (True, True)


# #363-T01: a request that was cancelled (the soft timeout) stays one that may have been billed.
def test_a_request_that_is_cancelled_may_have_used_the_model(installed: Install) -> None:
    async def never_answers(*args: Any, **kwargs: Any) -> Any:
        await asyncio.sleep(30)

    boundary, meter = installed(never_answers)

    async def run() -> None:
        with pytest.raises(TimeoutError):
            async with asyncio.timeout(0.05):
                await call(boundary)

    asyncio.run(run())

    assert meter.may_have_used_the_model is True


# #363-T01: an answer counts, priced or not, also one PR-Agent throws away afterwards.
@pytest.mark.parametrize("reply", [answer(0.01), answer(None)], ids=["priced", "unpriced"])
def test_an_answer_that_came_back_may_have_used_the_model(installed: Install, reply: Any) -> None:
    boundary, meter = installed(replying(reply))

    asyncio.run(call(boundary))

    assert meter.may_have_used_the_model is True


# #363-T01: a server error, a lost connection and a timeout leave the request open.
@pytest.mark.parametrize("status", [500, 502, 504, 408, 418])
def test_a_request_that_failed_on_the_provider_side_may_have_used_the_model(
    installed: Install, status: int
) -> None:
    boundary, meter = installed(replying(status_error(status)))

    async def run() -> None:
        with pytest.raises(Exception):  # noqa: B017 # the error under test is the one handed on
            await call(boundary)

    asyncio.run(run())

    assert meter.may_have_used_the_model is True


# #363-T03: only a refusal before any generation is no use of the model.
@pytest.mark.parametrize("status", [400, 401, 402, 403, 404, 422, 429])
def test_a_request_refused_before_any_generation_did_not_use_the_model(
    installed: Install, status: int
) -> None:
    boundary, meter = installed(replying(status_error(status)))

    async def run() -> None:
        with pytest.raises(Exception):  # noqa: B017 # the error under test is the one handed on
            await call(boundary)

    asyncio.run(run())

    assert meter.may_have_used_the_model is False


# #363-T03: a refusal and then an answer of a fallback model is a run that used the model.
def test_a_refusal_followed_by_an_answer_may_have_used_the_model(installed: Install) -> None:
    boundary, meter = installed(replying(status_error(429), answer(0.01)))

    async def run() -> None:
        with pytest.raises(Exception):  # noqa: B017 # the error under test is the one handed on
            await call(boundary)
        await call(boundary)

    asyncio.run(run())

    assert meter.may_have_used_the_model is True


# #363-T01: a call that carries a retry count stays open, so it may have used the model.
def test_a_call_that_carries_a_retry_count_may_have_used_the_model(installed: Install) -> None:
    boundary, meter = installed(replying(answer(0.01)))

    async def run() -> None:
        await boundary.acompletion(model="openrouter/vendor/model", messages=[], num_retries=2)

    asyncio.run(run())

    assert meter.may_have_used_the_model is True
