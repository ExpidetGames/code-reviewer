# SPDX-License-Identifier: Apache-2.0

"""The usage parsers of the passthrough proxy (#551): four families, a whole document and a stream.

Each parser reads the raw usage of the provider's answer and fails closed: a value it cannot
trust, a field it does not know that could carry a price, a stream that never stated its usage or
was cut, and an answer that is not about exactly one choice are all "unknown", never zero. The
shapes are those of the generic fakes in `fakes/wire` (the providers' documented formats); a real
capture is the live checklist of docs/spike/544-passthrough.md (L3, L14).
"""

import json
import sys
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fakes.wire.formats import Family, Turn, answer, stream

from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily
from code_reviewer_runner.dynamic_review.passthrough.usage import (
    CallUsage,
    TapResult,
    is_error_event,
    tap_for,
)
from passthrough_expect import usage_expected

MODEL = "acme-model-9"
FAKE: dict[WireFamily, Family] = {
    WireFamily.OPENAI_CHAT: "chat",
    WireFamily.OPENAI_RESPONSES: "responses",
    WireFamily.ANTHROPIC_MESSAGES: "messages",
    WireFamily.GOOGLE: "google",
}
FAMILIES = list(WireFamily)
CHAT, RESPONSES, MESSAGES, GOOGLE = FAMILIES
TURN = Turn(tool="read", args={"filePath": "/x"})


def sse(*events: tuple[str | None, Any]) -> bytes:
    out = b""
    for name, data in events:
        head = f"event: {name}\n" if name else ""
        payload = data if isinstance(data, str) else json.dumps(data)
        out += f"{head}data: {payload}\n\n".encode()
    return out


def read_stream(family: WireFamily, data: bytes, *, size: int = 0) -> TapResult:
    tap = tap_for(family, sse=True)
    step = size or max(len(data), 1)
    for at in range(0, len(data), step):
        tap.feed(data[at : at + step])
    return tap.finish()


def read_document(family: WireFamily, document: Any) -> TapResult:
    tap = tap_for(family, sse=False)
    tap.feed(json.dumps(document).encode())
    return tap.finish()


def fake_stream(family: WireFamily, call: int = 3, **options: Any) -> bytes:
    return b"".join(stream(FAKE[family], TURN, call, MODEL, **options))


def assert_unknown(result: TapResult) -> None:
    """Not a usage to settle with: no usage at all, or one that lists what it could not read.
    Never a usage of zeros that looks fine."""
    usage = result.usage
    assert usage is None or usage.unknown_fields or not usage.complete, usage


def assert_priceable(result: TapResult) -> CallUsage:
    assert result.usage is not None
    assert result.usage.unknown_fields == ()
    assert result.usage.complete
    assert result.terminated and not result.errored
    return result.usage


# -- T01, T02: the usage of each family, whole and streamed --------------------------------------


# #551-T01
@pytest.mark.parametrize("family", FAMILIES)
def test_a_whole_answer_gives_the_typed_usage_of_its_family(family: WireFamily) -> None:
    result = read_document(family, answer(FAKE[family], TURN, 2, MODEL))
    assert assert_priceable(result) == usage_expected(2, family)


# #551-T01
def test_a_chat_answer_carries_cache_reasoning_and_the_charge_the_provider_states() -> None:
    usage = {
        "prompt_tokens": 100,
        "completion_tokens": 20,
        "total_tokens": 120,
        "cost": 0.0012,
        "cost_details": {"upstream_inference_cost": 0.001},
        "prompt_tokens_details": {"cached_tokens": 30, "cache_write_tokens": 10},
        "completion_tokens_details": {"reasoning_tokens": 5},
    }
    got = assert_priceable(read_document(CHAT, {"choices": [], "usage": usage}))
    assert got == CallUsage(
        100,
        20,
        cache_read=30,
        cache_write_5m=10,
        reasoning_tokens=5,
        stated_cost=Decimal("0.0012"),
    )


# #551-T01
def test_a_deepseek_answer_states_the_cache_as_hit_and_miss_tokens() -> None:
    usage = {
        "prompt_tokens": 100,
        "completion_tokens": 10,
        "prompt_cache_hit_tokens": 70,
        "prompt_cache_miss_tokens": 30,
        "completion_tokens_details": {"reasoning_tokens": 4},
    }
    got = assert_priceable(read_document(CHAT, {"choices": [], "usage": usage}))
    assert got == CallUsage(100, 10, cache_read=70, reasoning_tokens=4)


# #551-T01
def test_a_messages_answer_splits_the_cache_write_by_lifetime_and_counts_the_whole_prompt() -> None:
    usage = {
        "input_tokens": 40,
        "output_tokens": 9,
        "cache_read_input_tokens": 300,
        "cache_creation_input_tokens": 60,
        "cache_creation": {"ephemeral_5m_input_tokens": 50, "ephemeral_1h_input_tokens": 10},
        "output_tokens_details": {"thinking_tokens": 3},
    }
    got = assert_priceable(read_document(MESSAGES, {"type": "message", "usage": usage}))
    assert got == CallUsage(
        400, 9, cache_read=300, cache_write_5m=50, cache_write_1h=10, reasoning_tokens=3
    )


# #551-T01
def test_a_messages_cache_write_without_a_split_is_a_five_minute_write() -> None:
    # The request can state no lifetime (`cache_control.ttl` is refused), so none is a 1 h write.
    usage = {"input_tokens": 40, "output_tokens": 9, "cache_creation_input_tokens": 60}
    got = assert_priceable(read_document(MESSAGES, {"usage": usage}))
    assert (got.cache_write_5m, got.cache_write_1h, got.prompt_tokens) == (60, 0, 100)


# #551-T01
def test_a_google_answer_counts_thoughts_as_output_and_cached_content_in_the_prompt() -> None:
    usage = {
        "promptTokenCount": 500,
        "candidatesTokenCount": 20,
        "thoughtsTokenCount": 7,
        "cachedContentTokenCount": 300,
        "totalTokenCount": 527,
        "promptTokensDetails": [{"modality": "TEXT", "tokenCount": 500}],
    }
    got = assert_priceable(read_document(GOOGLE, {"candidates": [], "usageMetadata": usage}))
    assert got == CallUsage(500, 27, cache_read=300, reasoning_tokens=7)


# #551-T01
def test_a_responses_answer_carries_cache_and_reasoning() -> None:
    usage = {
        "input_tokens": 90,
        "output_tokens": 12,
        "total_tokens": 102,
        "input_tokens_details": {"cached_tokens": 40},
        "output_tokens_details": {"reasoning_tokens": 8},
    }
    got = assert_priceable(read_document(RESPONSES, {"object": "response", "usage": usage}))
    assert got == CallUsage(90, 12, cache_read=40, reasoning_tokens=8)


# #551-T02
@pytest.mark.parametrize("family", FAMILIES)
@pytest.mark.parametrize("crlf", [False, True])
@pytest.mark.parametrize("size", [0, 1, 7])
def test_a_stream_gives_the_same_usage_in_one_piece_and_in_small_chunks(
    family: WireFamily, crlf: bool, size: int
) -> None:
    result = read_stream(family, fake_stream(family, 3, crlf=crlf), size=size)
    assert assert_priceable(result) == usage_expected(3, family)


# #551-T02
@pytest.mark.parametrize("size", [0, 1])
def test_a_chat_stream_in_the_openrouter_form_states_the_charge_on_its_last_chunk(
    size: int,
) -> None:
    usage = {"prompt_tokens": 10, "completion_tokens": 5, "cost": 0.0012}
    finish: dict[str, Any] = {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
    last: dict[str, Any] = {"choices": [], "usage": usage}
    data = sse((None, finish), (None, last), (None, "[DONE]"))
    got = assert_priceable(read_stream(CHAT, data, size=size))
    assert got == CallUsage(10, 5, stated_cost=Decimal("0.0012"))


# -- T03, T04: usage that grows during a stream --------------------------------------------------


# #551-T03
@pytest.mark.parametrize("size", [0, 1])
def test_google_takes_the_last_cumulative_usage_and_never_the_sum(size: int) -> None:
    result = read_stream(GOOGLE, fake_stream(GOOGLE, 4, cumulative_usage=True), size=size)
    assert assert_priceable(result) == usage_expected(4, GOOGLE)
    first: dict[str, Any] = {
        "candidates": [{"content": {"parts": []}}],
        "usageMetadata": _g(100, 5),
    }
    last = {"candidates": [{"finishReason": "STOP"}], "usageMetadata": _g(100, 9, thoughts=2)}
    got = assert_priceable(read_stream(GOOGLE, sse((None, first), (None, last)), size=size))
    assert (got.prompt_tokens, got.completion_tokens) == (100, 11)


def _g(prompt: int, candidates: int, *, thoughts: int = 0) -> dict[str, int]:
    usage = {"promptTokenCount": prompt, "candidatesTokenCount": candidates}
    return {**usage, "thoughtsTokenCount": thoughts} if thoughts else usage


# #551-T03
def test_a_google_stream_whose_last_chunk_has_no_usage_is_not_complete() -> None:
    # A usage from before the end is a part of the count: not a usage to settle with.
    first: dict[str, Any] = {
        "candidates": [{"content": {"parts": []}}],
        "usageMetadata": _g(100, 5),
    }
    last = {"candidates": [{"finishReason": "STOP"}]}
    result = read_stream(GOOGLE, sse((None, first), (None, last)))
    assert result.usage is None or not result.usage.complete


# #551-T03
def test_a_google_usage_chunk_after_the_finish_chunk_is_the_usage() -> None:
    finish = {"candidates": [{"finishReason": "STOP"}]}
    after = {"usageMetadata": _g(100, 9)}
    got = assert_priceable(read_stream(GOOGLE, sse((None, finish), (None, after))))
    assert (got.prompt_tokens, got.completion_tokens) == (100, 9)


def _messages_events(
    start: dict[str, Any], delta: dict[str, Any] | None, *, stop: bool = True
) -> bytes:
    events: list[tuple[str | None, Any]] = [
        ("message_start", {"type": "message_start", "message": {"usage": start}})
    ]
    if delta is not None:
        events.append(("message_delta", {"type": "message_delta", "usage": delta}))
    if stop:
        events.append(("message_stop", {"type": "message_stop"}))
    return sse(*events)


# #551-T04
@pytest.mark.parametrize("size", [0, 1])
def test_messages_takes_the_input_from_the_start_and_the_output_from_the_last_delta(
    size: int,
) -> None:
    start = {"input_tokens": 40, "output_tokens": 1, "cache_read_input_tokens": 300}
    got = assert_priceable(
        read_stream(MESSAGES, _messages_events(start, {"output_tokens": 77}), size=size)
    )
    assert (got.prompt_tokens, got.completion_tokens, got.cache_read) == (340, 77, 300)


# #551-T04
def test_messages_takes_a_delta_that_states_the_input_and_the_cache_again_cumulatively() -> None:
    # UNCONFIRMED against the real API (live L3): a delta may repeat the input fields, and a later
    # statement replaces the earlier one.
    start = {"input_tokens": 40, "output_tokens": 1, "cache_read_input_tokens": 300}
    delta = {"input_tokens": 40, "output_tokens": 77, "cache_read_input_tokens": 300}
    got = assert_priceable(read_stream(MESSAGES, _messages_events(start, delta)))
    assert (got.prompt_tokens, got.completion_tokens, got.cache_read) == (340, 77, 300)


# #551-T04
def test_a_messages_stream_that_stops_without_the_output_of_a_delta_is_not_complete() -> None:
    # The `output_tokens` of `message_start` is a placeholder: stating it as the output would be an
    # undercount.
    start = {"input_tokens": 40, "output_tokens": 1}
    result = read_stream(MESSAGES, _messages_events(start, None))
    assert result.usage is None or not result.usage.complete
    result = read_stream(MESSAGES, _messages_events(start, {}))
    assert result.usage is None or not result.usage.complete


# -- T05: values that cannot be trusted ----------------------------------------------------------

CHAT_OK: dict[str, Any] = {"prompt_tokens": 100, "completion_tokens": 20}
RESPONSES_OK: dict[str, Any] = {"input_tokens": 100, "output_tokens": 20}
MESSAGES_OK: dict[str, Any] = {"input_tokens": 100, "output_tokens": 20}
GOOGLE_OK: dict[str, Any] = {"promptTokenCount": 100, "candidatesTokenCount": 20}

BAD_USAGE: list[tuple[WireFamily, dict[str, Any]]] = [
    (CHAT, {**CHAT_OK, "prompt_tokens": -1}),
    (CHAT, {**CHAT_OK, "prompt_tokens": True}),
    (CHAT, {**CHAT_OK, "prompt_tokens": 100.5}),
    (CHAT, {**CHAT_OK, "prompt_tokens": "100"}),
    (CHAT, {**CHAT_OK, "completion_tokens": None}),
    (CHAT, {"prompt_tokens": 100}),
    (CHAT, {**CHAT_OK, "prompt_tokens_details": {"cached_tokens": 101}}),
    (CHAT, {**CHAT_OK, "prompt_tokens_details": {"cached_tokens": -1}}),
    (CHAT, {**CHAT_OK, "prompt_tokens_details": {"cached_tokens": True}}),
    (CHAT, {**CHAT_OK, "prompt_tokens_details": {"cached_tokens": 60, "cache_write_tokens": 50}}),
    (CHAT, {**CHAT_OK, "completion_tokens_details": {"reasoning_tokens": 21}}),
    (CHAT, {**CHAT_OK, "prompt_cache_hit_tokens": 70, "prompt_cache_miss_tokens": 20}),
    (
        CHAT,
        {**CHAT_OK, "prompt_cache_hit_tokens": 70, "prompt_tokens_details": {"cached_tokens": 60}},
    ),
    (CHAT, {**CHAT_OK, "cost": -0.5}),
    (CHAT, {**CHAT_OK, "cost": "0.5"}),
    (CHAT, {**CHAT_OK, "cost": True}),
    (CHAT, {**CHAT_OK, "cost": float("inf")}),
    (RESPONSES, {**RESPONSES_OK, "input_tokens": True}),
    (RESPONSES, {**RESPONSES_OK, "output_tokens": 1.5}),
    (RESPONSES, {**RESPONSES_OK, "input_tokens_details": {"cached_tokens": 101}}),
    (RESPONSES, {**RESPONSES_OK, "output_tokens_details": {"reasoning_tokens": 21}}),
    (RESPONSES, {**RESPONSES_OK, "output_tokens_details": {"reasoning_tokens": -2}}),
    (MESSAGES, {**MESSAGES_OK, "input_tokens": -1}),
    (MESSAGES, {**MESSAGES_OK, "cache_read_input_tokens": True}),
    (MESSAGES, {**MESSAGES_OK, "cache_creation_input_tokens": 2.5}),
    (MESSAGES, {**MESSAGES_OK, "output_tokens": "20"}),
    (
        MESSAGES,
        {
            **MESSAGES_OK,
            "cache_creation_input_tokens": 60,
            "cache_creation": {"ephemeral_5m_input_tokens": 50, "ephemeral_1h_input_tokens": 5},
        },
    ),
    (MESSAGES, {**MESSAGES_OK, "cache_creation": {"ephemeral_5m_input_tokens": -1}}),
    (MESSAGES, {**MESSAGES_OK, "output_tokens_details": {"thinking_tokens": 21}}),
    (GOOGLE, {**GOOGLE_OK, "promptTokenCount": True}),
    (GOOGLE, {**GOOGLE_OK, "promptTokenCount": None}),
    (GOOGLE, {**GOOGLE_OK, "candidatesTokenCount": -3}),
    (GOOGLE, {**GOOGLE_OK, "cachedContentTokenCount": 101}),
    (GOOGLE, {**GOOGLE_OK, "thoughtsTokenCount": 1.5}),
    (GOOGLE, {"promptTokenCount": 100}),
    (GOOGLE, {"candidatesTokenCount": 20}),
]


def _wrap(family: WireFamily, usage: dict[str, Any]) -> Any:
    if family is GOOGLE:
        return {"candidates": [], "usageMetadata": usage}
    return {"choices": [], "usage": usage}


# #551-T05
@pytest.mark.parametrize(("family", "usage"), BAD_USAGE)
def test_a_value_that_cannot_be_trusted_is_unknown_and_never_zero(
    family: WireFamily, usage: dict[str, Any]
) -> None:
    assert_unknown(read_document(family, _wrap(family, usage)))


# #551-T05
@pytest.mark.parametrize(("family", "usage"), BAD_USAGE)
def test_the_same_values_in_a_stream_are_unknown_too(
    family: WireFamily, usage: dict[str, Any]
) -> None:
    if family is MESSAGES:
        data = _messages_events(usage, {"output_tokens": usage.get("output_tokens")})
    elif family is RESPONSES:
        done = {"type": "response.completed", "response": {"usage": usage}}
        data = sse(("response.completed", done))
    elif family is GOOGLE:
        data = sse((None, {"candidates": [{"finishReason": "STOP"}], "usageMetadata": usage}))
    else:
        finish: dict[str, Any] = {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
        data = sse((None, finish), (None, {"choices": [], "usage": usage}), (None, "[DONE]"))
    assert_unknown(read_stream(family, data))


# #551-T05
def test_an_answer_without_a_usage_object_has_no_usage_in_any_family() -> None:
    for family in FAMILIES:
        document = answer(FAKE[family], TURN, 1, MODEL)
        document.pop("usage", None)
        document.pop("usageMetadata", None)
        result = read_document(family, document)
        assert result.usage is None
        assert result.terminated


# -- T06: fields that could carry a price --------------------------------------------------------

UNKNOWN_FIELD: list[tuple[WireFamily, dict[str, Any], str]] = [
    (
        CHAT,
        {"prompt_tokens_details": {"audio_tokens": 11}},
        "usage.prompt_tokens_details.audio_tokens",
    ),
    (CHAT, {"new_surcharge_tokens": 3}, "usage.new_surcharge_tokens"),
    (CHAT, {"extra_charge": 0.5}, "usage.extra_charge"),
    (CHAT, {"is_byok": True}, "usage.is_byok"),
    (
        CHAT,
        {"completion_tokens_details": {"rejected_prediction_tokens": 4}},
        "usage.completion_tokens_details.rejected_prediction_tokens",
    ),
    (
        RESPONSES,
        {"input_tokens_details": {"audio_tokens": 4}},
        "usage.input_tokens_details.audio_tokens",
    ),
    (RESPONSES, {"tool_tokens": 4}, "usage.tool_tokens"),
    (MESSAGES, {"server_tool_use": {"web_search_requests": 2}}, "usage.server_tool_use"),
    (MESSAGES, {"service_tier": "priority"}, "usage.service_tier"),
    (MESSAGES, {"speed": "fast"}, "usage.speed"),
    (MESSAGES, {"inference_geo": "us"}, "usage.inference_geo"),
    (MESSAGES, {"iterations": [{"input_tokens": 1}]}, "usage.iterations"),
    (
        MESSAGES,
        {"cache_creation": {"ephemeral_24h_input_tokens": 5}},
        "usage.cache_creation.ephemeral_24h_input_tokens",
    ),
    (GOOGLE, {"toolUsePromptTokenCount": 9}, "usageMetadata.toolUsePromptTokenCount"),
    (
        GOOGLE,
        {"promptTokensDetails": [{"modality": "AUDIO", "tokenCount": 5}]},
        "usageMetadata.promptTokensDetails",
    ),
    (GOOGLE, {"trafficType": "PROVISIONED_THROUGHPUT"}, "usageMetadata.trafficType"),
]

# What a real answer plausibly carries that costs nothing: a count of zero of a kind we do not
# price, the standard tier, a total, the usual breakdowns.
HARMLESS_FIELD: list[tuple[WireFamily, dict[str, Any]]] = [
    (CHAT, {"total_tokens": 120}),
    (CHAT, {"prompt_tokens_details": {"audio_tokens": 0, "cached_tokens": 0}}),
    (
        CHAT,
        {
            "completion_tokens_details": {
                "audio_tokens": 0,
                "accepted_prediction_tokens": 0,
                "rejected_prediction_tokens": 0,
            }
        },
    ),
    (CHAT, {"is_byok": False, "cost_details": {"upstream_inference_cost": 0}}),
    (RESPONSES, {"total_tokens": 120, "input_tokens_details": {"audio_tokens": 0}}),
    (MESSAGES, {"server_tool_use": {"web_search_requests": 0, "web_fetch_requests": 0}}),
    (MESSAGES, {"service_tier": "standard", "speed": "standard", "inference_geo": "not_available"}),
    (MESSAGES, {"service_tier": None, "iterations": [], "inference_geo": ""}),
    (
        GOOGLE,
        {"totalTokenCount": 120, "promptTokensDetails": [{"modality": "TEXT", "tokenCount": 100}]},
    ),
    (GOOGLE, {"toolUsePromptTokenCount": 0, "trafficType": None}),
]


def _doc_with(family: WireFamily, ok: dict[str, Any], extra: dict[str, Any]) -> Any:
    merged: dict[str, Any] = {**ok}
    for key, value in extra.items():
        old = merged.get(key)
        merged[key] = (
            {**old, **value} if isinstance(old, dict) and isinstance(value, dict) else value
        )
    return _wrap(family, merged)


OK_OF = {CHAT: CHAT_OK, RESPONSES: RESPONSES_OK, MESSAGES: MESSAGES_OK, GOOGLE: GOOGLE_OK}


# #551-T06
@pytest.mark.parametrize(("family", "extra", "name"), UNKNOWN_FIELD)
def test_an_unknown_usage_field_that_holds_something_is_listed_by_name_and_the_cost_is_unknown(
    family: WireFamily, extra: dict[str, Any], name: str
) -> None:
    result = read_document(family, _doc_with(family, OK_OF[family], extra))
    assert result.usage is not None
    assert name in result.usage.unknown_fields
    # Names only: no value (a hostile provider answer is untrusted text in a log).
    assert all(" " not in field and len(field) <= 80 for field in result.usage.unknown_fields)


# #551-T06
@pytest.mark.parametrize(("family", "extra"), HARMLESS_FIELD)
def test_a_known_harmless_field_or_a_zero_of_a_kind_we_do_not_price_is_no_unknown_field(
    family: WireFamily, extra: dict[str, Any]
) -> None:
    result = read_document(family, _doc_with(family, OK_OF[family], extra))
    assert result.usage is not None
    assert result.usage.unknown_fields == ()


# #551-T06
@pytest.mark.parametrize("family", FAMILIES)
@pytest.mark.parametrize("size", [0, 1])
def test_an_unknown_usage_field_in_a_stream_is_listed_too(family: WireFamily, size: int) -> None:
    data = fake_stream(family, 2, usage_fault="unknown_field")
    result = read_stream(family, data, size=size)
    assert result.usage is not None
    assert result.usage.unknown_fields


# #551-T06
@pytest.mark.parametrize("family", FAMILIES)
def test_an_unknown_usage_field_in_a_whole_answer_is_listed_too(family: WireFamily) -> None:
    result = read_document(
        family, answer(FAKE[family], TURN, 2, MODEL, usage_fault="unknown_field")
    )
    assert result.usage is not None
    assert result.usage.unknown_fields


# #551-T06
@pytest.mark.parametrize("tier", ["priority", "flex", "scale", "batch", 7])
def test_a_service_tier_other_than_the_standard_one_is_unknown_on_chat_and_responses(
    tier: object,
) -> None:
    chat: dict[str, Any] = {"choices": [], "usage": CHAT_OK, "service_tier": tier}
    got = read_document(CHAT, chat).usage
    assert got is not None and "service_tier" in got.unknown_fields
    responses = {
        "type": "response.completed",
        "response": {"usage": RESPONSES_OK, "service_tier": tier},
    }
    got = read_stream(RESPONSES, sse(("response.completed", responses))).usage
    assert got is not None and "service_tier" in got.unknown_fields


# #551-T06
@pytest.mark.parametrize("tier", [None, "default", "standard"])
def test_the_default_service_tier_of_chat_and_responses_is_no_unknown_field(tier: object) -> None:
    chat: dict[str, Any] = {"choices": [], "usage": CHAT_OK, "service_tier": tier}
    got = read_document(CHAT, chat).usage
    assert got is not None and got.unknown_fields == ()
    responses = {
        "type": "response.completed",
        "response": {"usage": RESPONSES_OK, "service_tier": tier},
    }
    got = read_stream(RESPONSES, sse(("response.completed", responses))).usage
    assert got is not None and got.unknown_fields == ()


# #551-T06
def test_a_field_unknown_in_an_early_event_of_a_stream_still_counts() -> None:
    start = {"input_tokens": 40, "output_tokens": 1, "server_tool_use": {"web_search_requests": 1}}
    delta = {"output_tokens": 77}
    got = read_stream(MESSAGES, _messages_events(start, delta)).usage
    assert got is not None and "usage.server_tool_use" in got.unknown_fields


# #551-T06
def test_an_answer_with_more_than_one_choice_is_unknown_and_never_summed() -> None:
    two = {
        "choices": [
            {"index": 0, "message": {"content": "a"}, "finish_reason": "stop"},
            {"index": 1, "message": {"content": "b"}, "finish_reason": "stop"},
        ],
        "usage": CHAT_OK,
    }
    got = read_document(CHAT, two).usage
    assert got is not None and "choices" in got.unknown_fields
    only_second = {"choices": [{"index": 1, "finish_reason": "stop"}], "usage": CHAT_OK}
    got = read_document(CHAT, only_second).usage
    assert got is not None and "choices" in got.unknown_fields
    chunk: dict[str, Any] = {
        "choices": [{"index": 0, "delta": {}}, {"index": 1, "delta": {}, "finish_reason": "stop"}]
    }
    data = sse((None, chunk), (None, {"choices": [], "usage": CHAT_OK}), (None, "[DONE]"))
    got = read_stream(CHAT, data).usage
    assert got is not None and "choices" in got.unknown_fields


# #551-T06
def test_an_answer_with_more_than_one_candidate_is_unknown_and_never_summed() -> None:
    candidates = [{"index": 0, "finishReason": "STOP"}, {"index": 1, "finishReason": "STOP"}]
    document = {"candidates": candidates, "usageMetadata": GOOGLE_OK}
    got = read_document(GOOGLE, document).usage
    assert got is not None and "candidates" in got.unknown_fields
    got = read_stream(GOOGLE, sse((None, document))).usage
    assert got is not None and "candidates" in got.unknown_fields
    second = {"candidates": [{"index": 1, "finishReason": "STOP"}], "usageMetadata": GOOGLE_OK}
    got = read_document(GOOGLE, second).usage
    assert got is not None and "candidates" in got.unknown_fields


# -- T07 (the parser's part): an answer that ends without its usage ------------------------------


# #551-T07
@pytest.mark.parametrize("family", FAMILIES)
def test_a_stream_cut_anywhere_is_never_a_complete_usage(family: WireFamily) -> None:
    events = stream(FAKE[family], TURN, 3, MODEL)
    # A Chat stream that is cut only before `[DONE]` has ended: its finish and usage are in.
    last = len(events) - 1 if family is CHAT else len(events)
    for keep in range(last):
        result = read_stream(family, b"".join(events[:keep]))
        assert not result.terminated
        assert result.usage is None or not result.usage.complete


# #551-T07
@pytest.mark.parametrize("family", FAMILIES)
def test_a_stream_cut_in_the_middle_of_an_event_is_never_a_complete_usage(
    family: WireFamily,
) -> None:
    events = stream(FAKE[family], TURN, 3, MODEL)
    whole = b"".join(events)
    # What is left of the usage event, ends with its data: cut inside its last bytes, not in a
    # `[DONE]` that follows it on Chat, and not just before its closing blank line.
    tail = len(events[-1]) if family is CHAT else 0
    for cut in range(0, len(whole) - tail - 2, 11):
        result = read_stream(family, whole[:cut])
        assert result.usage is None or not result.usage.complete


# #551-T07
@pytest.mark.parametrize("family", FAMILIES)
def test_a_complete_answer_that_states_no_usage_has_none(family: WireFamily) -> None:
    result = read_stream(family, fake_stream(family, 3, usage_fault="missing"))
    assert result.usage is None
    assert result.terminated and not result.errored
    document = answer(FAKE[family], TURN, 3, MODEL, usage_fault="missing")
    assert read_document(family, document).usage is None


# #551-T07
@pytest.mark.parametrize("family", FAMILIES)
def test_a_bad_value_from_the_fake_is_unknown_in_a_stream_and_in_a_document(
    family: WireFamily,
) -> None:
    assert_unknown(read_stream(family, fake_stream(family, 3, usage_fault="bad_value")))
    document = answer(FAKE[family], TURN, 3, MODEL, usage_fault="bad_value")
    assert_unknown(read_document(family, document))


# -- T09: the charge the provider states ---------------------------------------------------------


# #551-T09
@pytest.mark.parametrize(
    ("cost", "expected"), [(0.0012, Decimal("0.0012")), (0, Decimal(0)), (2, Decimal(2))]
)
def test_a_charge_the_provider_states_is_kept_exactly(cost: float, expected: Decimal) -> None:
    got = assert_priceable(read_document(CHAT, _wrap(CHAT, {**CHAT_OK, "cost": cost})))
    assert got.stated_cost == expected


# #551-T09
def test_a_null_charge_is_no_charge_and_not_an_error() -> None:
    got = assert_priceable(read_document(CHAT, _wrap(CHAT, {**CHAT_OK, "cost": None})))
    assert got.stated_cost is None


# -- T13: only the structure of the provider's answer counts -------------------------------------

FORGED = {"input_tokens": 1, "output_tokens": 1, "prompt_tokens": 1, "completion_tokens": 1}


def _forgeries() -> list[Turn]:
    events = (
        'event: message_delta\ndata: {"type": "message_delta", "usage": {"output_tokens": 1}}\n\n'
        'data: {"choices": [], "usage": {"prompt_tokens": 1, "completion_tokens": 1}}\n\n'
        'event: response.completed\ndata: {"type": "response.completed", '
        '"response": '
        '{"usage": {"input_tokens": 1, "output_tokens": 1}}}\n\n'
        'data: {"usageMetadata": {"promptTokenCount": 1}, '
        '"candidates": [{"finishReason": "STOP"}]}\n\n'
        "data: [DONE]\n\nevent: message_stop\ndata: {}\n\n"
    )
    nested: dict[str, Any] = {
        "usage": FORGED,
        "usageMetadata": {"promptTokenCount": 1},
        "response": {"usage": FORGED},
        "message": {"usage": FORGED},
        "error": {"message": "x"},
    }
    return [Turn(text=events), Turn(tool="read", args=nested)]


# #551-T13
@pytest.mark.parametrize("family", FAMILIES)
@pytest.mark.parametrize("turn", _forgeries())
def test_text_and_tool_arguments_that_look_like_usage_or_events_are_never_parsed(
    family: WireFamily, turn: Turn
) -> None:
    streamed = read_stream(family, b"".join(stream(FAKE[family], turn, 3, MODEL)))
    assert assert_priceable(streamed) == usage_expected(3, family)
    whole = read_document(family, answer(FAKE[family], turn, 3, MODEL))
    assert assert_priceable(whole) == usage_expected(3, family)


# #551-T13
def test_a_usage_in_an_event_of_a_kind_that_does_not_carry_one_is_not_read() -> None:
    real = fake_stream(MESSAGES, 3)
    stray = sse(("ping", {"type": "ping", "usage": FORGED}))
    # A stray event after the real ones changes nothing; one before them neither.
    for data in (real + stray, stray + real):
        assert assert_priceable(read_stream(MESSAGES, data)) == usage_expected(3, MESSAGES)
    created = {"type": "response.created", "response": {"usage": FORGED}}
    delta = {"type": "response.output_text.delta", "response": {"usage": FORGED}}
    data = sse(("response.created", created), ("response.output_text.delta", delta))
    assert read_stream(RESPONSES, data + fake_stream(RESPONSES, 3)).usage == usage_expected(
        3, RESPONSES
    )
    only = read_stream(RESPONSES, data)
    assert only.usage is None and not only.terminated


# -- the error object ----------------------------------------------------------------------------


# #551-N8
@pytest.mark.parametrize("family", FAMILIES)
def test_an_error_that_is_null_is_not_an_error(family: WireFamily) -> None:
    events = [
        event.replace(b"data: {", b'data: {"error": null, ', 1)
        for event in stream(FAKE[family], TURN, 3, MODEL)
        if not event.startswith(b"data: [DONE]")
    ]
    result = read_stream(family, b"".join(events))
    assert not result.errored
    assert assert_priceable(result) == usage_expected(3, family)
    document = {**answer(FAKE[family], TURN, 3, MODEL), "error": None}
    assert assert_priceable(read_document(family, document)) == usage_expected(3, family)


# #551-N8
@pytest.mark.parametrize("value", [None, False, "", 0, []])
def test_only_a_real_error_object_is_an_error_event(value: object) -> None:
    assert not is_error_event(sse((None, {"error": value, "x": 1})))


# #551-N8
@pytest.mark.parametrize("value", [{"message": "overloaded"}, {}, "overloaded", ["x"]])
def test_an_error_object_is_an_error_event(value: object) -> None:
    assert is_error_event(sse((None, {"error": value})))


# #551-N8
@pytest.mark.parametrize("family", FAMILIES)
def test_a_real_error_object_in_a_whole_answer_is_an_error(family: WireFamily) -> None:
    document = {**answer(FAKE[family], TURN, 3, MODEL), "error": {"message": "x"}}
    result = read_document(family, document)
    assert result.errored and not result.terminated


# #551-N8
def test_a_chat_choice_that_finishes_with_an_error_is_an_error() -> None:
    chunk: dict[str, Any] = {"choices": [{"index": 0, "delta": {}, "finish_reason": "error"}]}
    result = read_stream(CHAT, sse((None, chunk), (None, {"choices": [], "usage": CHAT_OK})))
    assert result.errored and not result.terminated


# -- review of PR #569: a usage must not go backwards, and one that is stated twice is no usage --
#
# The reviewer's proofs of concept, one row each. A call gets one usage-carrying event (Chat, a
# Responses terminal event); Messages has its fixed order; Google may state its cumulative usage
# again, but never less. Anything else is unknown, whatever the figures say.


def _m_start(inp: int = 1000, out: int = 1, **extra: Any) -> tuple[str, Any]:
    usage = {"input_tokens": inp, "output_tokens": out, **extra}
    return ("message_start", {"type": "message_start", "message": {"id": "m", "usage": usage}})


def _m_delta(**usage: Any) -> tuple[str, Any]:
    return (
        "message_delta",
        {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": usage},
    )


M_STOP = ("message_stop", {"type": "message_stop"})
M_PING = ("ping", {"type": "ping"})
M_ERROR = ("error", {"type": "error", "error": {"type": "overloaded_error"}})

MESSAGES_FINE: list[tuple[str, list[tuple[str | None, Any]]]] = [
    ("baseline", [_m_start(), _m_delta(output_tokens=500), M_STOP]),
    ("a ping between", [_m_start(), M_PING, _m_delta(output_tokens=500), M_PING, M_STOP]),
    (
        "a delta that states the input again",
        [_m_start(), _m_delta(input_tokens=1000, output_tokens=500), M_STOP],
    ),
    (
        "a delta that states the cache again",
        [
            _m_start(cache_read_input_tokens=4000),
            _m_delta(input_tokens=1000, cache_read_input_tokens=4000, output_tokens=500),
            M_STOP,
        ],
    ),
    (
        "two deltas, the output grows",
        [_m_start(), _m_delta(output_tokens=200), _m_delta(output_tokens=500), M_STOP],
    ),
    ("a ping after the stop", [_m_start(), _m_delta(output_tokens=500), M_STOP, M_PING]),
]

MESSAGES_BROKEN: list[tuple[str, list[tuple[str | None, Any]]]] = [
    ("a delta before the start", [_m_delta(output_tokens=500), _m_start(), M_STOP]),
    ("no start at all", [_m_delta(input_tokens=1000, output_tokens=500), M_STOP]),
    (
        "a later delta states less output",
        [_m_start(), _m_delta(output_tokens=500), _m_delta(output_tokens=5), M_STOP],
    ),
    (
        "a delta states less input than the start",
        [_m_start(), _m_delta(input_tokens=10, output_tokens=500), M_STOP],
    ),
    (
        "a delta states less cache than the start",
        [
            _m_start(cache_read_input_tokens=4000),
            _m_delta(cache_read_input_tokens=0, output_tokens=500),
            M_STOP,
        ],
    ),
    (
        "a second start after the delta",
        [_m_start(), _m_delta(output_tokens=500), _m_start(10), M_STOP],
    ),
    (
        "a second start before the delta",
        [_m_start(), _m_start(10), _m_delta(output_tokens=500), M_STOP],
    ),
    (
        "two messages in one stream",
        [_m_start(), _m_delta(output_tokens=500), _m_start(10), _m_delta(output_tokens=2), M_STOP],
    ),
    (
        "a start after the stop",
        [_m_start(), _m_delta(output_tokens=500), M_STOP, _m_start(5), _m_delta(output_tokens=1)],
    ),
    (
        "a delta after the stop",
        [_m_start(), _m_delta(output_tokens=500), M_STOP, _m_delta(output_tokens=900)],
    ),
    (
        "a content block after the stop",
        [
            _m_start(),
            _m_delta(output_tokens=500),
            M_STOP,
            ("content_block_start", {"type": "content_block_start"}),
        ],
    ),
    ("an error after the delta", [_m_start(), _m_delta(output_tokens=500), M_ERROR]),
    ("an error after the stop", [_m_start(), _m_delta(output_tokens=500), M_STOP, M_ERROR]),
    (
        "the tier priority in the start, standard in the delta",
        [
            _m_start(service_tier="priority"),
            _m_delta(output_tokens=500, service_tier="standard"),
            M_STOP,
        ],
    ),
    (
        "a server tool in the start, none in the delta",
        [
            _m_start(server_tool_use={"web_search_requests": 2}),
            _m_delta(output_tokens=500, server_tool_use={"web_search_requests": 0}),
            M_STOP,
        ],
    ),
    (
        "a cache write split in the start, flat zero in the delta",
        [
            _m_start(
                cache_creation={"ephemeral_5m_input_tokens": 100, "ephemeral_1h_input_tokens": 200},
                cache_creation_input_tokens=300,
            ),
            _m_delta(output_tokens=500, cache_creation_input_tokens=0),
            M_STOP,
        ],
    ),
]


# #551-R569-S1
@pytest.mark.parametrize(("name", "events"), MESSAGES_FINE, ids=[c[0] for c in MESSAGES_FINE])
@pytest.mark.parametrize("size", [0, 1])
def test_messages_events_in_the_order_of_the_api_give_one_usage(
    name: str, events: list[tuple[str | None, Any]], size: int
) -> None:
    got = assert_priceable(read_stream(MESSAGES, sse(*events), size=size))
    assert got.completion_tokens == 500
    assert got.prompt_tokens in (1000, 5000)


# #551-R569-S1
@pytest.mark.parametrize(("name", "events"), MESSAGES_BROKEN, ids=[c[0] for c in MESSAGES_BROKEN])
@pytest.mark.parametrize("size", [0, 1])
def test_messages_events_out_of_order_repeated_or_going_backwards_are_unknown(
    name: str, events: list[tuple[str | None, Any]], size: int
) -> None:
    assert_unknown(read_stream(MESSAGES, sse(*events), size=size))


CHAT_FINISH: dict[str, Any] = {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
CHAT_CONTENT: dict[str, Any] = {"choices": [{"index": 0, "delta": {"content": "x"}}]}


def _usage_chunk(prompt: int = 1000, completion: int = 500, **extra: Any) -> dict[str, Any]:
    usage = {"prompt_tokens": prompt, "completion_tokens": completion, **extra}
    return {"choices": [], "usage": usage}


def _with_usage(chunk: dict[str, Any], **usage: Any) -> dict[str, Any]:
    return {**chunk, "usage": {"prompt_tokens": 1000, "completion_tokens": 500, **usage}}


DONE: tuple[str | None, Any] = (None, "[DONE]")

CHAT_FINE: list[tuple[str, list[tuple[str | None, Any]]]] = [
    (
        "the usage after the finish",
        [(None, CHAT_CONTENT), (None, CHAT_FINISH), (None, _usage_chunk()), DONE],
    ),
    (
        "the usage in the finish chunk",
        [(None, CHAT_CONTENT), (None, _with_usage(CHAT_FINISH)), DONE],
    ),
    (
        "usage null on every chunk before",
        [
            (None, {**CHAT_CONTENT, "usage": None}),
            (None, {**CHAT_FINISH, "usage": None}),
            (None, _usage_chunk()),
            DONE,
        ],
    ),
    (
        "usage null after the real one",
        [
            (None, CHAT_CONTENT),
            (None, CHAT_FINISH),
            (None, _usage_chunk()),
            (None, {"choices": [], "usage": None}),
            DONE,
        ],
    ),
    (
        "no DONE, the usage ends it",
        [(None, CHAT_CONTENT), (None, CHAT_FINISH), (None, _usage_chunk())],
    ),
]

CHAT_BROKEN: list[tuple[str, list[tuple[str | None, Any]]]] = [
    (
        "two usage chunks, the last states less",
        [(None, CHAT_FINISH), (None, _usage_chunk()), (None, _usage_chunk(1000, 5)), DONE],
    ),
    (
        "two usage chunks that are the same",
        [(None, CHAT_FINISH), (None, _usage_chunk()), (None, _usage_chunk()), DONE],
    ),
    (
        "two usage chunks, the last states more",
        [(None, CHAT_FINISH), (None, _usage_chunk(1000, 5)), (None, _usage_chunk()), DONE],
    ),
    (
        "an early usage and none after the finish",
        [(None, _with_usage(CHAT_CONTENT, completion_tokens=1)), (None, CHAT_FINISH), DONE],
    ),
    (
        "an early usage, no DONE",
        [(None, _with_usage(CHAT_CONTENT, completion_tokens=1)), (None, CHAT_FINISH)],
    ),
    (
        "an early usage and a usage after the finish",
        [
            (None, _with_usage(CHAT_CONTENT, completion_tokens=1)),
            (None, CHAT_FINISH),
            (None, _usage_chunk()),
            DONE,
        ],
    ),
    (
        "an early usage and DONE only",
        [(None, _with_usage(CHAT_CONTENT, completion_tokens=1)), DONE],
    ),
    (
        "a usage in the finish chunk and another after it",
        [(None, _with_usage(CHAT_FINISH)), (None, _usage_chunk()), DONE],
    ),
    (
        "the usage, then an empty usage",
        [(None, CHAT_FINISH), (None, _usage_chunk()), (None, {"choices": [], "usage": {}}), DONE],
    ),
    (
        "the usage, then a usage that is text",
        [
            (None, CHAT_FINISH),
            (None, _usage_chunk()),
            (None, {"choices": [], "usage": "nope"}),
            DONE,
        ],
    ),
    (
        "the usage, then a usage that is a list",
        [
            (None, CHAT_FINISH),
            (None, _usage_chunk()),
            (None, {"choices": [], "usage": [1, 2]}),
            DONE,
        ],
    ),
]


# #551-R569-S1
@pytest.mark.parametrize(("name", "events"), CHAT_FINE, ids=[c[0] for c in CHAT_FINE])
@pytest.mark.parametrize("size", [0, 1])
def test_a_chat_usage_in_or_after_the_finish_chunk_is_the_usage(
    name: str, events: list[tuple[str | None, Any]], size: int
) -> None:
    got = assert_priceable(read_stream(CHAT, sse(*events), size=size))
    assert (got.prompt_tokens, got.completion_tokens) == (1000, 500)


# #551-R569-S1
# #551-R569-S2
@pytest.mark.parametrize(("name", "events"), CHAT_BROKEN, ids=[c[0] for c in CHAT_BROKEN])
@pytest.mark.parametrize("size", [0, 1])
def test_a_chat_usage_before_the_finish_or_stated_twice_is_unknown(
    name: str, events: list[tuple[str | None, Any]], size: int
) -> None:
    assert_unknown(read_stream(CHAT, sse(*events), size=size))


RESPONSES_USAGE: dict[str, Any] = {"input_tokens": 1000, "output_tokens": 500}


def _terminal(
    kind: str = "response.completed", usage: dict[str, Any] | None = None
) -> tuple[str, Any]:
    response = {"id": "r", "usage": RESPONSES_USAGE if usage is None else usage}
    return (kind, {"type": kind, "response": response})


RESPONSES_BROKEN: list[tuple[str, list[tuple[str | None, Any]]]] = [
    (
        "two completed, the last states less",
        [_terminal(), _terminal(usage={"input_tokens": 1000, "output_tokens": 5})],
    ),
    ("two completed that are the same", [_terminal(), _terminal()]),
    ("completed, then incomplete", [_terminal(), _terminal("response.incomplete")]),
    ("incomplete, then completed", [_terminal("response.incomplete"), _terminal()]),
    ("completed, then failed", [_terminal(), _terminal("response.failed")]),
]


# #551-R569-S1
@pytest.mark.parametrize("kind", ["response.completed", "response.incomplete"])
def test_a_responses_stream_with_one_terminal_event_gives_its_usage(kind: str) -> None:
    created = ("response.created", {"type": "response.created", "response": {"usage": None}})
    got = assert_priceable(read_stream(RESPONSES, sse(created, _terminal(kind))))
    assert (got.prompt_tokens, got.completion_tokens) == (1000, 500)


# #551-R569-S1
@pytest.mark.parametrize(("name", "events"), RESPONSES_BROKEN, ids=[c[0] for c in RESPONSES_BROKEN])
def test_a_responses_stream_with_a_second_terminal_event_is_unknown(
    name: str, events: list[tuple[str | None, Any]]
) -> None:
    assert_unknown(read_stream(RESPONSES, sse(*events)))


def _g_chunk(
    usage: dict[str, Any] | None = None, *, finish: bool = False
) -> tuple[str | None, Any]:
    candidate: dict[str, Any] = {"index": 0, "content": {"parts": [{"text": "x"}]}}
    if finish:
        candidate["finishReason"] = "STOP"
    chunk: dict[str, Any] = {"candidates": [candidate]}
    if usage is not None:
        chunk["usageMetadata"] = usage
    return (None, chunk)


def _gu(candidates: int = 500, **extra: int) -> dict[str, int]:
    return {"promptTokenCount": 1000, "candidatesTokenCount": candidates, **extra}


GOOGLE_FINE: list[tuple[str, list[tuple[str | None, Any]]]] = [
    (
        "cumulative and growing",
        [_g_chunk(_gu(10)), _g_chunk(_gu(300)), _g_chunk(_gu(500), finish=True)],
    ),
    ("only the last chunk", [_g_chunk(), _g_chunk(_gu(), finish=True)]),
    (
        "a usage chunk after the finish, the same",
        [_g_chunk(_gu()), _g_chunk(finish=True), _g_chunk(_gu())],
    ),
    (
        "thoughts that appear late",
        [_g_chunk(_gu(10)), _g_chunk(_gu(500, thoughtsTokenCount=40), finish=True)],
    ),
]

GOOGLE_BROKEN: list[tuple[str, list[tuple[str | None, Any]]]] = [
    ("the last chunk states less", [_g_chunk(_gu(500)), _g_chunk(_gu(5), finish=True)]),
    (
        "the finish states more, a chunk after it less",
        [_g_chunk(_gu(500), finish=True), _g_chunk(_gu(2))],
    ),
    (
        "two finishes, the second states less",
        [_g_chunk(_gu(500), finish=True), _g_chunk(_gu(2), finish=True)],
    ),
    (
        "the thoughts shrink",
        [_g_chunk(_gu(500, thoughtsTokenCount=30)), _g_chunk(_gu(500), finish=True)],
    ),
    (
        "the prompt shrinks",
        [
            _g_chunk(_gu(10)),
            _g_chunk({"promptTokenCount": 900, "candidatesTokenCount": 500}, finish=True),
        ],
    ),
    (
        "a field that could carry a price in an earlier chunk only",
        [_g_chunk(_gu(10, toolUsePromptTokenCount=40)), _g_chunk(_gu(500), finish=True)],
    ),
    (
        "a traffic type in an earlier chunk only",
        [
            _g_chunk({**_gu(10), "trafficType": "PROVISIONED_THROUGHPUT"}),
            _g_chunk(_gu(500), finish=True),
        ],
    ),
    ("the finish chunk has no usage", [_g_chunk(_gu(500)), _g_chunk(finish=True)]),
]


# #551-R569-S1
@pytest.mark.parametrize(("name", "events"), GOOGLE_FINE, ids=[c[0] for c in GOOGLE_FINE])
@pytest.mark.parametrize("size", [0, 1])
def test_google_usage_that_stays_or_grows_is_the_last_statement(
    name: str, events: list[tuple[str | None, Any]], size: int
) -> None:
    got = assert_priceable(read_stream(GOOGLE, sse(*events), size=size))
    assert got.prompt_tokens == 1000
    assert got.completion_tokens in (500, 540)


# #551-R569-S1
# #551-R569-N3
@pytest.mark.parametrize(("name", "events"), GOOGLE_BROKEN, ids=[c[0] for c in GOOGLE_BROKEN])
@pytest.mark.parametrize("size", [0, 1])
def test_google_usage_that_goes_backwards_or_hides_a_field_is_unknown(
    name: str, events: list[tuple[str | None, Any]], size: int
) -> None:
    assert_unknown(read_stream(GOOGLE, sse(*events), size=size))


# #551-R569-S1
@pytest.mark.parametrize("family", FAMILIES)
@pytest.mark.parametrize("size", [0, 1])
def test_the_fakes_duplicate_usage_is_unknown(family: WireFamily, size: int) -> None:
    result = read_stream(family, fake_stream(family, 3, usage_fault="duplicate"), size=size)
    assert_unknown(result)
    # The same call without the fault is whole: only the repeated statement made it unknown.
    assert_priceable(read_stream(family, fake_stream(family, 3), size=size))


# #551-R569-S1
@pytest.mark.parametrize("family", [CHAT, MESSAGES, GOOGLE])
@pytest.mark.parametrize("size", [0, 1])
def test_the_fakes_usage_out_of_order_is_unknown(family: WireFamily, size: int) -> None:
    options: dict[str, Any] = {"cumulative_usage": True} if family is GOOGLE else {}
    data = fake_stream(family, 3, usage_fault="out_of_order", **options)
    assert_unknown(read_stream(family, data, size=size))


# -- review of PR #569: the total the provider states must agree with the counts (S5) -----------

TOTALS_FINE: list[tuple[WireFamily, dict[str, Any]]] = [
    (CHAT, {**CHAT_OK, "total_tokens": 120}),
    (CHAT, {**CHAT_OK}),
    (CHAT, {**CHAT_OK, "total_tokens": 120, "completion_tokens_details": {"reasoning_tokens": 5}}),
    (RESPONSES, {**RESPONSES_OK, "total_tokens": 120}),
    (GOOGLE, {**GOOGLE_OK, "totalTokenCount": 120}),
    (GOOGLE, {**GOOGLE_OK, "thoughtsTokenCount": 7, "totalTokenCount": 127}),
]
TOTALS_BROKEN: list[tuple[str, WireFamily, dict[str, Any]]] = [
    ("chat, the total is more", CHAT, {**CHAT_OK, "total_tokens": 121}),
    ("chat, the total is less", CHAT, {**CHAT_OK, "total_tokens": 119}),
    (
        "chat, reasoning on top of the completion, as xAI states it",
        CHAT,
        {
            "prompt_tokens": 1000,
            "completion_tokens": 200,
            "total_tokens": 1500,
            "completion_tokens_details": {"reasoning_tokens": 300},
        },
    ),
    ("chat, the total is not a count", CHAT, {**CHAT_OK, "total_tokens": "120"}),
    ("chat, the total is negative", CHAT, {**CHAT_OK, "total_tokens": -120}),
    ("responses, the total is more", RESPONSES, {**RESPONSES_OK, "total_tokens": 500}),
    ("responses, the total is less", RESPONSES, {**RESPONSES_OK, "total_tokens": 20}),
    (
        "google, the total leaves out the thoughts",
        GOOGLE,
        {**GOOGLE_OK, "thoughtsTokenCount": 7, "totalTokenCount": 120},
    ),
    ("google, the total is more", GOOGLE, {**GOOGLE_OK, "totalTokenCount": 9999}),
    ("google, the total is less", GOOGLE, {**GOOGLE_OK, "totalTokenCount": 100}),
]


# #551-R569-S5
@pytest.mark.parametrize(("family", "usage"), TOTALS_FINE)
def test_a_total_that_agrees_with_the_counts_or_is_not_stated_is_no_unknown_field(
    family: WireFamily, usage: dict[str, Any]
) -> None:
    assert_priceable(read_document(family, _wrap(family, usage)))


# #551-R569-S5
@pytest.mark.parametrize(
    ("name", "family", "usage"), TOTALS_BROKEN, ids=[c[0] for c in TOTALS_BROKEN]
)
def test_a_total_that_disagrees_with_the_counts_is_unknown(
    name: str, family: WireFamily, usage: dict[str, Any]
) -> None:
    result = read_document(family, _wrap(family, usage))
    assert result.usage is not None
    assert result.usage.unknown_fields, "a total that disagrees must not be priced"
    # The same in a stream.
    if family is CHAT:
        data = sse((None, CHAT_FINISH), (None, {"choices": [], "usage": usage}), DONE)
        assert_unknown(read_stream(CHAT, data))


# -- review of PR #569: the tap never fails the relay (N1) ---------------------------------------


def _deep(depth: int) -> str:
    return "[" * depth + "1" + "]" * depth


# #551-R569-N1
@pytest.mark.parametrize("depth", [100, 300, 480, 600, 900, 5000])
@pytest.mark.parametrize("family", FAMILIES)
def test_a_usage_field_nested_deeper_than_the_parser_goes_is_unknown_and_never_raises(
    family: WireFamily, depth: int
) -> None:
    usage = json.dumps(OK_OF[family])[:-1] + f', "x": {_deep(depth)}}}'
    if family is GOOGLE:
        document = f'{{"candidates": [{{"finishReason": "STOP"}}], "usageMetadata": {usage}}}'
        events = f"data: {document}\n\n"
    elif family is RESPONSES:
        document = f'{{"type": "response.completed", "response": {{"usage": {usage}}}}}'
        events = f"event: response.completed\ndata: {document}\n\n"
    elif family is MESSAGES:
        document = f'{{"usage": {usage}}}'
        events = (
            f'event: message_start\ndata: {{"type": "message_start", "message": {document}}}\n\n'
            "event: message_delta\n"
            'data: {"type": "message_delta", "usage": {"output_tokens": 20}}\n\n'
            'event: message_stop\ndata: {"type": "message_stop"}\n\n'
        )
    else:
        document = f'{{"choices": [], "usage": {usage}}}'
        events = (
            'data: {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}\n\n'
            f"data: {document}\n\ndata: [DONE]\n\n"
        )
    # Whether the parser reads it or gives up on it, the tap does not raise and the call is unknown.
    assert_unknown(read_stream(family, events.encode()))
    tap = tap_for(family, sse=False)
    tap.feed(document.encode())
    assert_unknown(tap.finish())


# #551-R569-N1
def test_what_a_field_holds_is_decided_without_recursing() -> None:
    from code_reviewer_runner.dynamic_review.passthrough.usage_normalize import holds_something

    nested: Any = 1
    for _ in range(2_000):
        nested = [nested]
    assert holds_something(nested)
    empty: Any = 0
    for _ in range(2_000):
        empty = {"a": empty}
    assert not holds_something(empty)
