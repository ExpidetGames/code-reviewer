# SPDX-License-Identifier: Apache-2.0

"""The admission of a request to the passthrough proxy (#550): who may ask, for what, and how.

The engine is the untrusted side. Before a byte is reserved or forwarded the proxy decides from the
request line, the headers and three fields of the body, and refuses with a stable code anything the
job's one family, path, model and output cap do not allow.
"""

import json
import secrets
from collections.abc import Callable
from typing import Any

import pytest

from code_reviewer_runner.dynamic_review.passthrough.admission import (
    Admission,
    PassthroughTarget,
    RefusalCode,
    Refused,
)
from code_reviewer_runner.dynamic_review.passthrough.families import (
    ALLOWED_ANTHROPIC_BETAS,
    WireFamily,
    spec_of,
)
from code_reviewer_runner.result import ErrorCode

CAPABILITY = secrets.token_urlsafe(32)
OTHER_CAPABILITY = secrets.token_urlsafe(32)
MODEL = "acme-model-9"
ALLOWANCE = 8192
MAX_REQUEST_BYTES = 4096
Headers = list[tuple[str, str]]

PATHS = {
    WireFamily.OPENAI_CHAT: "/v1/chat/completions",
    WireFamily.OPENAI_RESPONSES: "/v1/responses",
    WireFamily.ANTHROPIC_MESSAGES: "/v1/messages",
    WireFamily.GOOGLE: f"/v1beta/models/{MODEL}:streamGenerateContent?alt=sse",
}
KEY_HEADERS = {
    WireFamily.OPENAI_CHAT: "authorization",
    WireFamily.OPENAI_RESPONSES: "authorization",
    WireFamily.ANTHROPIC_MESSAGES: "x-api-key",
    WireFamily.GOOGLE: "x-goog-api-key",
}
FAMILIES = list(WireFamily)


def admission(family: WireFamily) -> Admission:
    target = PassthroughTarget(family=family, model=MODEL, output_allowance=ALLOWANCE)
    return Admission(target, CAPABILITY)


def key_header(family: WireFamily, capability: str = CAPABILITY) -> tuple[str, str]:
    name = KEY_HEADERS[family]
    return name, f"Bearer {capability}" if name == "authorization" else capability


def engine_headers(family: WireFamily, *extra: tuple[str, str]) -> Headers:
    """The closed set the pinned engine sends (docs/spike/544-passthrough.md, section 4)."""
    headers: Headers = [
        key_header(family),
        ("Accept", "*/*"),
        ("Accept-Encoding", "gzip, deflate, br, zstd"),
        ("Connection", "keep-alive"),
        ("Content-Type", "application/json"),
        ("Host", "127.0.0.1:4100"),
        ("User-Agent", "opencode/1.19.0 ai-sdk/provider-utils/4.0.0 runtime/bun/1.3.14"),
        ("x-opencode-session-id", "ses_1"),
        ("x-session-id", "ses_1"),
        ("x-session-affinity", "ses_1"),
    ]
    if family is WireFamily.ANTHROPIC_MESSAGES:
        headers += [
            ("anthropic-version", "2023-06-01"),
            ("anthropic-beta", ",".join(sorted(ALLOWED_ANTHROPIC_BETAS))),
        ]
    return [*headers, *extra]


def body_for(family: WireFamily, **overrides: Any) -> bytes:
    document: dict[str, Any]
    if family is WireFamily.GOOGLE:
        document = {"contents": [], "generationConfig": {"maxOutputTokens": 1000}}
    elif family is WireFamily.OPENAI_RESPONSES:
        document = {"model": MODEL, "input": [], "stream": True, "max_output_tokens": 1000}
    else:
        document = {"model": MODEL, "messages": [], "stream": True, "max_tokens": 1000}
    document.update(overrides)
    return json.dumps(document).encode()


def admit_head(
    family: WireFamily,
    *,
    method: str = "POST",
    target: str | None = None,
    headers: Headers | None = None,
    length: int | None = 100,
) -> Any:
    sent = engine_headers(family) if headers is None else headers
    if length is not None:
        sent = [*sent, ("Content-Length", str(length))]
    return admission(family).head(method, target or PATHS[family], sent, MAX_REQUEST_BYTES)


def refusal_of(call: Any) -> Refused:
    with pytest.raises(Refused) as raised:
        call()
    return raised.value


# #550-T01
@pytest.mark.parametrize("family", FAMILIES)
@pytest.mark.parametrize("case", ["none", "wrong", "other-job", "other-header", "twice"])
def test_a_request_without_this_jobs_capability_is_refused_with_401(
    family: WireFamily, case: str
) -> None:
    name, value = key_header(family)
    others = {"authorization", "x-api-key", "x-goog-api-key"} - {name}
    base = [h for h in engine_headers(family) if h[0].lower() != name]
    headers = {
        "none": base,
        "wrong": [*base, (name, value + "x")],
        "other-job": [*base, key_header(family, OTHER_CAPABILITY)],
        # The right capability, in a header the family does not use for its key.
        "other-header": [*base, (sorted(others)[0], CAPABILITY)],
        "twice": [*base, (name, value), (name, value)],
    }[case]
    refused = refusal_of(lambda: admit_head(family, headers=headers))
    assert (refused.status, refused.code) == (401, RefusalCode.CAPABILITY_INVALID)


# #550-T02
@pytest.mark.parametrize("family", FAMILIES)
def test_every_credential_header_is_dropped_and_the_capability_is_never_forwarded(
    family: WireFamily,
) -> None:
    extra = [
        ("Authorization", "Bearer smuggled"),
        ("x-api-key", "smuggled"),
        ("x-goog-api-key", "smuggled"),
        ("Cookie", "session=smuggled"),
        ("Proxy-Authorization", "Basic smuggled"),
        ("Proxy-Connection", "keep-alive"),
        ("X-Forwarded-For", "10.0.0.1"),
    ]
    headers = [h for h in engine_headers(family) if h[0].lower() != KEY_HEADERS[family]]
    headers += [key_header(family), *[h for h in extra if h[0].lower() != KEY_HEADERS[family]]]
    forwarded = admit_head(family, headers=headers).headers
    assert not {"authorization", "x-api-key", "x-goog-api-key", "cookie"} & set(forwarded)
    assert CAPABILITY not in "".join(forwarded.values())
    assert "smuggled" not in "".join(forwarded.values())


# #550-T03
@pytest.mark.parametrize("family", FAMILIES)
def test_only_the_headers_of_the_pinned_engine_are_forwarded(family: WireFamily) -> None:
    unknown = [("X-Evil", "1"), ("X-Api-Version", "9"), ("Forwarded", "for=1.2.3.4")]
    forwarded = admit_head(family, headers=[*engine_headers(family), *unknown]).headers
    allowed = {
        "accept",
        "content-type",
        "user-agent",
        "x-opencode-session-id",
        "x-session-id",
        "x-session-affinity",
        "anthropic-version",
        "anthropic-beta",
    }
    assert set(forwarded) <= allowed
    assert {"content-type", "x-session-id"} <= set(forwarded)
    # The proxy sets these itself (the length, the host, the identity encoding).
    assert not {"host", "connection", "content-length", "accept-encoding"} & set(forwarded)


# #550-T03
@pytest.mark.parametrize(
    "header",
    [
        ("anthropic-beta", "thinking-binding-controls-2026-08-01,context-1m-2025-08-07"),
        ("anthropic-beta", "files-api-2025-04-14"),
        ("anthropic-version", "2099-01-01"),
    ],
)
def test_an_anthropic_header_value_off_the_list_is_refused(header: tuple[str, str]) -> None:
    family = WireFamily.ANTHROPIC_MESSAGES
    headers = [h for h in engine_headers(family) if h[0] != header[0]] + [header]
    refused = refusal_of(lambda: admit_head(family, headers=headers))
    assert (refused.status, refused.code) == (403, RefusalCode.REQUEST_NOT_ALLOWED)


# #550-T03
def test_the_values_of_the_pinned_engine_are_on_the_beta_list() -> None:
    assert {"thinking-binding-controls-2026-08-01", "structured-outputs-2025-11-13"} <= (
        ALLOWED_ANTHROPIC_BETAS
    )
    forwarded = admit_head(WireFamily.ANTHROPIC_MESSAGES).headers
    assert forwarded["anthropic-version"] == "2023-06-01"
    assert set(forwarded["anthropic-beta"].split(",")) == ALLOWED_ANTHROPIC_BETAS


# #550-T04
@pytest.mark.parametrize("family", FAMILIES)
def test_the_one_allowed_request_of_a_family_passes_and_names_its_upstream_path(
    family: WireFamily,
) -> None:
    head = admit_head(family)
    expected = {
        WireFamily.OPENAI_CHAT: "/chat/completions",
        WireFamily.OPENAI_RESPONSES: "/responses",
        WireFamily.ANTHROPIC_MESSAGES: "/messages",
        WireFamily.GOOGLE: f"/models/{MODEL}:streamGenerateContent?alt=sse",
    }
    assert head.upstream_path == expected[family]
    assert head.content_length == 100


def _bare(path: str) -> str:
    return path.split("?")[0]


# What a hostile engine may try instead of the exact request target, by name.
MUTATIONS: dict[str, Callable[[str], str]] = {
    "trailing slash": lambda path: _bare(path) + "/",
    "dot dot": lambda path: path.replace("/v1", "/v1/..", 1),
    "encoded dot dot": lambda path: path.replace("/v1", "/v1/%2e%2e/v1", 1),
    "double slash": lambda path: "/" + path,
    "path parameter": lambda path: _bare(path) + ";x=1",
    "second question mark": lambda path: _bare(path) + "?a?b",
    "fragment": lambda path: _bare(path) + "#fragment",
    "absolute url": lambda path: "http://evil.example" + path,
    "upper case": lambda path: path.upper(),
    "models listing": lambda path: "/v1/models",
    "completions": lambda path: "/v1/completions",
    "key after alt": lambda path: _bare(path) + "?alt=sse&key=stolen",
    "key before alt": lambda path: _bare(path) + "?key=stolen&alt=sse",
    "alt json": lambda path: _bare(path) + "?alt=json",
    "unknown query": lambda path: _bare(path) + "?x=1",
}


# #550-T04
@pytest.mark.parametrize("family", FAMILIES)
@pytest.mark.parametrize("mutation", MUTATIONS)
def test_any_other_path_or_query_is_refused_locally(family: WireFamily, mutation: str) -> None:
    target = MUTATIONS[mutation](PATHS[family])
    if target == PATHS[family]:
        pytest.skip("this mutation leaves the path as it is for this family")
    refused = refusal_of(lambda: admit_head(family, target=target))
    assert (refused.status, refused.error) == (403, ErrorCode.DYNAMIC_POLICY_VIOLATION)
    assert refused.code in (RefusalCode.REQUEST_NOT_ALLOWED, RefusalCode.MODEL_NOT_ALLOWED)


# #550-T04
@pytest.mark.parametrize("family", FAMILIES)
@pytest.mark.parametrize("method", ["GET", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])
def test_only_post_is_allowed(family: WireFamily, method: str) -> None:
    refused = refusal_of(lambda: admit_head(family, method=method))
    assert (refused.status, refused.code) == (403, RefusalCode.REQUEST_NOT_ALLOWED)


# #550-T04
def test_google_needs_the_stream_query_and_no_other() -> None:
    family = WireFamily.GOOGLE
    bare = f"/v1beta/models/{MODEL}:streamGenerateContent"
    assert refusal_of(lambda: admit_head(family, target=bare)).code is (
        RefusalCode.REQUEST_NOT_ALLOWED
    )


# #550-T05
def test_google_pins_the_model_in_the_path_for_the_stream() -> None:
    family = WireFamily.GOOGLE
    other = "/v1beta/models/gemini-9-ultra:streamGenerateContent?alt=sse"
    refused = refusal_of(lambda: admit_head(family, target=other))
    assert (refused.status, refused.code) == (403, RefusalCode.MODEL_NOT_ALLOWED)
    assert admit_head(family).upstream_path.startswith(f"/models/{MODEL}:")
    # The non-stream method is not on the list: the tee reads a stream.
    plain = f"/v1beta/models/{MODEL}:generateContent"
    assert refusal_of(lambda: admit_head(family, target=plain)).code is (
        RefusalCode.REQUEST_NOT_ALLOWED
    )


# #550-T06
@pytest.mark.parametrize(
    "family", [f for f in FAMILIES if f is not WireFamily.GOOGLE], ids=lambda f: f.value
)
def test_a_body_for_another_model_is_refused_with_403(family: WireFamily) -> None:
    head = admit_head(family)
    refused = refusal_of(
        lambda: admission(family).body(head, body_for(family, model="expensive-model-1"))
    )
    assert (refused.status, refused.code) == (403, RefusalCode.MODEL_NOT_ALLOWED)
    missing = body_for(family)
    without = json.loads(missing)
    del without["model"]
    refused = refusal_of(lambda: admission(family).body(head, json.dumps(without).encode()))
    assert refused.code is RefusalCode.REQUEST_NOT_ALLOWED


# #550-T06
@pytest.mark.parametrize("family", FAMILIES)
@pytest.mark.parametrize("cap", [ALLOWANCE + 1, 10**9, 0, -5, 1.5, "100", True, None])
def test_an_output_cap_above_the_allowance_or_no_cap_is_refused(
    family: WireFamily, cap: Any
) -> None:
    document = json.loads(body_for(family))
    if family is WireFamily.GOOGLE:
        document["generationConfig"]["maxOutputTokens"] = cap
    elif family is WireFamily.OPENAI_RESPONSES:
        document["max_output_tokens"] = cap
    else:
        document["max_tokens"] = cap
    body = json.dumps(document).encode()
    refused = refusal_of(lambda: admission(family).body(admit_head(family), body))
    assert (refused.status, refused.code) == (403, RefusalCode.REQUEST_NOT_ALLOWED)


# #550-T06
@pytest.mark.parametrize("family", FAMILIES)
def test_a_body_that_is_no_json_object_is_refused(family: WireFamily) -> None:
    head = admit_head(family)
    for body in (b"[]", b'"model"', b"7", b"not json", b"\xff\xfe", b"", b'{"model": NaN}'):
        refused = refusal_of(lambda body=body: admission(family).body(head, body))
        assert refused.code is RefusalCode.REQUEST_NOT_ALLOWED, body


# #550-T06
def test_a_key_given_twice_is_refused_because_two_parsers_may_read_two_models() -> None:
    family = WireFamily.OPENAI_CHAT
    body = b'{"model": "expensive-model-1", "model": "%s", "max_tokens": 10}' % MODEL.encode()
    refused = refusal_of(lambda: admission(family).body(admit_head(family), body))
    assert refused.code is RefusalCode.REQUEST_NOT_ALLOWED


# #550-T06
@pytest.mark.parametrize("field", ["models", "route", "plugins", "transforms"])
def test_an_openai_chat_body_may_not_name_other_models_or_plugins(field: str) -> None:
    family = WireFamily.OPENAI_CHAT
    body = body_for(family, **{field: ["expensive-model-1"]})
    refused = refusal_of(lambda: admission(family).body(admit_head(family), body))
    assert refused.code is RefusalCode.REQUEST_NOT_ALLOWED


# #550-T06
@pytest.mark.parametrize("family", FAMILIES)
def test_a_valid_body_is_relayed_byte_for_byte(family: WireFamily) -> None:
    # Odd spacing, key order and an OpenRouter field: nothing of it is parsed away.
    tools: dict[WireFamily, Any] = {
        WireFamily.OPENAI_CHAT: [{"type": "function", "function": {"name": "read"}}],
        WireFamily.OPENAI_RESPONSES: [{"type": "function", "name": "read", "parameters": {}}],
        WireFamily.ANTHROPIC_MESSAGES: [{"name": "read", "input_schema": {}}],
        WireFamily.GOOGLE: [{"functionDeclarations": [{"name": "read"}]}],
    }
    document = json.loads(body_for(family))
    document["tools"] = tools[family]
    if family is WireFamily.OPENAI_CHAT:
        document["usage"] = {"include": True}
    body = json.dumps(document, indent=3, ensure_ascii=False, sort_keys=True).encode()
    admitted = admission(family).body(admit_head(family, length=len(body)), body)
    assert admitted.body == body
    assert admitted.output_cap == 1000
    assert admitted.model == MODEL


# #550-T06
def test_the_length_of_the_body_is_checked_before_it_is_read() -> None:
    family = WireFamily.OPENAI_CHAT
    too_large = refusal_of(lambda: admit_head(family, length=MAX_REQUEST_BYTES + 1))
    assert (too_large.status, too_large.code) == (413, RefusalCode.REQUEST_TOO_LARGE)
    assert too_large.error is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert admit_head(family, length=MAX_REQUEST_BYTES).content_length == MAX_REQUEST_BYTES


# #550-T06
@pytest.mark.parametrize(
    "headers",
    [
        [("Transfer-Encoding", "chunked")],
        [("Transfer-Encoding", "chunked"), ("Content-Length", "10")],
        [("Content-Length", "abc")],
        [("Content-Length", "-1")],
        [("Content-Length", "1, 2")],
        [("Content-Length", "10"), ("Content-Length", "20")],
        [],
    ],
)
def test_a_chunked_or_unmeasurable_request_body_is_refused_with_411(
    headers: Headers,
) -> None:
    family = WireFamily.OPENAI_CHAT
    sent = [*engine_headers(family), *headers]
    refused = refusal_of(lambda: admit_head(family, headers=sent, length=None))
    assert (refused.status, refused.code) == (411, RefusalCode.LENGTH_REQUIRED)


def test_the_families_are_the_four_of_the_contract() -> None:
    assert {family.value for family in WireFamily} == {
        "openai-chat",
        "openai-responses",
        "anthropic-messages",
        "google",
    }
    for family in WireFamily:
        assert spec_of(family).key_header == KEY_HEADERS[family]
