# SPDX-License-Identifier: Apache-2.0

"""The model proxy of a Dynamic Review with the Anthropic provider (#511).

The engine speaks the chat protocol to the proxy; the proxy speaks the Claude Messages API to the
provider (`anthropic_wire.py`) and keeps every guarantee it gives for any provider: the reservation
before the call, the provider's counters after it, the cost of every call in the ledger, stable
codes for every refusal, the key and the capability never in the wrong place. Here the cost of a
call is worked out from its usage and the price list, so an answer that cannot be priced stops the
run like an answer without a stated charge does for any other provider."""

import json
from decimal import Decimal
from typing import Any

import pytest
from anthropic_usage import real_anthropic_usage

from code_reviewer_runner.anthropic_models import MODELS
from code_reviewer_runner.dynamic_review.budget import BudgetLedger, DynamicLimits, UnitCosts
from code_reviewer_runner.dynamic_review.config import new_proxy_capability
from code_reviewer_runner.dynamic_review.proxy import (
    ModelProxy,
    ProxyResponse,
    capabilities_from_config,
)
from code_reviewer_runner.llm_providers import ANTHROPIC
from code_reviewer_runner.result import ErrorCode

KEY = "dummy-anthropic-api03-workspace-key-0123456789"
CAPABILITY = new_proxy_capability()
MODEL = "claude-sonnet-5"
URL = "https://api.anthropic.com/v1/messages"
CAPABILITIES = json.dumps(
    {"tool_choice_required": True, "structured_output": True, "max_output_tokens": 8192}
)
# What the descriptor of the model says: the dearest tier, to reserve against.
UNIT_COSTS = UnitCosts(input_usd_per_mtok=Decimal(2), output_usd_per_mtok=Decimal(10))

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "read",
            "description": "Read a file",
            "parameters": {"type": "object", "properties": {"path": {"type": "string"}}},
        },
    },
    {
        "type": "function",
        "function": {"name": "StructuredOutput", "parameters": {"type": "object"}},
    },
]


class Upstream:
    """A stand-in for the Claude API: records what it got and answers what the test scripts."""

    def __init__(self, *bodies: dict[str, Any], status: int = 200) -> None:
        self.bodies = list(bodies)
        self.status = status
        self.requests: list[tuple[str, dict[str, Any], dict[str, str]]] = []

    def __call__(
        self, url: str, body: bytes, headers: dict[str, str], limit: int
    ) -> tuple[int, bytes]:
        self.requests.append((url, json.loads(body), headers))
        answer = self.bodies.pop(0) if len(self.bodies) > 1 else self.bodies[0]
        return self.status, json.dumps(answer).encode("utf-8")


def message(
    content: list[dict[str, Any]] | None = None,
    stop_reason: str = "end_turn",
    **usage: Any,
) -> dict[str, Any]:
    return {
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "model": MODEL,
        "content": content if content is not None else [{"type": "text", "text": "ok"}],
        "stop_reason": stop_reason,
        # Every field the real API returns (#534), not only the token counts.
        "usage": real_anthropic_usage(**{"input_tokens": 10, "output_tokens": 5, **usage}),
    }


def tool_use(name: str = "read", **arguments: Any) -> dict[str, Any]:
    return message(
        [{"type": "tool_use", "id": "toolu_1", "name": name, "input": arguments}],
        "tool_use",
    )


def proxy(upstream: Upstream, model: str = MODEL, **overrides: Any) -> ModelProxy:
    configured: dict[str, Any] = {
        "ledger": BudgetLedger(DynamicLimits(), unit_costs=UNIT_COSTS),
        "base_path": "/v1",
        "model": model,
        "upstream_url": URL,
        "upstream_api_key": KEY,
        "upstream_model": model,
        "capabilities": capabilities_from_config(CAPABILITIES),
        "capability": CAPABILITY,
        "post": upstream,
        "provider": ANTHROPIC,
    }
    configured.update(overrides)
    return ModelProxy(**configured)


def chat(pad: int = 0, **extra: Any) -> dict[str, Any]:
    """A chat request. `pad` bytes of text make a prompt big enough for the tokens an answer
    reports: a provider never reports more tokens than the request has bytes."""
    body: dict[str, Any] = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": "You review code."},
            {"role": "user", "content": "review this change" + " x" * (pad // 2)},
        ],
        "tools": TOOLS,
        "tool_choice": "auto",
    }
    body.update(extra)
    return body


def post(subject: ModelProxy, body: dict[str, Any]) -> ProxyResponse:
    return subject.handle(
        "POST",
        "/v1/chat/completions",
        json.dumps(body).encode("utf-8"),
        {"Authorization": f"Bearer {CAPABILITY}"},
    )


def code(response: ProxyResponse) -> str:
    return str(json.loads(response.body)["error"]["code"])


# #539-T17
# #511-T26
def test_the_request_goes_to_the_messages_endpoint_with_the_key_in_the_header_of_the_api() -> None:
    upstream = Upstream(message())

    response = post(proxy(upstream), chat())

    assert response.status == 200
    url, body, headers = upstream.requests[0]
    assert url == URL
    assert headers["x-api-key"] == KEY
    assert headers["anthropic-version"] == "2023-06-01"
    assert "Authorization" not in headers
    assert CAPABILITY not in json.dumps(body) and CAPABILITY not in json.dumps(headers)
    assert body["model"] == MODEL
    assert body["system"] == [
        {"type": "text", "text": "You review code.", "cache_control": {"type": "ephemeral"}}
    ]
    assert body["messages"] == [
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "review this change",
                    "cache_control": {"type": "ephemeral"},
                }
            ],
        }
    ]
    assert body["thinking"] == {"type": "disabled"}
    assert body["tool_choice"] == {"type": "auto"}
    assert body["max_tokens"] <= 8192
    for field in ("stream", "provider", "stream_options"):
        assert field not in body


# #511-T26
def test_the_engine_gets_a_chat_completion_with_the_tool_calls_the_model_asked_for() -> None:
    subject = proxy(Upstream(tool_use("read", path="a.py")))

    response = post(subject, chat())

    completion = json.loads(response.body)
    choice = completion["choices"][0]
    assert choice["finish_reason"] == "tool_calls"
    call = choice["message"]["tool_calls"][0]
    assert call["id"] == "toolu_1"
    assert call["function"]["name"] == "read"
    assert json.loads(call["function"]["arguments"]) == {"path": "a.py"}


# #511-T26
def test_a_streamed_request_is_answered_as_a_stream_from_the_whole_translated_answer() -> None:
    upstream = Upstream(tool_use("read", path="a.py"))

    response = post(proxy(upstream), chat(stream=True, stream_options={"include_usage": True}))

    assert response.content_type == "text/event-stream"
    events = [
        json.loads(line.removeprefix("data: "))
        for line in response.body.decode().splitlines()
        if line.startswith("data: {")
    ]
    assert response.body.rstrip().endswith(b"data: [DONE]")
    call = events[0]["choices"][0]["delta"]["tool_calls"][0]
    assert call["function"]["name"] == "read"
    assert events[-1]["choices"][0]["finish_reason"] == "tool_calls"
    assert "stream" not in upstream.requests[0][1]


# #511-T26
def test_every_call_of_a_tool_loop_is_settled_with_its_exact_cost() -> None:
    upstream = Upstream(
        tool_use("read", path="a.py"),
        message(input_tokens=12_000, output_tokens=300),
        message(
            input_tokens=2000,
            output_tokens=700,
            cache_read_input_tokens=12_000,
            cache_creation_input_tokens=1000,
            cache_creation={"ephemeral_5m_input_tokens": 1000, "ephemeral_1h_input_tokens": 0},
        ),
    )
    subject = proxy(upstream)

    for _ in range(3):
        assert post(subject, chat(pad=40_000)).status == 200

    usage = subject.ledger.usage(MODEL)
    # Sonnet 5: $2 in, $10 out, $0.20 cache read, $2.50 cache write (5m) per million tokens.
    first = Decimal("10") * 2 + Decimal("5") * 10
    second = Decimal("12000") * 2 + Decimal("300") * 10
    third = (
        Decimal("2000") * 2
        + Decimal("700") * 10
        + Decimal("12000") * Decimal("0.20")
        + Decimal("1000") * Decimal("2.50")
    )
    assert usage.ai_calls == 3
    assert usage.cost_usd is not None
    assert Decimal(repr(usage.cost_usd)) == (first + second + third) / 1_000_000
    # The counters are the provider's, with the cache inside the prompt.
    assert usage.prompt_tokens == 10 + 12_000 + 15_000
    assert usage.completion_tokens == 5 + 300 + 700


# #511-T26
def test_the_cost_of_a_call_is_not_taken_from_anything_the_answer_claims() -> None:
    answer = message()
    answer["usage"]["cost"] = 99.0
    answer["usage"]["total_cost"] = 99.0
    subject = proxy(Upstream(answer))

    assert post(subject, chat()).status == 200

    # 10 input and 5 output tokens of Sonnet 5: 10 x 2 + 5 x 10 = 70 millionths of a dollar.
    assert Decimal(repr(subject.ledger.usage(MODEL).cost_usd)) == Decimal("0.00007")


# #511-T26
def test_the_fallback_to_the_higher_tier_of_haiku_is_priced_by_the_prompt_of_the_request() -> None:
    haiku = "claude-haiku-5-5"
    upstream = Upstream(message(input_tokens=150_000, output_tokens=1000))
    subject = proxy(
        upstream,
        haiku,
        ledger=BudgetLedger(
            DynamicLimits(),
            window_tokens=1_000_000,
            unit_costs=UnitCosts(Decimal("0.5"), Decimal("2.5")),
        ),
    )

    assert post(subject, chat(pad=160_000, model=haiku)).status == 200

    # $0.50 in and $2.50 out per million tokens for a prompt over 100000 tokens.
    assert subject.ledger.usage(haiku).cost_usd == pytest.approx(0.0775)


# #511-T27
def test_an_answer_without_usage_stops_the_run_instead_of_counting_zero() -> None:
    answer = message()
    del answer["usage"]
    subject = proxy(Upstream(answer))

    response = post(subject, chat())

    assert code(response) == ErrorCode.DYNAMIC_ACCOUNTING_FAILED.value
    assert subject.ledger.usage(MODEL).cost_usd is None


# #511-T27
@pytest.mark.parametrize(
    "usage",
    [
        {"input_tokens": 0, "output_tokens": 0},
        {"input_tokens": 10, "output_tokens": 5, "service_tier": "priority"},
        {"input_tokens": 10, "output_tokens": 5, "speed": "fast"},
        {"input_tokens": 10, "output_tokens": 5, "server_tool_use": {"web_search_requests": 2}},
    ],
    ids=repr,
)
def test_a_call_that_cannot_be_priced_stops_the_run_and_is_never_a_cost_of_zero(
    usage: dict[str, Any],
) -> None:
    answer = message()
    answer["usage"] = usage
    subject = proxy(Upstream(answer))

    response = post(subject, chat())

    assert code(response) == ErrorCode.DYNAMIC_ACCOUNTING_FAILED.value
    assert subject.ledger.usage(MODEL).cost_usd is None


# #511-T27
def test_a_model_the_list_does_not_know_cannot_be_priced_and_stops_the_run() -> None:
    subject = proxy(Upstream(message()), "claude-future-9-9")

    response = post(subject, chat(model="claude-future-9-9"))

    assert code(response) == ErrorCode.DYNAMIC_ACCOUNTING_FAILED.value


# #511-T22 #533-T01: a model that rejects a forced choice is no longer refused before anything is
# spent: the choice goes out as `auto` (the whole steering is in
# `test_dynamic_review_proxy_anthropic_steering.py`).
@pytest.mark.parametrize("model", ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"])
def test_a_forced_tool_choice_for_a_model_that_rejects_it_is_sent_as_auto_never_forced(
    model: str,
) -> None:
    upstream = Upstream(message())
    subject = proxy(upstream, model)

    response = post(subject, chat(model=model, tool_choice="required"))

    assert response.status == 200
    assert upstream.requests[0][1]["tool_choice"] == {"type": "auto"}


# #511-T22
def test_content_the_provider_cannot_carry_is_refused_before_anything_is_spent() -> None:
    upstream = Upstream(message())
    subject = proxy(upstream)
    image = [{"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}]

    response = post(subject, chat(messages=[{"role": "user", "content": image}]))

    assert code(response) == ErrorCode.DYNAMIC_POLICY_VIOLATION.value
    assert upstream.requests == []
    assert subject.ledger.model_calls == 0


# #511-T23
@pytest.mark.parametrize("model", list(MODELS.values()), ids=list(MODELS))
def test_sampling_parameters_of_the_engine_reach_the_provider_only_where_the_flags_allow(
    model: Any,
) -> None:
    upstream = Upstream(message())
    subject = proxy(upstream, model.id)

    post(subject, chat(model=model.id, tool_choice="auto", temperature=0.2, top_p=0.9))

    body = upstream.requests[0][1]
    assert ("temperature" in body) is model.temperature
    assert "top_p" not in body


# #511-T23
def test_the_wrap_up_call_forces_the_structured_output_tool_alone() -> None:
    upstream = Upstream(tool_use("StructuredOutput"))
    subject = proxy(upstream)
    # A ledger that has no room for another turn makes the next call the final one.
    subject.ledger._wrap_up_reason = lambda *args: "time_limit"  # type: ignore[method-assign]  # pyright: ignore[reportAttributeAccessIssue, reportPrivateUsage]

    post(subject, chat())

    body = upstream.requests[0][1]
    assert [tool["name"] for tool in body["tools"]] == ["StructuredOutput"]
    # `required` with the one tool left: the API calls that `any`.
    assert body["tool_choice"] == {"type": "any"}
    assert body["messages"][-1]["role"] == "user"


# #511-T25
@pytest.mark.parametrize(
    ("status", "error_type", "message_text", "expected"),
    [
        (
            400,
            "invalid_request_error",
            "prompt is too long: 215000 tokens > 200000 maximum",
            ErrorCode.LLM_CONTEXT_LENGTH_EXCEEDED,
        ),
        (
            400,
            "invalid_request_error",
            "tool_choice: type 'any' is not supported",
            ErrorCode.LLM_BAD_REQUEST,
        ),
        (401, "authentication_error", "invalid x-api-key", ErrorCode.LLM_AUTH),
        (403, "permission_error", "no access to this model", ErrorCode.LLM_AUTH),
        (404, "not_found_error", "model: claude-x", ErrorCode.MODEL_UNKNOWN),
        (429, "rate_limit_error", "slow down", ErrorCode.LLM_RATE_LIMIT),
        (500, "api_error", "internal", ErrorCode.LLM_UNAVAILABLE),
        (529, "overloaded_error", "Overloaded", ErrorCode.LLM_UNAVAILABLE),
    ],
)
def test_an_error_of_the_messages_api_gets_the_stable_code_of_the_other_providers(
    status: int, error_type: str, message_text: str, expected: ErrorCode
) -> None:
    upstream = Upstream(
        {"type": "error", "error": {"type": error_type, "message": message_text}}, status=status
    )
    subject = proxy(upstream)

    response = post(subject, chat())

    assert response.status == status
    assert code(response) == expected.value
    # What the provider said never reaches the engine, and the key never does either.
    assert message_text.encode() not in response.body
    assert KEY.encode() not in response.body
