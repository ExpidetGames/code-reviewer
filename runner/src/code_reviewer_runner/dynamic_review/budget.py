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

**Cost.** Before a call the ledger reserves what the call could cost: the input estimate and the
output allowance at the unit costs of the model's descriptor. A model without unit costs does not
run (`dynamic_config_invalid`, see `runner.dynamic_ledger`): a cost that cannot be priced cannot be
bounded before it is spent. The call is refused when what is spent, what is reserved for calls in
flight and this reservation would together pass the limit. After the call the reservation is
replaced by the `usage.cost` the provider reported. A call that reports no cost cannot be bounded by
money, so the run stops (`dynamic_accounting_failed`): it is never continued without a bound, and a
missing cost is never read as zero.

**Wrap-up (#293).** The run does not just stop when the limit is near. A call that can be rewritten
into a final answer (`can_wrap_up`: the model proxy can reduce the request to the structured-output
return tool) becomes the *final call* when a further normal call could not be followed by a final
one inside the cost limit (what is spent, what is held, this call and a final call after it, with
room for two more tool results in the history), or when less than a reserve of wall clock is left
(one provider call: 150 s, a quarter of a shorter deadline). The decision is the ledger's alone,
from its own cost and clock; nothing in the request can start or prevent it. The final call must
itself fit the cost limit, and it is the last call granted: any other request after it is refused.
The ledger remembers why the run stopped early (`stopped_early`) for the result and the summary.

**Recovery (#309).** A turn can end with no structured answer although nothing was used up (the
model answered in prose, was cut off, or the provider ended a step the engine took for the last).
The adapter then asks `begin_recovery()` once. It says yes only while no final call was granted,
a model call was made, the clock has more than a twentieth of the deadline left and the estimate of
one more call fits the cost limit; the next call that can be rewritten is then granted as a final
call with the recovery instruction. It is the same last call as the wrap-up's (nothing is granted
after it), so a run has at most one of the two, and it does not count as stopping early: the review
is not cut short by a limit. If it fails, the run fails as it did before.

**Tokens.** The input estimate is bytes over a conservative 3 bytes per token (real text has
about 3 to 4), tightened to what the provider settled on the previous call when that content was
denser, and never below the last settled prompt. It is an estimate, not a bound: it prices the
reservation. The model window is only a backstop in front of the provider's own limit and is
checked with a much more lenient density (`WINDOW_CHECK_DENSITY`), so the ledger refuses only what
cannot fit at any realistic density and leaves every other case to the provider's context error.
The proven bound stays the byte count (a BPE token is never fewer than one byte): usage the
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
# The wrap-up reserve of the wall clock: one provider call (the proxy waits 120 s for one) and a
# margin. A shorter deadline gets a quarter of it, so a short test deadline still has a normal part.
WRAP_UP_RESERVE_SECONDS = 150.0
WRAP_UP_RESERVE_FRACTION = 0.25
# What the history of the call after a normal call can have grown by, for the cost of a final call
# that is reserved before the normal call is allowed: two tool results of the largest size.
FINAL_CALL_GROWTH_BYTES = 2 * MAX_TOOL_RESULT_BYTES
STOPPED_EARLY_COST = "cost_limit"
STOPPED_EARLY_TIME = "time_limit"
# The clock a recovery needs at least, as a part of the deadline (30 s of 600 s): about the time a
# model needs to write its answer once it has all the facts. Below it the call could not finish.
RECOVERY_RESERVE_FRACTION = 0.05
# What the recovery call's request is larger than the last call's by, besides the model's own last
# answer (one output allowance): the engine's recovery message and the runner's instruction.
RECOVERY_REQUEST_SLACK_BYTES = 4096
# The density of the window backstop: the bytes one token is assumed to hold when the ledger asks
# whether a request can fit the model window at all. Natural text has 3 to 4.5, so 6 refuses only
# what cannot fit at any realistic density (a long run of one repeated character is the only text
# that packs tighter), and a request the provider could still take is never refused here: the
# provider's own context error ends the run with a code of its own instead.
WINDOW_CHECK_DENSITY = 6.0
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
    # True for the one call that the run is wrapped up with (#293): the proxy rewrites it.
    final: bool = False
    # True when that final call is the recovery of a turn without an answer (#309), which carries
    # the recovery instruction instead of the wrap-up one.
    recovery: bool = False


@dataclass
class _Counters:
    model_calls: int = 0
    reserved_cost: Decimal = field(default_factory=lambda: Decimal(0))
    prompt_tokens: int = 0
    completion_tokens: int = 0
    last_prompt_tokens: int = 0
    # Bytes per token the previous call settled on, when denser than the default estimate.
    density: float = ASSUMED_DENSITY
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
        unit_costs: UnitCosts,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if window_tokens < 1:
            raise LimitError(ErrorCode.DYNAMIC_CONFIG_INVALID, "the model window is not positive")
        self.limits = limits
        self.window_tokens = window_tokens
        self.output_tokens = min(max(output_tokens, 1), window_tokens)
        self._unit_costs = unit_costs
        self._wrap_up_seconds = min(
            WRAP_UP_RESERVE_SECONDS, WRAP_UP_RESERVE_FRACTION * limits.deadline_seconds
        )
        self._final_granted = False
        self._final_unanswered = False
        self._recovery_seconds = RECOVERY_RESERVE_FRACTION * limits.deadline_seconds
        self._recovery_armed = False
        self._recovered = False
        self._stopped_early: str | None = None
        self._clock = clock
        self._started = clock()
        self._counters = _Counters()
        self._lock = threading.Lock()
        self._failure: LimitError | None = None

    @property
    def started(self) -> float:
        return self._started

    def elapsed_seconds(self) -> float:
        """The time since the ledger started, on its own clock."""
        return self._clock() - self._started

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

    @property
    def stopped_early(self) -> str | None:
        """Why the run was wrapped up (`cost_limit`, `time_limit`), or None for a complete run."""
        with self._lock:
            return self._stopped_early

    @property
    def recovered(self) -> bool:
        """True when the run's final call was the recovery of a turn without an answer (#309)."""
        with self._lock:
            return self._recovered

    def begin_recovery(self) -> bool:
        """Arm the one recovery call, or say that it is not possible. At most once per run.

        Not possible: a final call was granted already (its answer was the last chance, whatever
        it was), the recovery was armed before, no model call was made (nothing ended a turn),
        less than the recovery reserve of the clock is left, or one more call, priced as the last
        call's prompt plus the model's last answer plus a slack, does not fit the cost limit. The
        call itself is still reserved like any other when it arrives.
        """
        with self._lock:
            counters = self._counters
            if self._final_granted or self._recovery_armed or self._recovered:
                return False
            if counters.model_calls == 0 or self.remaining_seconds() <= self._recovery_seconds:
                return False
            slack = math.ceil(RECOVERY_REQUEST_SLACK_BYTES / counters.density)
            input_tokens = counters.last_prompt_tokens + self.output_tokens + slack
            held = counters.cost + counters.reserved_cost
            if held + self._call_cost(input_tokens, self.output_tokens) > self.limits.max_cost_usd:
                return False
            self._recovery_armed = True
            return True

    def note_final_unanswered(self) -> None:
        """The final call came back without the structured answer (#301 F3): the model's failure.

        Whatever the engine asks for afterwards is refused as `llm_output_invalid`, which is what
        an operator has to look at, not the cost limit.
        """
        with self._lock:
            self._final_unanswered = True

    def reserve_call(
        self,
        request_text: str,
        *,
        output_tokens: int | None = None,
        can_wrap_up: bool = False,
        wrap_up_text: str = "",
        recovery_text: str = "",
    ) -> Reservation:
        """Reserve one model call before its request is sent. Raises when it cannot fit.

        Every attempt reserves, including a retry, a compaction or a hidden call: they are all model
        calls and they all spend the same budget. The request plus the output allowance must fit
        the window at a lenient density (a backstop in front of the provider's own limit, which
        refuses only what cannot fit at all), and the cost spent, the cost reserved for calls in
        flight and the cost this call could have must stay within the limit.
        """
        self.check_deadline()
        size = len(request_text.encode("utf-8", errors="replace"))
        allowance = self.output_tokens if output_tokens is None else output_tokens
        counters = self._counters
        with self._lock:
            if self._final_granted:
                if self._final_unanswered:
                    raise LimitError(
                        ErrorCode.LLM_OUTPUT_INVALID,
                        "the final call returned no structured answer",
                    )
                raise LimitError(
                    ErrorCode.DYNAMIC_BUDGET_EXCEEDED,
                    "the run asked for a call after its final call",
                )
            # The estimate prices the reservation. The last settled prompt is a heuristic floor:
            # it usually predicts the next prompt in a tool loop, and after a compaction or a
            # hidden call with another prompt it can over-reserve, which only costs headroom.
            # The byte count stays the proven bound on what the provider may report.
            estimate = self._estimate(size)
            bound = max(size, counters.last_prompt_tokens)
            if math.ceil(size / WINDOW_CHECK_DENSITY) + allowance > self.window_tokens:
                raise LimitError(
                    ErrorCode.DYNAMIC_BUDGET_EXCEEDED,
                    "the request plus its output allowance exceeds the model window",
                )
            held = counters.cost + counters.reserved_cost
            cost = self._call_cost(estimate, allowance)
            recovery = self._recovery_armed and can_wrap_up
            reason = (
                None
                if not can_wrap_up or recovery
                else self._wrap_up_reason(held, cost, estimate, allowance)
            )
            if reason is not None or recovery:
                # The last call of the run: it carries the instruction and nothing else grows.
                text = recovery_text if recovery else wrap_up_text
                size += len(text.encode("utf-8", errors="replace"))
                estimate = self._estimate(size)
                bound += size - len(request_text.encode("utf-8", errors="replace"))
                cost = self._call_cost(estimate, allowance)
            if held + cost > self.limits.max_cost_usd:
                raise LimitError(ErrorCode.DYNAMIC_BUDGET_EXCEEDED, "the cost limit is used up")
            if reason is not None or recovery:
                self._final_granted = True
                if recovery:
                    self._recovery_armed = False
                    self._recovered = True
                else:
                    self._stopped_early = reason
            counters.model_calls += 1
            counters.reserved_cost = _SUM.add(counters.reserved_cost, cost)
        return Reservation(
            input_tokens=estimate,
            output_tokens=allowance,
            byte_bound=bound,
            request_bytes=size,
            cost=cost,
            final=reason is not None or recovery,
            recovery=recovery,
        )

    def _estimate(self, size: int) -> int:
        return max(math.ceil(size / self._counters.density), self._counters.last_prompt_tokens)

    def _wrap_up_reason(
        self, held: Decimal, cost: Decimal, estimate: int, allowance: int
    ) -> str | None:
        """Why this call has to be the final one: the clock first, then what the next would cost."""
        if self.remaining_seconds() <= self._wrap_up_seconds:
            return STOPPED_EARLY_TIME
        growth = math.ceil(FINAL_CALL_GROWTH_BYTES / self._counters.density)
        after = self._call_cost(estimate + growth, allowance)
        if held + cost + after > self.limits.max_cost_usd:
            return STOPPED_EARLY_COST
        return None

    def _call_cost(self, input_tokens: int, output_tokens: int) -> Decimal:
        """What one call could cost, to reserve: estimate and allowance at the unit costs."""
        return self._unit_costs.of_call(input_tokens, output_tokens)

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
                stopped_early=self._stopped_early,
            )
