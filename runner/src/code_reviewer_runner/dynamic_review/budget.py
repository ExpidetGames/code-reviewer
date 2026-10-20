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

**Cost.** Before a call the ledger reserves what the call is expected to cost (#540), from what the
run itself has shown. A model without unit costs does not run (`dynamic_config_invalid`, see
`runner.dynamic_ledger`): a cost that cannot be priced cannot be bounded before it is spent. A
normal call is refused when what is spent, what is reserved for calls in flight and this
reservation would together pass the limit; the final call is the exception (see "The bound"). After
the call the reservation is replaced by the `usage.cost` the provider reported. A call that reports
no cost cannot be bounded by money, so the run stops (`dynamic_accounting_failed`): it is never
continued without a bound, and a missing cost is never read as zero.

*What a call is expected to cost.* The prompt is split into the **prefix** the previous call left in
the provider's cache and the **growth** since. When the previous call reported cache reads and the
descriptor has a cache-read price, the prefix is priced at it; the growth is priced at the
cache-write price while the cache is in use (else at the input price). A provider that reports no
cache tokens, or a descriptor without cache prices (an OpenRouter model), is priced at the uncached
input price throughout: nothing is assumed about a discount that cannot be seen. The growth is the
bytes the request added since the last one over the observed density, not the whole request again.
The output is the **p95 of the run's own completions** (nearest rank) with a floor, capped by the
allowance and by the cap the model's wire names for a reservation (a thinking model, #533); the
allowance (`max_tokens`) stays the hard cap a completion is held to, but is no longer what every
call reserves. A call that writes the review (the final call, the recovery, a retry of
either) reserves at least `FINAL_OUTPUT_FLOOR_TOKENS`.

*The bound.* A run must never end without a review because of the cost guard, so the guard has two
rules and no failure mode in between.

- A **normal call** is admitted only while `spent + held + its expected cost <= limit`.
- The **final call** (the wrap-up, the recovery and the retries of either) is the last chance of a
  review. It is admitted whenever `spent + held <= limit`, even when its expected cost no longer
  fits, and it is delivered whatever it costs. A normal call that settles **over** the limit (a
  cache miss, an unusually long answer, a 64 KiB tool result: costs the expectation did not see)
  is delivered too, but it ends the agent phase at once: the next request that can be rewritten is
  the final call, admitted by the same exemption although the spend is over the limit, and no
  normal call is admitted again (a request that cannot be rewritten is refused,
  `dynamic_budget_exceeded`). If the final call returns no answer, one retry past the limit is
  still made (the retries within the limit are made as before).

So the settled total is at most **the limit, plus the excess of the last normal call (its real cost
minus its reservation, at most its real cost), plus the cost of the final call**. The final call
costs at most its input plus `allowance x output price`: it reserves the cap the model's wire names
(`reserved_output_tokens`, the allowance by default) when there is one, so the wrap-up decision
leaves room for the worst case of a review, not for a tool call. When the final call answers
without a structured answer and the spend is over the limit, the one retry past the limit is a
final call more. Fail closed is unchanged: a call without a usable cost is
`dynamic_accounting_failed`. The model calls of the engine are serial (one agent, no subagent tool,
a step waits for its tool results); if requests ever overlapped, the bound is the sum of these
excesses over the calls in flight, and the final call is refused when `spent + held` already passes
the limit. The result reports how far the limit was passed as `usage.limitExceededBy` (USD) and
the log says it.

**Wrap-up (#293).** The run does not just stop when the limit is near. A call that can be rewritten
into a final answer (`can_wrap_up`: the model proxy can reduce the request to the structured-output
return tool) becomes the *final call* when a further normal call could not be followed by a final
one inside the cost limit, or when less than a reserve of wall clock is left (one provider call:
150 s, a quarter of a shorter deadline). The cost test is `spent + held + (this call + a final call
after it) * RESERVE_MARGIN > limit`: the final call after it is priced realistically (#540), as the
next prompt plus the growth the run showed per round (p95, floor `GROWTH_FLOOR_TOKENS`) with the
cached prefix and a review-sized output, and the margin keeps a normal call that costs a little more
than expected from taking the room of the final call. The decision is the ledger's alone, from its
own cost and clock; nothing in the request can start or prevent it. The final call is admitted
whenever the spend is within the limit (see "The bound") and is the last call granted: any other
request after it is refused. The ledger
remembers why the run stopped early (`stopped_early`) for the result and the summary.

**Recovery (#309).** A turn can end with no structured answer although nothing was used up (the
model answered in prose, was cut off, or the provider ended a step the engine took for the last).
The adapter then asks `begin_recovery()` once. It says yes only while no final call was granted,
a model call was made, the clock has more than the wrap-up's reserve left (one provider call: the
recovery call writes a whole review) and the spend is within the cost limit (the recovery call is a
final call: its expected cost is not asked, see "The bound"); the next call that can be rewritten is
then granted as a final call with the recovery instruction. It is
the same last call as the wrap-up's (nothing is granted after it), so a run has at most one of the
two, and it does not count as stopping early: the review is not cut short by a limit. If it fails,
the run fails as it did before.

**Finalization above the wire (#552).** On the native path the proxy relays the engine's bytes
and never rewrites a request, so it cannot make the final call. The adapter asks for the answer
instead, and the ledger gives it the same guarantee, with the same bound: a run never ends without
a review because of the cost guard. The adapter declares this (`enable_final_above_wire`); from then
on a call the guard refuses for the cost or the clock is a `RefusedForFinal`, which is **not** the
run's failure (`record_failure` counts it, `refusals`) but the signal to
abort the turn and send one "answer now" message. That message's call is admitted past the limit
when the adapter marked it (`arm_final`): the mark is one call, it needs nothing in flight, it is
consumed by the next reservation, and nothing in a request can make a call final by itself. A second
mark exists for the one repair of an answer that is not the review; there is no third. Before
refusing, the adapter can ask whether the answer is due (`wrap_up_due`, read only: the arithmetic of
the wrap-up above and, for the clock, a lead of `WRAP_UP_ANNOUNCE_LEAD` of the reserve) and announce
it to the model by an ordinary message; a model that complies is wrapped up without any refusal.
The bound is the one above: the limit, plus the excess of the last normal call, plus the final
call, plus the one repair. A failure that is recorded (a limit, a policy violation) admits no later
call at all.

**Tokens.** The input estimate is bytes over a conservative 3 bytes per token (real text has
about 3 to 4), tightened to what the provider settled on the previous call when that content was
denser, and never below the last settled prompt. It is an estimate, not a bound: it prices the
reservation. The model window is only a backstop in front of the provider's own limit and is
checked with a much more lenient density (`WINDOW_CHECK_DENSITY`), so the ledger refuses only what
cannot fit at any realistic density and leaves every other case to the provider's context error.
The proven bound stays the byte count (a BPE token is never fewer than one byte): usage the
provider reports above it is an accounting failure.
"""

import json
import math
import re
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from decimal import Context, Decimal, InvalidOperation

from code_reviewer_runner.dynamic_review.call_trace import CallTrace
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
STOPPED_EARLY_COST = "cost_limit"
STOPPED_EARLY_TIME = "time_limit"
# The adapter asks the model for its answer this much before the clock reserve starts (a share of
# the reserve), so a model that complies is never refused; the reserve itself is the hard rule.
WRAP_UP_ANNOUNCE_LEAD = 0.4
# The calls the adapter may mark as final (#552): the answer, and the one repair of an answer that
# is not the review.
MAX_FINAL_MARKS = 2
# How often one mark comes back when its call was turned away unbilled (a 429 or a 5xx before the
# provider generated anything): the engine retries such a call by itself.
MAX_MARK_RETURNS = 2
# What the recovery call's request is larger than the last call's by, besides the model's own last
# answer (one output allowance): the engine's recovery message and the runner's instruction.
RECOVERY_REQUEST_SLACK_BYTES = 4096
# How many of the last model calls the ledger remembers the outcome of (#312).
RECENT_CALL_OUTCOMES = 3
# The density of the window backstop: the bytes one token is assumed to hold when the ledger asks
# whether a request can fit the model window at all. Natural text has 3 to 4.5, so 6 refuses only
# what cannot fit at any realistic density (a long run of one repeated character is the only text
# that packs tighter), and a request the provider could still take is never refused here: the
# provider's own context error ends the run with a code of its own instead.
WINDOW_CHECK_DENSITY = 6.0
# What a call reserves of its output (#540): the p95 of the run's completions so far, never below
# this floor and never above the allowance. A call that writes the review reserves more, since a
# review is longer than a tool call.
OUTPUT_FLOOR_TOKENS = 1_024
FINAL_OUTPUT_FLOOR_TOKENS = 4_096
# What the prompt of the call after the next one grows by, when the run has shown no round yet:
# about 12 KB of tool result. Later the p95 of the rounds seen takes over, never below this floor.
GROWTH_FLOOR_TOKENS = 4_096
# The factor on (this call + a final call after it) in the wrap-up test: both are expectations, and
# a normal call that costs a little more must not take the room of the final one.
RESERVE_MARGIN = Decimal("1.25")
# The nearest-rank percentile of the observed completions and rounds, in percent.
OBSERVED_PERCENTILE = 95
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


class RefusedForFinal(LimitError):
    """The guard refused a call that the adapter can answer with a final call (#552): the cost
    limit is used up, the clock reserve has started, or a call came after the final one.

    It is a `LimitError` like any other, so a ledger without `enable_final_above_wire` records it
    as the run's failure; with it, it is a counted refusal (`refusals`).
    """


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
    """What the model's descriptor says one million tokens cost, in USD.

    Used only to price a reservation before a call. The cost of a call is always the `usage.cost`
    the provider reported after it, never these numbers. The two cache prices are optional (#540):
    only a provider whose price list the runner knows has them (Anthropic); without them every
    token of the prompt is priced as plain input.
    """

    input_usd_per_mtok: Decimal
    output_usd_per_mtok: Decimal
    cache_read_usd_per_mtok: Decimal | None = None
    cache_write_usd_per_mtok: Decimal | None = None

    def of_call(
        self,
        input_tokens: int,
        output_tokens: int,
        *,
        cached_tokens: int = 0,
        cache_in_use: bool = False,
    ) -> Decimal:
        """The price of a call: `cached_tokens` of the input at the cache-read price, the rest at
        the cache-write price while the cache is in use, else at the input price. Without the cache
        prices of the descriptor everything is plain input."""
        read_usd = self.cache_read_usd_per_mtok
        cached = 0 if read_usd is None else min(max(cached_tokens, 0), input_tokens)
        fresh_usd = self.input_usd_per_mtok
        if cache_in_use and self.cache_write_usd_per_mtok is not None:
            fresh_usd = max(fresh_usd, self.cache_write_usd_per_mtok)
        total = _SUM.multiply(Decimal(input_tokens - cached), fresh_usd)
        if read_usd is not None:
            total = _SUM.add(total, _SUM.multiply(Decimal(cached), read_usd))
        total = _SUM.add(total, _SUM.multiply(Decimal(output_tokens), self.output_usd_per_mtok))
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
    # True when the final call is the one the adapter marked (`arm_final`, #552): a call the
    # provider turns away unbilled gives its mark back.
    marked: bool = False
    # Which reservation this is (0: none). The ledger settles each once, so a call that an error
    # handler settles again after the normal path already did is booked once (#550).
    serial: int = 0


@dataclass
class _Counters:
    model_calls: int = 0
    reserved_cost: Decimal = field(default_factory=lambda: Decimal(0))
    prompt_tokens: int = 0
    completion_tokens: int = 0
    last_prompt_tokens: int = 0
    # What the previous call's request weighed, what the provider reported of its cache and how much
    # it completed (#540).
    last_request_bytes: int = 0
    last_cache_read: int = 0
    last_cache_write: int = 0
    last_completion_tokens: int = 0
    # The completions and the per-round growth of the prompt of the normal calls so far.
    completions: list[int] = field(default_factory=lambda: list[int]())
    growths: list[int] = field(default_factory=lambda: list[int]())
    # Bytes per token the previous call settled on, when denser than the default estimate.
    density: float = ASSUMED_DENSITY
    # The cost the provider charged, summed as exact decimals, over the calls that reported one.
    cost: Decimal = field(default_factory=lambda: Decimal(0))
    priced_calls: int = 0
    # Calls whose usage was never seen (#550): booked at their worst case.
    unknown_calls: int = 0
    tool_calls: int = 0
    returned_bytes: int = 0
    # What the tools had returned when the last call settled: the growth of the history since is
    # what the audit saw them return after (#552, the size of the final request).
    returned_at_settle: int = 0
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


def _percentile(values: list[int]) -> int:
    """The nearest-rank `OBSERVED_PERCENTILE` of the values; 0 for none."""
    if not values:
        return 0
    rank = -(-OBSERVED_PERCENTILE * len(values) // 100)
    return sorted(values)[max(rank, 1) - 1]


def _cache_tokens(read: int | None, written: int | None, prompt_tokens: int) -> tuple[int, int]:
    """The cache tokens a call reported, as counts of the prompt. A count that is missing, not a
    count, or together above the prompt is no cache signal at all (0, 0): the call is then priced as
    plain input, the cautious reading."""
    counts = [0 if value is None else value for value in (read, written)]
    # A boolean is an int in Python and no count.
    if any(isinstance(value, bool) or value < 0 for value in counts):
        return 0, 0
    if sum(counts) > prompt_tokens:
        return 0, 0
    return counts[0], counts[1]


def reserved_tokens(text: str) -> int:
    """A proven upper bound on the tokens of `text`: one token is never fewer than one byte."""
    return len(text.encode("utf-8", errors="replace"))


def _json_forms(message: str) -> tuple[bytes, ...]:
    """The bytes a JSON body holds `message` as: the inside of a JSON string, with or without the
    non-ASCII characters escaped (an encoder is free to do either)."""
    forms = {json.dumps(message, ensure_ascii=flag)[1:-1].encode("utf-8") for flag in (True, False)}
    return tuple(sorted(forms))


def _byte_size(text: str | bytes) -> int:
    """The bytes of a request: the length of the bytes the passthrough proxy relays (#550), the
    UTF-8 length of the text the legacy proxy builds."""
    return len(text) if isinstance(text, bytes) else len(text.encode("utf-8", errors="replace"))


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
        reserved_output_tokens: int | None = None,
        unit_costs: UnitCosts,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if window_tokens < 1:
            raise LimitError(ErrorCode.DYNAMIC_CONFIG_INVALID, "the model window is not positive")
        self.limits = limits
        self.window_tokens = window_tokens
        self.output_tokens = min(max(output_tokens, 1), window_tokens)
        # The most a call reserves of its output allowance (#533): the allowance (None) unless the
        # model's wire says a call rarely uses the whole of it (thinking raises it). Within this cap
        # a call reserves the output the run has shown (#540). The allowance stays the cap an answer
        # is held to.
        self._reserved_cap = (
            None
            if reserved_output_tokens is None
            else min(max(reserved_output_tokens, 1), self.output_tokens)
        )
        self._unit_costs = unit_costs
        self._wrap_up_seconds = min(
            WRAP_UP_RESERVE_SECONDS, WRAP_UP_RESERVE_FRACTION * limits.deadline_seconds
        )
        self._final_granted = False
        self._final_unanswered = False
        self._recovery_armed = False
        self._recovered = False
        # A normal call settled over the limit (#540): the agent phase is over, the next request
        # that can be rewritten is the final call. And whether the retry past the limit was used.
        self._overshot = False
        self._retried_past_limit = False
        # Finalization above the wire (#552): declared by the adapter, then marks and refusals.
        self._above_wire = False
        self._final_armed = False
        self._final_needles: tuple[bytes, ...] = ()
        self._final_message_bytes = 0
        self._mark_returns = 0
        self._marks_used = 0
        self._refusals = 0
        self._stopped_early: str | None = None
        self._clock = clock
        self._started = clock()
        self._counters = _Counters()
        self._lock = threading.Lock()
        self._serials = 0
        self._open: set[int] = set()
        # What each call was, without content (#541); filled by the proxy and the audit, read by
        # nothing in the run.
        self.trace = CallTrace()
        self._failure: LimitError | None = None
        self._outcomes: deque[str] = deque(maxlen=RECENT_CALL_OUTCOMES)

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
            if self._above_wire and isinstance(error, RefusedForFinal):
                # Not the run's failure: the adapter asks for the answer (#552).
                self._refusals += 1
            elif self._failure is None:
                self._failure = error

    @property
    def failure(self) -> LimitError | None:
        with self._lock:
            return self._failure

    def enable_final_above_wire(self) -> None:
        """The adapter will ask for the answer itself (#552): a call the guard refuses for the cost
        or the clock is then a pending refusal and not the run's failure, and a call the adapter
        marked (`arm_final`) is admitted as the final call. The ledger of a run on the legacy path
        never calls this."""
        with self._lock:
            self._above_wire = True

    @property
    def refusals(self) -> int:
        """How many calls the guard has refused for the adapter to finalize, ever. The adapter
        takes this count when a turn starts and reacts only to an increase (#552): a refusal that
        landed between two turns belongs to neither."""
        with self._lock:
            return self._refusals

    def wait_idle(self, timeout: float) -> bool:
        """Wait until no reserved call is open; False when `timeout` ran out first (#552). A call
        of the aborted turn can still be answered by the provider when the adapter wants to mark
        the next one, and the mark needs nothing in flight."""
        until = time.monotonic() + max(timeout, 0.0)
        while True:
            with self._lock:
                if not self._open:
                    return True
            if time.monotonic() >= until:
                return False
            time.sleep(min(0.01, max(until - time.monotonic(), 0.0)))

    def note_wrap_up(self, reason: str) -> None:
        """The model was asked to answer now (`wrap_up_due`): that is why the run stopped early.
        The first reason wins."""
        with self._lock:
            if self._stopped_early is None:
                self._stopped_early = reason

    def wrap_up_due(self) -> str | None:
        """Why the model should be asked for its answer now, or None. Read only (#552).

        It is the arithmetic of the wrap-up (`_wrap_up_reason`) for the call the run would make
        next, priced from what the run has shown, and the clock a little before its reserve
        starts, so that a model that answers when asked is never refused. Nothing is recorded.
        """
        with self._lock:
            if self._final_granted or self._final_armed:
                return None
            reserve = self._wrap_up_seconds
            if self.remaining_seconds() <= reserve * (1 + WRAP_UP_ANNOUNCE_LEAD):
                return STOPPED_EARLY_TIME
            counters = self._counters
            if counters.last_prompt_tokens == 0:
                return None  # no call settled yet: nothing to price a next one with
            priced = counters.last_prompt_tokens + self._growth_tokens()
            allowance = self.output_tokens
            held = counters.cost + counters.reserved_cost
            return self._wrap_up_reason(
                held, self._expected_cost(priced, allowance), priced, allowance
            )

    def arm_final(self, message: str) -> bool:
        """Mark the next call as the run's final call, or say that it cannot be (#552).

        The final call is admitted past the cost limit (see "The bound"), once. The adapter marks
        it after it aborted the turn, so nothing is in flight; the call that follows is the
        engine's answer to the adapter's message. `message` is that message, exactly: the mark
        belongs to the first request that holds it (see "The mark") and is no larger than the
        history the run had plus that message. Any other request is a normal call.

        Not possible: a call is in flight, the mark is armed already, both marks (the answer and
        its one repair) are used, the deadline has passed, the run failed, or the spend already
        passes the limit without a normal call having settled over it (a cost that was only booked
        at its worst case).
        """
        with self._lock:
            if self._failure is not None or self._final_armed or self._open:
                return False
            if self._marks_used >= MAX_FINAL_MARKS or self.remaining_seconds() <= 0:
                return False
            held = self._counters.cost + self._counters.reserved_cost
            if not (self._final_granted or self._final_admissible(held)):
                return False
            self._final_armed = True
            self._final_needles = _json_forms(message)
            self._final_message_bytes = len(message.encode("utf-8", errors="replace"))
            self._mark_returns = 0
            self._marks_used += 1
            return True

    @property
    def final_armed(self) -> bool:
        """True while a mark waits for the call that carries the adapter's message."""
        with self._lock:
            return self._final_armed

    def _carries_mark(self, request_text: str | bytes, size: int, allowance: int) -> bool:
        """Whether this request is the one the armed mark is for. Call with the lock held.

        It holds the adapter's message as a JSON body holds text, and it is no larger than the
        history the run had at its last settled call plus what can have been added since: the
        model's answer (one output allowance), the tool results the audit saw after that call, the
        message, and the engine's framing (`RECOVERY_REQUEST_SLACK_BYTES`). A body that fails
        either test is an ordinary call: it must fit, or it is refused, and the mark stays.
        """
        if not self._final_armed:
            return False
        counters = self._counters
        history = counters.last_request_bytes or self.limits.max_request_bytes
        allowed = (
            history
            + math.ceil(allowance * WINDOW_CHECK_DENSITY)
            + max(counters.returned_bytes - counters.returned_at_settle, 0)
            + self._final_message_bytes
            + RECOVERY_REQUEST_SLACK_BYTES
        )
        if size > allowed:
            return False
        body = request_text if isinstance(request_text, bytes) else request_text.encode()
        return any(needle in body for needle in self._final_needles)

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
    def limit_exceeded_by(self) -> Decimal | None:
        """By how much the settled cost passed the cost limit in USD, None when it did not (#540).

        The run's usage reports it as a fact, so the bound of "The bound" in the module docstring
        can be watched on real runs."""
        with self._lock:
            excess = self._counters.cost - self.limits.max_cost_usd
            return excess if excess > 0 else None

    @property
    def recovered(self) -> bool:
        """True when the run's final call was the recovery of a turn without an answer (#309)."""
        with self._lock:
            return self._recovered

    def begin_recovery(self) -> bool:
        """Arm the one recovery call, or say that it is not possible. At most once per run.

        Not possible: a final call was granted already (its answer was the last chance, whatever
        it was), the recovery was armed before, no model call was made (nothing ended a turn),
        less than the wrap-up reserve of the clock is left (the call writes a whole review), or the
        spend and what is in flight already pass the cost limit. The recovery call is a final call:
        it is admitted whenever the spend is within the limit, even when its expected cost no longer
        fits, and after a normal call that settled over the limit (#540). The call itself is still
        reserved when it arrives.
        """
        with self._lock:
            counters = self._counters
            if self._final_granted or self._recovery_armed or self._recovered:
                return False
            if counters.model_calls == 0 or self.remaining_seconds() <= self._wrap_up_seconds:
                return False
            if not self._final_admissible(counters.cost + counters.reserved_cost):
                return False
            self._recovery_armed = True
            return True

    def note_call_outcome(self, outcome: str) -> None:
        """Remember how a model call ended (`call_outcome.py`): sizes and names, no model text.

        Only the last few are kept; they are what a failure of the run says about itself (#312).
        """
        with self._lock:
            self._outcomes.append(outcome)

    @property
    def recent_call_outcomes(self) -> tuple[str, ...]:
        with self._lock:
            return tuple(self._outcomes)

    def note_final_unanswered(self) -> None:
        """The final call came back without the structured answer (#301 F3): the model's failure.

        Whatever the engine asks for afterwards is refused as `llm_output_invalid`, which is what
        an operator has to look at, not the cost limit.
        """
        with self._lock:
            self._final_unanswered = True

    def reserve_call(
        self,
        request_text: str | bytes,
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
        size = _byte_size(request_text)
        allowance = self.output_tokens if output_tokens is None else output_tokens
        counters = self._counters
        with self._lock:
            if self._above_wire and self._failure is not None:
                # The run has failed (#552): no call is admitted after a recorded failure.
                raise LimitError(self._failure.code, self._failure.detail)
            marked = self._carries_mark(request_text, size, allowance)
            if self._final_granted and not marked:
                if self._final_unanswered:
                    raise LimitError(
                        ErrorCode.LLM_OUTPUT_INVALID,
                        "the final call returned no structured answer",
                    )
                raise RefusedForFinal(
                    ErrorCode.DYNAMIC_BUDGET_EXCEEDED,
                    "the run asked for a call after its final call",
                )
            if self._above_wire and not marked and self._wrap_up_started():
                self._stop_early(STOPPED_EARLY_TIME)
                raise RefusedForFinal(
                    ErrorCode.DYNAMIC_BUDGET_EXCEEDED,
                    "the clock reserve for the answer has started",
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
            priced = self._priced_input(size, estimate)
            cost = self._expected_cost(priced, allowance)
            recovery = self._recovery_armed and can_wrap_up
            if self._overshot and not can_wrap_up and not marked:
                # A normal call settled over the limit: nothing but the final call follows.
                raise self._cost_refusal()
            if recovery or marked:
                reason = None
            elif self._overshot:
                reason = STOPPED_EARLY_COST
            elif can_wrap_up:
                reason = self._wrap_up_reason(held, cost, priced, allowance)
            else:
                reason = None
            final = reason is not None or recovery or marked
            if final:
                # The last call of the run: it carries the instruction and nothing else grows.
                text = recovery_text if recovery else wrap_up_text
                size += len(text.encode("utf-8", errors="replace"))
                estimate = self._estimate(size)
                bound += size - _byte_size(request_text)
                cost = self._expected_cost(
                    self._priced_input(size, estimate), allowance, final=True
                )
            # A normal call is admitted only when its expected cost fits. The final call is the last
            # chance of a review, so it is admitted whenever the spend and what is in flight are
            # within the limit, even when its expected cost no longer fits (#540).
            # A call the adapter marked was checked when it was marked (`arm_final`).
            fits = marked or (
                self._final_admissible(held) if final else held + cost <= self.limits.max_cost_usd
            )
            if not fits:
                raise self._cost_refusal()
            if final:
                self._final_granted = True
                if marked:
                    # Why the run stopped early, if it did, was recorded when the model was asked.
                    self._final_armed = False
                elif recovery:
                    self._recovery_armed = False
                    self._recovered = True
                else:
                    self._stopped_early = reason
            counters.model_calls += 1
            counters.reserved_cost = _SUM.add(counters.reserved_cost, cost)
            serial = self._issue()
        return Reservation(
            input_tokens=estimate,
            output_tokens=allowance,
            byte_bound=bound,
            request_bytes=size,
            cost=cost,
            final=final,
            recovery=recovery,
            marked=marked,
            serial=serial,
        )

    def _wrap_up_started(self) -> bool:
        """The clock reserve for the answer has started. Call with the lock held."""
        return self.remaining_seconds() <= self._wrap_up_seconds

    def _stop_early(self, reason: str) -> None:
        """Remember why the run is wrapped up; the first reason wins. Call with the lock held."""
        if self._stopped_early is None:
            self._stopped_early = reason

    def _cost_refusal(self) -> RefusedForFinal:
        """The error of a call the cost limit cannot hold. Call with the lock held."""
        if self._above_wire:
            self._stop_early(STOPPED_EARLY_COST)
        return RefusedForFinal(ErrorCode.DYNAMIC_BUDGET_EXCEEDED, "the cost limit is used up")

    def try_reserve_final_retry(
        self, request_text: str | bytes, *, output_tokens: int | None = None
    ) -> Reservation | None:
        """Reserve one more attempt at the final call, or say there is no room for it (#312).

        The final call (wrap-up or recovery) can only return the review. When its reply did not,
        the proxy asks again, but only while the clock and the cost limit have room: the attempt is
        priced and reserved like any call (the same window check), and it is a final call: admitted
        whenever the spend and what is in flight are within the cost limit, even when its expected
        cost no longer fits. Once the spend is over the limit, one retry is still admitted and then
        none (#540). None means "stop asking"; the last reply is what the engine gets.
        """
        allowance = self.output_tokens if output_tokens is None else output_tokens
        size = _byte_size(request_text)
        counters = self._counters
        with self._lock:
            if not self._final_granted or self.remaining_seconds() <= 0:
                return None
            if math.ceil(size / WINDOW_CHECK_DENSITY) + allowance > self.window_tokens:
                return None
            estimate = self._estimate(size)
            bound = max(size, counters.last_prompt_tokens)
            cost = self._expected_cost(self._priced_input(size, estimate), allowance, final=True)
            if counters.cost + counters.reserved_cost > self.limits.max_cost_usd:
                if self._retried_past_limit:
                    return None
                self._retried_past_limit = True
            counters.model_calls += 1
            counters.reserved_cost = _SUM.add(counters.reserved_cost, cost)
            serial = self._issue()
        return Reservation(
            input_tokens=estimate,
            output_tokens=allowance,
            byte_bound=bound,
            request_bytes=size,
            cost=cost,
            final=True,
            serial=serial,
        )

    def _final_admissible(self, held: Decimal) -> bool:
        """Whether a final call (wrap-up, recovery) may start: the spend and what is in flight are
        within the cost limit, or a normal call settled over it and this is the call that ends the
        run (#540). Its expected cost is not asked: the final call is delivered whatever it costs.
        """
        return self._overshot or held <= self.limits.max_cost_usd

    def _estimate(self, size: int) -> int:
        return max(math.ceil(size / self._counters.density), self._counters.last_prompt_tokens)

    def _priced_input(self, size: int, estimate: int) -> int:
        """The input tokens a reservation is priced with: the last settled prompt plus the tokens of
        the bytes the request added since (#540), never more than the conservative estimate.

        The provider counted the history it has seen, so it is not estimated again from bytes. A
        request that is not longer than the last one (a compaction, a hidden call with another
        prompt) says nothing about the last prompt and is priced at the estimate.
        """
        counters = self._counters
        if counters.last_request_bytes == 0 or size < counters.last_request_bytes:
            return estimate
        added = math.ceil((size - counters.last_request_bytes) / counters.density)
        return min(estimate, counters.last_prompt_tokens + added)

    def _reads_cache(self) -> bool:
        """True when the previous call read from the cache and the descriptor prices a read."""
        return self._unit_costs.cache_read_usd_per_mtok is not None and (
            self._counters.last_cache_read > 0
        )

    def _cache_in_use(self) -> bool:
        counters = self._counters
        return counters.last_cache_read + counters.last_cache_write > 0

    def _expected_output(self, allowance: int, *, final: bool = False) -> int:
        """The output a call reserves: the p95 of the run's completions with a floor, at most the
        allowance and at most the cap the model's wire names for a reservation (#533). The call
        that writes the review reserves the larger floor, or, when the wire names a cap, the cap
        itself: a review can use all of it (the thinking of a model counts), and the final call is
        the one call that is delivered over the limit, so it is not priced optimistically (#540)."""
        cap = allowance if self._reserved_cap is None else min(allowance, self._reserved_cap)
        if final and self._reserved_cap is not None:
            return cap
        observed = _percentile(self._counters.completions)
        floor = FINAL_OUTPUT_FLOOR_TOKENS if final else OUTPUT_FLOOR_TOKENS
        return min(cap, max(floor, observed))

    def _growth_tokens(self) -> int:
        """What one round adds to the prompt: the p95 of the rounds seen, never below the floor."""
        return max(GROWTH_FLOOR_TOKENS, _percentile(self._counters.growths))

    def _expected_cost(
        self, priced_input: int, allowance: int, *, final: bool = False, prefix: int | None = None
    ) -> Decimal:
        """What one call is expected to cost, to reserve (#540): the prefix the previous call left
        in the cache at the cache-read price, the rest at the write (or input) price, the output
        the run has shown. `prefix` defaults to what the previous call cached; it is zero unless
        that call read from the cache."""
        if prefix is None:
            counters = self._counters
            prefix = (
                counters.last_cache_read + counters.last_cache_write if self._reads_cache() else 0
            )
        return self._unit_costs.of_call(
            priced_input,
            self._expected_output(allowance, final=final),
            cached_tokens=prefix,
            cache_in_use=self._cache_in_use(),
        )

    def _wrap_up_reason(
        self, held: Decimal, cost: Decimal, priced: int, allowance: int
    ) -> str | None:
        """Why this call has to be the final one: the clock first, then what the next would cost."""
        if self.remaining_seconds() <= self._wrap_up_seconds:
            return STOPPED_EARLY_TIME
        # The final call comes after this one: its prompt is this prompt (cached by then) plus one
        # round of growth.
        prefix = priced if self._reads_cache() else 0
        after = self._expected_cost(
            priced + self._growth_tokens(), allowance, final=True, prefix=prefix
        )
        if _SUM.add(held, _SUM.multiply(_SUM.add(cost, after), RESERVE_MARGIN)) > (
            self.limits.max_cost_usd
        ):
            return STOPPED_EARLY_COST
        return None

    def settle_call(
        self,
        reservation: Reservation,
        *,
        prompt_tokens: int | None,
        completion_tokens: int | None,
        cost: Decimal | None = None,
        cache_read_tokens: int | None = None,
        cache_write_tokens: int | None = None,
    ) -> None:
        """Replace a reservation with what the provider actually reported. Missing usage fails.

        The provider is authoritative after the call. A missing counter is not zero: the run cannot
        be accounted for and is stopped. A prompt above the proven byte bound or an answer above
        the output allowance is a violation of the envelope, not a value to add up; a prompt above
        the estimate but within the bound is only an estimate that was too low.

        `cost` is what this call cost: the charge the provider states (`exact_cost`), or the usage
        priced with the provider's price list (`LlmProviderSpec.cost_extractor`). A call without one
        cannot be bounded by money: the tokens are recorded, then the run is stopped, and it is
        never read as zero.
        """
        if not self._is_open(reservation):
            return  # settled already (an error handler came after the normal path)
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
            self._book_over_report(reservation, prompt_tokens, completion_tokens, cost)
            raise LimitError(
                ErrorCode.DYNAMIC_ACCOUNTING_FAILED,
                "the provider reported more than the request reserved",
            )
        read, written = _cache_tokens(cache_read_tokens, cache_write_tokens, prompt_tokens)
        counters = self._counters
        with self._lock:
            self._close(reservation)
            counters.reserved_cost = _SUM.subtract(counters.reserved_cost, reservation.cost)
            counters.prompt_tokens += prompt_tokens
            counters.completion_tokens += completion_tokens
            if not reservation.final:
                counters.completions.append(completion_tokens)
                if 0 < counters.last_prompt_tokens < prompt_tokens:
                    counters.growths.append(prompt_tokens - counters.last_prompt_tokens)
            counters.last_prompt_tokens = prompt_tokens
            counters.last_completion_tokens = completion_tokens
            counters.last_request_bytes = reservation.request_bytes
            counters.returned_at_settle = counters.returned_bytes
            counters.last_cache_read = read
            counters.last_cache_write = written
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
            # The final call carries the answer: it is delivered even if it cost more than expected.
            # A normal call over the limit is delivered too, but it ends the agent phase: the next
            # request is the final call, and no normal call is admitted again (see "The bound").
            if counters.cost > self.limits.max_cost_usd and not reservation.final:
                self._overshot = True

    def _book_over_report(
        self,
        reservation: Reservation,
        prompt_tokens: int,
        completion_tokens: int,
        cost: Decimal | None,
    ) -> None:
        """Book a call whose usage broke the envelope, before the run is stopped for it (#550).

        The provider did charge for it. Stopping the run without booking would drop the charge from
        the result (a hostile engine could hide a cost by making the report look like a
        violation): the reported cost is spent, or, with none reported, what was reserved, and then
        the cost of the run is unknown.
        """
        with self._lock:
            counters = self._counters
            self._close(reservation)
            counters.reserved_cost = _SUM.subtract(counters.reserved_cost, reservation.cost)
            counters.prompt_tokens += prompt_tokens
            counters.completion_tokens += completion_tokens
            counters.cost = _SUM.add(counters.cost, reservation.cost if cost is None else cost)
            if cost is not None:
                counters.priced_calls += 1

    def _issue(self) -> int:
        """A serial for a new reservation. Call with the lock held."""
        self._serials += 1
        self._open.add(self._serials)
        return self._serials

    def _is_open(self, reservation: Reservation) -> bool:
        with self._lock:
            return reservation.serial == 0 or reservation.serial in self._open

    def _close(self, reservation: Reservation) -> None:
        """The reservation is settled. Call with the lock held."""
        self._open.discard(reservation.serial)

    def settle_unbilled(self, reservation: Reservation) -> None:
        """Release the reservation of a call the provider refused before it generated anything
        (#550).

        The engine of the passthrough path retries a refusal (429, 5xx) by itself, so the refusal
        does not end the run as it does on the legacy path. The call was made and is counted, it
        cost nothing, and what was held for it is free again.
        """
        with self._lock:
            if reservation.serial and reservation.serial not in self._open:
                return
            self._close(reservation)
            self._counters.reserved_cost = _SUM.subtract(
                self._counters.reserved_cost, reservation.cost
            )
            self._counters.priced_calls += 1
            self._return_mark(reservation)

    def _return_mark(self, reservation: Reservation) -> None:
        """A marked call the provider turned away before it generated anything did not carry the
        answer: its mark comes back, a bounded number of times per mark (#552). Without it the
        engine's own retry would meet "a call after the final call" and the run would end without
        a review for a transient 429. Call with the lock held."""
        if not (self._above_wire and reservation.marked) or self._mark_returns >= MAX_MARK_RETURNS:
            return
        self._mark_returns += 1
        self._final_armed = True

    def worst_case_cost(self, reservation: Reservation) -> Decimal:
        """The most one reserved call can cost: the bytes of its request, each as a token of the
        dearest input kind (the byte count bounds the tokens), and the whole output cap."""
        return self._unit_costs.of_call(
            max(reservation.byte_bound, reservation.input_tokens),
            reservation.output_tokens,
            cache_in_use=True,
        )

    def settle_unknown(self, reservation: Reservation) -> bool:
        """Settle a call whose usage was never seen (a cut stream, an error inside a stream, a
        timeout after the request was sent, a server error) (#550).

        The provider may have billed it, and an engine that can make a call's usage unreadable
        must not thereby make it free: the call is booked at its **worst case**, not at what it was
        expected to cost, and counted as unknown. Like any call without a reported cost it makes
        the cost of the whole run unknown, never a partial sum. Returns False (and books nothing)
        for a reservation that was settled already.
        """
        worst = self.worst_case_cost(reservation)
        with self._lock:
            if reservation.serial and reservation.serial not in self._open:
                return False  # settled already: an error handler came after the normal path
            self._close(reservation)
            counters = self._counters
            counters.reserved_cost = _SUM.subtract(counters.reserved_cost, reservation.cost)
            counters.cost = _SUM.add(counters.cost, max(worst, reservation.cost))
            counters.unknown_calls += 1
        return True

    @property
    def unknown_calls(self) -> int:
        """How many calls were booked at their worst case because their usage was never seen."""
        with self._lock:
            return self._counters.unknown_calls

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
        (None) rather than a partial sum that would look exact. The cost of a call is the charge the
        provider states, or, for a provider that states none, what its usage costs by that
        provider's own price list (#511): never an estimate, and never LiteLLM's table. A run that
        made no call has nothing to report. A total that is not a finite
        float (the providers' charges add up beyond the float range) is unknown too: it could not be
        sent as a result.
        """
        with self._lock:
            counters = self._counters
            exact = counters.model_calls > 0 and counters.priced_calls == counters.model_calls
            total = float(counters.cost)
            excess = float(counters.cost - self.limits.max_cost_usd)
            return Usage(
                model=model,
                prompt_tokens=counters.prompt_tokens,
                completion_tokens=counters.completion_tokens,
                total_tokens=counters.prompt_tokens + counters.completion_tokens,
                ai_calls=counters.model_calls,
                fallback_used=False,
                cost_usd=total if exact and math.isfinite(total) else None,
                stopped_early=self._stopped_early,
                limit_exceeded_by=excess if exact and 0 < excess < math.inf else None,
                call_trace=self.trace.to_json(),
            )
