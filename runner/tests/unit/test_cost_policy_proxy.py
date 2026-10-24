# SPDX-License-Identifier: LicenseRef-Proprietary

"""How the passthrough proxy settles a call for each key (#553).

The managed key (we pay) fails closed: a cost that is not known ends the run with
`dynamic_accounting_failed`, which billing treats as our fault. The own key (the user pays the
provider) goes on: the call is booked by its tokens, its cost stays unknown, and the token cap and
the clock bind. A call that stated no usage at all fails the run for both, since the cap cannot
count it.
"""

import logging
import secrets
import sys
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fakes.wire.formats import stream
from passthrough_support import (
    ALLOWANCE,
    FAKE,
    MODEL,
    REAL_KEY,
    TURN,
    Rig,
    Scripted,
    ScriptedUpstream,
    failing,
    streamed,
)

from code_reviewer_runner.dynamic_review.budget import DynamicLimits
from code_reviewer_runner.dynamic_review.passthrough.admission import PassthroughTarget
from code_reviewer_runner.dynamic_review.passthrough.cost_policy import (
    CostPolicy,
    KeyMode,
    build_native_ledger,
    parse_cost_policy,
)
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily
from code_reviewer_runner.dynamic_review.passthrough.pricing import call_cost
from code_reviewer_runner.dynamic_review.passthrough.proxy import PassthroughProxy
from code_reviewer_runner.dynamic_review.passthrough.upstream import UpstreamError, UpstreamFailure
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.result import ErrorCode
from passthrough_expect import usage_expected

LOGGER = "code_reviewer_runner.dynamic_review.passthrough.usage_report"
FAMILIES = list(WireFamily)
# The generic fakes state a cache read, both cache writes and reasoning with every call
# (`fakes/wire/formats.py`), so a book prices a complete answer only when it prices all of them.
BOOK: dict[str, Any] = {
    "input": "3000000",
    "output": "15000000",
    "cacheRead": "300000",
    "cacheWrite5m": "3750000",
    "cacheWrite1h": "6000000",
    "reasoning": None,
    "inputAudio": None,
    "outputAudio": None,
    "contextOver200k": None,
    "tiers": [],
}


def policy(mode: str, *, book: dict[str, Any] | None = BOOK, cap: int | None = None) -> CostPolicy:
    if mode == "own" and cap is None:
        cap = 4_000_000
    return parse_cost_policy({"keyMode": mode, "priceBook": book, "maxTotalTokens": cap})


def policy_rig(
    family: WireFamily, cost_policy: CostPolicy, *answers: Scripted, deadline: float = 600.0
) -> Rig:
    clock = [0.0]
    ledger = build_native_ledger(
        cost_policy,
        DynamicLimits(max_cost_usd=Decimal("5.00"), deadline_seconds=deadline),
        window_tokens=1_000_000,
        output_tokens=ALLOWANCE,
        clock=lambda: clock[0],
    )
    upstream = ScriptedUpstream(*answers)
    capability = secrets.token_urlsafe(32)
    proxy = PassthroughProxy(
        ledger=ledger,
        target=PassthroughTarget(family=family, model=MODEL, output_allowance=ALLOWANCE),
        upstream=upstream,
        upstream_api_key=REAL_KEY,
        capability=capability,
        prices=cost_policy.book,
        unknown_cost_ends_run=cost_policy.unknown_cost_ends_run,
    )
    return Rig(proxy, ledger, upstream, family, capability, clock)


def counters(r: Rig) -> Any:
    return r.ledger._counters  # pyright: ignore[reportPrivateUsage]


# #553-T03
@pytest.mark.parametrize("family", FAMILIES)
@pytest.mark.parametrize("fault", ["unknown_field", "bad_value"])
def test_a_managed_run_ends_on_a_usage_it_cannot_price_and_its_cost_is_not_zero(
    family: WireFamily, fault: str
) -> None:
    r = policy_rig(family, policy("managed"), streamed(family, 1, usage_fault=fault))  # type: ignore[arg-type]
    r.post(r.body())
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED
    assert r.ledger.usage(MODEL).cost_usd is None
    assert r.ledger.unknown_calls == 1


# #553-T03
@pytest.mark.parametrize("family", FAMILIES)
def test_a_managed_run_ends_on_a_stream_cut_after_the_request_went_out(
    family: WireFamily,
) -> None:
    events = stream(FAKE[family], TURN, 1, MODEL)
    cut = Scripted(chunks=[*events[:-2], UpstreamError(UpstreamFailure.CUT, sent=True)])
    r = policy_rig(family, policy("managed"), cut)
    r.post(r.body())
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED
    assert r.ledger.usage(MODEL).cost_usd is None


# #553-T02
@pytest.mark.parametrize("family", FAMILIES)
def test_a_managed_run_prices_a_complete_answer_from_the_book_of_the_claim(
    family: WireFamily,
) -> None:
    managed = policy("managed")
    r = policy_rig(family, managed, streamed(family, 1))
    r.post(r.body())
    assert r.ledger.failure is None
    expected = call_cost(usage_expected(1, family), managed.book)  # type: ignore[arg-type]
    assert expected is not None
    assert r.ledger.usage(MODEL).cost_usd == pytest.approx(float(expected))


# #553-R04
@pytest.mark.parametrize("family", FAMILIES)
def test_a_managed_run_does_not_price_a_cache_read_the_book_has_no_price_for(
    family: WireFamily,
) -> None:
    no_read = {**BOOK, "cacheRead": None}
    # The fakes state a cache read with every call.
    r = policy_rig(family, policy("managed", book=no_read), streamed(family, 1))
    r.post(r.body())
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED
    assert r.ledger.usage(MODEL).cost_usd is None


# #553-T06
@pytest.mark.parametrize("family", FAMILIES)
def test_an_own_run_goes_on_after_a_usage_it_cannot_price_and_logs_counts_only(
    family: WireFamily, caplog: pytest.LogCaptureFixture
) -> None:
    r = policy_rig(family, policy("own"), streamed(family, 1, usage_fault="unknown_field"))
    with caplog.at_level(logging.WARNING, logger=LOGGER):
        sink = r.post(r.body())
    assert r.ledger.failure is None
    assert sink.ended and not sink.aborted
    usage = r.ledger.usage(MODEL)
    assert usage.cost_usd is None
    assert usage.ai_calls == 1
    # The tokens the provider stated are booked against the cap.
    assert usage.prompt_tokens > 0 and usage.completion_tokens > 0
    assert r.proxy.price_risk_calls == 1
    messages = [record.getMessage() for record in caplog.records]
    assert any(message.startswith("price_risk: 1 call") for message in messages)
    # Counts and field names only: never a token count, a cost, a model or a key.
    assert not any(REAL_KEY in message or MODEL in message for message in messages)


# #553-T05
@pytest.mark.parametrize("family", FAMILIES)
def test_an_unpriced_own_run_settles_a_complete_answer_by_its_tokens(family: WireFamily) -> None:
    r = policy_rig(family, policy("own", book=None), streamed(family, 1))
    sink = r.post(r.body())
    assert r.ledger.failure is None
    assert sink.ended
    usage = r.ledger.usage(MODEL)
    stated = usage_expected(1, family)
    assert usage.cost_usd is None
    assert usage.prompt_tokens == stated.prompt_tokens
    assert usage.completion_tokens == stated.completion_tokens
    assert counters(r).cost == 0


# #553-T04
@pytest.mark.parametrize("family", FAMILIES)
def test_a_priced_own_run_prices_a_complete_answer_as_before(family: WireFamily) -> None:
    own = policy("own")
    r = policy_rig(family, own, streamed(family, 1))
    r.post(r.body())
    assert r.ledger.failure is None
    expected = call_cost(usage_expected(1, family), own.book)  # type: ignore[arg-type]
    assert expected is not None
    assert r.ledger.usage(MODEL).cost_usd == pytest.approx(float(expected))
    assert r.proxy.price_risk_calls == 0


# #553-T05
@pytest.mark.parametrize("family", FAMILIES)
def test_an_own_run_goes_on_after_a_stream_cut_and_books_its_expected_tokens(
    family: WireFamily,
) -> None:
    events = stream(FAKE[family], TURN, 1, MODEL)
    cut = Scripted(chunks=[*events[:-2], UpstreamError(UpstreamFailure.CUT, sent=True)])
    r = policy_rig(family, policy("own", book=None), cut)
    body = r.body()
    r.post(body)
    assert r.ledger.failure is None
    assert r.ledger.unknown_calls == 1
    assert counters(r).unknown_tokens > 0
    assert r.ledger.usage(MODEL).cost_usd is None


# #553-T07
@pytest.mark.parametrize("family", FAMILIES)
@pytest.mark.parametrize("fault", ["missing", "bad_value"])
def test_an_own_run_still_fails_on_an_answer_with_no_usage_it_can_count(
    family: WireFamily, fault: str
) -> None:
    # `bad_value` damages a count the family must state: there are no tokens to put against the cap.
    scripted = streamed(family, 1, usage_fault=fault)  # type: ignore[arg-type]
    r = policy_rig(family, policy("own", book=None), scripted)
    r.post(r.body())
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED
    assert r.ledger.usage(MODEL).cost_usd is None


# #553-T05
@pytest.mark.parametrize("family", FAMILIES)
def test_an_own_run_that_reaches_its_token_cap_stops_and_never_runs_unbounded(
    family: WireFamily,
) -> None:
    # Each call states about 1,000 to 1,400 tokens; the cap holds a call or two and then refuses.
    answers = [streamed(family, call) for call in range(1, 40)]
    r = policy_rig(family, policy("own", book=None, cap=3_000), *answers)
    statuses: list[int] = []
    for _ in range(10):
        statuses.append(r.post(r.body(size=3000)).status)
    assert statuses[0] == 200
    assert 403 in statuses
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert len(r.upstream.requests) < 10
    assert r.ledger.usage(MODEL).cost_usd is None


# #553-T10
@pytest.mark.parametrize("family", FAMILIES)
def test_the_clock_ends_an_unpriced_own_run_as_it_ends_a_priced_one(family: WireFamily) -> None:
    r = policy_rig(family, policy("own", book=None), streamed(family, 1), deadline=100.0)
    r.clock[0] = 100.0
    sink = r.post(r.body())
    assert sink.status == 403
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert not r.upstream.requests


# #553-T05
@pytest.mark.parametrize("family", FAMILIES)
def test_an_own_run_goes_on_after_a_timeout_status(family: WireFamily) -> None:
    # A 408 may have been billed: unknown, and for an own key not fatal.
    r = policy_rig(family, policy("own", book=None), failing(family, 408))
    r.post(r.body())
    assert r.ledger.failure is None
    assert r.ledger.unknown_calls == 1


# #553-R05
def test_a_managed_key_cannot_have_a_proxy_without_prices() -> None:
    with pytest.raises(Exception) as raised:
        PassthroughProxy(
            ledger=build_native_ledger(
                policy("own", book=None),
                DynamicLimits(),
                window_tokens=1_000_000,
                output_tokens=ALLOWANCE,
            ),
            target=PassthroughTarget(
                family=WireFamily.OPENAI_CHAT, model=MODEL, output_allowance=ALLOWANCE
            ),
            upstream=ScriptedUpstream(Scripted()),
            upstream_api_key=REAL_KEY,
            capability=secrets.token_urlsafe(32),
            prices=None,
            unknown_cost_ends_run=True,
        )
    assert getattr(raised.value, "code", None) is ErrorCode.DYNAMIC_CONFIG_INVALID


def test_the_policy_type_exposes_the_mode_the_tests_use() -> None:
    assert policy("own", book=None).key_mode is KeyMode.OWN
    assert as_object({}) == {}
