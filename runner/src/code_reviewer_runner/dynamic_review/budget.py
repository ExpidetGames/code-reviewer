# SPDX-License-Identifier: Apache-2.0

"""The limits of one Dynamic Review and the ledger that enforces them (#197, #290).

The one budget of a run is an operator cost limit in USD (default 1.00, never above a ceiling in
code, `RUNNER_DYNAMIC_MAX_COST_USD`). Besides it only technical limits stay: the 600 seconds of
the whole job (the lease and the runner's capacity depend on it), 64 KiB per tool result, 4 MiB of
cumulative content returned to the model, 2 MiB of untrusted input and the protocol byte caps.
They protect the machine and the isolation, they are not a budget. There is no limit on tokens,
model calls, tool calls or files: a tool loop sends its whole history again with every call, so
those counts say little about what a run costs, and the cost does. All of them are operator-owned
and never come from the repository, the skill or the model.

Enforcement lives here and in the model proxy, **outside** the engine and its prompt: a bound that
is only asked for in the prompt or only observed after the fact is not enforced. Every model call
is reserved before the request is sent, every tool part the engine reports is counted, and a
missing or oversized answer fails closed. Nothing here is advisory.

**Cost.** Before a call the ledger reserves what the call could cost: with the unit costs of the
model's descriptor, the input estimate and the output allowance at those costs; without them, a
fixed floor or twice the dearest settled call. The call is refused when what is spent, what is
reserved for calls in flight and this reservation would together pass the limit. After the call the
reservation is replaced by the `usage.cost` the provider reported. A call that reports no cost
cannot be bounded by money, so the run stops (`dynamic_accounting_failed`): it is never continued
without a bound, and a missing cost is never read as zero.

**Tokens.** The input estimate is bytes over a conservative 3 bytes per token (real text has
about 3 to 4), tightened to what the provider settled on the previous call when that content was
denser, and never below the last settled prompt. It is an estimate, not a bound: it prices the
reservation and checks the model window, which is only a backstop in front of the provider's own
limit. The proven bound stays the byte count (a BPE token is never fewer than one byte): usage the
provider reports above it is an accounting failure. The margin of the estimate is that every call
also reserves its whole output allowance at the output cost although a call rarely uses it.
"""

import math
import re
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from decimal import Context, Decimal, InvalidOperation

from code_reviewer_runner.result import ErrorCode, Usage

# Operator-owned validated configuration, never repository instructions.
TOTAL_DEADLINE_SECONDS = 600.0
# The one budget: what a run may cost in USD, and the highest value an operator can set.
MAX_COST_USD = Decimal("1.00")
MAX_COST_USD_CEILING = Decimal("20")
MAX_TOOL_RESULT_BYTES = 64 * 1024
MAX_RETURNED_BYTES = 4 * 1024 * 1024
MAX_INPUT_BYTES = 2 * 1024 * 1024
MAX_FINDINGS = 30
# The model protocol bytes the proxy may forward. Derived from the envelope: no single request may
# carry more content than the cumulative content bound, and no single answer may be larger than a
# few tool results. A stream that exceeds its bound is refused mid-flight rather than buffered.
MAX_REQUEST_BYTES = 4 * 1024 * 1024
MAX_RESPONSE_BYTES = 256 * 1024
MAX_STREAM_BYTES = 1024 * 1024
# The output allowance reserved per call when the job does not name a window: 8,192 tokens, the
# largest output most chat protocols default to. A window the job does name caps it further.
DEFAULT_OUTPUT_TOKENS = 8_192
# Used when the model's descriptor names no context window: deliberately small, so a descriptor
# that forgets the field is refused early rather than trusted with a window it does not have.
DEFAULT_WINDOW_TOKENS = 128_000
# Density of the input estimate: the bytes of text one token is assumed to hold. Real text has
# about 3 to 4; 3 errs on the side of more tokens, and a denser previous call tightens it, down
# to the proven 1.
ASSUMED_DENSITY = 3.0
# What a call reserves when the descriptor has no unit costs: the floor, or twice the dearest call
# settled so far when that is more. A call's cost grows with its history, and a tool result adds
# at most 64 KiB to it, so the next call rarely costs more than twice the dearest one so far.
FALLBACK_CALL_RESERVE_USD = Decimal("0.05")
FALLBACK_GROWTH_FACTOR = 2
# A request smaller than this says nothing about the content's density: the provider's own
# overhead per request dominates it. Only larger requests tighten the estimate.
MIN_CALIBRATION_BYTES = 4096


class LimitError(Exception):
    """A hard limit stopped the run.

    `code` is stable; `detail` names the limit, never a value from the repository or the model.
    """

    def __init__(self, code: ErrorCode, detail: str) -> None:
        super().__init__(f"{code.value}: {detail}")
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class DynamicLimits:
    """The envelope of one Dynamic Review. Frozen: nothing at run time may widen it."""

    deadline_seconds: float = TOTAL_DEADLINE_SECONDS
    max_cost_usd: Decimal = MAX_COST_USD
    max_tool_result_bytes: int = MAX_TOOL_RESULT_BYTES
    max_returned_bytes: int = MAX_RETURNED_BYTES
    max_input_bytes: int = MAX_INPUT_BYTES
    max_request_bytes: int = MAX_REQUEST_BYTES
    max_response_bytes: int = MAX_RESPONSE_BYTES
    max_stream_bytes: int = MAX_STREAM_BYTES


def max_cost_from_environment(raw: str | None) -> Decimal:
    """The operator's cost limit (`RUNNER_DYNAMIC_MAX_COST_USD`): unset or blank is the default.

    Anything else must be a plain positive decimal number up to the ceiling; a value that does not
    parse or lies outside is a configuration error, never silently replaced by the default or
    clamped, so an operator who mistyped learns it. The text of the value is not echoed.
    """
    text = (raw or "").strip()
    if not text:
        return MAX_COST_USD
    invalid = LimitError(
        ErrorCode.DYNAMIC_CONFIG_INVALID,
        "the operator cost limit is not a number between zero and the ceiling",
    )
    if not _PLAIN_DECIMAL.fullmatch(text):
        raise invalid
    try:
        limit = Decimal(text)
    except InvalidOperation:
        raise invalid from None
    if not Decimal(0) < limit <= MAX_COST_USD_CEILING:
        raise invalid
    return limit


@dataclass(frozen=True)
class UnitCosts:
    """What the model's descriptor says one million input and output tokens cost, in USD.

    Used only to price a reservation before a call. The cost of a call is always the `usage.cost`
    the provider reported after it, never these numbers.
    """

    input_usd_per_mtok: Decimal
    output_usd_per_mtok: Decimal

    def of_call(self, input_tokens: int, output_tokens: int) -> Decimal:
        total = _SUM.add(
            _SUM.multiply(Decimal(input_tokens), self.input_usd_per_mtok),
            _SUM.multiply(Decimal(output_tokens), self.output_usd_per_mtok),
        )
        return _SUM.divide(total, Decimal(1_000_000))


@dataclass(frozen=True)
class Reservation:
    """What one model call reserved before it was sent.

    `input_tokens` is the estimate the reservation was priced with; `byte_bound` is the proven
    upper bound on what the provider can report for the prompt; `cost` is the reserved USD.
    """

    input_tokens: int
    output_tokens: int
    byte_bound: int = 0
    request_bytes: int = 0
    cost: Decimal = Decimal(0)


@dataclass
class _Counters:
    model_calls: int = 0
    reserved_cost: Decimal = field(default_factory=lambda: Decimal(0))
    prompt_tokens: int = 0
    completion_tokens: int = 0
    last_prompt_tokens: int = 0
    # Bytes per token the previous call settled on, when denser than the default estimate.
    density: float = ASSUMED_DENSITY
    dearest_call: Decimal = field(default_factory=lambda: Decimal(0))
    # The cost the provider charged, summed as exact decimals, over the calls that reported one.
    cost: Decimal = field(default_factory=lambda: Decimal(0))
    priced_calls: int = 0
    tool_calls: int = 0
    returned_bytes: int = 0
    files: set[str] = field(default_factory=lambda: set[str]())


# The sum of costs is exact. A float is at most about 1e308 and at least about 5e-324, so any sum of
# them fits in far fewer than this many significant digits; the context never rounds, and no sum
# depends on the precision the calling thread happens to have set.
_SUM = Context(prec=1000)
# A decimal number as plain digits: no sign, exponent, `nan`, `inf`, underscore or separator.
_PLAIN_DECIMAL = re.compile(r"[0-9]+(\.[0-9]+)?")


def exact_cost(value: object) -> Decimal | None:
    """The charge the provider reported for one call, or None when it reported no usable one.

    Only a finite, non-negative number counts. A missing, null, boolean, textual or negative value
    is not a cost; it is never read as zero. A negative zero is a plain zero. The decimal is the
    shortest decimal text of the number as it was parsed from the provider's answer (a float64, so a
    cost with more than about 17 significant digits is already shortened by then); adding calls up
    in decimals does not drift the way a float sum does.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    cost = Decimal(repr(value))
    if cost == 0:
        return Decimal(0)
    return cost if cost > 0 else None


def reserved_tokens(text: str) -> int:
    """A proven upper bound on the tokens of `text`: one token is never fewer than one byte."""
    return len(text.encode("utf-8", errors="replace"))


class BudgetLedger:
    """Reserves and counts everything one Dynamic Review consumes. Fails closed.

    One instance per run, shared by the proxy (model calls and tokens) and the adapter (tool calls,
    files and returned bytes). The clock is injected so a test never waits.

    The proxy serves from a threaded server, so every check-then-update section holds one lock: two
    concurrent calls can never both pass the same bound.
    """

    def __init__(
        self,
        limits: DynamicLimits,
        *,
        window_tokens: int = DEFAULT_WINDOW_TOKENS,
        output_tokens: int = DEFAULT_OUTPUT_TOKENS,
        unit_costs: UnitCosts | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if window_tokens < 1:
            raise LimitError(ErrorCode.DYNAMIC_CONFIG_INVALID, "the model window is not positive")
        self.limits = limits
        self.window_tokens = window_tokens
        self.output_tokens = min(max(output_tokens, 1), window_tokens)
        self._unit_costs = unit_costs
        self._clock = clock
        self._started = clock()
        self._counters = _Counters()
        self._lock = threading.Lock()
        self._failure: LimitError | None = None

    @property
    def started(self) -> float:
        return self._started

    def remaining_seconds(self) -> float:
        """The time left before the whole-job deadline. Never negative."""
        return max(self.limits.deadline_seconds - (self._clock() - self._started), 0.0)

    def expired(self) -> bool:
        return self.remaining_seconds() <= 0

    def record_failure(self, error: LimitError) -> None:
        """Remember the first thing that stopped the run; later ones never replace it.

        The proxy is where most limits trip, but its caller is the engine, which only sees an HTTP
        error. The adapter reads the stable code from here, so the run ends with the real cause and
        never with a generic engine failure, and an answer the engine still produced afterwards is
        not a success.
        """
        with self._lock:
            if self._failure is None:
                self._failure = error

    @property
    def failure(self) -> LimitError | None:
        with self._lock:
            return self._failure

    def check_deadline(self, *, tolerance: float = 0.0) -> None:
        """Raise when the deadline has passed, or is closer than `tolerance` seconds."""
        if self.remaining_seconds() <= tolerance:
            raise LimitError(
                ErrorCode.DYNAMIC_BUDGET_EXCEEDED, "the whole-job deadline was reached"
            )

    def reserve_call(self, request_text: str, *, output_tokens: int | None = None) -> Reservation:
        """Reserve one model call before its request is sent. Raises when it cannot fit.

        Every attempt reserves, including a retry, a compaction or a hidden call: they are all model
        calls and they all spend the same budget. The request plus the output allowance must fit
        the window (a backstop in front of the provider's own limit), and the cost spent, the cost
        reserved for calls in flight and the cost this call could have must stay within the limit.
        """
        self.check_deadline()
        size = len(request_text.encode("utf-8", errors="replace"))
        allowance = self.output_tokens if output_tokens is None else output_tokens
        counters = self._counters
        with self._lock:
            # The estimate prices the reservation. The last settled prompt is a heuristic floor:
            # it usually predicts the next prompt in a tool loop, and after a compaction or a
            # hidden call with another prompt it can over-reserve, which only costs headroom.
            # The byte count stays the proven bound on what the provider may report.
            estimate = max(math.ceil(size / counters.density), counters.last_prompt_tokens)
            bound = max(size, counters.last_prompt_tokens)
            if estimate + allowance > self.window_tokens:
                raise LimitError(
                    ErrorCode.DYNAMIC_BUDGET_EXCEEDED,
                    "the request plus its output allowance exceeds the model window",
                )
            cost = self._call_cost(estimate, allowance)
            if counters.cost + counters.reserved_cost + cost > self.limits.max_cost_usd:
                raise LimitError(ErrorCode.DYNAMIC_BUDGET_EXCEEDED, "the cost limit is used up")
            counters.model_calls += 1
            counters.reserved_cost = _SUM.add(counters.reserved_cost, cost)
        return Reservation(
            input_tokens=estimate,
            output_tokens=allowance,
            byte_bound=bound,
            request_bytes=size,
            cost=cost,
        )

    def _call_cost(self, input_tokens: int, output_tokens: int) -> Decimal:
        """What one call could cost, to reserve: priced when the unit costs are known."""
        if self._unit_costs is not None:
            return self._unit_costs.of_call(input_tokens, output_tokens)
        dearest = _SUM.multiply(self._counters.dearest_call, Decimal(FALLBACK_GROWTH_FACTOR))
        return max(FALLBACK_CALL_RESERVE_USD, dearest)

    def settle_call(
        self,
        reservation: Reservation,
        *,
        prompt_tokens: int | None,
        completion_tokens: int | None,
        cost: Decimal | None = None,
    ) -> None:
        """Replace a reservation with what the provider actually reported. Missing usage fails.

        The provider is authoritative after the call. A missing counter is not zero: the run cannot
        be accounted for and is stopped. A prompt above the proven byte bound or an answer above
        the output allowance is a violation of the envelope, not a value to add up; a prompt above
        the estimate but within the bound is only an estimate that was too low.

        `cost` is what the provider charged for this call (`exact_cost`). A call without one
        cannot be bounded by money: the tokens are recorded, then the run is stopped, and it is
        never read as zero.
        """
        if prompt_tokens is None or completion_tokens is None:
            raise LimitError(
                ErrorCode.DYNAMIC_ACCOUNTING_FAILED, "the provider did not report usage"
            )
        if prompt_tokens < 0 or completion_tokens < 0:
            raise LimitError(
                ErrorCode.DYNAMIC_ACCOUNTING_FAILED, "the provider reported negative usage"
            )
        if (
            prompt_tokens > max(reservation.byte_bound, reservation.input_tokens)
            or completion_tokens > reservation.output_tokens
        ):
            raise LimitError(
                ErrorCode.DYNAMIC_ACCOUNTING_FAILED,
                "the provider reported more than the request reserved",
            )
        counters = self._counters
        with self._lock:
            counters.reserved_cost = _SUM.subtract(counters.reserved_cost, reservation.cost)
            counters.prompt_tokens += prompt_tokens
            counters.completion_tokens += completion_tokens
            counters.last_prompt_tokens = prompt_tokens
            if prompt_tokens > 0 and reservation.request_bytes >= MIN_CALIBRATION_BYTES:
                observed = reservation.request_bytes / prompt_tokens
                counters.density = max(1.0, min(ASSUMED_DENSITY, observed))
            if cost is None:
                raise LimitError(
                    ErrorCode.DYNAMIC_ACCOUNTING_FAILED,
                    "the provider did not report the cost of a call",
                )
            counters.cost = _SUM.add(counters.cost, cost)
            counters.priced_calls += 1
            counters.dearest_call = max(counters.dearest_call, cost)
            if counters.cost > self.limits.max_cost_usd:
                raise LimitError(ErrorCode.DYNAMIC_BUDGET_EXCEEDED, "the cost limit is used up")

    def count_tool_call(self, name: str) -> None:
        """Count one tool call the engine reported. Unknown attempts count too. Not a budget."""
        if not name:
            raise LimitError(ErrorCode.DYNAMIC_POLICY_VIOLATION, "a tool call without a name")
        with self._lock:
            self._counters.tool_calls += 1

    def count_file(self, path: str) -> None:
        """Count a content-bearing file the run read. Distinct files, not calls. Not a budget."""
        with self._lock:
            self._counters.files.add(path)

    def add_result_bytes(self, size: int) -> None:
        """Count the UTF-8 bytes of one tool result delivered to the model."""
        if size < 0:
            raise LimitError(
                ErrorCode.DYNAMIC_ACCOUNTING_FAILED, "a tool result with a negative size"
            )
        if size > self.limits.max_tool_result_bytes:
            raise LimitError(
                ErrorCode.DYNAMIC_BUDGET_EXCEEDED, "a tool result exceeds the per-result byte bound"
            )
        with self._lock:
            if self._counters.returned_bytes + size > self.limits.max_returned_bytes:
                raise LimitError(
                    ErrorCode.DYNAMIC_BUDGET_EXCEEDED, "the cumulative content bound is used up"
                )
            self._counters.returned_bytes += size

    def check_input_bytes(self, size: int) -> None:
        """Refuse untrusted input larger than the bound before the engine is given any of it."""
        if size > self.limits.max_input_bytes:
            raise LimitError(
                ErrorCode.DYNAMIC_BUDGET_EXCEEDED, "the review input exceeds the input byte bound"
            )

    def check_request_bytes(self, size: int) -> None:
        """Refuse a model-protocol request before any byte of it is forwarded."""
        if size > self.limits.max_request_bytes:
            raise LimitError(
                ErrorCode.DYNAMIC_BUDGET_EXCEEDED, "the request exceeds the protocol byte bound"
            )

    def check_response_bytes(self, size: int) -> None:
        """Refuse a model answer whose bytes exceed the bound."""
        if size > self.limits.max_response_bytes:
            raise LimitError(
                ErrorCode.DYNAMIC_BUDGET_EXCEEDED, "the response exceeds the protocol byte bound"
            )

    @property
    def model_calls(self) -> int:
        with self._lock:
            return self._counters.model_calls

    @property
    def tool_calls(self) -> int:
        with self._lock:
            return self._counters.tool_calls

    @property
    def files(self) -> int:
        with self._lock:
            return len(self._counters.files)

    @property
    def returned_bytes(self) -> int:
        with self._lock:
            return self._counters.returned_bytes

    def usage(self, model: str | None) -> Usage:
        """The run's usage in the existing result shape. Cost is exact or unknown, never guessed.

        The cost is the sum of what the provider charged for each call, and only when **every**
        model call the run made has one. A call without a reported cost (the provider omitted it,
        refused the call, or never answered) may still have been charged, so the total is unknown
        (None) rather than a partial sum that would look exact. Nothing is derived from tokens or a
        price table. A run that made no call has nothing to report. A total that is not a finite
        float (the providers' charges add up beyond the float range) is unknown too: it could not be
        sent as a result.
        """
        with self._lock:
            counters = self._counters
            exact = counters.model_calls > 0 and counters.priced_calls == counters.model_calls
            total = float(counters.cost)
            return Usage(
                model=model,
                prompt_tokens=counters.prompt_tokens,
                completion_tokens=counters.completion_tokens,
                total_tokens=counters.prompt_tokens + counters.completion_tokens,
                ai_calls=counters.model_calls,
                fallback_used=False,
                cost_usd=total if exact and math.isfinite(total) else None,
            )
