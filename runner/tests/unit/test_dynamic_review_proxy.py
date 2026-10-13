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

from code_reviewer_runner.dynamic_review.config import new_proxy_capability
from code_reviewer_runner.dynamic_review.limits import BudgetLedger, DynamicLimits, LimitError
from code_reviewer_runner.dynamic_review.proxy import (
    ModelProxy,
    ProxyResponse,
    capabilities_from_config,
)
from code_reviewer_runner.result import ErrorCode

UPSTREAM_KEY = "sk-or-v1-workspace-key-0123456789"
CAPABILITY = "job-capability-0123456789abcdef0123456789abcdef"
OTHER_CAPABILITY = "other-job-capability-0123456789abcdef012345"
CAPABILITIES = json.dumps(
    {"tool_choice_required": True, "structured_output": True, "max_output_tokens": 4096}
)


class Upstream:
    """A stand-in for the provider: records what it got, answers what the test scripts."""

    def __init__(self, *, status: int = 200, body: dict[str, Any] | None = None) -> None:
        self.status = status
        self.body = body if body is not None else answer_with_usage()
        self.requests: list[tuple[str, bytes, dict[str, str]]] = []
        self.limits: list[int] = []

    def __call__(
        self, url: str, body: bytes, headers: dict[str, str], limit: int
    ) -> tuple[int, bytes]:
        self.limits.append(limit)
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
        "capability": CAPABILITY,
        "post": upstream,
    }
    configured.update(overrides)
    return ModelProxy(**configured)


def bearer(token: str = CAPABILITY) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def post(
    subject: ModelProxy,
    body: dict[str, Any],
    path: str = "/v1/chat/completions",
    headers: dict[str, str] | None = None,
) -> ProxyResponse:
    return subject.handle(
        "POST", path, json.dumps(body).encode("utf-8"), bearer() if headers is None else headers
    )


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
        response = subject.handle("POST", path, json.dumps(request_body()).encode(), bearer())
        assert error_code(response) == ErrorCode.DYNAMIC_POLICY_VIOLATION.value

    assert upstream.requests == []
    listed = subject.handle("GET", "/v1/models", b"", bearer())
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


# #197-T04
def test_a_request_without_the_job_capability_is_refused_and_never_forwarded() -> None:
    upstream = Upstream()
    subject = proxy(upstream)

    for headers in (
        {},
        {"Authorization": ""},
        {"Authorization": "Bearer "},
        {"Authorization": CAPABILITY},
        {"Authorization": f"Basic {CAPABILITY}"},
        {"Authorization": "Bearer runner-proxy"},
        {"Authorization": f"Bearer {CAPABILITY}x"},
        {"Authorization": f"Bearer {CAPABILITY[:-1]}"},
        {"Authorization": "Bearer \u00e9\u00e9"},
    ):
        response = post(subject, request_body(), headers=headers)
        assert response.status == 401
        assert error_code(response) == ErrorCode.DYNAMIC_POLICY_VIOLATION.value

    assert subject.handle("GET", "/v1/models", b"", {}).status == 401
    assert upstream.requests == []
    assert subject.ledger.model_calls == 0


# #197-T04
def test_the_workspace_key_is_never_accepted_from_the_caller() -> None:
    upstream = Upstream()
    subject = proxy(upstream)

    response = post(subject, request_body(), headers=bearer(UPSTREAM_KEY))

    assert response.status == 401
    assert upstream.requests == []


# #197-T04
def test_another_jobs_capability_is_refused_by_this_jobs_proxy() -> None:
    first_upstream, second_upstream = Upstream(), Upstream()
    first = proxy(first_upstream)
    second = proxy(second_upstream, capability=OTHER_CAPABILITY)

    assert post(first, request_body(), headers=bearer(OTHER_CAPABILITY)).status == 401
    assert post(second, request_body(), headers=bearer(CAPABILITY)).status == 401
    assert first_upstream.requests == [] and second_upstream.requests == []

    assert post(first, request_body()).status == 200
    assert post(second, request_body(), headers=bearer(OTHER_CAPABILITY)).status == 200


# #197-T04
def test_the_job_capability_is_never_forwarded_upstream() -> None:
    upstream = Upstream()
    subject = proxy(upstream)

    assert post(subject, request_body()).status == 200

    _, body, headers = upstream.requests[0]
    assert CAPABILITY not in body.decode()
    assert CAPABILITY not in json.dumps(headers)
    assert headers["Authorization"] == f"Bearer {UPSTREAM_KEY}"


# #197-T04
def test_a_weak_job_capability_does_not_start_the_proxy() -> None:
    for weak in ("", "short", "x" * 31):
        with pytest.raises(LimitError) as refused:
            proxy(Upstream(), capability=weak)
        assert refused.value.code is ErrorCode.DYNAMIC_CONFIG_INVALID


# #197-T04
def test_the_runner_generates_an_unguessable_capability_per_job() -> None:
    first, second = new_proxy_capability(), new_proxy_capability()

    assert first != second
    # 32 random bytes in url-safe base64 are 43 characters: at least 256 bits.
    assert len(first) >= 43


# #197-T12
def test_the_transport_is_told_to_read_at_most_one_byte_past_the_response_bound() -> None:
    upstream = Upstream()
    subject = proxy(upstream, ledger=BudgetLedger(DynamicLimits(max_response_bytes=1234)))

    post(subject, request_body())

    assert upstream.limits == [1235]


# #197-T10
def test_a_request_that_names_a_route_or_destination_is_refused_and_never_forwarded() -> None:
    for field in (
        "provider",
        "route",
        "models",
        "transforms",
        "plugins",
        "endpoint",
        "base_url",
        "api_base",
        "url",
    ):
        upstream = Upstream()
        subject = proxy(upstream)

        body = request_body()
        body[field] = {"order": ["attacker-host"]}
        response = post(subject, body)

        assert error_code(response) == ErrorCode.DYNAMIC_POLICY_VIOLATION.value, field
        assert upstream.requests == [], field
        assert subject.ledger.model_calls == 0, field


# #197-T10
def test_only_the_allowlisted_request_fields_reach_the_provider() -> None:
    upstream = Upstream()
    subject = proxy(upstream)

    response = post(
        subject,
        request_body(
            temperature=0.1,
            top_p=0.9,
            seed=7,
            stop=["END"],
            parallel_tool_calls=False,
            response_format={"type": "text"},
            user="someone",
            n=5,
            logit_bias={"1": 100},
            metadata={"anything": "else"},
            reasoning={"effort": "high"},
            unknown_future_field=True,
        ),
    )

    assert response.status == 200
    forwarded = json.loads(upstream.requests[0][1])
    assert set(forwarded) == {
        "model",
        "messages",
        "tools",
        "tool_choice",
        "temperature",
        "top_p",
        "seed",
        "stop",
        "parallel_tool_calls",
        "response_format",
        "max_tokens",
    }
    assert forwarded["model"] == "deepseek/deepseek-v4.1-flash"
    assert forwarded["tool_choice"] == "required"


# #197-T12
def test_the_forwarded_output_bound_never_exceeds_the_trusted_limit() -> None:
    # The capability descriptor allows 4096 output tokens.
    cases: list[tuple[dict[str, Any], int]] = [
        ({}, 4096),
        ({"max_tokens": 100}, 100),
        ({"max_tokens": 1_000_000}, 4096),
        ({"max_completion_tokens": 1_000_000}, 4096),
        ({"max_completion_tokens": 50}, 50),
        ({"max_tokens": "lots"}, 4096),
        ({"max_tokens": -5}, 4096),
    ]
    for extra, expected in cases:
        upstream = Upstream()
        subject = proxy(upstream)

        body = request_body()
        body.update(extra)
        assert post(subject, body).status == 200

        forwarded = json.loads(upstream.requests[0][1])
        assert forwarded["max_tokens"] == expected, extra
        assert "max_completion_tokens" not in forwarded
