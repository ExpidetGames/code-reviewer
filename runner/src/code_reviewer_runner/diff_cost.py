# SPDX-License-Identifier: Apache-2.0

# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false
"""The exact model cost of a Diff run (#274).

PR-Agent prices a call itself: from the charge in the answer when it finds one, otherwise from
LiteLLM's price table, which can be missing, stale or different from what the provider charged. Its
sum also covers only the calls it accepted. A Diff run on the operator's key is billed from its
cost, so the runner measures it the way the Dynamic Review does (#267): the charge of a call is the
`usage.cost` the provider states in its answer, nothing is derived from tokens or a price table,
and the sum is all or nothing.

Every request PR-Agent makes goes through one function, `acompletion` of its LiteLLM handler. It is
wrapped here, which sees every answer that comes back, also one that PR-Agent throws away afterwards
(an empty reply is still billed):

- an answer whose `usage.cost` is a finite number of zero or more is a priced call; the sum adds up
  decimals, so it does not drift the way float sums do;
- an answer without such a charge (none stated, no usage, a value that is no cost) is an unpriced
  call, and the cost is unknown;
- a request that was certainly rejected before any generation (the statuses in
  `_REJECTED_BEFORE_GENERATION`: rate limit, authentication, payment, permission, request
  validation) states no usage and costs nothing: it is left out, which is what makes a fallback
  model after such a failure exact;
- every other end may have been billed and nobody can say, so the cost is unknown: a server error
  (LiteLLM raises one also for an HTTP 200 answer whose body is an error, and a gateway timeout
  comes while the provider may still be working), a timeout, a lost connection, a status nobody
  knows, a cancelled request, a stream that was not read to its end;
- a call that carries a retry count (`num_retries`, `max_retries`) is never counted: LiteLLM may
  send several requests inside it and only the last answer would be seen. The runner pins the
  retries to zero (`pr_agent_config.py`); this is the second defence.

PR-Agent's own pricing is switched off (`config.output_run_cost`, `pr_agent_config.py`), so no price
table is consulted anywhere.

The wrapper reaches into the handler module, so it is tied to the PR-Agent version it was written
for (`identity_patch.check_pr_agent_version` runs before it). Anything else is refused instead of
being wrapped blindly.
"""

import inspect
import threading
from collections.abc import AsyncIterator, Callable
from decimal import Decimal
from functools import wraps
from importlib import import_module
from typing import Any

from code_reviewer_runner.dynamic_review.budget import exact_cost

_HANDLER_MODULE = "pr_agent.algo.ai_handlers.litellm_ai_handler"
_FUNCTION = "acompletion"
# Set on the replacement, so a second application finds the real function instead of wrapping it.
_ORIGINAL_ATTRIBUTE = "__diff_cost_meter_original__"
# The only statuses that mean the provider refused the request before it generated anything. Any
# other status (every 5xx, 408, 504/524 of a gateway, an unknown one) leaves the request open.
_REJECTED_BEFORE_GENERATION = frozenset({400, 401, 402, 403, 404, 422, 429})
# Errors that carry a status but are not an answer: LiteLLM gives a lost connection the status 500
# and a client timeout 408, but the provider never answered.
_NO_ANSWER_CLASSES = frozenset({"APIConnectionError", "APITimeoutError", "Timeout"})
# The sanity ceiling of a stated charge and of the sum of a run, in USD. No provider states a
# charge near it; a value above it is not a cost anybody can trust (and 1e308 added twice would
# not even be a number in the result).
MAX_CALL_COST_USD = Decimal(1_000)
MAX_RUN_COST_USD = Decimal(100_000)


class CostMeterError(Exception):
    """PR-Agent does not have the function the meter was written for."""


def _field(source: Any, name: str) -> Any:
    if isinstance(source, dict):
        return source.get(name)
    return getattr(source, name, None)


def _stated_charge(usage: Any) -> Decimal | None:
    """What the provider says the call cost: `usage.cost`, never `response_cost` (LiteLLM's own).

    A charge above the sanity ceiling is no cost anybody can trust: the call is unpriced.
    """
    if usage is None:
        return None
    charge = exact_cost(_field(usage, "cost"))
    if charge is None or charge > MAX_CALL_COST_USD:
        return None
    return charge


def _is_stream(response: Any) -> bool:
    return not isinstance(response, dict) and hasattr(response, "__aiter__")


def _is_rejection(error: BaseException) -> bool:
    """True only for an error that is known to come before any generation: nothing was charged.

    LiteLLM's `status_code` is not always the HTTP status of the provider's answer (an HTTP 200 with
    an error body becomes a 5xx exception), so only the statuses of a plain refusal count.
    """
    if any(cls.__name__ in _NO_ANSWER_CLASSES for cls in type(error).__mro__):
        return False
    status = getattr(error, "status_code", None)
    if isinstance(status, bool) or not isinstance(status, int):
        return False
    return status in _REJECTED_BEFORE_GENERATION


def _carries_a_retry(kwargs: dict[str, Any]) -> bool:
    """True when the call lets LiteLLM or its client send the request again by itself."""
    for name in ("num_retries", "max_retries"):
        value = kwargs.get(name)
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, int) or value != 0:
            return True
    return False


def _chunk_usage(chunk: Any) -> Any:
    """The usage of a regular or a metadata-only chunk (PR-Agent reads both the same way)."""
    usage = _field(chunk, "usage")
    if usage is not None:
        return usage
    hidden = _field(chunk, "_hidden_params")
    return hidden.get("usage") if isinstance(hidden, dict) else None


class DiffCostMeter:
    """What the provider charged for the model calls of one Diff run. One instance per run."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._total = Decimal(0)
        self._priced = 0
        self._unpriced = 0
        # Requests whose end is not known: in flight, cancelled, or a stream not read to its end.
        self._open = 0

    def cost_usd(self) -> Decimal | None:
        """The exact sum of the charges of all calls; None unless every call is accounted for.

        None as well for a run that had no answer at all: no cost is not a cost of zero.
        """
        with self._lock:
            if self._open or self._unpriced or not self._priced:
                return None
            if self._total > MAX_RUN_COST_USD:
                return None
            return self._total

    @property
    def answered_calls(self) -> int:
        """How many answers came back through the metered function, priced or not."""
        with self._lock:
            return self._priced + self._unpriced

    def begin(self) -> None:
        """A request is sent."""
        with self._lock:
            self._open += 1

    def answered(self, usage: Any) -> None:
        """The request got an answer with this usage (None when it has none)."""
        charge = _stated_charge(usage)
        with self._lock:
            self._open -= 1
            if charge is None:
                self._unpriced += 1
                return
            self._priced += 1
            self._total += charge

    def refused(self) -> None:
        """The provider answered the request with an error status: nothing was used."""
        with self._lock:
            self._open -= 1


def _watched(meter: DiffCostMeter, stream: Any) -> AsyncIterator[Any]:
    """The chunks of `stream` unchanged; the call is accounted when the last one was read."""

    async def chunks() -> AsyncIterator[Any]:
        usage: Any = None
        async for chunk in stream:
            found = _chunk_usage(chunk)
            if found is not None:
                usage = found
            yield chunk
        # Reached only when the stream was read to its end: otherwise the request stays open.
        meter.answered(usage)

    return chunks()


def install_cost_meter(
    module: Any | None = None,
) -> tuple[DiffCostMeter, Callable[[], None]]:
    """Wrap PR-Agent's `acompletion`. Returns the meter and a function that undoes the wrapping.

    Everything the wrapper relies on is checked first, and a failed check changes nothing.
    Installing twice does not wrap twice.
    """
    # PR-Agent ships no type information: the module is `Any` on purpose.
    target: Any = module if module is not None else import_module(_HANDLER_MODULE)
    current = getattr(target, _FUNCTION, None)
    if not callable(current):
        raise CostMeterError(f"{_HANDLER_MODULE}.{_FUNCTION} does not exist")
    original: Callable[..., Any] = getattr(current, _ORIGINAL_ATTRIBUTE, current)
    if not inspect.iscoroutinefunction(original):
        raise CostMeterError(f"{_HANDLER_MODULE}.{_FUNCTION} is not a coroutine function")

    meter = DiffCostMeter()

    @wraps(original)
    async def metered(*args: Any, **kwargs: Any) -> Any:
        meter.begin()
        if _carries_a_retry(kwargs):
            # Requests we cannot count one by one: the call is handed on unchanged and stays open.
            return await original(*args, **kwargs)
        try:
            response = await original(*args, **kwargs)
        except BaseException as error:
            if _is_rejection(error):
                meter.refused()
            # Any other end leaves the request open: it may have been billed.
            raise
        if _is_stream(response):
            return _watched(meter, response)
        meter.answered(_field(response, "usage"))
        return response

    setattr(metered, _ORIGINAL_ATTRIBUTE, original)
    setattr(target, _FUNCTION, metered)

    def undo() -> None:
        setattr(target, _FUNCTION, original)

    return meter, undo
