# SPDX-License-Identifier: Apache-2.0

"""Pins down the model proxy of one Dynamic Review (#197).

The proxy is where the model boundary is enforced: only the model protocol, one configured model,
the workspace credential only ever in the forwarded request, the reservation before the call, usage
from the provider, and a destination that must advertise the required features. Every refusal is a
stable code; nothing falls back to another model, provider or engine.
"""

import json
from typing import Any

import pytest

from code_reviewer_runner.dynamic_review.limits import BudgetLedger, DynamicLimits, LimitError
from code_reviewer_runner.dynamic_review.proxy import (
    ModelProxy,
    ProxyResponse,
    capabilities_from_config,
)
from code_reviewer_runner.result import ErrorCode

UPSTREAM_KEY = "sk-or-v1-workspace-key-0123456789"
CAPABILITIES = json.dumps(
    {"tool_choice_required": True, "structured_output": True, "max_output_tokens": 4096}
)


class Upstream:
    """A stand-in for the provider: records what it got, answers what the test scripts."""

    def __init__(self, *, status: int = 200, body: dict[str, Any] | None = None) -> None:
        self.status = status
        self.body = body if body is not None else answer_with_usage()
        self.requests: list[tuple[str, bytes, dict[str, str]]] = []

    def __call__(self, url: str, body: bytes, headers: dict[str, str]) -> tuple[int, bytes]:
        self.requests.append((url, body, headers))
        return self.status, json.dumps(self.body).encode("utf-8")


def answer_with_usage(prompt: int = 10, completion: int = 5) -> dict[str, Any]:
    return {
        "id": "chatcmpl-1",
        "choices": [{"message": {"role": "assistant", "content": "{}"}}],
        "usage": {"prompt_tokens": prompt, "completion_tokens": completion},
    }


def request_body(*, model: str = "deepseek-v4.1-flash", **extra: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": model,
        "messages": [{"role": "user", "content": "hello"}],
        "tools": [{"type": "function", "function": {"name": "StructuredOutput", "parameters": {}}}],
        "tool_choice": "required",
    }
    body.update(extra)
    return body


def proxy(upstream: Upstream, **overrides: Any) -> ModelProxy:
    configured: dict[str, Any] = {
        "ledger": BudgetLedger(DynamicLimits()),
        "base_path": "/v1",
        "model": "deepseek-v4.1-flash",
        "upstream_url": "https://openrouter.ai/api/v1/chat/completions",
        "upstream_api_key": UPSTREAM_KEY,
        "upstream_model": "deepseek/deepseek-v4.1-flash",
        "capabilities": capabilities_from_config(CAPABILITIES),
        "post": upstream,
    }
    configured.update(overrides)
    return ModelProxy(**configured)


def post(
    subject: ModelProxy, body: dict[str, Any], path: str = "/v1/chat/completions"
) -> ProxyResponse:
    return subject.handle("POST", path, json.dumps(body).encode("utf-8"))


def error_code(response: ProxyResponse) -> str:
    return str(json.loads(response.body)["error"]["code"])


# #197-T11
def test_a_destination_that_cannot_serve_the_required_features_is_refused() -> None:
    # The descriptor must be usable at all: missing, unreadable or without an output bound fails.
    for document in (
        None,
        "not json",
        json.dumps({"tool_choice_required": True, "structured_output": True}),
    ):
        with pytest.raises(LimitError) as refused:
            capabilities_from_config(document)
        assert refused.value.code is ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED

    # A destination that does not advertise a required feature fails before the engine starts.
    for document in (
        json.dumps(
            {"tool_choice_required": False, "structured_output": True, "max_output_tokens": 4096}
        ),
        json.dumps(
            {"tool_choice_required": True, "structured_output": False, "max_output_tokens": 4096}
        ),
        json.dumps(
            {"tool_choice_required": True, "structured_output": True, "max_output_tokens": 0}
        ),
    ):
        with pytest.raises(LimitError) as refused:
            proxy(Upstream(), capabilities=capabilities_from_config(document))
        assert refused.value.code is ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED


# #197-T11
def test_the_proxy_does_not_start_for_an_unusable_destination() -> None:
    with pytest.raises(LimitError) as refused:
        proxy(Upstream(), capabilities=capabilities_from_config(None))
    assert refused.value.code is ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED


# #197-T04
def test_only_the_model_protocol_paths_are_served() -> None:
    upstream = Upstream()
    subject = proxy(upstream)

    for path in ("/v1/completions", "/v1/chat/completions/../..", "/session/1", "/v1/models/1"):
        response = subject.handle("POST", path, json.dumps(request_body()).encode())
        assert error_code(response) == ErrorCode.DYNAMIC_POLICY_VIOLATION.value

    assert upstream.requests == []
    listed = subject.handle("GET", "/v1/models", b"")
    assert listed.status == 200
    assert json.loads(listed.body)["data"][0]["id"] == "deepseek-v4.1-flash"


# #197-T04
def test_the_forwarded_request_carries_the_workspace_key_and_the_trusted_model() -> None:
    upstream = Upstream()
    subject = proxy(upstream)

    response = post(subject, request_body())
    assert response.status == 200

    url, body, headers = upstream.requests[0]
    assert url == "https://openrouter.ai/api/v1/chat/completions"
    assert headers["Authorization"] == f"Bearer {UPSTREAM_KEY}"
    assert json.loads(body)["model"] == "deepseek/deepseek-v4.1-flash"
    # The engine holds only the dummy capability; the proxy never forwards it upstream.
    assert "runner-proxy" not in body.decode()


# #197-T04
def test_a_request_that_names_another_model_is_refused_and_never_forwarded() -> None:
    upstream = Upstream()
    subject = proxy(upstream)

    response = post(subject, request_body(model="anthropic/claude-sonnet-5.5"))

    assert error_code(response) == ErrorCode.DYNAMIC_POLICY_VIOLATION.value
    assert upstream.requests == []


# #197-T12
def test_a_request_over_the_protocol_byte_bound_is_refused_before_forwarding() -> None:
    upstream = Upstream()
    subject = proxy(upstream, ledger=BudgetLedger(DynamicLimits(max_request_bytes=100)))

    response = post(subject, request_body())

    assert error_code(response) == ErrorCode.DYNAMIC_BUDGET_EXCEEDED.value
    assert upstream.requests == []


# #197-T12
def test_an_answer_over_the_response_byte_bound_is_refused() -> None:
    upstream = Upstream(body={"choices": [], "usage": {"prompt_tokens": 1, "completion_tokens": 1}})
    subject = proxy(upstream, ledger=BudgetLedger(DynamicLimits(max_response_bytes=10)))

    response = post(subject, request_body())

    assert error_code(response) == ErrorCode.DYNAMIC_BUDGET_EXCEEDED.value


# #197-T05
def test_missing_usage_stops_the_run_instead_of_counting_zero() -> None:
    upstream = Upstream(body={"choices": [{"message": {"content": "{}"}}]})
    subject = proxy(upstream)

    response = post(subject, request_body())

    assert error_code(response) == ErrorCode.DYNAMIC_ACCOUNTING_FAILED.value
    assert subject.ledger.model_calls == 1


# #197-T12
def test_the_provider_counters_settle_the_reservation() -> None:
    upstream = Upstream(body=answer_with_usage(prompt=12, completion=7))
    subject = proxy(upstream)

    response = post(subject, request_body())

    assert response.status == 200
    assert subject.ledger.usage("deepseek/deepseek-v4.1-flash").total_tokens == 19


# #197-T06
def test_a_provider_refusal_becomes_a_stable_code_and_is_never_a_partial_success() -> None:
    for status, code in (
        (401, ErrorCode.LLM_AUTH),
        (402, ErrorCode.LLM_QUOTA),
        (429, ErrorCode.LLM_RATE_LIMIT),
        (503, ErrorCode.LLM_UNAVAILABLE),
    ):
        upstream = Upstream(status=status, body={"error": "provider message with data in it"})
        subject = proxy(upstream)

        response = post(subject, request_body())

        assert response.status == status
        assert error_code(response) == code.value
        # The provider's own message never reaches the engine.
        assert b"provider message" not in response.body


# #197-T12
def test_a_streaming_request_is_refused_rather_than_left_unaccounted() -> None:
    upstream = Upstream()
    subject = proxy(upstream)

    response = post(subject, request_body(stream=True))

    assert error_code(response) == ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED.value
    assert upstream.requests == []


# #197-T05
def test_the_call_budget_stops_the_run_at_the_proxy() -> None:
    upstream = Upstream()
    subject = proxy(upstream, ledger=BudgetLedger(DynamicLimits(max_model_calls=1)))

    assert post(subject, request_body()).status == 200
    second = post(subject, request_body())

    assert error_code(second) == ErrorCode.DYNAMIC_BUDGET_EXCEEDED.value
    assert len(upstream.requests) == 1
