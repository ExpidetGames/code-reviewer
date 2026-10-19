# SPDX-License-Identifier: Apache-2.0

"""The relay of the passthrough proxy with the ledger around it (#550).

What goes out is the engine's request, byte for byte, with the one real key in the one header of the
family; what comes back is the provider's answer, byte for byte, event by event as it arrives, while
the tee reads the usage. Every call, the engine's retries included, is reserved before it is sent
and settled after it, and nothing the provider says about an error reaches the engine with the key
in it.
"""

import hashlib
import logging
import sys
from decimal import Decimal
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fakes.wire.formats import error_event, stream
from passthrough_support import (
    FAKE,
    MODEL,
    PRICES,
    REAL_KEY,
    TURN,
    MemorySink,
    Scripted,
    document,
    failing,
    real_key_header,
    rig,
    streamed,
)

from code_reviewer_runner.dynamic_review.budget import DynamicLimits, UnitCosts
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily, spec_of
from code_reviewer_runner.dynamic_review.passthrough.pricing import call_cost
from code_reviewer_runner.dynamic_review.passthrough.upstream import UpstreamError, UpstreamFailure
from code_reviewer_runner.dynamic_review.passthrough.usage import CallUsage
from code_reviewer_runner.result import ErrorCode
from passthrough_expect import usage_expected

FAMILIES = list(WireFamily)


def cost_of(call: int, family: WireFamily) -> Decimal:
    cost = call_cost(usage_expected(call, family), PRICES)
    assert cost is not None
    return cost


# #550-T01
@pytest.mark.parametrize("family", FAMILIES)
def test_a_request_without_the_capability_is_answered_401_and_nothing_is_forwarded(
    family: WireFamily,
) -> None:
    r = rig(family, streamed(family))
    sink = r.post(headers=r.headers(capability="not-the-capability"))
    assert sink.status == 401
    assert r.upstream.requests == []
    assert r.ledger.model_calls == 0
    # A caller that proved nothing does not end the run of the job.
    assert r.ledger.failure is None


# #550-T02
@pytest.mark.parametrize("family", FAMILIES)
def test_the_upstream_gets_the_real_key_in_the_header_of_the_family_and_nothing_else(
    family: WireFamily,
) -> None:
    r = rig(family, streamed(family))
    smuggled = [
        ("Authorization", "Bearer smuggled"),
        ("x-api-key", "smuggled"),
        ("Cookie", "a=smuggled"),
        ("Proxy-Authorization", "Basic smuggled"),
    ]
    # Credentials for the other families ride along; the family's own header is not given twice.
    headers = r.headers(*[h for h in smuggled if h[0].lower() != spec_of(family).key_header])
    body = r.body()
    sink = r.post(body, headers=headers)
    assert sink.status == 200
    sent = r.upstream.requests[0]
    assert sent.headers[spec_of(family).key_header] == real_key_header(family)
    assert sent.headers["accept-encoding"] == "identity"
    names = {name.lower() for name in sent.headers}
    credentials = {"authorization", "x-api-key", "x-goog-api-key"} - {spec_of(family).key_header}
    assert not credentials & names and "cookie" not in names
    assert r.capability not in "".join(sent.headers.values())
    assert "smuggled" not in "".join(sent.headers.values())
    assert hashlib.sha256(sent.body).hexdigest() == hashlib.sha256(body).hexdigest()
    assert sent.path == spec_of(family).upstream_path(MODEL)


# #550-T03
def test_only_a_few_headers_of_the_answer_reach_the_engine() -> None:
    family = WireFamily.OPENAI_CHAT
    answer = streamed(family)
    answer.headers = [
        ("content-type", "text/event-stream"),
        ("retry-after", "3"),
        ("set-cookie", "session=abc"),
        ("x-evil", "1"),
        ("server", "provider"),
        ("content-length", "999"),
        ("transfer-encoding", "chunked"),
        ("x-request-id", "req_1"),
    ]
    r = rig(family, answer)
    sink = r.post()
    names = {name.lower() for name, _ in sink.headers}
    assert names == {"content-type", "retry-after", "x-request-id"}


# #550-T08
@pytest.mark.parametrize("family", FAMILIES)
def test_a_stream_reaches_the_engine_event_by_event_and_byte_for_byte(family: WireFamily) -> None:
    answer = streamed(family, call=3)
    r = rig(family, answer)
    sink = r.post()
    assert sink.status == 200 and sink.ended and not sink.aborted
    assert sink.length is None  # a stream is handed on without a length
    assert sink.body == b"".join(c for c in answer.chunks if isinstance(c, bytes))
    # The first event is with the engine before the last one is read from the provider.
    timeline = r.upstream.timeline
    assert timeline.index("write:1") < max(
        i for i, e in enumerate(timeline) if e.startswith("read:")
    )
    # The tee read the usage and the ledger settled the call at its price.
    usage = r.ledger.usage(MODEL)
    assert (usage.ai_calls, usage.prompt_tokens, usage.completion_tokens) == (
        1,
        usage_expected(3, family).prompt_tokens,
        usage_expected(3, family).completion_tokens,
    )
    assert usage.cost_usd == pytest.approx(float(cost_of(3, family)))
    assert r.ledger.failure is None


# #550-T08
@pytest.mark.parametrize("family", FAMILIES)
def test_a_plain_answer_is_relayed_with_its_length_and_settled(family: WireFamily) -> None:
    r = rig(family, document(family, call=2))
    sink = r.post()
    assert sink.status == 200 and sink.ended
    assert sink.length == len(sink.body)
    usage = r.ledger.usage(MODEL)
    assert usage.cost_usd == pytest.approx(float(cost_of(2, family)))


# #550-T08
def test_a_second_call_is_reserved_from_what_the_first_one_showed() -> None:
    family = WireFamily.ANTHROPIC_MESSAGES
    reserved: list[Decimal] = []
    r = rig(family, streamed(family, 1), streamed(family, 2))
    r.upstream._on_send = lambda: reserved.append(  # pyright: ignore[reportPrivateUsage]
        r.ledger._counters.reserved_cost  # pyright: ignore[reportPrivateUsage]
    )
    r.post()
    r.post()
    # The call is reserved before it is sent, and the realistic guard prices the second one from
    # the first (the prompt it settled on), not from the bytes alone.
    assert reserved[0] > 0 and reserved[1] > 0
    assert reserved[0] != reserved[1]
    assert r.ledger._counters.reserved_cost == 0  # pyright: ignore[reportPrivateUsage]


# #550-T06
def test_an_answer_without_usage_stops_the_run() -> None:
    family = WireFamily.OPENAI_CHAT
    r = rig(family, streamed(family, include_usage=False))
    sink = r.post()
    assert sink.status == 200 and sink.ended
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED


# #550-T06
def test_a_call_that_cannot_be_priced_stops_the_run() -> None:
    # The provider reports cache writes and the job has no write price.
    family = WireFamily.ANTHROPIC_MESSAGES
    plain = UnitCosts(
        input_usd_per_mtok=PRICES.input_usd_per_mtok, output_usd_per_mtok=PRICES.output_usd_per_mtok
    )
    r = rig(family, streamed(family), prices=plain)
    r.post()
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED
    assert r.ledger.usage(MODEL).cost_usd is None


# #550-T06
def test_an_answer_that_is_encoded_is_refused_because_its_usage_cannot_be_read() -> None:
    family = WireFamily.OPENAI_CHAT
    answer = streamed(family)
    answer.headers.append(("content-encoding", "gzip"))
    r = rig(family, answer)
    sink = r.post()
    assert sink.status == 502
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED


# #550-T07
def test_a_redirect_is_not_followed_and_ends_the_run() -> None:
    family = WireFamily.OPENAI_CHAT
    redirect = Scripted(status=307, headers=[("location", "https://evil.example/")], chunks=[b""])
    r = rig(family, redirect)
    sink = r.post()
    assert sink.status == 502
    assert b"evil.example" not in sink.everything()
    assert len(r.upstream.requests) == 1
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_POLICY_VIOLATION


# #550-T09
@pytest.mark.parametrize("family", FAMILIES)
def test_a_cut_stream_cuts_the_engine_and_is_held_as_spent_not_given_back(
    family: WireFamily,
) -> None:
    events = stream(FAKE[family], TURN, 1, MODEL)
    cut = Scripted(chunks=[*events[:2], UpstreamError(UpstreamFailure.CUT, sent=True)])
    r = rig(family, cut)
    sink = r.post()
    assert sink.aborted and not sink.ended
    assert sink.body == b"".join(events[:2])
    # The engine retries it as a new call, so the run goes on; its cost is unknown from here on.
    assert r.ledger.failure is None
    usage = r.ledger.usage(MODEL)
    assert usage.ai_calls == 1 and usage.cost_usd is None
    assert r.proxy.last_upstream_error is ErrorCode.LLM_UNAVAILABLE
    assert r.upstream.responses[0].closed


# #550-T09
@pytest.mark.parametrize("family", FAMILIES)
def test_an_error_inside_a_200_stream_is_a_failed_call(family: WireFamily) -> None:
    events = [*stream(FAKE[family], TURN, 1, MODEL)[:2], error_event(FAKE[family])]
    r = rig(family, Scripted(chunks=events))
    sink = r.post()
    assert sink.status == 200 and sink.ended
    assert sink.body == b"".join(events)  # the engine sees the error, as it does from a provider
    assert r.ledger.failure is None
    assert r.ledger.usage(MODEL).cost_usd is None
    assert r.proxy.last_upstream_error is ErrorCode.LLM_UNAVAILABLE


# #550-T09
def test_a_stream_that_closes_before_its_last_event_is_cut_for_the_engine() -> None:
    family = WireFamily.ANTHROPIC_MESSAGES
    r = rig(family, Scripted(chunks=stream("messages", TURN, 1, MODEL)[:4]))
    sink = r.post()
    assert sink.aborted and not sink.ended


# #550-T09
@pytest.mark.parametrize("family", FAMILIES)
def test_an_engine_that_goes_away_cancels_the_call_to_the_provider(family: WireFamily) -> None:
    r = rig(family, streamed(family))
    sink = MemorySink(r.upstream.timeline, gone_after=1)
    r.post(sink=sink)
    assert r.upstream.responses[0].closed
    assert sink.aborted
    assert len(sink.chunks) < len(streamed(family).chunks)
    assert r.ledger.usage(MODEL).cost_usd is None


# #550-T10
def test_the_retries_of_the_engine_are_calls_of_their_own_in_the_ledger() -> None:
    family = WireFamily.OPENAI_CHAT
    r = rig(
        family,
        failing(family, 429, retry_after="2"),
        failing(family, 500),
        failing(family, 529),
        streamed(family, 4),
    )
    statuses = [r.post().status for _ in range(4)]
    assert statuses == [429, 500, 529, 200]
    usage = r.ledger.usage(MODEL)
    assert usage.ai_calls == 4
    # A refusal costs nothing; only the answered call has a price.
    assert usage.cost_usd == pytest.approx(float(cost_of(4, family)))
    assert r.ledger.failure is None
    assert [len(r.upstream.requests)] == [4]


# #550-T10
@pytest.mark.parametrize(
    ("status", "code", "ends_the_run"),
    [
        (401, ErrorCode.LLM_AUTH, True),
        (403, ErrorCode.LLM_AUTH, True),
        (402, ErrorCode.LLM_QUOTA, True),
        (404, ErrorCode.MODEL_UNKNOWN, True),
        (400, ErrorCode.LLM_BAD_REQUEST, True),
        (422, ErrorCode.LLM_BAD_REQUEST, True),
        (429, ErrorCode.LLM_RATE_LIMIT, False),
        (500, ErrorCode.LLM_UNAVAILABLE, False),
        (503, ErrorCode.LLM_UNAVAILABLE, False),
        (529, ErrorCode.LLM_UNAVAILABLE, False),
    ],
)
def test_a_provider_error_gets_a_stable_code_and_keeps_its_status_for_the_engine(
    status: int, code: ErrorCode, ends_the_run: bool
) -> None:
    family = WireFamily.ANTHROPIC_MESSAGES
    r = rig(family, failing(family, status, "provider words about the pull request"))
    sink = r.post()
    assert sink.status == status
    assert r.proxy.last_upstream_error is code
    assert (r.ledger.failure is not None) is ends_the_run
    if r.ledger.failure is not None:
        assert r.ledger.failure.code is code
        assert "provider words" not in r.ledger.failure.detail


# #550-T10
def test_a_request_that_is_larger_than_the_context_has_a_code_of_its_own() -> None:
    family = WireFamily.OPENAI_CHAT
    body = b'{"error": {"code": "context_length_exceeded", "message": "too long"}}'
    r = rig(
        family, Scripted(status=400, headers=[("content-type", "application/json")], chunks=[body])
    )
    r.post()
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.LLM_CONTEXT_LENGTH_EXCEEDED


# #550-T10
@pytest.mark.parametrize(
    ("failure", "status", "code", "settled_free"),
    [
        (UpstreamError(UpstreamFailure.TIMEOUT, sent=True), 504, ErrorCode.LLM_TIMEOUT, False),
        (UpstreamError(UpstreamFailure.CUT, sent=True), 502, ErrorCode.LLM_UNAVAILABLE, False),
        (UpstreamError(UpstreamFailure.UNREACHABLE), 502, ErrorCode.LLM_UNAVAILABLE, True),
    ],
)
def test_a_call_without_an_answer_is_a_5xx_the_engine_may_retry(
    failure: UpstreamError, status: int, code: ErrorCode, settled_free: bool
) -> None:
    family = WireFamily.OPENAI_CHAT
    r = rig(family, Scripted(fails=failure))
    sink = r.post()
    assert sink.status == status
    assert r.proxy.last_upstream_error is code
    assert r.ledger.failure is None
    usage = r.ledger.usage(MODEL)
    # A call that never left costs nothing; one that did may have been billed.
    assert usage.cost_usd == (0.0 if settled_free else None)


# #550-T10
def test_a_destination_that_is_not_public_ends_the_run() -> None:
    family = WireFamily.OPENAI_CHAT
    r = rig(family, Scripted(fails=UpstreamError(UpstreamFailure.ADDRESS_REFUSED)))
    sink = r.post()
    assert sink.status == 502
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_POLICY_VIOLATION


# #550-T10
@pytest.mark.parametrize("family", FAMILIES)
def test_an_error_body_that_quotes_the_key_reaches_the_engine_redacted(
    family: WireFamily, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    quoting = failing(family, 401, f"(key: {REAL_KEY}) Bearer {REAL_KEY[:14]}...{REAL_KEY[-9:]}")
    r = rig(family, quoting)
    sink = r.post()
    assert sink.status == 401
    wire = sink.everything()
    assert REAL_KEY.encode() not in wire
    assert REAL_KEY[:12].encode() not in wire and REAL_KEY[-9:].encode() not in wire
    assert b"[redacted]" in wire
    assert sink.length == len(sink.body)
    assert r.ledger.failure is not None
    assert REAL_KEY[:12] not in r.ledger.failure.detail
    assert REAL_KEY[:12] not in caplog.text


# #550-T10
@pytest.mark.parametrize("family", FAMILIES)
def test_an_error_event_that_quotes_the_key_is_redacted_in_the_stream(
    family: WireFamily,
) -> None:
    events = stream(FAKE[family], TURN, 1, MODEL)[:2]
    events.append(error_event(FAKE[family], f"invalid key {REAL_KEY}"))
    r = rig(family, Scripted(chunks=events))
    sink = r.post()
    assert REAL_KEY.encode() not in sink.body
    assert REAL_KEY[:12].encode() not in sink.body
    assert b"[redacted]" in sink.body
    # What the engine got of the events before it is unchanged.
    assert sink.body.startswith(b"".join(events[:2]))


# #550-T11
def test_a_request_that_is_too_large_is_refused_before_its_body_is_read() -> None:
    family = WireFamily.OPENAI_CHAT
    limits = DynamicLimits(max_request_bytes=2000)
    r = rig(family, streamed(family), limits=limits)
    read: list[int] = []
    headers = [*r.headers(), ("Content-Length", "5000")]
    sink = MemorySink()
    r.proxy.handle("POST", r.target(), headers, lambda n: read.append(n) or b"", sink)
    assert sink.status == 413
    assert read == [] and r.upstream.requests == []
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED


# #550-T11
def test_an_answer_larger_than_its_bound_is_cut_and_ends_the_run() -> None:
    family = WireFamily.OPENAI_CHAT
    limits = DynamicLimits(max_response_bytes=500, max_stream_bytes=500)
    big = Scripted(
        headers=[("content-type", "application/json")], chunks=[b'{"x": "' + b"y" * 600 + b'"}']
    )
    r = rig(family, big, limits=limits)
    sink = r.post()
    assert sink.aborted
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    streaming = Scripted(chunks=[b"data: " + b"y" * 300 + b"\n\n"] * 3)
    r = rig(family, streaming, limits=limits)
    # The bound of a stream grows with the output the request asks for; this one asks for 1 token.
    sink = r.post(r.body(max_tokens=1))
    assert sink.aborted
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED


# #550-T11
def test_the_timeout_of_a_call_is_the_time_the_job_has_left() -> None:
    family = WireFamily.OPENAI_CHAT
    r = rig(family, streamed(family), deadline=30.0)
    r.post()
    assert r.upstream.timeouts == [30.0]
    r = rig(family, streamed(family), deadline=600.0)
    r.post()
    assert r.upstream.timeouts == [120.0]


# #550-T11
def test_a_job_whose_deadline_has_passed_makes_no_call() -> None:
    family = WireFamily.OPENAI_CHAT
    r = rig(family, streamed(family), deadline=10.0)
    r.clock[0] = 11.0
    sink = r.post()
    assert sink.status == 403
    assert r.upstream.requests == []
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED


# #550-T11
def test_a_stream_that_outlives_the_deadline_is_cut() -> None:
    family = WireFamily.OPENAI_CHAT
    r = rig(family, streamed(family), deadline=10.0)
    r.upstream._on_send = lambda: r.clock.__setitem__(0, 11.0)  # pyright: ignore[reportPrivateUsage]
    sink = r.post()
    assert sink.aborted
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED


# #550-T11
def test_the_cost_guard_refuses_a_call_the_limit_cannot_hold_and_ends_the_run() -> None:
    family = WireFamily.OPENAI_CHAT
    r = rig(family, streamed(family), limit="0.01")
    sink = r.post()
    assert sink.status == 403
    assert r.upstream.requests == []
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED


# #550-T11
def test_a_run_that_was_superseded_makes_no_new_call() -> None:
    family = WireFamily.OPENAI_CHAT
    r = rig(family, streamed(family), superseded=lambda: True)
    sink = r.post()
    assert sink.status == 403
    assert r.upstream.requests == []
    assert r.ledger.model_calls == 0


# #550-T16
@pytest.mark.parametrize("family", FAMILIES)
def test_the_key_is_in_nothing_the_engine_is_told(family: WireFamily) -> None:
    quoted = f"key {REAL_KEY}"
    answers = [
        streamed(family),
        document(family),
        failing(family, 401, quoted),
        failing(family, 500, quoted),
        Scripted(status=307, headers=[("location", f"https://x/{REAL_KEY}")], chunks=[b""]),
    ]
    r = rig(family, *answers)
    seen = b""
    for _ in answers:
        seen += r.post().everything()
    seen += r.post(headers=r.headers(capability="wrong")).everything()
    seen += r.post(target="/v1/other").everything()
    assert REAL_KEY.encode() not in seen
    assert CallUsage  # the tap's usage type is part of the surface under test
