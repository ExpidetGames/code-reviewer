# SPDX-License-Identifier: Apache-2.0

"""Round 2 of the security review of the passthrough proxy (#550): the smaller holes.

An exception after the request was sent must end the run with a code that says why; a status-only
5xx is unbilled only when it really looks like one; the engine does not choose the content type the
provider sees; an error event is replaced by a fixed one of ours; every read is bounded by the time
the job has left; and the drain after a hang-up reads to the end of the answer.
"""

import json
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
    failing,
    rig,
    streamed,
)

from code_reviewer_runner.dynamic_review.budget import DynamicLimits
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily
from code_reviewer_runner.dynamic_review.passthrough.pricing import call_cost
from code_reviewer_runner.dynamic_review.passthrough.proxy import fixed_error_event
from code_reviewer_runner.dynamic_review.passthrough.usage import is_error_event
from code_reviewer_runner.result import ErrorCode
from passthrough_expect import usage_expected

FAMILIES = list(WireFamily)
DEEP = 30_000


def worst_case(body_bytes: int, output_cap: int = 1000) -> Decimal:
    return PRICES.of_call(body_bytes, output_cap, cache_in_use=True)


def spent(ledger: object) -> Decimal:
    return ledger._counters.cost  # type: ignore[attr-defined]  # pyright: ignore


def deep_event() -> bytes:
    """An event whose JSON is nested far deeper than the parser's recursion limit."""
    nested = "[" * DEEP + "]" * DEEP
    data = '{"candidates":[{"content":{"parts":[{"functionCall":{"name":"x","args":' + nested
    return ("data: " + data + "}}]}}]}\n\n").encode()


# -- S1: an exception after the request was sent --------------------------------------------------


# #550-R2-S1
def test_an_event_nested_too_deep_to_parse_is_unreadable_not_a_crash() -> None:
    assert is_error_event(deep_event()) is False
    assert is_error_event(b"event: error\ndata: " + b"[" * DEEP + b"\n\n") is True


# #550-R2-S1
@pytest.mark.parametrize("family", FAMILIES)
def test_an_event_nested_30000_deep_goes_through_and_the_call_is_still_settled(
    family: WireFamily,
) -> None:
    events = stream(FAKE[family], TURN, 1, MODEL)
    events.insert(1, deep_event())
    r = rig(family, Scripted(chunks=events))
    sink = r.post()
    assert sink.body == b"".join(events) and sink.ended
    cost = call_cost(usage_expected(1, family), PRICES)
    assert r.ledger.usage(MODEL).cost_usd == pytest.approx(float(cost or 0))
    assert r.ledger.failure is None


# #550-R2-S1
def test_a_document_nested_too_deep_to_parse_is_a_call_without_usage() -> None:
    family = WireFamily.GOOGLE
    body = ('{"candidates":[' + "[" * DEEP + "]" * DEEP + "]}").encode()
    r = rig(family, Scripted(headers=[("content-type", "application/json")], chunks=[body]))
    sink = r.post()
    assert sink.ended
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED


# #550-R2-S1
@pytest.mark.parametrize("family", FAMILIES)
def test_an_exception_after_the_request_was_sent_books_the_call_and_ends_the_run_with_a_code(
    family: WireFamily,
) -> None:
    events = stream(FAKE[family], TURN, 1, MODEL)
    r = rig(family, Scripted(chunks=[events[0], RuntimeError("a bug")]))
    body = r.body()
    sink = r.post(body)  # does not raise: the server would have answered runner_error
    assert sink.aborted
    assert spent(r.ledger) == worst_case(len(body))
    assert r.ledger.unknown_calls == 1
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED


# #550-R2-S1
def test_an_exception_after_the_call_was_settled_does_not_settle_it_twice() -> None:
    family = WireFamily.OPENAI_CHAT

    class Breaks(MemorySink):
        def end(self) -> None:
            raise RuntimeError("a bug in the sink")

    r = rig(family, streamed(family, 2))
    sink = Breaks(r.upstream.timeline)
    r.post(sink=sink)
    cost = call_cost(usage_expected(2, family), PRICES)
    assert spent(r.ledger) == cost
    assert r.ledger.unknown_calls == 0
    assert r.ledger.failure is None
    assert sink.aborted


# -- S3: when a 5xx is unbilled --------------------------------------------------------------------


def server_error(family: WireFamily, status: int, body: bytes, content_type: str) -> Scripted:
    return Scripted(status=status, headers=[("content-type", content_type)], chunks=[body])


def book(r: object) -> tuple[Decimal, int]:
    return spent(r.ledger), r.ledger.unknown_calls  # type: ignore[attr-defined]  # pyright: ignore


# #550-R2-S3
@pytest.mark.parametrize("status", [500, 502, 503, 529])
def test_a_status_within_15_seconds_without_a_usage_object_is_unbilled(status: int) -> None:
    family = WireFamily.ANTHROPIC_MESSAGES
    r = rig(family, failing(family, status))
    r.upstream._on_send = lambda: r.clock.__setitem__(0, 14.9)  # pyright: ignore
    r.post()
    assert book(r) == (0, 0)
    assert r.ledger.failure is None


# #550-R2-S3
def test_a_status_that_took_longer_than_15_seconds_is_unknown() -> None:
    family = WireFamily.ANTHROPIC_MESSAGES
    r = rig(family, failing(family, 503))
    r.upstream._on_send = lambda: r.clock.__setitem__(0, 15.5)  # pyright: ignore
    body = r.body()
    r.post(body)
    assert book(r) == (worst_case(len(body)), 1)
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED


# #550-R2-S3
@pytest.mark.parametrize("status", [500, 503])
def test_a_5xx_that_is_an_event_stream_is_unknown(status: int) -> None:
    family = WireFamily.OPENAI_CHAT
    r = rig(family, server_error(family, status, b'data: {"error": {}}\n\n', "text/event-stream"))
    body = r.body()
    r.post(body)
    assert book(r) == (worst_case(len(body)), 1)


# #550-R2-S3
@pytest.mark.parametrize(
    "body",
    [
        b'{"error": {"message": "x"}, "usage": {"input_tokens": 10, "output_tokens": 0}}',
        b'{"usageMetadata": {"promptTokenCount": 10}}',
        b'{"response": {"usage": {"input_tokens": 3}}}',
        b"<html>billed usage: 10 tokens</html>",
    ],
)
def test_a_5xx_whose_body_has_a_usage_object_is_unknown(body: bytes) -> None:
    family = WireFamily.OPENAI_CHAT
    r = rig(family, server_error(family, 502, body, "application/json"))
    request = r.body()
    r.post(request)
    assert book(r) == (worst_case(len(request)), 1)


# #550-R2-S3
def test_a_5xx_with_a_body_that_is_longer_than_the_bound_is_unknown() -> None:
    family = WireFamily.OPENAI_CHAT
    limits = DynamicLimits(max_response_bytes=500, max_cost_usd=Decimal(5))
    r = rig(family, server_error(family, 503, b"x" * 2000, "text/html"), limits=limits)
    request = r.body()
    r.post(request)
    assert book(r) == (worst_case(len(request)), 1)


# #550-R2-S3
def test_a_5xx_page_of_a_gateway_without_a_usage_object_is_unbilled() -> None:
    family = WireFamily.OPENAI_CHAT
    r = rig(family, server_error(family, 502, b"<html>Bad Gateway</html>", "text/html"))
    r.post()
    assert book(r) == (0, 0)


# -- N6: a status below 200 ----------------------------------------------------------------------


# #550-R2-N6
@pytest.mark.parametrize("status", [101, 103, 199])
def test_a_status_below_200_is_unknown(status: int) -> None:
    family = WireFamily.OPENAI_CHAT
    r = rig(family, Scripted(status=status, headers=[], chunks=[b""]))
    body = r.body()
    r.post(body)
    assert book(r) == (worst_case(len(body)), 1)


# -- S5: the content type is ours ---------------------------------------------------------------


# #550-R2-S5
@pytest.mark.parametrize("family", FAMILIES)
@pytest.mark.parametrize(
    "sent",
    [
        "application/json; charset=utf-8",
        "application/json; boundary=x; a=b",
        "APPLICATION/JSON",
        None,
    ],
)
def test_the_provider_sees_application_json_whatever_the_engine_sent(
    family: WireFamily, sent: str | None
) -> None:
    r = rig(family, streamed(family))
    headers = [h for h in r.headers() if h[0].lower() != "content-type"]
    if sent is not None:
        headers.append(("Content-Type", sent))
    r.post(headers=headers)
    assert r.upstream.requests[0].headers["content-type"] == "application/json"


# -- N3: a fixed error event --------------------------------------------------------------------


# #550-R2-N3
@pytest.mark.parametrize("family", FAMILIES)
def test_an_error_event_in_a_200_stream_is_replaced_by_a_fixed_event_of_ours(
    family: WireFamily,
) -> None:
    provider_says = f"overloaded; your pull request says {REAL_KEY[:20]}"
    events = stream(FAKE[family], TURN, 1, MODEL)[:2]
    events.append(error_event(FAKE[family], provider_says))
    r = rig(family, Scripted(chunks=events))
    sink = r.post()
    fixed = fixed_error_event(family)
    assert sink.body == b"".join(events[:2]) + fixed
    assert is_error_event(fixed)
    assert b"overloaded" not in sink.body[len(b"".join(events[:2])) :]
    assert REAL_KEY[:12].encode() not in sink.body
    assert r.ledger.unknown_calls == 1


# #550-R2-N3
def test_a_fixed_event_is_the_same_whatever_the_provider_wrote() -> None:
    family = WireFamily.ANTHROPIC_MESSAGES
    seen: list[bytes] = []
    for words in ("one", "two " * 300):
        events = [*stream(FAKE[family], TURN, 1, MODEL)[:2], error_event(FAKE[family], words)]
        seen.append(rig(family, Scripted(chunks=events)).post().body)
    assert seen[0] == seen[1]


# #550-R2-N3
def test_a_200_document_that_is_an_error_is_replaced_too() -> None:
    family = WireFamily.OPENAI_CHAT
    body = json.dumps({"error": {"message": f"bad key {REAL_KEY}", "type": "x"}}).encode()
    r = rig(family, Scripted(headers=[("content-type", "application/json")], chunks=[body]))
    sink = r.post()
    assert REAL_KEY.encode() not in sink.body and b"bad key" not in sink.body
    assert json.loads(sink.body)["error"]["message"]


# -- N4: every read is bounded by the time the job has left --------------------------------------


# #550-R2-N4
def test_every_read_of_a_stream_gets_the_time_the_job_has_left() -> None:
    family = WireFamily.OPENAI_CHAT
    events = stream(FAKE[family], TURN, 1, MODEL)
    r = rig(
        family,
        Scripted(chunks=[events[0], lambda: r.clock.__setitem__(0, 20.0), *events[1:]]),
        deadline=30.0,
    )
    r.post()
    timeouts = r.upstream.responses[0].read_timeouts
    assert timeouts[0] == 30.0
    # The read that ran the clock forward still had the old time; every one after has the new.
    assert all(t is not None and t <= 10.0 for t in timeouts[2:])


# #550-R2-N4
def test_every_read_of_a_document_and_of_an_error_body_gets_the_time_left() -> None:
    family = WireFamily.OPENAI_CHAT
    body = json.dumps({"id": "x", "usage": {"prompt_tokens": 1, "completion_tokens": 1}}).encode()
    r = rig(
        family,
        Scripted(
            headers=[("content-type", "application/json")],
            chunks=[body[:10], lambda: r.clock.__setitem__(0, 25.0), body[10:]],
        ),
        deadline=30.0,
    )
    r.post()
    timeouts = r.upstream.responses[0].read_timeouts
    assert timeouts[0] == 30.0 and all(t is not None and t <= 5.0 for t in timeouts[2:])
    r = rig(family, failing(family, 400), deadline=30.0)
    r.post()
    assert all(t == 30.0 for t in r.upstream.responses[0].read_timeouts)


# #550-R2-N4
def test_a_read_never_gets_more_than_the_budget_of_a_call() -> None:
    family = WireFamily.OPENAI_CHAT
    r = rig(family, streamed(family), deadline=600.0)
    r.post()
    assert set(r.upstream.responses[0].read_timeouts) == {120.0}


# -- N5: the drain reads to the end --------------------------------------------------------------


# #550-R2-N5
def test_after_a_hang_up_the_answer_is_read_to_its_end() -> None:
    family = WireFamily.OPENAI_CHAT
    answer = streamed(family, 3)
    r = rig(family, answer)
    r.post(sink=MemorySink(r.upstream.timeline, gone_after=1))
    # Every chunk, and the read that finds the end.
    assert r.upstream.responses[0].reads == len(answer.chunks) + 1
