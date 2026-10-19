# SPDX-License-Identifier: Apache-2.0

"""The passthrough proxy of one job (#550): authenticate, swap the key, relay, count.

For every request the engine makes, in this order:

1. **Admission** (`admission.py`): the capability, one method, path, query and header set, a body
   length that can be measured; the body only for `model` (the job's), the output cap and `stream`.
   A refusal is answered locally with a stable code and nothing is reserved or forwarded.
2. **Reservation**: the ledger (`budget.py`, the realistic guard of #540/#542) reserves the call
   from the bytes of the body and what the run has shown. Every upstream call is a call of its own,
   the engine's retries (429, 5xx, a cut stream, an error event in a 200) included.
3. **The relay**: the request goes out byte for byte with the one real key in the one header of the
   family and `accept-encoding: identity`, to the job's one upstream, with no redirect followed. The
   answer comes back byte for byte, a stream one whole event at a time, while the tee reads the
   usage from the same bytes.
4. **Settlement**: a complete answer with a usage and a price settles the reservation; a refusal
   costs nothing; a cut stream, an error event, an engine that went away and a timeout after the
   request was sent are held as spent and make the cost of the run unknown. A complete answer
   without a readable usage or price stops the run (`dynamic_accounting_failed`), as on the legacy
   path; relaxing that for an own key is #553.

Nothing the provider says about an error is passed on or logged before the key is cut out of it
(`redact.py`). A refusal that ends the run (a policy violation, a limit, a provider error that no
retry will help) is recorded in the ledger with a stable `ErrorCode`; one the engine retries by
itself (429, 5xx, a cut stream) is not, and its code is kept in `last_upstream_error` for the
caller to name when the engine gives up. No file here logs.

Not done here: how a final call is told to answer (#552: a call is never rewritten on this path, so
the ledger is asked with `can_wrap_up=False` and a call the limit cannot hold is refused); the
parsers beyond the minimal ones (#551); an own key without prices (#553).
"""

import json
import threading
from collections.abc import Callable, Sequence
from typing import Final

from code_reviewer_runner.cache_usage import CacheTally
from code_reviewer_runner.dynamic_review.budget import (
    BudgetLedger,
    LimitError,
    Reservation,
    UnitCosts,
)
from code_reviewer_runner.dynamic_review.config import PROXY_CAPABILITY_BYTES
from code_reviewer_runner.dynamic_review.passthrough.admission import (
    Admission,
    Admitted,
    Head,
    PassthroughTarget,
    RefusalCode,
    Refused,
)
from code_reviewer_runner.dynamic_review.passthrough.families import spec_of
from code_reviewer_runner.dynamic_review.passthrough.pricing import call_cost
from code_reviewer_runner.dynamic_review.passthrough.redact import Redactor
from code_reviewer_runner.dynamic_review.passthrough.sink import ClientGone, ResponseSink
from code_reviewer_runner.dynamic_review.passthrough.sse import SseFramer
from code_reviewer_runner.dynamic_review.passthrough.upstream import (
    Upstream,
    UpstreamError,
    UpstreamFailure,
    UpstreamRequest,
    UpstreamResponse,
)
from code_reviewer_runner.dynamic_review.passthrough.usage import TapResult, UsageTap, tap_for
from code_reviewer_runner.error_mapping import is_context_length_exceeded, llm_status_code
from code_reviewer_runner.result import ErrorCode

# `secrets.token_urlsafe(n)` yields ceil(4n/3) characters: the shortest acceptable capability.
_MIN_CAPABILITY_CHARS: Final = -(-PROXY_CAPABILITY_BYTES * 4 // 3)
# The wait for the provider: connecting and each read. The job's own deadline can be shorter.
CALL_TIMEOUT_SECONDS: Final = 120.0
_READ_BYTES: Final = 65536
# A server-sent stream is far larger than the text in it: an event per token costs about 100 bytes
# of framing. The bound of a stream is the larger of the ledger's and this much per output token.
_STREAM_BYTES_PER_OUTPUT_TOKEN: Final = 256
# The headers of the provider's answer that reach the engine. The engine's retries read the first
# ones; the rest identify a call in a log. Everything else (cookies, rate-limit state, the server)
# is
# the provider's own business.
_RESPONSE_HEADERS: Final = frozenset(
    {
        "content-type",
        "retry-after",
        "retry-after-ms",
        "x-should-retry",
        "request-id",
        "x-request-id",
    }
)
_MAX_HEADER_VALUE: Final = 1024
_REFUSAL_DETAIL: Final = {
    RefusalCode.CAPABILITY_INVALID: "the request carries no valid capability",
    RefusalCode.REQUEST_NOT_ALLOWED: "the request is not one this job may make",
    RefusalCode.MODEL_NOT_ALLOWED: "the request names another model",
    RefusalCode.REQUEST_TOO_LARGE: "the request exceeds the protocol byte bound",
    RefusalCode.LENGTH_REQUIRED: "the request has no length that can be measured",
}


def _error_body(code: str, detail: str) -> bytes:
    """The stable error shape the engine sees: a code, never a message with data in it."""
    return json.dumps({"error": {"code": code, "detail": detail}}).encode("utf-8")


class PassthroughProxy:
    """One per job. `handle` is the whole policy for one request; `server.py` puts it on
    loopback."""

    def __init__(
        self,
        *,
        ledger: BudgetLedger,
        target: PassthroughTarget,
        upstream: Upstream,
        upstream_api_key: str,
        capability: str,
        prices: UnitCosts,
        superseded: Callable[[], bool] = lambda: False,
        call_timeout: float = CALL_TIMEOUT_SECONDS,
    ) -> None:
        if len(capability) < _MIN_CAPABILITY_CHARS:
            raise LimitError(
                ErrorCode.DYNAMIC_CONFIG_INVALID, "the proxy capability is not strong enough"
            )
        self.ledger = ledger
        # How much of the input of the run came from the provider's cache (counts only, #539).
        self.cache_tally = CacheTally()
        # The stable code of the last thing the provider did wrong (429, 5xx, a cut stream), kept
        # for
        # the caller to name if the engine gives up: the engine retries these itself.
        self.last_upstream_error: ErrorCode | None = None
        self._admission = Admission(target, capability)
        self._spec = spec_of(target.family)
        self._upstream = upstream
        self._key = upstream_api_key
        self._redactor = Redactor(upstream_api_key)
        self._prices = prices
        self._superseded = superseded
        self._call_timeout = call_timeout
        self._family = target.family
        # Requests being answered right now (`wait_idle`: a superseded run lets them finish).
        self._in_flight = 0
        self._idle = threading.Condition()

    def authorized(self, headers: Sequence[tuple[str, str]]) -> bool:
        return self._admission.authorized(headers)

    def wait_idle(self, timeout: float) -> bool:
        """Wait until no request is being answered; False when `timeout` ran out first."""
        with self._idle:
            return self._idle.wait_for(lambda: self._in_flight == 0, timeout=timeout)

    # -- one request ------------------------------------------------------------------------------

    def handle(
        self,
        method: str,
        raw_target: str,
        headers: Sequence[tuple[str, str]],
        read_body: Callable[[int], bytes],
        sink: ResponseSink,
    ) -> None:
        """Decide on one request and answer it through `sink`. Every refusal is a stable code."""
        with self._idle:
            self._in_flight += 1
        try:
            self._handle(method, raw_target, headers, read_body, sink)
        finally:
            with self._idle:
                self._in_flight -= 1
                self._idle.notify_all()

    def _handle(
        self,
        method: str,
        raw_target: str,
        headers: Sequence[tuple[str, str]],
        read_body: Callable[[int], bytes],
        sink: ResponseSink,
    ) -> None:
        try:
            head = self._admission.head(
                method, raw_target, headers, self.ledger.limits.max_request_bytes
            )
            if self._superseded():
                raise LimitError(ErrorCode.SUPERSEDED, "the run was superseded by a newer push")
            admitted = self._admission.body(head, read_body(head.content_length))
            reservation = self.ledger.reserve_call(admitted.body, output_tokens=admitted.output_cap)
        except Refused as refused:
            self._refuse(sink, refused)
            return
        except LimitError as error:
            # 403, not 5xx: a deterministic refusal must not be retried (every retry is a call).
            self.ledger.record_failure(error)
            self._respond(sink, 403, _error_body(error.code.value, error.detail))
            return
        self._relay(head, admitted, reservation, sink)

    def _refuse(self, sink: ResponseSink, refused: Refused) -> None:
        detail = _REFUSAL_DETAIL[refused.code]
        if refused.code is not RefusalCode.CAPABILITY_INVALID:
            # An engine that asks for what it may not is misbehaving: the run stops. A caller that
            # proved nothing is not the engine of this job and does not end it.
            self.ledger.record_failure(LimitError(refused.error, detail))
        self._respond(sink, refused.status, _error_body(refused.code.value, detail))

    @staticmethod
    def _respond(sink: ResponseSink, status: int, body: bytes) -> None:
        try:
            sink.start(status, [("content-type", "application/json")], len(body))
            sink.write(body)
            sink.end()
        except ClientGone:
            sink.abort()

    # -- the call
    # -----------------------------------------------------------------------------------

    def _relay(
        self, head: Head, admitted: Admitted, reservation: Reservation, sink: ResponseSink
    ) -> None:
        started_ms = int(self.ledger.elapsed_seconds() * 1000)
        outgoing = dict(head.headers)
        outgoing.setdefault("content-type", "application/json")
        outgoing[self._spec.key_header] = self._spec.key_value(self._key)
        # A tee that reads the usage cannot read an answer that was compressed for the engine.
        outgoing["accept-encoding"] = "identity"
        timeout = min(self._call_timeout, self.ledger.remaining_seconds())
        try:
            response = self._upstream.send(
                UpstreamRequest(head.upstream_path, outgoing, admitted.body), timeout
            )
        except UpstreamError as error:
            self._no_answer(sink, error, reservation, started_ms)
            return
        try:
            self._answer(response, admitted, reservation, started_ms, sink)
        finally:
            response.close()

    def _no_answer(
        self, sink: ResponseSink, error: UpstreamError, reservation: Reservation, started_ms: int
    ) -> None:
        # A call that never left costs nothing; one that was sent may have been billed.
        if error.sent:
            self.ledger.settle_unknown(reservation)
        else:
            self.ledger.settle_unbilled(reservation)
        self._trace_failed(started_ms, reservation)
        if error.kind is UpstreamFailure.ADDRESS_REFUSED:
            problem = LimitError(
                ErrorCode.DYNAMIC_POLICY_VIOLATION, "the model provider is not at a public address"
            )
            self.ledger.record_failure(problem)
            self._respond(sink, 502, _error_body(problem.code.value, problem.detail))
            return
        timed_out = error.kind is UpstreamFailure.TIMEOUT
        code = ErrorCode.LLM_TIMEOUT if timed_out else ErrorCode.LLM_UNAVAILABLE
        self.last_upstream_error = code
        detail = (
            "the model provider did not answer in time"
            if timed_out
            else "the model provider could not be reached"
        )
        self._respond(sink, 504 if timed_out else 502, _error_body(code.value, detail))

    def _answer(
        self,
        response: UpstreamResponse,
        admitted: Admitted,
        reservation: Reservation,
        started_ms: int,
        sink: ResponseSink,
    ) -> None:
        status = response.status
        headers = {name.lower(): value for name, value in response.headers}
        if 300 <= status < 400:
            # Never followed, and the destination it names is never read.
            self.ledger.settle_unbilled(reservation)
            self._trace_failed(started_ms, reservation)
            problem = LimitError(
                ErrorCode.DYNAMIC_POLICY_VIOLATION, "the model provider answered with a redirect"
            )
            self.ledger.record_failure(problem)
            self._respond(sink, 502, _error_body(problem.code.value, problem.detail))
            return
        if not 200 <= status < 300:
            self._provider_error(response, status, reservation, started_ms, sink)
            return
        if headers.get("content-encoding", "identity").lower() != "identity":
            self.ledger.settle_unknown(reservation)
            self._trace_failed(started_ms, reservation)
            problem = LimitError(
                ErrorCode.DYNAMIC_ACCOUNTING_FAILED,
                "the model provider answered with an encoded body",
            )
            self.ledger.record_failure(problem)
            self._respond(sink, 502, _error_body(problem.code.value, problem.detail))
            return
        sse = headers.get("content-type", "").lower().startswith("text/event-stream")
        if sse:
            self._stream(response, admitted, reservation, started_ms, sink)
        else:
            self._document(response, status, reservation, started_ms, sink)

    def _forwarded_headers(self, response: UpstreamResponse) -> list[tuple[str, str]]:
        return [
            (name.lower(), self._redactor.redact(value.encode("utf-8")).decode("utf-8", "replace"))
            for name, value in response.headers
            if name.lower() in _RESPONSE_HEADERS and len(value) <= _MAX_HEADER_VALUE
        ]

    def _provider_error(
        self,
        response: UpstreamResponse,
        status: int,
        reservation: Reservation,
        started_ms: int,
        sink: ResponseSink,
    ) -> None:
        body, _ = self._read_bounded(response, self.ledger.limits.max_response_bytes)
        text = body.decode("utf-8", errors="replace")
        code = (
            ErrorCode.LLM_CONTEXT_LENGTH_EXCEEDED
            if is_context_length_exceeded(status, text)
            else llm_status_code(status) or ErrorCode.LLM_BAD_REQUEST
        )
        self.last_upstream_error = code
        # The engine retries these itself; any other refusal ends its turn, and so the run.
        if not (status in (408, 409, 429) or status >= 500):
            self.ledger.record_failure(LimitError(code, "the model provider refused the request"))
        # Refused before it generated anything: the call cost nothing.
        self.ledger.settle_unbilled(reservation)
        self._trace_failed(started_ms, reservation)
        # The provider's words reach the engine (its retry logic reads them) with the key cut out.
        redacted = self._redactor.redact(body)
        headers = self._forwarded_headers(response)
        try:
            sink.start(status, headers, len(redacted))
            sink.write(redacted)
            sink.end()
        except ClientGone:
            sink.abort()

    @staticmethod
    def _read_bounded(response: UpstreamResponse, limit: int) -> tuple[bytes, bool]:
        """At most `limit` bytes of the body. The flag is False when it ended early or ran past."""
        body = b""
        try:
            while len(body) <= limit:
                data = response.read(_READ_BYTES)
                if not data:
                    return body, True
                body += data
        except UpstreamError:
            return body, False
        return body[:limit], False

    def _document(
        self,
        response: UpstreamResponse,
        status: int,
        reservation: Reservation,
        started_ms: int,
        sink: ResponseSink,
    ) -> None:
        tap = tap_for(self._family, sse=False)
        limit = self.ledger.limits.max_response_bytes
        body = b""
        try:
            while True:
                data = response.read(_READ_BYTES)
                if not data:
                    break
                body += data
                if len(body) > limit:
                    self._too_large(reservation, started_ms, sink)
                    return
                tap.feed(data)
        except UpstreamError as error:
            self._cut(sink, error, reservation, started_ms)
            return
        result = tap.finish()
        redacted = self._redactor.redact(body)
        self._settle(result, reservation, started_ms)
        try:
            sink.start(status, self._forwarded_headers(response), len(redacted))
            sink.write(redacted)
            sink.end()
        except ClientGone:
            sink.abort()

    def _stream(
        self,
        response: UpstreamResponse,
        admitted: Admitted,
        reservation: Reservation,
        started_ms: int,
        sink: ResponseSink,
    ) -> None:
        tap: UsageTap = tap_for(self._family, sse=True)
        framer = SseFramer()
        limit = max(
            self.ledger.limits.max_stream_bytes,
            admitted.output_cap * _STREAM_BYTES_PER_OUTPUT_TOKEN,
        )
        total = 0
        try:
            sink.start(response.status, self._forwarded_headers(response), None)
            while True:
                if self.ledger.expired():
                    self._deadline(reservation, started_ms, sink)
                    return
                data = response.read(_READ_BYTES)
                if not data:
                    break
                total += len(data)
                if total > limit:
                    self._too_large(reservation, started_ms, sink)
                    return
                tap.feed(data)
                for event in framer.feed(data):
                    sink.write(self._redactor.redact(event))
            rest = framer.finish()
            if rest:
                sink.write(self._redactor.redact(rest))
        except UpstreamError as error:
            self._cut(sink, error, reservation, started_ms)
            return
        except ClientGone:
            # The engine went away: the call to the provider is cancelled (the caller closes it),
            # and what it would have cost is not known.
            self.ledger.settle_unknown(reservation)
            self._trace_failed(started_ms, reservation)
            sink.abort()
            return
        result = tap.finish()
        if not result.errored and not result.terminated:
            # A closed connection is no end of the answer: the engine sees a cut stream too.
            self.ledger.settle_unknown(reservation)
            self._trace_failed(started_ms, reservation)
            self.last_upstream_error = ErrorCode.LLM_UNAVAILABLE
            sink.abort()
            return
        self._settle(result, reservation, started_ms)
        sink.end()

    # -- settlement
    # -----------------------------------------------------------------------------------

    def _settle(self, result: TapResult, reservation: Reservation, started_ms: int) -> None:
        """Settle a call whose answer arrived whole."""
        if result.errored:
            # An error inside a 200: the status never showed it. The call failed and may have been
            # billed for what it generated; the engine retries it as a new call.
            self.ledger.settle_unknown(reservation)
            self._trace_failed(started_ms, reservation)
            self.last_upstream_error = ErrorCode.LLM_UNAVAILABLE
            return
        usage = result.usage
        if usage is None or not result.terminated:
            self.ledger.settle_unknown(reservation)
            self._trace_failed(started_ms, reservation)
            self.ledger.record_failure(
                LimitError(ErrorCode.DYNAMIC_ACCOUNTING_FAILED, "the provider did not report usage")
            )
            return
        cost = call_cost(usage, self._prices)
        # Noted before the settlement: a call the ledger then stops the run for is in the trace too.
        self.ledger.trace.model_call(
            t_ms=started_ms,
            prompt_tokens=usage.prompt_tokens,
            cache_read=usage.cache_read,
            cache_write=usage.cache_write,
            completion_tokens=usage.completion_tokens,
            cost=cost,
            finish_reason=None,
            final=reservation.final,
            tool_names=[],
        )
        try:
            self.ledger.settle_call(
                reservation,
                prompt_tokens=usage.prompt_tokens,
                completion_tokens=usage.completion_tokens,
                cost=cost,
                cache_read_tokens=usage.cache_read,
                cache_write_tokens=usage.cache_write,
            )
        except LimitError as error:
            self.ledger.record_failure(error)
            return
        self.cache_tally.add(
            {
                "prompt_tokens": usage.prompt_tokens,
                "cache_read_input_tokens": usage.cache_read,
                "cache_creation_input_tokens": usage.cache_write,
            }
        )

    def _trace_failed(self, started_ms: int, reservation: Reservation) -> None:
        """A call that gave no usable answer is in the trace with nothing known about it."""
        self.ledger.trace.model_call(
            t_ms=started_ms,
            prompt_tokens=None,
            cache_read=None,
            cache_write=None,
            completion_tokens=None,
            cost=None,
            finish_reason=None,
            final=reservation.final,
            tool_names=[],
        )

    def _cut(
        self, sink: ResponseSink, error: UpstreamError, reservation: Reservation, started_ms: int
    ) -> None:
        """The connection stopped mid-answer. The engine's is dropped the same way, and it retries
        the call as a whole new one."""
        self.ledger.settle_unknown(reservation)
        self._trace_failed(started_ms, reservation)
        self.last_upstream_error = (
            ErrorCode.LLM_TIMEOUT
            if error.kind is UpstreamFailure.TIMEOUT
            else ErrorCode.LLM_UNAVAILABLE
        )
        sink.abort()

    def _too_large(self, reservation: Reservation, started_ms: int, sink: ResponseSink) -> None:
        self.ledger.settle_unknown(reservation)
        self._trace_failed(started_ms, reservation)
        self.ledger.record_failure(
            LimitError(
                ErrorCode.DYNAMIC_BUDGET_EXCEEDED, "the response exceeds the protocol byte bound"
            )
        )
        sink.abort()

    def _deadline(self, reservation: Reservation, started_ms: int, sink: ResponseSink) -> None:
        self.ledger.settle_unknown(reservation)
        self._trace_failed(started_ms, reservation)
        self.ledger.record_failure(
            LimitError(ErrorCode.DYNAMIC_BUDGET_EXCEEDED, "the whole-job deadline was reached")
        )
        sink.abort()
