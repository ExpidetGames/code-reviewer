# SPDX-License-Identifier: Apache-2.0

"""A hostile engine against the relay (#550, B2/B3/B4 and the settlement of errors).

The engine is driven by an untrusted model. These tests are the three things such an engine tries
that the relay must not allow:

- **B2, redaction as an oracle.** If the proxy cuts the real key out of what the provider answers,
  an engine that writes guesses of the key into its output sees the cut where the guess is right.
  So an answer is never changed; what the provider says about an error is not passed on at all.
- **B3, hiding a cost by hanging up.** A call whose usage is never read is booked at its worst
  case, and an engine that disconnects does not make the usage unreadable: the proxy keeps reading.
- **B4, parallel calls.** At most one call is in flight; a second one is refused at once.
"""

import json
import sys
import threading
from decimal import Decimal
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fakes.wire.formats import Turn, stream
from passthrough_support import (
    FAKE,
    MODEL,
    PRICES,
    REAL_KEY,
    TURN,
    MemorySink,
    Scripted,
    ScriptedResponse,
    failing,
    rig,
    streamed,
)

from code_reviewer_runner.dynamic_review.budget import DynamicLimits, LimitError
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily
from code_reviewer_runner.dynamic_review.passthrough.pricing import call_cost
from code_reviewer_runner.dynamic_review.passthrough.redact import Redactor
from code_reviewer_runner.dynamic_review.passthrough.upstream import (
    UpstreamError,
    UpstreamFailure,
    UpstreamRequest,
)
from code_reviewer_runner.result import ErrorCode
from passthrough_expect import usage_expected

FAMILIES = list(WireFamily)
GUESSES = [REAL_KEY, REAL_KEY[:14], REAL_KEY[-9:], REAL_KEY[3:20], REAL_KEY[:8]]


def worst_case(body_bytes: int, output_cap: int = 1000) -> Decimal:
    """The most a call can cost: the bytes of the request as tokens at the dearest input price, and
    the whole output cap."""
    return PRICES.of_call(body_bytes, output_cap, cache_in_use=True)


def spent(r_ledger: object) -> Decimal:
    return r_ledger._counters.cost  # type: ignore[attr-defined]  # pyright: ignore[reportAttributeAccessIssue, reportUnknownMemberType, reportUnknownVariableType]


# -- B2: no oracle ----


# #550-B2-O01
@pytest.mark.parametrize("family", FAMILIES)
def test_a_stream_whose_text_repeats_parts_of_the_key_comes_back_unchanged(
    family: WireFamily,
) -> None:
    """The PoC of the review: the model writes guesses of the key into its output. If a guess is
    cut out, the engine can tell a right one from a wrong one, one run after the other."""
    turn = Turn(text=" ".join(GUESSES))
    events = stream(FAKE[family], turn, 1, MODEL)
    r = rig(family, Scripted(chunks=events))
    sink = r.post()
    assert sink.body == b"".join(events)
    assert b"[redacted]" not in sink.body
    assert r.ledger.failure is None


# #550-B2-O01
@pytest.mark.parametrize("family", FAMILIES)
def test_a_plain_answer_that_repeats_parts_of_the_key_comes_back_unchanged(
    family: WireFamily,
) -> None:
    import fakes.wire.formats as formats

    body = json.dumps(formats.answer(FAKE[family], Turn(text=" ".join(GUESSES)), 2, MODEL)).encode()
    answer = Scripted(headers=[("content-type", "application/json")], chunks=[body])
    r = rig(family, answer)
    sink = r.post()
    assert sink.body == body


# #550-B2-O01
def test_an_answer_with_a_right_guess_and_one_with_a_wrong_guess_look_the_same() -> None:
    family = WireFamily.OPENAI_CHAT
    wrong = "sk-fake-key-" + REAL_KEY.split("sk-real-key-")[1]
    assert len(wrong) == len(REAL_KEY) and wrong != REAL_KEY
    seen: list[bytes] = []
    for guess in (REAL_KEY, wrong):
        events = stream(FAKE[family], Turn(text=guess), 1, MODEL)
        r = rig(family, Scripted(chunks=events))
        seen.append(r.post().body)
    # Same length, no cut in either: nothing tells the engine which guess was right.
    assert len(seen[0]) == len(seen[1])
    assert b"[redacted]" not in seen[0] + seen[1]


# #550-B2-O02
@pytest.mark.parametrize("status", [400, 401, 403, 404, 422, 429, 500, 503, 529])
@pytest.mark.parametrize("family", FAMILIES)
def test_what_the_provider_says_about_an_error_does_not_reach_the_engine(
    family: WireFamily, status: int
) -> None:
    words = f"(key: {REAL_KEY}) the field {GUESSES[3]} in your pull request is not valid"
    r = rig(family, failing(family, status, words, **{"retry-after": "7"}))
    sink = r.post()
    wire = sink.everything()
    assert sink.status == status
    for secret in (*GUESSES, b"pull request", b"fake upstream"):
        raw = secret if isinstance(secret, bytes) else secret.encode()
        assert raw not in wire
    # Our own, stable text: a code and a sentence, the same for every body the provider sends.
    assert json.loads(sink.body)["error"]["code"] in {code.value for code in ErrorCode}
    assert dict(sink.headers)["content-type"] == "application/json"
    assert sink.length == len(sink.body)
    if status == 429:
        assert dict(sink.headers)["retry-after"] == "7"


# #550-B2-O02
def test_an_error_gives_the_engine_the_same_bytes_whatever_the_provider_wrote() -> None:
    family = WireFamily.ANTHROPIC_MESSAGES
    bodies: list[bytes] = []
    for words in ("guess one", REAL_KEY, "x" * 3000):
        r = rig(family, failing(family, 400, words))
        bodies.append(r.post().body)
    assert bodies[0] == bodies[1] == bodies[2]


# #550-B2-O02
def test_only_the_retry_hint_of_an_error_is_passed_on() -> None:
    family = WireFamily.OPENAI_CHAT
    answer = failing(family, 429, **{"retry-after": "2"})
    answer.headers += [
        ("retry-after-ms", "1500"),
        ("x-request-id", f"req_{REAL_KEY}"),
        ("set-cookie", "a=b"),
        ("x-should-retry", "true"),
        ("retry-after", "see https://evil.example"),
    ]
    r = rig(family, answer)
    sink = r.post()
    names = [name for name, _ in sink.headers]
    assert "set-cookie" not in names and "x-request-id" not in names
    assert dict(sink.headers)["retry-after-ms"] == "1500"
    assert dict(sink.headers)["retry-after"] == "2"  # the first valid one; a text value is dropped
    assert REAL_KEY.encode() not in sink.everything()


# #550-B2-O03
def test_a_redactor_without_a_key_or_with_a_short_one_is_refused_and_never_loops() -> None:
    for key in ("", "a", "short-key"):
        with pytest.raises(ValueError, match="too short"):
            Redactor(key)
    assert Redactor("k" * 20).redact(b"nothing here") == b"nothing here"


# #550-B2-O03
@pytest.mark.parametrize("key", ["", "x", "sk-short"])
def test_a_proxy_is_not_built_for_a_key_that_is_too_short_to_be_one(key: str) -> None:
    from code_reviewer_runner.dynamic_review.passthrough.admission import PassthroughTarget
    from code_reviewer_runner.dynamic_review.passthrough.proxy import PassthroughProxy

    r = rig(WireFamily.OPENAI_CHAT, streamed(WireFamily.OPENAI_CHAT))
    with pytest.raises(LimitError) as raised:
        PassthroughProxy(
            ledger=r.ledger,
            target=PassthroughTarget(WireFamily.OPENAI_CHAT, MODEL, 8192),
            upstream=r.upstream,
            upstream_api_key=key,
            capability=r.capability,
            prices=PRICES,
        )
    assert raised.value.code is ErrorCode.DYNAMIC_CONFIG_INVALID


# -- B3: no cost hidden by hanging up ----


# #550-B3-H01
@pytest.mark.parametrize("family", FAMILIES)
def test_an_engine_that_hangs_up_does_not_hide_the_usage_of_the_call(family: WireFamily) -> None:
    answer = streamed(family, call=3)
    r = rig(family, answer)
    sink = MemorySink(r.upstream.timeline, gone_after=1)
    r.post(sink=sink)
    response = r.upstream.responses[0]
    # The proxy read the answer on to its usage, forwarded nothing more, and closed the call.
    assert len(sink.chunks) == 1 and sink.aborted and not sink.ended
    assert response.closed
    # Settled normally, at the provider's own usage.
    call = usage_expected(3, family)
    cost = call_cost(call, PRICES)
    assert cost is not None
    usage = r.ledger.usage(MODEL)
    assert usage.cost_usd == pytest.approx(float(cost))
    assert usage.prompt_tokens == call.prompt_tokens
    assert r.ledger.failure is None


# #550-B3-H02
@pytest.mark.parametrize("family", FAMILIES)
def test_when_the_usage_cannot_be_read_after_a_hang_up_the_worst_case_is_booked(
    family: WireFamily,
) -> None:
    events = stream(FAKE[family], TURN, 1, MODEL)
    cut = Scripted(chunks=[*events[:2], UpstreamError(UpstreamFailure.CUT, sent=True)])
    r = rig(family, cut)
    body = r.body()
    r.post(body, sink=MemorySink(r.upstream.timeline, gone_after=1))
    assert spent(r.ledger) == worst_case(len(body))
    usage = r.ledger.usage(MODEL)
    assert usage.cost_usd is None
    assert r.ledger.unknown_calls == 1
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED


# #550-B3-H03
def test_the_read_after_a_hang_up_is_bounded_by_the_bytes_of_a_stream() -> None:
    family = WireFamily.OPENAI_CHAT
    limits = DynamicLimits(max_stream_bytes=4000, max_cost_usd=Decimal(5))
    endless = Scripted(chunks=[b"data: " + b"y" * 900 + b"\n\n"] * 5000)
    r = rig(family, endless, limits=limits)
    body = r.body(max_tokens=1)
    r.post(body, sink=MemorySink(r.upstream.timeline, gone_after=1))
    response = r.upstream.responses[0]
    assert response.reads < 20  # nowhere near the 5000 chunks
    assert response.closed
    assert spent(r.ledger) == worst_case(len(body), 1)
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED


# #550-B3-H03
def test_the_read_after_a_hang_up_is_bounded_by_the_deadline() -> None:
    family = WireFamily.OPENAI_CHAT
    r = rig(family, streamed(family), deadline=10.0)
    sink = MemorySink(r.upstream.timeline, gone_after=1)
    body = r.body()
    original = r.upstream.send

    def late(request: UpstreamRequest, timeout: float) -> ScriptedResponse:
        response = original(request, timeout)
        r.clock[0] = 11.0  # the deadline passes while the engine is gone
        return response

    r.upstream.send = late  # type: ignore[method-assign]
    r.post(body, sink=sink)
    assert r.upstream.responses[0].closed
    assert spent(r.ledger) == worst_case(len(body))
    assert r.ledger.failure is not None


# #550-B3-U01
@pytest.mark.parametrize("family", FAMILIES)
def test_a_cut_stream_is_booked_at_its_worst_case_and_ends_a_managed_run(
    family: WireFamily,
) -> None:
    events = stream(FAKE[family], TURN, 1, MODEL)
    cut = Scripted(chunks=[*events[:2], UpstreamError(UpstreamFailure.CUT, sent=True)])
    r = rig(family, cut)
    body = r.body()
    sink = r.post(body)
    assert sink.aborted
    assert spent(r.ledger) == worst_case(len(body))
    assert spent(r.ledger) > 0
    assert r.ledger.unknown_calls == 1
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED
    assert r.proxy.last_upstream_error is ErrorCode.LLM_UNAVAILABLE


# #550-B3-U01
def test_an_own_key_run_keeps_going_after_an_unknown_call_with_the_worst_case_booked() -> None:
    """The relaxation for an own key is #553; the hook it will use is here and off by default."""
    family = WireFamily.OPENAI_CHAT
    events = stream(FAKE[family], TURN, 1, MODEL)
    cut = Scripted(chunks=[*events[:2], UpstreamError(UpstreamFailure.CUT, sent=True)])
    r = rig(family, cut, unknown_cost_ends_run=False)
    body = r.body()
    r.post(body)
    assert spent(r.ledger) == worst_case(len(body))
    assert r.ledger.failure is None
    assert r.ledger.usage(MODEL).cost_usd is None


# #550-B3-U01
@pytest.mark.parametrize("family", FAMILIES)
def test_an_error_event_in_a_200_stream_is_an_unknown_call_at_its_worst_case(
    family: WireFamily,
) -> None:
    from fakes.wire.formats import error_event

    events = [*stream(FAKE[family], TURN, 1, MODEL)[:2], error_event(FAKE[family])]
    r = rig(family, Scripted(chunks=events))
    body = r.body()
    r.post(body)
    assert spent(r.ledger) == worst_case(len(body))
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED


# -- settlement of a provider error (item 7) ----


# #550-B3-S01
@pytest.mark.parametrize("status", [400, 401, 402, 403, 404, 409, 413, 422, 429])
def test_a_refusal_before_anything_was_generated_costs_nothing(status: int) -> None:
    family = WireFamily.ANTHROPIC_MESSAGES
    r = rig(family, failing(family, status))
    r.post()
    assert spent(r.ledger) == 0
    assert r.ledger.usage(MODEL).cost_usd == 0.0
    assert r.ledger.unknown_calls == 0


# #550-B3-S02
@pytest.mark.parametrize("status", [408, 500, 502, 503, 504, 524, 529])
def test_a_timeout_or_server_error_may_have_been_billed_so_it_is_booked_at_its_worst_case(
    status: int,
) -> None:
    family = WireFamily.ANTHROPIC_MESSAGES
    r = rig(family, failing(family, status))
    body = r.body()
    sink = r.post(body)
    assert sink.status == status
    assert spent(r.ledger) == worst_case(len(body))
    assert r.ledger.unknown_calls == 1
    assert r.ledger.usage(MODEL).cost_usd is None
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED


# #550-B3-S02
def test_a_call_that_timed_out_after_it_was_sent_is_booked_at_its_worst_case() -> None:
    family = WireFamily.OPENAI_CHAT
    r = rig(family, Scripted(fails=UpstreamError(UpstreamFailure.TIMEOUT, sent=True)))
    body = r.body()
    r.post(body)
    assert spent(r.ledger) == worst_case(len(body))
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED


# #550-B3-S02
def test_a_call_that_never_left_costs_nothing_and_does_not_end_the_run() -> None:
    family = WireFamily.OPENAI_CHAT
    r = rig(family, Scripted(fails=UpstreamError(UpstreamFailure.UNREACHABLE)))
    r.post()
    assert spent(r.ledger) == 0
    assert r.ledger.failure is None


# -- B4: one call at a time ----


# #550-B4-P01
@pytest.mark.parametrize("family", FAMILIES)
def test_a_second_call_while_one_is_in_flight_is_refused_at_once(family: WireFamily) -> None:
    started, release = threading.Event(), threading.Event()

    def hold() -> None:
        started.set()
        assert release.wait(10)

    r = rig(family, streamed(family, 1), streamed(family, 2), on_send=hold)
    first_sink = MemorySink()
    first = threading.Thread(target=lambda: r.post(sink=first_sink))
    first.start()
    try:
        assert started.wait(10)
        second = r.post()
        # Refused before it is reserved or sent: not a call, and not a reason to end the run.
        assert second.status == 429
        assert dict(second.headers)["retry-after"] == "1"
        assert json.loads(second.body)["error"]["code"] == "call_in_flight"
        assert len(r.upstream.requests) == 1
        assert r.ledger.model_calls == 1
        assert r.ledger.failure is None
    finally:
        release.set()
        first.join(10)
    assert first_sink.status == 200 and first_sink.ended
    # The slot is free again, and the refusal was no call: the next request is the second call.
    r.upstream._on_send = None  # pyright: ignore[reportPrivateUsage]
    assert r.post().status == 200
    assert r.ledger.model_calls == 2


# #550-B4-P01
def test_the_slot_is_free_again_after_every_way_a_call_can_end() -> None:
    family = WireFamily.OPENAI_CHAT
    events = stream(FAKE[family], TURN, 1, MODEL)
    r = rig(
        family,
        failing(family, 500),
        Scripted(fails=UpstreamError(UpstreamFailure.CUT, sent=True)),
        Scripted(chunks=[*events[:2], UpstreamError(UpstreamFailure.CUT, sent=True)]),
        streamed(family, 4),
        unknown_cost_ends_run=False,
    )
    statuses = [r.post().status for _ in range(4)]
    assert 429 not in statuses
    assert statuses[-1] == 200


# #550-B4-P01
def test_a_request_that_proves_nothing_is_a_401_not_a_busy_signal() -> None:
    family = WireFamily.OPENAI_CHAT
    started, release = threading.Event(), threading.Event()

    def hold() -> None:
        started.set()
        release.wait(10)

    r = rig(family, streamed(family), on_send=hold)
    first = threading.Thread(target=r.post)
    first.start()
    try:
        assert started.wait(10)
        stranger = r.post(headers=r.headers(capability="not-the-capability"))
        assert stranger.status == 401
    finally:
        release.set()
        first.join(10)


# #550-B4-P02
def test_many_parallel_requests_make_one_call_and_refuse_the_rest() -> None:
    family = WireFamily.OPENAI_CHAT
    started, release = threading.Event(), threading.Event()

    def hold() -> None:
        started.set()
        release.wait(10)

    r = rig(family, streamed(family), on_send=hold)
    sinks: list[MemorySink] = []
    lock = threading.Lock()

    def request() -> None:
        sink = r.post()
        with lock:
            sinks.append(sink)

    threads = [threading.Thread(target=request) for _ in range(8)]
    for thread in threads:
        thread.start()
    assert started.wait(10)
    # Seven are refused while the eighth is held.
    for _ in range(200):
        with lock:
            if len(sinks) == 7:
                break
        threading.Event().wait(0.02)
    release.set()
    for thread in threads:
        thread.join(10)
    statuses = sorted(sink.status for sink in sinks)
    assert statuses == [200, *([429] * 7)]
    assert len(r.upstream.requests) == 1 and r.ledger.model_calls == 1
