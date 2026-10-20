# SPDX-License-Identifier: Apache-2.0

"""The real pinned OpenCode through the production passthrough proxy, one engine for all (#550).

The engine holds a random per-job capability and speaks its own wire family; the proxy in front of
each strict fake provider checks, swaps the capability for the real key, relays the bytes and counts
in a ledger. The fake accepts only the real key under the real header, one path and one model, so a
loop that completes is a loop the proxy relayed correctly. An engine start costs about five seconds:
four family loops run side by side, and the faults (retries, a key quoted in an error, a model the
engine does not know) are further providers of the same engine.
"""

import json
import sys
from decimal import Decimal
from fractions import Fraction
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fakes.wire.formats import AUTH_HEADER, FAMILIES, Family, auth_value, request_path
from fakes.wire.upstream import ScriptedUpstream
from opencode_native import DEFAULT_IDS, REAL_KEY, Outcome, Provider, Step, run_plan
from opencode_passthrough import (
    PRICE_BOOK_JSON,
    PRICES,
    WIRE,
    PassthroughEngine,
    passthrough_engine,
)

from code_reviewer_runner.dynamic_review.passthrough.engine_errors import model_not_found_for_turn
from code_reviewer_runner.dynamic_review.passthrough.pricing import call_cost
from code_reviewer_runner.result import ErrorCode
from passthrough_expect import usage_expected
from usage_calc import expected_cost

pytestmark = pytest.mark.engine

TOOL_ORDER = ["glob", "read", "grep", "read", "glob", "grep"]
CREDENTIAL_HEADERS = {
    "authorization",
    "x-api-key",
    "x-goog-api-key",
    "cookie",
    "proxy-authorization",
}
THINKING = "Let me look at the files."


def _quoting_401(upstream: ScriptedUpstream) -> None:
    """A 401 whose message quotes the key it was sent (the fault is cleared before every turn)."""
    upstream.quote_key = True
    upstream.fail_next(401)


def providers() -> list[Provider]:
    loops = [
        Provider(family, thinking=THINKING if family in ("messages", "google") else "")
        for family in FAMILIES
    ]
    return [
        *loops,
        # The same chat family, three more providers: faults leave their mark on a ledger.
        Provider("chat", id="acme-retry", model="acme-retry-9"),
        Provider("chat", id="acme-quote", model="acme-quote-9"),
        Provider("chat", id="acme-errevent", model="acme-errevent-9"),
    ]


def plan() -> list[Step]:
    steps = [
        Step(f"loop-{family}", DEFAULT_IDS[family][0], DEFAULT_IDS[family][1])
        for family in FAMILIES
    ]
    return [
        *steps,
        Step(
            "retry",
            "acme-retry",
            "acme-retry-9",
            faults=lambda upstream: upstream.fail_next(429, 429),
        ),
        Step(
            "errevent",
            "acme-errevent",
            "acme-errevent-9",
            faults=lambda upstream: upstream.error_in_stream(after_events=1, times=1),
        ),
        Step(
            "quote",
            "acme-quote",
            "acme-quote-9",
            faults=_quoting_401,
        ),
    ]


@pytest.fixture(scope="module")
def run(tmp_path_factory: pytest.TempPathFactory):  # type: ignore[no-untyped-def]
    scratch = tmp_path_factory.mktemp("passthrough")
    with passthrough_engine(scratch, providers()) as engine:
        outcomes = run_plan(engine, plan())
        # A model the engine's configuration does not offer: no call reaches the proxy at all.
        unknown = engine.turn(DEFAULT_IDS["chat"][0], "retired-model-1")
        yield engine, outcomes, unknown


def _prices_of(outcome: Outcome, family: Family) -> Decimal:
    total = Decimal(0)
    for call in range(1, len(outcome.records) + 1):
        usage = usage_expected(call, WIRE[family])
        cost = call_cost(usage, PRICES)
        assert cost is not None
        # An independent calculator prices the same usage the same way (#551-T08).
        assert Fraction(cost) == expected_cost(
            PRICE_BOOK_JSON,
            prompt=usage.prompt_tokens,
            completion=usage.completion_tokens,
            read=usage.cache_read,
            write_5m=usage.cache_write_5m,
            write_1h=usage.cache_write_1h,
            reasoning=usage.reasoning_tokens,
        )
        total += cost
    return total


# #550-T14
@pytest.mark.parametrize("family", FAMILIES)
def test_the_engine_runs_a_tool_loop_through_the_passthrough_and_the_fake_saw_the_real_key_only(
    run: Any, family: Family
) -> None:
    engine: PassthroughEngine
    outcomes: dict[str, Outcome]
    engine, outcomes, _ = run
    outcome = outcomes[f"loop-{family}"]
    assert outcome.http_status == 200
    assistant_tools = [tool for step in outcome.assistants for tool in step.tools]
    assert assistant_tools == TOOL_ORDER
    assert all(step.error is None for step in outcome.assistants)
    front = engine.front(DEFAULT_IDS[family][0])
    assert len(outcome.records) == 7  # six tool steps and the answer
    for record in outcome.records:
        # The strict fake only answers the real key in the real header; no other credential came.
        assert record.headers[AUTH_HEADER[family]] == auth_value(family, REAL_KEY)
        assert not CREDENTIAL_HEADERS & set(record.headers) - {AUTH_HEADER[family]}
        assert front.capability not in json.dumps(record.headers) + json.dumps(record.body)
        assert record.headers["accept-encoding"] == "identity"
        assert record.method == "POST"
        assert record.target.split("?")[0] == request_path(
            family, DEFAULT_IDS[family][1], streaming=True
        )
    # The engine's own caching marks reached the provider as the engine wrote them.
    if family == "messages":
        assert "cache_control" in json.dumps(outcome.records[0].body)
    if family == "responses":
        assert "prompt_cache_key" in outcome.records[0].body
    # The ledger counted every call, at the price of the usage the tee read from the bytes.
    usage = front.ledger.usage(DEFAULT_IDS[family][1])
    assert front.ledger.failure is None
    assert usage.ai_calls == 7
    assert usage.cost_usd == pytest.approx(float(_prices_of(outcome, family)))
    assert usage.prompt_tokens == sum(
        usage_expected(call, WIRE[family]).prompt_tokens for call in range(1, 8)
    )


# #550-T14
def test_the_retries_of_the_engine_are_calls_of_their_own(run: Any) -> None:
    engine: PassthroughEngine
    engine, outcomes, _ = run
    outcome = outcomes["retry"]
    assert outcome.http_status == 200
    assert [tool for step in outcome.assistants for tool in step.tools] == TOOL_ORDER
    front = engine.front("acme-retry")
    # Two 429s, then the seven calls of the loop: nine upstream calls, nine in the ledger.
    assert len(outcome.records) == 9
    usage = front.ledger.usage("acme-retry-9")
    assert usage.ai_calls == 9
    # The refusals cost nothing; the loop is priced as any other.
    assert usage.cost_usd == pytest.approx(
        float(
            sum(
                (call_cost(usage_expected(call, WIRE["chat"]), PRICES) or Decimal(0))
                for call in range(1, 8)
            )
        )
    )
    assert front.ledger.failure is None
    # The engine retried the 429s and the loop went through: the code is the last call's (#552-N2).
    assert front.proxy.last_upstream_error is None


# #550-T10
def test_an_error_that_quotes_the_key_reaches_the_engine_without_it(run: Any) -> None:
    engine: PassthroughEngine
    engine, outcomes, _ = run
    outcome = outcomes["quote"]
    # The provider's 401 quoted the key it was sent (the real one); the engine's error does not.
    assert len(outcome.records) == 1
    assert REAL_KEY in outcome.records[0].headers[AUTH_HEADER["chat"]]
    errors = [step.error for step in outcome.assistants if step.error is not None]
    assert errors, outcome.reply
    shown = json.dumps(errors) + json.dumps(outcome.reply)
    assert REAL_KEY not in shown and REAL_KEY[:12] not in shown
    # The provider's words are not passed on, so there is nothing to cut: our sentence is.
    assert "the model provider refused the request" in shown
    failure = engine.front("acme-quote").ledger.failure
    assert failure is not None and failure.code is ErrorCode.LLM_AUTH
    assert REAL_KEY[:12] not in failure.detail
    assert REAL_KEY not in engine.log()


# #550-T10
def test_a_model_the_engine_does_not_offer_is_unknown_and_reaches_no_provider(run: Any) -> None:
    engine: PassthroughEngine
    engine, _, unknown = run
    assert unknown.http_status == 500
    assert unknown.records == []
    assert model_not_found_for_turn(unknown.http_status, unknown.reply, upstream_calls=0)
    assert engine.front(DEFAULT_IDS["chat"][0]).ledger.failure is None


# #550-R2-N3
def test_an_error_event_in_a_stream_reaches_the_engine_as_our_fixed_event_and_is_retried(
    run: Any,
) -> None:
    engine: PassthroughEngine
    engine, outcomes, _ = run
    outcome = outcomes["errevent"]
    # The fixed event is an error to the engine like the provider's was: it retries the call.
    assert outcome.http_status == 200
    assert [tool for step in outcome.assistants for tool in step.tools] == TOOL_ORDER
    assert len(outcome.records) == 8  # the call with the error event, then the seven of the loop
    front = engine.front("acme-errevent")
    assert front.ledger.unknown_calls == 1
    # The call may have been billed and its usage is unknown: a managed run ends there.
    assert front.ledger.failure is not None
    assert front.ledger.failure.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED
    assert "overloaded" not in engine.log()
