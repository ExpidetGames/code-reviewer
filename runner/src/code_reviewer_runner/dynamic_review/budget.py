# SPDX-License-Identifier: Apache-2.0

"""The hard limits of one Dynamic Review and the ledger that enforces them (#197).

The bounds are the epic's (#193): 600 seconds for the whole job, 30 model calls, 120,000 cumulative
input + output tokens, 200 tool calls, 100 distinct files, 64 KiB per tool result and 4 MiB of
cumulative content returned to the model. They are operator-owned and never come from the
repository, the skill or the model.

Enforcement lives here and in the model proxy, **outside** the engine and its prompt: a bound that
is only asked for in the prompt or only observed after the fact is not enforced. Every model call
is reserved before the request is sent, every tool part the engine reports is counted, and a
missing or oversized answer fails closed. Nothing here is advisory.

The token reservation uses a **proven conservative bound**: a BPE token is never fewer than one
UTF-8 byte, so the byte length of the serialized request is an upper bound on its token count. It is
deliberately conservative; a verified DeepSeek tokenizer may tighten it later without weakening the
envelope. A request that fits the byte bound but not the token budget is refused before it is sent.

The token budget is cumulative and preventive (#231): a call is refused when the usage already
settled, the calls still in flight and this call's own reservation would together pass the cap, so a
run never overshoots by the one call that would have crossed it.
"""

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field

from code_reviewer_runner.result import ErrorCode, Usage

# The epic's defaults. Operator-owned validated configuration, never repository instructions.
TOTAL_DEADLINE_SECONDS = 600.0
MAX_MODEL_CALLS = 30
MAX_TOTAL_TOKENS = 120_000
MAX_TOOL_CALLS = 200
MAX_FILES = 100
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
# Used when the job names no context window. The epic's 600 s / 120k token envelope binds first.
DEFAULT_WINDOW_TOKENS = 128_000


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
    max_model_calls: int = MAX_MODEL_CALLS
    max_total_tokens: int = MAX_TOTAL_TOKENS
    max_tool_calls: int = MAX_TOOL_CALLS
    max_files: int = MAX_FILES
    max_tool_result_bytes: int = MAX_TOOL_RESULT_BYTES
    max_returned_bytes: int = MAX_RETURNED_BYTES
    max_input_bytes: int = MAX_INPUT_BYTES
    max_request_bytes: int = MAX_REQUEST_BYTES
    max_response_bytes: int = MAX_RESPONSE_BYTES
    max_stream_bytes: int = MAX_STREAM_BYTES


@dataclass(frozen=True)
class Reservation:
    """What one model call reserved before it was sent."""

    input_tokens: int
    output_tokens: int


@dataclass
class _Counters:
    model_calls: int = 0
    reserved_tokens: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    last_prompt_tokens: int = 0
    tool_calls: int = 0
    returned_bytes: int = 0
    files: set[str] = field(default_factory=lambda: set[str]())


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
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if window_tokens < 1:
            raise LimitError(ErrorCode.DYNAMIC_CONFIG_INVALID, "the model window is not positive")
        self.limits = limits
        self.window_tokens = window_tokens
        self.output_tokens = min(max(output_tokens, 1), window_tokens)
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
        calls and they all consume the same budget. The reservation is the serialized request plus
        the output allowance; both must fit the window and the budget left after the usage already
        settled and the calls still in flight.
        """
        self.check_deadline()
        estimate = reserved_tokens(request_text)
        allowance = self.output_tokens if output_tokens is None else output_tokens
        counters = self._counters
        with self._lock:
            # The byte count is the proven bound. The last settled prompt is a heuristic safety
            # net, not a bound: it usually predicts the next prompt in a tool loop and may cover
            # what the provider adds that the bytes do not show, such as its chat template, but
            # after a compaction or a hidden call with another prompt it can over-reserve. It only
            # ever raises the reservation, so soundness rests on the byte count alone.
            input_tokens = max(estimate, counters.last_prompt_tokens)
            if input_tokens + allowance > self.window_tokens:
                raise LimitError(
                    ErrorCode.DYNAMIC_BUDGET_EXCEEDED,
                    "the request plus its output allowance exceeds the model window",
                )
            if counters.model_calls + 1 > self.limits.max_model_calls:
                raise LimitError(
                    ErrorCode.DYNAMIC_BUDGET_EXCEEDED, "the model call budget is used up"
                )
            settled = counters.prompt_tokens + counters.completion_tokens
            if settled + counters.reserved_tokens + input_tokens + allowance > (
                self.limits.max_total_tokens
            ):
                raise LimitError(ErrorCode.DYNAMIC_BUDGET_EXCEEDED, "the token budget is used up")
            counters.model_calls += 1
            counters.reserved_tokens += input_tokens + allowance
        return Reservation(input_tokens=input_tokens, output_tokens=allowance)

    def settle_call(
        self, reservation: Reservation, *, prompt_tokens: int | None, completion_tokens: int | None
    ) -> None:
        """Replace a reservation with what the provider actually reported. Missing usage fails.

        The provider is authoritative after the call. A missing counter is not zero: the run cannot
        be accounted for and is stopped. An answer larger than the reserved allowance is a violation
        of the envelope, not a value to add up.
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
            prompt_tokens > reservation.input_tokens
            or completion_tokens > reservation.output_tokens
        ):
            raise LimitError(
                ErrorCode.DYNAMIC_ACCOUNTING_FAILED,
                "the provider reported more than the request reserved",
            )
        counters = self._counters
        with self._lock:
            counters.reserved_tokens -= reservation.input_tokens + reservation.output_tokens
            counters.prompt_tokens += prompt_tokens
            counters.completion_tokens += completion_tokens
            counters.last_prompt_tokens = prompt_tokens
            if counters.prompt_tokens + counters.completion_tokens > self.limits.max_total_tokens:
                raise LimitError(ErrorCode.DYNAMIC_BUDGET_EXCEEDED, "the token budget is used up")

    def count_tool_call(self, name: str) -> None:
        """Count one tool call the engine reported. Unknown attempts count too."""
        if not name:
            raise LimitError(ErrorCode.DYNAMIC_POLICY_VIOLATION, "a tool call without a name")
        with self._lock:
            if self._counters.tool_calls + 1 > self.limits.max_tool_calls:
                raise LimitError(
                    ErrorCode.DYNAMIC_BUDGET_EXCEEDED, "the tool call budget is used up"
                )
            self._counters.tool_calls += 1

    def count_file(self, path: str) -> None:
        """Count a content-bearing file the run read. Distinct files, not calls."""
        files = self._counters.files
        with self._lock:
            if path in files:
                return
            if len(files) + 1 > self.limits.max_files:
                raise LimitError(
                    ErrorCode.DYNAMIC_BUDGET_EXCEEDED, "the distinct file budget is used up"
                )
            files.add(path)

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
        """The run's usage in the existing result shape. Cost is never guessed."""
        with self._lock:
            counters = self._counters
            return Usage(
                model=model,
                prompt_tokens=counters.prompt_tokens,
                completion_tokens=counters.completion_tokens,
                total_tokens=counters.prompt_tokens + counters.completion_tokens,
                ai_calls=counters.model_calls,
                fallback_used=False,
                cost_usd=None,
            )
