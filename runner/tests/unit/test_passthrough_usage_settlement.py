# SPDX-License-Identifier: Apache-2.0

"""How the passthrough proxy books a call whose usage is hard to read (#551).

The parsers (`test_usage_parsers.py`) say what a usage is; here the proxy acts on it, for each of
the four families and with the generic fakes: an answer that ends without its usage, a usage that
lists a field nobody can price, a value that cannot be trusted and a charge the provider states
that the price book does not agree with. The call is never free: it is booked at its worst case
and counted as unknown, and a managed run ends.
"""

import json
import logging
import sys
from decimal import Decimal
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fakes.wire.formats import stream
from passthrough_support import (
    FAKE,
    MODEL,
    PRICES,
    TURN,
    Scripted,
    document,
    failing,
    rig,
    streamed,
)

from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily
from code_reviewer_runner.dynamic_review.passthrough.pricing import call_cost
from code_reviewer_runner.dynamic_review.passthrough.upstream import UpstreamError, UpstreamFailure
from code_reviewer_runner.result import ErrorCode
from passthrough_expect import usage_expected

FAMILIES = list(WireFamily)
LOGGER = "code_reviewer_runner.dynamic_review.passthrough.proxy"


def worst_case(body_bytes: int, output_cap: int = 1000) -> Decimal:
    return PRICES.of_call(body_bytes, output_cap, cache_in_use=True)


def spent(r_ledger: object) -> Decimal:
    return r_ledger._counters.cost  # type: ignore[attr-defined]  # pyright: ignore[reportAttributeAccessIssue, reportUnknownMemberType, reportUnknownVariableType]


def assert_unknown_call(r: object, body_bytes: int) -> None:
    ledger = r.ledger  # type: ignore[attr-defined]  # pyright: ignore[reportAttributeAccessIssue, reportUnknownMemberType, reportUnknownVariableType]
    assert spent(ledger) == worst_case(body_bytes)
    assert ledger.usage(MODEL).cost_usd is None  # pyright: ignore[reportUnknownMemberType]
    assert ledger.unknown_calls == 1  # pyright: ignore[reportUnknownMemberType]


# #551-T07
@pytest.mark.parametrize("family", FAMILIES)
def test_a_stream_that_closes_before_its_usage_event_is_booked_at_the_worst_case(
    family: WireFamily,
) -> None:
    events = stream(FAKE[family], TURN, 1, MODEL)
    r = rig(family, Scripted(chunks=list(events[:-2])))
    body = r.body()
    sink = r.post(body)
    assert sink.aborted and not sink.ended
    assert_unknown_call(r, len(body))
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED


# #551-T07
@pytest.mark.parametrize("family", FAMILIES)
def test_a_stream_cut_by_the_connection_is_booked_at_the_worst_case(family: WireFamily) -> None:
    events = stream(FAKE[family], TURN, 1, MODEL)
    cut = Scripted(chunks=[*events[:-2], UpstreamError(UpstreamFailure.CUT, sent=True)])
    r = rig(family, cut)
    body = r.body()
    r.post(body)
    assert_unknown_call(r, len(body))
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED


# #551-T07
@pytest.mark.parametrize("family", FAMILIES)
@pytest.mark.parametrize("whole", [False, True])
def test_a_complete_answer_without_usage_is_booked_at_the_worst_case(
    family: WireFamily, whole: bool
) -> None:
    scripted = (
        _document_without_usage(family) if whole else streamed(family, 1, usage_fault="missing")
    )
    r = rig(family, scripted)
    body = r.body()
    r.post(body)
    assert_unknown_call(r, len(body))
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED


def _document_without_usage(family: WireFamily) -> Scripted:
    from fakes.wire.formats import answer

    body = json.dumps(answer(FAKE[family], TURN, 1, MODEL, usage_fault="missing")).encode()
    return Scripted(headers=[("content-type", "application/json")], chunks=[body])


# #551-T06
@pytest.mark.parametrize("family", FAMILIES)
@pytest.mark.parametrize("fault", ["unknown_field", "bad_value"])
def test_a_usage_with_an_unknown_field_or_a_bad_value_is_an_unknown_call_for_a_managed_key(
    family: WireFamily, fault: str, caplog: pytest.LogCaptureFixture
) -> None:
    r = rig(family, streamed(family, 1, usage_fault=fault))  # type: ignore[arg-type]
    body = r.body()
    with caplog.at_level(logging.WARNING, logger=LOGGER):
        sink = r.post(body)
    assert sink.ended
    assert_unknown_call(r, len(body))
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED
    # The names of what could not be read are logged and no value is.
    messages = " ".join(record.getMessage() for record in caplog.records)
    assert "usage" in messages


# #551-T06
@pytest.mark.parametrize("family", FAMILIES)
def test_a_whole_answer_with_an_unknown_usage_field_is_an_unknown_call(
    family: WireFamily,
) -> None:
    from fakes.wire.formats import answer

    body = json.dumps(answer(FAKE[family], TURN, 1, MODEL, usage_fault="unknown_field")).encode()
    r = rig(family, Scripted(headers=[("content-type", "application/json")], chunks=[body]))
    request = r.body()
    r.post(request)
    assert_unknown_call(r, len(request))


# #551-T06
@pytest.mark.parametrize("family", FAMILIES)
def test_for_an_own_key_the_unknown_call_is_booked_and_the_run_goes_on(family: WireFamily) -> None:
    # The relaxation itself is #553; the proxy only does not end the run when told not to.
    r = rig(family, streamed(family, 1, usage_fault="unknown_field"), unknown_cost_ends_run=False)
    body = r.body()
    r.post(body)
    assert_unknown_call(r, len(body))
    assert r.ledger.failure is None


# #551-T06
@pytest.mark.parametrize("family", FAMILIES)
def test_the_usage_the_fakes_state_still_settles_at_the_price_of_the_book(
    family: WireFamily,
) -> None:
    r = rig(family, streamed(family, 2), document(family, 3))
    r.post()
    r.post()
    cost = (call_cost(usage_expected(2, family), PRICES) or 0) + (
        call_cost(usage_expected(3, family), PRICES) or 0
    )
    assert r.ledger.usage(MODEL).cost_usd == pytest.approx(float(cost))
    assert r.ledger.unknown_calls == 0 and r.ledger.failure is None


# -- T09: price drift ----------------------------------------------------------------------------


def _openrouter(cost: float) -> Scripted:
    usage = {"prompt_tokens": 10, "completion_tokens": 5, "cost": cost}
    finish = {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
    chunks = [
        f"data: {json.dumps(finish)}\n\n".encode(),
        f"data: {json.dumps({'choices': [], 'usage': usage})}\n\n".encode(),
        b"data: [DONE]\n\n",
    ]
    return Scripted(chunks=chunks)


# #551-T09
def test_a_charge_the_provider_states_is_booked_and_a_mismatch_with_the_book_is_counted(
    caplog: pytest.LogCaptureFixture,
) -> None:
    family = WireFamily.OPENAI_CHAT
    r = rig(family, _openrouter(0.0012))
    with caplog.at_level(logging.INFO, logger=LOGGER):
        r.post()
    # The provider's charge is the cost, not the book's 0.000105.
    assert r.ledger.usage(MODEL).cost_usd == pytest.approx(0.0012)
    assert r.proxy.price_drift_calls == 1
    drift = [rec.getMessage() for rec in caplog.records if "price_drift" in rec.getMessage()]
    # Counts only: no amount, no model, no token count.
    assert drift == ["price_drift: 1 call"]


# #551-T09
def test_a_charge_that_agrees_with_the_book_is_no_drift(caplog: pytest.LogCaptureFixture) -> None:
    family = WireFamily.OPENAI_CHAT
    r = rig(family, _openrouter(0.000105))
    with caplog.at_level(logging.INFO, logger=LOGGER):
        r.post()
    assert r.ledger.usage(MODEL).cost_usd == pytest.approx(0.000105)
    assert r.proxy.price_drift_calls == 0
    assert not [rec for rec in caplog.records if "price_drift" in rec.getMessage()]


# -- T10: an SDK retry ---------------------------------------------------------------------------


# #551-T10
@pytest.mark.parametrize("family", FAMILIES)
def test_a_retry_after_a_429_is_two_upstream_calls_with_one_settled_at_the_usage(
    family: WireFamily,
) -> None:
    r = rig(family, failing(family, 429, **{"retry-after": "1"}), streamed(family, 1))
    first = r.post()
    second = r.post()
    assert len(r.upstream.requests) == 2
    assert first.status == 429 and second.status == 200
    usage = r.ledger.usage(MODEL)
    # The refused call was never billed and the answered one is priced at its usage.
    assert usage.cost_usd == pytest.approx(float(call_cost(usage_expected(1, family), PRICES) or 0))
    assert r.ledger.unknown_calls == 0 and r.ledger.failure is None
