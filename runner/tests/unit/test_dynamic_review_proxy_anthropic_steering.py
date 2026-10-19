# SPDX-License-Identifier: Apache-2.0

"""The model proxy with a model that refuses a forced tool choice and always thinks (#533).

The upstream here is the strict fake of the Claude Messages API (`fakes/llm/anthropic_rules.py`):
it answers a 400 for a forced choice, for `thinking: disabled`, for thinking blocks that do not
come back as issued and for a conversation whose tool set changed without `drop_block`. The proxy
has to get a whole Dynamic run through it: the engine's calls (`required` on every one), the
thinking turns, the wrap-up that cuts the tools down to the return tool, and the retry of a final
call that answered in prose. Every call is settled with the cost computed from its usage."""

import json
import sys
from decimal import Decimal
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.llm.anthropic_rules import StrictMessagesApi

from code_reviewer_runner.dynamic_review.budget import BudgetLedger, DynamicLimits, UnitCosts
from code_reviewer_runner.dynamic_review.config import new_proxy_capability
from code_reviewer_runner.dynamic_review.proxy import (
    ModelProxy,
    ProxyResponse,
    capabilities_from_config,
    with_reserved_output,
)
from code_reviewer_runner.llm_providers import ANTHROPIC

KEY = "dummy-anthropic-api03-workspace-key-0123456789"
CAPABILITY = new_proxy_capability()
MODEL = "claude-sonnet-5-5"
URL = "https://api.anthropic.com/v1/messages"
CAPABILITIES = json.dumps(
    {"tool_choice_required": True, "structured_output": True, "max_output_tokens": 8192}
)
# Sonnet 5.5: $2 in and $10 out per million tokens.
UNIT_COSTS = UnitCosts(input_usd_per_mtok=Decimal(2), output_usd_per_mtok=Decimal(10))
THINK = {"type": "thinking", "thinking": "", "signature": "sig-one"}
REDACTED = {"type": "redacted_thinking", "data": "opaque-one"}
REVIEW: dict[str, Any] = {"findings": [], "resolvedIds": []}
READ_TOOL = {
    "type": "function",
    "function": {
        "name": "read",
        "description": "Read a file",
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}}},
    },
}
STRUCTURED_TOOL = {
    "type": "function",
    "function": {
        "name": "StructuredOutput",
        "parameters": {
            "type": "object",
            "properties": {
                "findings": {
                    "type": "array",
                    "maxItems": 5,
                    "items": {
                        "type": "object",
                        "properties": {"id": {"type": "string", "maxLength": 128}},
                        "required": ["id"],
                    },
                },
                "resolvedIds": {"type": "array", "items": {"type": "string", "maxLength": 128}},
            },
            "required": ["findings", "resolvedIds"],
        },
    },
}
TOOLS = [READ_TOOL, STRUCTURED_TOOL]


class StrictUpstream:
    """The Claude API as the strict fake knows it, answering the script of the test."""

    def __init__(self, *answers: dict[str, Any]) -> None:
        self.api = StrictMessagesApi()
        self.answers = list(answers)
        self.requests: list[tuple[dict[str, str], dict[str, Any]]] = []

    def __call__(
        self, url: str, body: bytes, headers: dict[str, str], limit: int
    ) -> tuple[int, bytes]:
        request: dict[str, Any] = json.loads(body)
        self.requests.append((headers, request))
        refusal = self.api.check(headers, request)
        if refusal is not None:
            return refusal[0], json.dumps(refusal[1]).encode("utf-8")
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        answer = self.shape(request, answer)
        self.api.record(request, answer)
        return 200, json.dumps(answer).encode("utf-8")

    def shape(self, request: dict[str, Any], answer: dict[str, Any]) -> dict[str, Any]:
        """What the model makes of the scripted answer; the base class gives it as it is."""
        return answer


def message(content: list[dict[str, Any]], stop_reason: str, **usage: Any) -> dict[str, Any]:
    return {
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "model": MODEL,
        "content": content,
        "stop_reason": stop_reason,
        "usage": {"input_tokens": 10, "output_tokens": 5, **usage},
    }


def tool_use(call_id: str, name: str = "read", **arguments: Any) -> dict[str, Any]:
    return {"type": "tool_use", "id": call_id, "name": name, "input": arguments}


def proxy(upstream: StrictUpstream, ledger: BudgetLedger | None = None) -> ModelProxy:
    return ModelProxy(
        ledger=ledger or BudgetLedger(DynamicLimits(), unit_costs=UNIT_COSTS),
        base_path="/v1",
        model=MODEL,
        upstream_url=URL,
        upstream_api_key=KEY,
        upstream_model=MODEL,
        capabilities=capabilities_from_config(CAPABILITIES),
        capability=CAPABILITY,
        post=upstream,
        provider=ANTHROPIC,
    )


def engine_request(*history: dict[str, Any], model: str = MODEL) -> dict[str, Any]:
    """What the pinned engine sends: `required` on every call, whatever the turn."""
    return {
        "model": model,
        "messages": [
            {"role": "system", "content": "You review code."},
            {"role": "user", "content": "review this change"},
            *history,
        ],
        "tools": TOOLS,
        "tool_choice": "required",
        "stream": True,
    }


def asks(call_id: str, path: str) -> list[dict[str, Any]]:
    """The assistant turn the engine keeps after a tool call, and the result it adds."""
    return [
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": call_id,
                    "type": "function",
                    "function": {"name": "read", "arguments": json.dumps({"path": path})},
                }
            ],
        },
        {"role": "tool", "tool_call_id": call_id, "content": f"contents of {path}"},
    ]


def post(subject: ModelProxy, body: dict[str, Any]) -> ProxyResponse:
    return subject.handle(
        "POST",
        "/v1/chat/completions",
        json.dumps(body).encode("utf-8"),
        {"Authorization": f"Bearer {CAPABILITY}"},
    )


def completion(response: ProxyResponse) -> dict[str, Any]:
    """The chat completion behind a streamed answer, as the engine would assemble it."""
    assert response.status == 200, response.body
    message: dict[str, Any] = {"role": "assistant", "content": ""}
    calls: dict[int, dict[str, Any]] = {}
    for line in response.body.decode().splitlines():
        if not line.startswith("data: {"):
            continue
        delta: dict[str, Any] = json.loads(line.removeprefix("data: "))["choices"][0]["delta"]
        message["content"] += delta.get("content") or ""
        streamed: list[dict[str, Any]] = delta.get("tool_calls") or []
        for call in streamed:
            entry = calls.setdefault(call["index"], {"function": {"name": "", "arguments": ""}})
            entry["id"] = call.get("id", entry.get("id"))
            entry["function"]["name"] += call["function"].get("name") or ""
            entry["function"]["arguments"] += call["function"].get("arguments") or ""
    if calls:
        message["tool_calls"] = list(calls.values())
    return message


def sent(upstream: StrictUpstream, index: int) -> dict[str, Any]:
    return upstream.requests[index][1]


# #539-T17
# #533-T11
def test_a_steered_tool_loop_with_thinking_runs_through_the_strict_api_and_is_costed_exactly() -> (
    None
):
    upstream = StrictUpstream(
        message([THINK, REDACTED, tool_use("toolu_1", path="a.py")], "tool_use"),
        message([THINK, tool_use("toolu_2", path="b.py")], "tool_use"),
        message(
            [THINK, tool_use("toolu_3", "StructuredOutput", **REVIEW)],
            "tool_use",
            output_tokens=900,
            output_tokens_details={"thinking_tokens": 600},
        ),
    )
    subject = proxy(upstream)

    first = completion(post(subject, engine_request()))
    second = completion(post(subject, engine_request(*asks("toolu_1", "a.py"))))
    third = completion(
        post(subject, engine_request(*asks("toolu_1", "a.py"), *asks("toolu_2", "b.py")))
    )

    # Nothing of the thinking reached the engine, and the call it asked for is the call it got.
    assert "sig-one" not in json.dumps([first, second, third])
    assert third["tool_calls"][0]["function"]["name"] == "StructuredOutput"
    for _, body in upstream.requests:
        assert body["tool_choice"] == {"type": "auto"}
        assert body["system"][0]["text"].startswith("You review code.\n\n")
        assert [tool["name"] for tool in body["tools"]] == ["read", "StructuredOutput"]
        assert "strict" not in body["tools"][0]
        assert body["tools"][1]["strict"] is True
        assert body["thinking"]["block_binding"] == {"prefix_mismatch_behavior": "drop_block"}
    # The blocks of an answer come back with the tool call they accompanied, in order.
    assert sent(upstream, 1)["messages"][1]["content"][:2] == [THINK, REDACTED]
    assert sent(upstream, 2)["messages"][1]["content"][:2] == [THINK, REDACTED]
    assert sent(upstream, 2)["messages"][3]["content"][0] == THINK
    usage = subject.ledger.usage(MODEL)
    assert usage.ai_calls == 3
    assert usage.cost_usd is not None
    # $2 in, $10 out per million tokens; the thinking tokens are a part of the 900 output tokens.
    assert (
        Decimal(repr(usage.cost_usd))
        == (Decimal(10) * 2 * 3 + (Decimal(5) + Decimal(5) + Decimal(900)) * 10) / 1_000_000
    )


# #533-T11
def test_the_strict_api_refuses_what_the_proxy_would_send_without_the_translation() -> None:
    api = StrictMessagesApi()

    forced = api.check({}, {"model": MODEL, "tool_choice": {"type": "any"}})
    disabled = api.check({}, {"model": MODEL, "thinking": {"type": "disabled"}})

    assert forced is not None and forced[0] == 400
    assert disabled is not None and disabled[0] == 400


# #533-T12
def test_a_final_call_that_answers_in_prose_is_asked_again_and_the_review_is_taken() -> None:
    upstream = StrictUpstream(
        message([THINK, {"type": "text", "text": "Here is my review: no findings."}], "end_turn"),
        message([THINK, tool_use("toolu_9", "StructuredOutput", **REVIEW)], "tool_use"),
    )
    # The limit leaves room for one call: the first call is the final one.
    subject = proxy(
        upstream, BudgetLedger(DynamicLimits(max_cost_usd=Decimal("0.1")), unit_costs=UNIT_COSTS)
    )

    reply = completion(post(subject, engine_request()))

    assert reply["tool_calls"][0]["function"]["name"] == "StructuredOutput"
    assert json.loads(reply["tool_calls"][0]["function"]["arguments"]) == REVIEW
    assert len(upstream.requests) == 2
    final = sent(upstream, 0)
    # The return tool alone, with the choice that the model refuses given as `auto`, and the
    # runner's instruction last.
    assert [tool["name"] for tool in final["tools"]] == ["StructuredOutput"]
    assert final["tool_choice"] == {"type": "auto"}
    assert "Return the complete review now" in json.dumps(final["messages"][-1])
    retry = sent(upstream, 1)
    assert "did not return the review" in json.dumps(retry["messages"][-1])
    assert retry["tool_choice"] == {"type": "auto"}


# #533-T13
def test_the_wrap_up_after_thinking_turns_changes_the_tool_set_and_the_strict_api_takes_it() -> (
    None
):
    upstream = StrictUpstream(
        message([THINK, REDACTED, tool_use("toolu_1", path="a.py")], "tool_use"),
        message([THINK, tool_use("toolu_2", "StructuredOutput", **REVIEW)], "tool_use"),
    )
    subject = proxy(upstream)
    assert post(subject, engine_request()).status == 200
    assert subject.ledger.begin_recovery() is True

    reply = completion(post(subject, engine_request(*asks("toolu_1", "a.py"))))

    assert reply["tool_calls"][0]["function"]["name"] == "StructuredOutput"
    wrap_up = sent(upstream, 1)
    # Another tool set than the call that issued the blocks: only `drop_block` makes that a
    # degraded call and not a 400 on an account that is checked.
    assert [tool["name"] for tool in wrap_up["tools"]] == ["StructuredOutput"]
    assert wrap_up["thinking"]["block_binding"]["prefix_mismatch_behavior"] == "drop_block"
    assert upstream.requests[1][0]["anthropic-beta"] == "thinking-binding-controls-2026-08-01"
    assert wrap_up["messages"][1]["content"][:2] == [THINK, REDACTED]


class ThinkingUpstream(StrictUpstream):
    """A strict upstream whose model thinks first: the thinking and the answer together count
    against `max_tokens`, and a call that needs more is cut off with `stop_reason: max_tokens` and
    the tool call it had started, which has no arguments (a hard cap of the real API)."""

    def __init__(self, thinking_tokens: int, answer_tokens: int, *answers: dict[str, Any]) -> None:
        super().__init__(*answers)
        self.thinking_tokens = thinking_tokens
        self.answer_tokens = answer_tokens
        self.truncated = 0

    def shape(self, request: dict[str, Any], answer: dict[str, Any]) -> dict[str, Any]:
        needed = self.thinking_tokens + self.answer_tokens
        usage: dict[str, Any] = {"input_tokens": 10, "output_tokens": needed}
        if needed <= request["max_tokens"]:
            details = {"thinking_tokens": self.thinking_tokens}
            return {**answer, "usage": {**usage, "output_tokens_details": details}}
        self.truncated += 1
        calls: list[dict[str, Any]] = [
            block for block in answer["content"] if block["type"] == "tool_use"
        ]
        cut: list[dict[str, Any]] = [THINK, *({**call, "input": {}} for call in calls)]
        usage = {"input_tokens": 10, "output_tokens": request["max_tokens"]}
        return {**answer, "content": cut, "stop_reason": "max_tokens", "usage": usage}


OPUS = "claude-opus-5-5"
# Opus 5.5: $4 in and $20 out per million tokens.
OPUS_COSTS = UnitCosts(input_usd_per_mtok=Decimal(4), output_usd_per_mtok=Decimal(20))


def thinking_proxy(upstream: StrictUpstream, allowance: int) -> ModelProxy:
    """A proxy for Opus 5.5 as a job runs it: the descriptor gives `allowance` and the ledger is
    built by the runner's rule (`with_reserved_output`)."""
    capabilities = with_reserved_output(
        capabilities_from_config(
            json.dumps(
                {
                    "tool_choice_required": True,
                    "structured_output": True,
                    "max_output_tokens": allowance,
                }
            )
        ),
        ANTHROPIC.wire(OPUS),
    )
    ledger = BudgetLedger(
        DynamicLimits(),
        output_tokens=capabilities.max_output_tokens,
        reserved_output_tokens=capabilities.reserved_output_tokens,
        unit_costs=OPUS_COSTS,
    )
    return ModelProxy(
        ledger=ledger,
        base_path="/v1",
        model=OPUS,
        upstream_url=URL,
        upstream_api_key=KEY,
        upstream_model=OPUS,
        capabilities=capabilities,
        capability=CAPABILITY,
        post=upstream,
        provider=ANTHROPIC,
    )


# #533-T22
def test_a_model_that_spends_most_of_the_allowance_on_thinking_still_gets_a_complete_answer() -> (
    None
):
    answer = message([THINK, tool_use("toolu_1", "StructuredOutput", **REVIEW)], "tool_use")
    # 28000 tokens of thinking and 2000 of review: more than the old allowance of 8192 by far.
    upstream = ThinkingUpstream(28_000, 2_000, answer)
    subject = thinking_proxy(upstream, 32_768)

    reply = completion(post(subject, engine_request(model=OPUS)))

    assert upstream.truncated == 0
    assert sent(upstream, 0)["max_tokens"] == 32_768
    assert reply["tool_calls"][0]["function"]["name"] == "StructuredOutput"
    assert json.loads(reply["tool_calls"][0]["function"]["arguments"]) == REVIEW
    # The reservation of a first call was the realistic part of the allowance, so the call was an
    # ordinary one and the run was not wrapped up; the cost is the usage's, thinking priced once.
    assert subject.ledger.stopped_early is None
    usage = subject.ledger.usage(OPUS)
    assert usage.cost_usd is not None
    assert Decimal(repr(usage.cost_usd)) == (Decimal(10 * 4) + Decimal(30_000 * 20)) / 1_000_000


# #533-T22
def test_the_same_thinking_exhausts_the_old_allowance_and_cuts_the_answer_off() -> None:
    answer = message([THINK, tool_use("toolu_1", "StructuredOutput", **REVIEW)], "tool_use")
    upstream = ThinkingUpstream(28_000, 2_000, answer)
    subject = thinking_proxy(upstream, 8_192)

    reply = completion(post(subject, engine_request(model=OPUS)))

    assert upstream.truncated >= 1
    assert sent(upstream, 0)["max_tokens"] == 8_192
    assert json.loads(reply["tool_calls"][0]["function"]["arguments"]) != REVIEW


# #533-T21
def test_the_runner_reserves_a_realistic_output_for_a_model_that_always_thinks() -> None:
    thinking = with_reserved_output(
        capabilities_from_config(CAPABILITIES.replace("8192", "32768")), ANTHROPIC.wire(OPUS)
    )
    plain = with_reserved_output(
        capabilities_from_config(CAPABILITIES.replace("8192", "32768")),
        ANTHROPIC.wire("claude-haiku-5-5"),
    )

    assert thinking.max_output_tokens == 32_768
    assert thinking.reserved_output_tokens == 8_192
    assert plain.reserved_output_tokens == 32_768
