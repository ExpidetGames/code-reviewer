# SPDX-License-Identifier: Apache-2.0

"""What a call of an own key counts against the token cap when its cost is unknown (#553, review of
PR #577).

The cap counts tokens, so a call whose usage is stated but not trusted must not be counted by the
counts alone: a provider that states reasoning on top of the completion (xAI) or a total above the
sum of the counts (Gemini with a part we do not model) has used more. The call is booked at the
largest of what it states. One factory makes the ledger and the proxy of a policy, so the two can
never disagree about whose key it is.
"""

import json
import secrets
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from passthrough_support import ALLOWANCE, MODEL, REAL_KEY, Rig, Scripted, ScriptedUpstream

from code_reviewer_runner.dynamic_review.budget import DynamicLimits
from code_reviewer_runner.dynamic_review.passthrough.admission import PassthroughTarget
from code_reviewer_runner.dynamic_review.passthrough.cost_policy import CostPolicy, KeyMode
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily
from code_reviewer_runner.dynamic_review.passthrough.native_run import build_native_run
from code_reviewer_runner.dynamic_review.passthrough.usage_normalize import normalize
from code_reviewer_runner.result import ErrorCode

OWN = CostPolicy(key_mode=KeyMode.OWN, book=None, max_total_tokens=4_000_000)


def own_rig(family: WireFamily, *answers: Scripted) -> Rig:
    capability = secrets.token_urlsafe(32)
    run = build_native_run(
        OWN,
        DynamicLimits(),
        window_tokens=1_000_000,
        output_tokens=ALLOWANCE,
        target=PassthroughTarget(family=family, model=MODEL, output_allowance=ALLOWANCE),
        upstream=ScriptedUpstream(*answers),
        upstream_api_key=REAL_KEY,
        capability=capability,
    )
    return Rig(run.proxy, run.ledger, run.upstream, family, capability, [0.0])  # type: ignore[arg-type]


def chat_with(usage: dict[str, Any]) -> Scripted:
    finish: dict[str, Any] = {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
    return Scripted(
        chunks=[
            f"data: {json.dumps(finish)}\n\n".encode(),
            f"data: {json.dumps({'choices': [], 'usage': usage})}\n\n".encode(),
            b"data: [DONE]\n\n",
        ]
    )


def google_with(usage: dict[str, Any]) -> Scripted:
    chunk = {
        "candidates": [
            {"content": {"role": "model", "parts": [{"text": "ok"}]}, "finishReason": "STOP"}
        ],
        "usageMetadata": usage,
    }
    return Scripted(chunks=[f"data: {json.dumps(chunk)}\n\n".encode()])


CHAT_REASONING_ON_TOP: dict[str, Any] = {
    "prompt_tokens": 1000,
    "completion_tokens": 100,
    "total_tokens": 5000,
    "completion_tokens_details": {"reasoning_tokens": 3900},
}
GOOGLE_TOTAL_ABOVE_PARTS: dict[str, Any] = {
    "promptTokenCount": 1000,
    "candidatesTokenCount": 100,
    "totalTokenCount": 9000,
}


# #577-L1
def test_the_parsers_keep_the_total_the_provider_states() -> None:
    chat = normalize(WireFamily.OPENAI_CHAT, CHAT_REASONING_ON_TOP)
    google = normalize(WireFamily.GOOGLE, GOOGLE_TOTAL_ABOVE_PARTS)
    plain = normalize(WireFamily.OPENAI_CHAT, {"prompt_tokens": 10, "completion_tokens": 5})
    assert chat is not None and chat.stated_total == 5000
    assert google is not None and google.stated_total == 9000
    assert plain is not None and plain.stated_total is None


# #577-L1
def test_a_chat_usage_with_reasoning_on_top_books_what_it_states_in_all() -> None:
    r = own_rig(WireFamily.OPENAI_CHAT, chat_with(CHAT_REASONING_ON_TOP))
    r.post(r.body())
    assert r.ledger.failure is None
    assert r.ledger.tokens_used >= 5000
    assert r.ledger.usage(MODEL).cost_usd is None


# #577-L1
def test_a_google_usage_whose_total_is_above_its_parts_books_the_total() -> None:
    r = own_rig(WireFamily.GOOGLE, google_with(GOOGLE_TOTAL_ABOVE_PARTS))
    r.post(r.body())
    assert r.ledger.failure is None
    assert r.ledger.tokens_used >= 9000


# #577-L1
def test_a_call_that_states_nothing_unusual_books_its_counts() -> None:
    r = own_rig(
        WireFamily.OPENAI_CHAT,
        chat_with(
            {
                "prompt_tokens": 1000,
                "completion_tokens": 100,
                "total_tokens": 1100,
                "prompt_tokens_details": {"audio_tokens": 3},
            }
        ),
    )
    r.post(r.body())
    assert r.ledger.tokens_used == 1100


# #577-NIT factory
@pytest.mark.parametrize("mode", [KeyMode.OWN, KeyMode.MANAGED])
def test_the_factory_makes_the_ledger_and_the_proxy_of_one_policy(mode: KeyMode) -> None:
    book = {"input": "3000000", "output": "15000000"}
    from code_reviewer_runner.dynamic_review.passthrough.cost_policy import parse_cost_policy

    policy = parse_cost_policy(
        {
            "keyMode": mode.value,
            "priceBook": book,
            "maxTotalTokens": 4_000_000 if mode is KeyMode.OWN else None,
        }
    )
    run = build_native_run(
        policy,
        DynamicLimits(),
        window_tokens=1_000_000,
        output_tokens=ALLOWANCE,
        target=PassthroughTarget(
            family=WireFamily.OPENAI_CHAT, model=MODEL, output_allowance=ALLOWANCE
        ),
        upstream=ScriptedUpstream(Scripted()),
        upstream_api_key=REAL_KEY,
        capability=secrets.token_urlsafe(32),
    )
    # The same fact on both sides: an unknown call ends a managed run and is booked by an own key.
    assert run.proxy.ends_run_on_unknown_cost is (mode is KeyMode.MANAGED)
    assert run.ledger.tolerates_unknown_cost is (mode is KeyMode.OWN)
    assert run.ledger.priced is True


# #577-NIT factory
def test_the_factory_refuses_a_policy_the_ledger_cannot_carry() -> None:
    from code_reviewer_runner.dynamic_review.budget import LimitError

    with pytest.raises(LimitError) as raised:
        build_native_run(
            CostPolicy(key_mode=KeyMode.MANAGED, book=None, max_total_tokens=None),
            DynamicLimits(),
            window_tokens=1_000_000,
            output_tokens=ALLOWANCE,
            target=PassthroughTarget(
                family=WireFamily.OPENAI_CHAT, model=MODEL, output_allowance=ALLOWANCE
            ),
            upstream=ScriptedUpstream(Scripted()),
            upstream_api_key=REAL_KEY,
            capability=secrets.token_urlsafe(32),
        )
    assert raised.value.code is ErrorCode.DYNAMIC_CONFIG_INVALID
