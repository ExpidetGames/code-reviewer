# SPDX-License-Identifier: Apache-2.0

"""The real pinned OpenCode under the cost policy of an own key whose model nobody priced (#553).

An own key is free to choose any model, so a price may be missing. Through the production proxy and
the ledger a native job builds, the engine runs a tool loop on a model with no price: the loop
completes under the token cap, the cost of the run is unknown (`costUsd` null, never zero) and
billing charges minutes only; the same loop under a small cap is braked by the cap before the
provider is asked again. Kept lean: one engine, two providers of one family.
"""

import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from opencode_native import Outcome, Provider, Step, run_plan
from opencode_passthrough import PassthroughEngine, passthrough_engine

from code_reviewer_runner.dynamic_review.passthrough.cost_policy import (
    CostPolicy,
    KeyMode,
)
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily
from code_reviewer_runner.result import ErrorCode
from passthrough_expect import usage_expected

pytestmark = pytest.mark.engine

TOOL_ORDER = ["glob", "read", "grep", "read", "glob", "grep"]
ROOMY = "acme-unpriced"
TIGHT = "acme-capped"


def policies() -> dict[str, CostPolicy]:
    unpriced = {"book": None, "key_mode": KeyMode.OWN}
    return {
        ROOMY: CostPolicy(max_total_tokens=1_000_000, **unpriced),  # type: ignore[arg-type]
        # Three calls' worth: the cap stops the loop where it would otherwise go on for seven.
        TIGHT: CostPolicy(max_total_tokens=4_500, **unpriced),  # type: ignore[arg-type]
    }


@pytest.fixture(scope="module")
def run(tmp_path_factory: pytest.TempPathFactory):  # type: ignore[no-untyped-def]
    scratch = tmp_path_factory.mktemp("cost-policy")
    providers = [
        Provider("chat", id=ROOMY, model="acme-unpriced-9"),
        Provider("chat", id=TIGHT, model="acme-capped-9"),
    ]
    with passthrough_engine(scratch, providers, policies=policies()) as engine:
        outcomes = run_plan(
            engine,
            [
                Step("roomy", ROOMY, "acme-unpriced-9"),
                Step("tight", TIGHT, "acme-capped-9"),
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


# #553-T05
def test_a_run_that_reaches_its_token_cap_is_braked_before_the_provider_is_asked_again(
    run: Any,
) -> None:
    engine: PassthroughEngine
    outcomes: dict[str, Outcome]
    engine, outcomes = run
    outcome = outcomes["tight"]
    front = engine.front(TIGHT)
    # The cap is reached long before the loop's seventh call, and the provider is not asked again.
    assert 1 <= len(outcome.records) < 7
    assert front.ledger.failure is not None
    assert front.ledger.failure.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert "token" in front.ledger.failure.detail
    usage = front.ledger.usage("acme-capped-9")
    assert usage.cost_usd is None
    assert usage.prompt_tokens + usage.completion_tokens <= 4_500 + 2_000
