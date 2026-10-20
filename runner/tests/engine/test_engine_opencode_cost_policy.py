# SPDX-License-Identifier: Apache-2.0

"""The real pinned OpenCode under the cost policy of an own key whose model nobody priced (#553).

An own key is free to choose any model, so a price may be missing. Through the production proxy and
the ledger a native job builds, the engine runs a tool loop on a model with no price: the loop
completes under the token cap and the cost of the run is unknown (`costUsd` null, never zero), and
the production adapter on the native path (#552) finishes a run that reaches its cap the way it
finishes one that reaches its cost limit: the model is asked to answer, a model that ignores the
message is refused and asked once more, and the review is delivered with `stoppedEarly:
token_limit`. Kept lean.
"""

import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fakes.wire.formats import Turn
from opencode_native import Outcome, Provider, Step, run_plan
from opencode_passthrough import PassthroughEngine, passthrough_engine
from plain_final_support import native_run, reads, review
from test_engine_plain_final import answer_when_asked, many_reads

from code_reviewer_runner.dynamic_review.passthrough.cost_policy import (
    CostPolicy,
    KeyMode,
)
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily
from passthrough_expect import usage_expected

pytestmark = pytest.mark.engine

TOOL_ORDER = ["glob", "read", "grep", "read", "glob", "grep"]
ROOMY = "acme-unpriced"


def policies() -> dict[str, CostPolicy]:
    return {ROOMY: unpriced(1_000_000)}


@pytest.fixture(scope="module")
def run(tmp_path_factory: pytest.TempPathFactory):  # type: ignore[no-untyped-def]
    scratch = tmp_path_factory.mktemp("cost-policy")
    providers = [
        Provider("chat", id=ROOMY, model="acme-unpriced-9"),
    ]
    with passthrough_engine(scratch, providers, policies=policies()) as engine:
        outcomes = run_plan(
            engine,
            [
                Step("roomy", ROOMY, "acme-unpriced-9"),
            ],
        )
        yield engine, outcomes


# #553-T05
def test_an_unpriced_model_completes_its_loop_under_the_token_cap_and_its_cost_is_unknown(
    run: Any,
) -> None:
    engine: PassthroughEngine
    outcomes: dict[str, Outcome]
    engine, outcomes = run
    outcome = outcomes["roomy"]
    assert outcome.http_status == 200
    assert [tool for step in outcome.assistants for tool in step.tools] == TOOL_ORDER
    assert len(outcome.records) == 7
    front = engine.front(ROOMY)
    assert front.ledger.failure is None
    usage = front.ledger.usage("acme-unpriced-9")
    # Seven calls whose tokens were read: counted, and their cost not known (null, not zero).
    assert usage.ai_calls == 7
    assert usage.cost_usd is None
    assert usage.prompt_tokens == sum(
        usage_expected(call, WireFamily.OPENAI_CHAT).prompt_tokens for call in range(1, 8)
    )
    assert usage.limit_exceeded_by is None


def unpriced(cap: int) -> CostPolicy:
    return CostPolicy(key_mode=KeyMode.OWN, book=None, max_total_tokens=cap)


# #553-T05, #552: the sister of the cost-limit cases of `test_engine_plain_final.py` for an own key
# with no price. The cap is reached long before the script is out of tool calls; the model that is
# asked to answer does, and the review is delivered with the reason it stopped
def test_an_own_key_run_at_its_token_cap_is_asked_to_answer_and_delivers_its_review(
    tmp_path: Path,
) -> None:
    with native_run(
        tmp_path, many_reads, policy=unpriced(6_000), react=answer_when_asked(times=1)
    ) as run:
        assert run.answer.ok, run.answer.error
        usage = run.ledger.usage(None)
        assert usage.stopped_early == "token_limit"
        assert usage.cost_usd is None
        assert run.ledger.failure is None
        assert len(run.requests) < 36  # the script had far more calls than the cap admits


# #553-T05, #552: the model ignores the message; the ledger refuses its next call for the tokens,
# the adapter aborts the turn and asks once more, the answer is admitted past the cap, and the
# review is delivered
def test_an_own_key_model_that_ignores_the_message_still_delivers_a_review_past_the_cap(
    tmp_path: Path,
) -> None:
    with native_run(
        tmp_path, many_reads, policy=unpriced(6_000), react=answer_when_asked(times=2)
    ) as run:
        assert run.answer.ok, run.answer.error
        usage = run.ledger.usage(None)
        assert usage.stopped_early == "token_limit"
        assert usage.cost_usd is None
        assert run.ledger.failure is None
        assert run.ledger.refusals >= 1
        assert run.ledger.refusal_reason == "token_limit"


# #553-T05: a run that stays within its cap is a complete run with an unknown cost
def test_an_own_key_run_within_its_cap_is_complete_and_its_cost_is_unknown(
    tmp_path: Path,
) -> None:
    with native_run(
        tmp_path, lambda export: [*reads(export, 3), Turn(text=review())], policy=unpriced(500_000)
    ) as run:
        assert run.answer.ok, run.answer.error
        usage = run.ledger.usage(None)
        assert usage.stopped_early is None and usage.cost_usd is None
