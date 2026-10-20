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
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fakes.wire.formats import stream
from passthrough_support import (
    FAKE,
    MODEL,
    PRICES,
    TURN,
    Rig,
    Scripted,
    document,
    failing,
    rig,
    streamed,
    worst_case,
)

from code_reviewer_runner.dynamic_review.budget import BudgetLedger, UnitCosts
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily
from code_reviewer_runner.dynamic_review.passthrough.price_book import PriceBook, PriceLevel
from code_reviewer_runner.dynamic_review.passthrough.pricing import call_cost
from code_reviewer_runner.dynamic_review.passthrough.upstream import UpstreamError, UpstreamFailure
from code_reviewer_runner.result import ErrorCode
from passthrough_expect import usage_expected

FAMILIES = list(WireFamily)
LOGGER = "code_reviewer_runner.dynamic_review.passthrough.usage_report"


def spent(ledger: BudgetLedger) -> Decimal:
    return ledger._counters.cost  # pyright: ignore[reportPrivateUsage]


def assert_unknown_call(r: Rig, body_bytes: int) -> None:
    assert spent(r.ledger) == worst_case(body_bytes)
    assert r.ledger.usage(MODEL).cost_usd is None
    assert r.ledger.unknown_calls == 1


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
    # The names of what could not be priced are logged and no value is (a count that cannot be read
    # at all leaves no field to name).
    messages = " ".join(record.getMessage() for record in caplog.records)
    assert ("usage" in messages) == (fault == "unknown_field")
    assert not any(char.isdigit() for char in messages.replace("usageMetadata", ""))


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
    finish: dict[str, Any] = {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
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


# -- review of PR #569: a call the book cannot price, a charge that cannot be believed -----------


# #551-R569-S3
def test_a_call_with_a_one_hour_write_and_no_one_hour_price_is_booked_at_the_worst_case() -> None:
    # The generic fake's first call writes to the cache for 5 minutes and for an hour.
    no_one_hour = UnitCosts(
        input_usd_per_mtok=Decimal(3),
        output_usd_per_mtok=Decimal(15),
        cache_read_usd_per_mtok=Decimal("0.3"),
        cache_write_usd_per_mtok=Decimal("3.75"),
    )
    family = WireFamily.ANTHROPIC_MESSAGES
    r = rig(family, streamed(family, 1), prices=no_one_hour)
    body = r.body()
    r.post(body)
    assert_unknown_call(r, len(body))
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED


# #551-R569-S3
@pytest.mark.parametrize("which", ["5m", "1h"])
def test_a_price_book_without_the_price_of_a_write_the_call_made_is_an_unknown_call(
    which: str,
) -> None:
    level = PriceLevel(
        input=3_000_000,
        output=15_000_000,
        cache_read=300_000,
        cache_write_5m=None if which == "5m" else 3_750_000,
        cache_write_1h=None if which == "1h" else 6_000_000,
    )
    family = WireFamily.ANTHROPIC_MESSAGES
    r = rig(family, streamed(family, 1), prices=PriceBook(base=level))
    body = r.body()
    r.post(body)
    assert_unknown_call(r, len(body))
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED


# #551-R569-S3
def test_for_an_own_key_a_call_the_book_cannot_price_is_booked_and_the_run_goes_on() -> None:
    family = WireFamily.ANTHROPIC_MESSAGES
    level = PriceLevel(input=3_000_000, output=15_000_000, cache_read=300_000)
    r = rig(family, streamed(family, 1), prices=PriceBook(base=level), unknown_cost_ends_run=False)
    body = r.body()
    r.post(body)
    assert_unknown_call(r, len(body))
    assert r.ledger.failure is None


# #551-R569-S4
@pytest.mark.parametrize("cost", [0, 1e-300, 5e-324, 0.00000001, 0.000009])
def test_a_charge_far_below_what_the_book_expects_is_an_unknown_call_at_the_worst_case(
    cost: float,
) -> None:
    # The book expects 0.000105 for the call (10 in, 5 out): one hundredth of it is no price.
    r = rig(WireFamily.OPENAI_CHAT, _openrouter(cost))
    body = r.body()
    r.post(body)
    assert_unknown_call(r, len(body))
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED


# #551-R569-S4
def test_a_charge_below_the_book_by_less_than_ten_times_books_the_book_and_counts_the_drift() -> (
    None
):
    r = rig(WireFamily.OPENAI_CHAT, _openrouter(0.00005))
    r.post()
    assert r.ledger.usage(MODEL).cost_usd == pytest.approx(0.000105)
    assert r.proxy.price_drift_calls == 1
    assert r.ledger.unknown_calls == 0 and r.ledger.failure is None


# -- review of PR #569: usage that is stated twice or in the wrong order -------------------------


# #551-R569-S1
@pytest.mark.parametrize("family", FAMILIES)
def test_a_usage_that_is_stated_twice_is_an_unknown_call_at_the_worst_case(
    family: WireFamily,
) -> None:
    r = rig(family, streamed(family, 1, usage_fault="duplicate"))
    body = r.body()
    r.post(body)
    assert_unknown_call(r, len(body))
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED


# #551-R569-S1
@pytest.mark.parametrize(
    "family", [WireFamily.OPENAI_CHAT, WireFamily.ANTHROPIC_MESSAGES, WireFamily.GOOGLE]
)
def test_a_usage_in_the_wrong_order_is_an_unknown_call_at_the_worst_case(
    family: WireFamily,
) -> None:
    r = rig(family, streamed(family, 1, usage_fault="out_of_order"))
    body = r.body()
    r.post(body)
    assert_unknown_call(r, len(body))


# #551-R569-S2
def test_the_two_usage_chunks_of_the_reviewers_chat_stream_cannot_book_the_smaller_one() -> None:
    # Before: the last chunk (5 tokens out) replaced the first (500) and the call cost a hundredth.
    finish: dict[str, Any] = {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}

    def usage(completion: int) -> dict[str, Any]:
        counts = {"prompt_tokens": 1000, "completion_tokens": completion}
        return {"choices": [], "usage": {**counts, "total_tokens": 1000 + completion}}

    chunks = [
        f"data: {json.dumps(item)}\n\n".encode() for item in (finish, usage(500), usage(5))
    ] + [b"data: [DONE]\n\n"]
    r = rig(WireFamily.OPENAI_CHAT, Scripted(chunks=chunks))
    body = r.body()
    r.post(body)
    assert_unknown_call(r, len(body))
