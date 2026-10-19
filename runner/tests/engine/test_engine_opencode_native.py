# SPDX-License-Identifier: Apache-2.0

"""The pinned OpenCode against a plain key swapping relay, one test per claim of #546 (#544).

Study #544 rests on claims it could only read in source: that the pinned OpenCode (v1.19.0)
resolves a model it has never heard of from the per-job config entry alone, that it speaks all
four wire families through a relay that only swaps the key, and that nothing in the relay has to
understand the body. Every test here runs the real, unmodified binary through the real tool loop
(read, grep, glob) against `fakes/wire` over loopback: a strict scripted upstream per family and
the relay of `fakes/wire/relay.py` in front of it. The engine holds a dummy key; only the relay
knows the real one. No real provider, key or model is involved, so what these tests prove is the
behavior of the engine and the shape of its requests. What only a real provider can prove (its
real usage forms, its real errors) is the live checklist in docs/spike/544-passthrough.md.

The support code is `opencode_native.py`. Run with `uv run pytest -m engine` and this file's path.
"""

import json
import sys
from pathlib import Path
from typing import Any, cast

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.llm.anthropic_rules import StrictMessagesApi
from fakes.wire.formats import AUTH_HEADER, FAMILIES, Family, request_path
from opencode_native import (
    DEFAULT_IDS,
    NativeRun,
    native_run,
    resolved_model,
)

pytestmark = pytest.mark.engine

TOOL_ORDER = ["glob", "read", "grep", "read", "glob", "grep"]
OUTPUT_CAP = {
    "chat": ("max_tokens",),
    "responses": ("max_output_tokens",),
    "messages": ("max_tokens",),
    "google": ("generationConfig", "maxOutputTokens"),
}
# The headers the pinned engine sends besides the key, per family: the allow-list #550 builds on.
COMMON_HEADERS = {
    "accept",
    "accept-encoding",
    "connection",
    "content-length",
    "content-type",
    "host",
    "user-agent",
    "x-opencode-session-id",
    "x-session-affinity",
    "x-session-id",
}
FAMILY_HEADERS = {
    "chat": {"authorization"},
    "responses": {"authorization"},
    "messages": {"x-api-key", "anthropic-version", "anthropic-beta"},
    "google": {"x-goog-api-key"},
}


@pytest.fixture(scope="module")
def loops(tmp_path_factory: pytest.TempPathFactory) -> dict[Family, NativeRun]:
    """One six step tool loop per family, on a provider and a model no snapshot has."""
    return {
        family: native_run(tmp_path_factory.mktemp(f"loop-{family}"), family) for family in FAMILIES
    }


def sent(run: NativeRun) -> list[dict[str, Any]]:
    """The chat calls' bodies as the engine sent them (tool-less title calls included)."""
    bodies: list[dict[str, Any]] = []
    for seen in run.relay.seen:
        body: Any = seen.body
        if isinstance(body, dict):
            bodies.append(cast("dict[str, Any]", body))
    return bodies


def output_cap(family: Family, body: dict[str, Any]) -> Any:
    value: Any = body
    for key in OUTPUT_CAP[family]:
        value = value[key]
    return value


# -- T03, T04: the model is resolved from the config entry alone --------------------------------


# #546-T04
@pytest.mark.parametrize("family", FAMILIES)
def test_a_provider_the_snapshot_does_not_know_runs_a_six_step_tool_loop_from_its_config_entry(
    loops: dict[Family, NativeRun], family: Family
) -> None:
    run = loops[family]

    assert run.http_status == 200
    assert [step.tools for step in run.assistants[:6]] == [[tool] for tool in TOOL_ORDER]
    assert [step.finish for step in run.assistants] == ["tool-calls"] * 6 + ["stop"]
    assert all(step.error is None for step in run.assistants)
    assert len(run.upstream.records) == 7
    assert [seen.status for seen in run.relay.seen] == [200] * 7


# #546-T04
@pytest.mark.parametrize("family", FAMILIES)
def test_the_engine_lists_the_model_of_the_entry_with_the_limits_and_capabilities_it_states(
    loops: dict[Family, NativeRun], family: Family
) -> None:
    model = loops[family].resolved

    assert model["status"] == "active"
    assert model["limit"] == {"context": 200000, "output": 8192}
    assert model["capabilities"]["toolcall"] is True
    assert model["api"]["id"] == DEFAULT_IDS[family][1]


# #546-T03
@pytest.mark.parametrize(
    ("family", "provider", "model"),
    [
        ("messages", "anthropic", "claude-spike-9"),
        ("responses", "openai", "gpt-spike-9"),
        ("google", "google", "gemini-spike-9"),
    ],
)
def test_a_model_the_snapshot_lacks_runs_under_a_provider_the_snapshot_has_without_naming_the_sdk(
    tmp_path: Path, family: Family, provider: str, model: str
) -> None:
    run = native_run(tmp_path, family, provider=provider, model=model, npm=False, steps=1)

    assert run.http_status == 200
    assert [step.finish for step in run.assistants] == ["tool-calls", "stop"]
    assert run.relay.seen[0].target.split("?")[0] == request_path(family, model)


# #546-T03
def test_a_model_that_is_in_the_snapshot_keeps_its_prices_and_limits_under_an_empty_entry(
    tmp_path: Path,
) -> None:
    model = resolved_model(
        tmp_path, "messages", provider="anthropic", model="claude-sonnet-5-5", npm=False, entry={}
    )

    assert model["cost"]["input"] == 2
    assert model["limit"]["output"] == 128000
    assert model["capabilities"]["reasoning"] is True


# #546-T04
def test_a_new_provider_without_an_sdk_name_speaks_openai_chat_whatever_the_family(
    tmp_path: Path,
) -> None:
    run = native_run(tmp_path, "messages", npm=False, steps=1)

    first = run.relay.seen[0]
    assert first.target == "/v1/chat/completions"
    assert first.status == 401  # the relay wanted the dummy in x-api-key; the engine sent a bearer


# #546-T03
def test_an_entry_with_a_limit_must_state_both_the_context_and_the_output(tmp_path: Path) -> None:
    with pytest.raises(AssertionError, match="Missing key"):
        native_run(tmp_path, "chat", entry={"limit": {"context": 200000}}, steps=1)


# #546-T03
def test_an_empty_entry_is_enough_and_the_output_cap_falls_back_to_thirty_two_thousand(
    tmp_path: Path,
) -> None:
    run = native_run(tmp_path, "chat", entry={}, steps=1)

    assert run.http_status == 200
    assert sent(run)[0]["max_tokens"] == 32000


# #546-T03
def test_the_output_cap_of_a_request_is_at_most_thirty_two_thousand_whatever_the_limit(
    tmp_path: Path,
) -> None:
    run = native_run(
        tmp_path,
        "messages",
        provider="anthropic",
        model="claude-sonnet-5-5",
        npm=False,
        entry={},
        steps=1,
    )

    assert sent(run)[0]["max_tokens"] == 32000


# #546-T03
def test_a_model_entry_marked_deprecated_is_not_offered_by_the_engine(tmp_path: Path) -> None:
    run = native_run(tmp_path, "chat", entry={"status": "deprecated"}, steps=1)

    assert run.http_status == 500
    assert "ProviderModelNotFoundError" in run.log
    assert run.upstream.records == []


# #546-T05
def test_a_minimal_models_file_resolves_the_model_when_the_config_has_only_the_options(
    tmp_path: Path,
) -> None:
    run = native_run(tmp_path, "messages", models_file=True, steps=1)

    assert run.http_status == 200
    assert [step.finish for step in run.assistants] == ["tool-calls", "stop"]


# -- T06: prices -----------------------------------------------------------------------------


# #546-T06
def test_an_entry_without_cost_is_priced_at_zero_by_the_engine_while_the_usage_is_real(
    loops: dict[Family, NativeRun],
) -> None:
    run = loops["chat"]

    assert [step.cost for step in run.assistants] == [0] * 7
    assert all(step.tokens["input"] > 0 for step in run.assistants)


# #546-T06
def test_the_engine_prices_the_usage_with_the_prices_of_the_entry_and_nothing_else(
    tmp_path: Path,
) -> None:
    prices = {"input": 3, "output": 15}
    run = native_run(tmp_path, "chat", entry={"cost": prices}, steps=1)

    first = run.assistants[0]
    # The first call states prompt 1010 (301 of them cached) and completion 21 (6 reasoning); the
    # cached tokens cost nothing here because the entry gives no cache price.
    assert first.cost == pytest.approx(((1010 - 301) * 3 + 21 * 15) / 1_000_000)


# -- T01, T02, T08, T09: what the engine sends -----------------------------------------------


# #546-T01
@pytest.mark.parametrize("family", FAMILIES)
def test_the_engine_sends_its_key_in_the_header_of_the_family_and_nowhere_else(
    loops: dict[Family, NativeRun], family: Family
) -> None:
    run = loops[family]
    key_headers = {"authorization", "x-api-key", "x-goog-api-key"}

    for seen in run.relay.seen:
        assert seen.headers[AUTH_HEADER[family]] == "<dummy>"
        assert key_headers & seen.headers.keys() == {AUTH_HEADER[family]}
    assert "dummy" not in json.dumps([record.headers for record in run.upstream.records])


# #546-T01
@pytest.mark.parametrize("family", FAMILIES)
def test_the_headers_the_engine_sends_are_a_closed_set_per_family(
    loops: dict[Family, NativeRun], family: Family
) -> None:
    run = loops[family]

    for seen in run.relay.seen:
        names = set(seen.headers)
        assert names == COMMON_HEADERS | FAMILY_HEADERS[family]
        assert seen.headers["user-agent"].startswith("opencode/1.19.0 ")


# #546-T01
def test_the_messages_call_names_the_api_version_and_the_beta_features_it_uses(
    loops: dict[Family, NativeRun],
) -> None:
    headers = loops["messages"].relay.seen[0].headers

    assert headers["anthropic-version"] == "2023-06-01"
    assert "thinking-binding-controls-2026-08-01" in headers["anthropic-beta"]


# #546-T02, #546-T09
@pytest.mark.parametrize("family", FAMILIES)
def test_the_engine_only_posts_one_streaming_chat_call_per_step_and_never_asks_anything_else(
    loops: dict[Family, NativeRun], family: Family
) -> None:
    run = loops[family]
    path = request_path(family, DEFAULT_IDS[family][1])

    assert {seen.method for seen in run.relay.seen} == {"POST"}
    expected = path + ("?alt=sse" if family == "google" else "")
    assert {seen.target for seen in run.relay.seen} == {expected}
    if family != "google":
        assert all(body["stream"] is True for body in sent(run))


# #546-T02
def test_openai_chat_asks_for_the_usage_in_the_stream(loops: dict[Family, NativeRun]) -> None:
    assert all(body["stream_options"] == {"include_usage": True} for body in sent(loops["chat"]))


# #546-T08
@pytest.mark.parametrize("family", FAMILIES)
def test_the_output_cap_of_every_family_is_the_output_limit_of_the_entry(
    loops: dict[Family, NativeRun], family: Family
) -> None:
    assert {output_cap(family, body) for body in sent(loops[family])} == {8192}


# #546-T08
@pytest.mark.parametrize("family", FAMILIES)
def test_the_engine_lets_the_model_choose_its_tools_and_never_forces_one(
    loops: dict[Family, NativeRun], family: Family
) -> None:
    for body in sent(loops[family]):
        if family == "google":
            assert body["toolConfig"] == {"functionCallingConfig": {"mode": "AUTO"}}
        elif family == "messages":
            assert body["tool_choice"] == {"type": "auto"}
        else:
            assert body["tool_choice"] == "auto"


# #546-T02
def test_a_session_without_a_title_makes_one_extra_streamed_call_without_tools(
    tmp_path: Path,
) -> None:
    run = native_run(tmp_path, "chat", steps=1, title=None)

    bodies = sent(run)
    assert len(bodies) == 3
    assert "tools" not in bodies[0] and all("tools" in body for body in bodies[1:])
    assert all(body["stream"] is True for body in bodies)


# -- Q3: the engine's own prompt caching through a pure relay ------------------------------------


def mark_places(body: Any, place: str = "") -> set[str]:
    """Where a request carries a cache mark (`cache_control`, `prompt_cache_key`)."""
    found: set[str] = set()
    if isinstance(body, dict):
        for key, value in cast("dict[str, Any]", body).items():
            if key in ("cache_control", "prompt_cache_key"):
                found.add(f"{place}/{key}")
            found |= mark_places(value, f"{place}/{key}")
    elif isinstance(body, list):
        for index, value in enumerate(cast("list[Any]", body)):
            found |= mark_places(value, f"{place}[{index}]")
    return found


# #546-T08
@pytest.mark.parametrize("family", FAMILIES)
def test_the_relay_hands_on_every_request_body_byte_for_byte(
    loops: dict[Family, NativeRun], family: Family
) -> None:
    run = loops[family]

    assert [seen.sha256 for seen in run.relay.seen] == [r.sha256 for r in run.upstream.records]
    assert len(run.relay.seen) == 7


# #546-T08
def test_the_engine_marks_the_system_prompt_and_the_last_two_messages_for_anthropic_caching(
    loops: dict[Family, NativeRun],
) -> None:
    bodies = sent(loops["messages"])

    assert mark_places(bodies[0]) == {
        "/system[0]/cache_control",
        "/messages[0]/content[0]/cache_control",
    }
    count = len(bodies[-1]["messages"])
    assert mark_places(bodies[-1]) == {
        "/system[0]/cache_control",
        f"/messages[{count - 2}]/content[0]/cache_control",
        f"/messages[{count - 1}]/content[0]/cache_control",
    }


# #546-T08
def test_the_engine_keys_openai_prompt_caching_on_the_session(
    loops: dict[Family, NativeRun],
) -> None:
    run = loops["responses"]

    for seen in run.relay.seen:
        assert seen.body["prompt_cache_key"] == seen.headers["x-session-id"]


# #546-T08
@pytest.mark.parametrize("family", ("chat", "google"))
def test_the_engine_adds_no_cache_mark_for_a_plain_model_of_these_families(
    loops: dict[Family, NativeRun], family: Family
) -> None:
    assert all(mark_places(body) == set() for body in sent(loops[family]))


# #546-T08
def test_the_engine_marks_an_openai_compatible_model_whose_id_names_claude(
    tmp_path: Path,
) -> None:
    run = native_run(tmp_path, "chat", model="claude-spike-9", steps=2)

    assert all(mark_places(body) != set() for body in sent(run))
    assert [seen.sha256 for seen in run.relay.seen] == [r.sha256 for r in run.upstream.records]


# -- T08 and the surprise of the first spike run: thinking ---------------------------------------


# #546-T08
def test_reasoning_variants_are_derived_for_a_model_that_says_it_reasons(
    tmp_path: Path,
) -> None:
    entry: dict[str, Any] = {"limit": {"context": 200000, "output": 8192}, "reasoning": True}
    expected = {
        "chat": ["low", "medium", "high"],
        "responses": ["low", "medium", "high"],
        "messages": ["low", "medium", "high", "xhigh", "max"],
        "google": ["low", "medium", "high"],
    }

    for family in FAMILIES:
        model = resolved_model(tmp_path / family, family, entry=entry)
        assert list(model["variants"]) == expected[family]


# #546-T08
def test_a_model_without_the_reasoning_flag_has_no_variants(tmp_path: Path) -> None:
    for family in FAMILIES:
        assert resolved_model(tmp_path / family, family).get("variants", {}) == {}


# #546-T08
def test_gemini_is_asked_to_think_at_a_high_level_by_default_when_the_entry_says_it_reasons(
    tmp_path: Path,
) -> None:
    entry: dict[str, Any] = {"limit": {"context": 200000, "output": 8192}, "reasoning": True}

    run = native_run(tmp_path, "google", entry=entry, steps=1)

    config = sent(run)[0]["generationConfig"]
    assert config["thinkingConfig"] == {"includeThoughts": True, "thinkingLevel": "high"}


# #546-T01
def test_a_claude_model_that_refuses_a_forced_tool_choice_runs_the_loop_under_the_strict_rules(
    tmp_path: Path,
) -> None:
    strict = StrictMessagesApi()
    run = native_run(
        tmp_path,
        "messages",
        provider="anthropic",
        model="claude-fable-5-1",
        npm=False,
        entry={},
        steps=4,
        thinking="Let me look at the files.",
        judge=lambda headers, body: strict.check(headers, body),
        on_answer=lambda body, reply: strict.record(body, reply),
    )

    assert run.http_status == 200
    assert [seen.status for seen in run.relay.seen] == [200] * 5
    assert [step.finish for step in run.assistants] == ["tool-calls"] * 4 + ["stop"]
    for body in sent(run):
        assert body["tool_choice"] == {"type": "auto"}
        assert body["thinking"]["type"] == "adaptive"
        assert body["thinking"]["block_binding"] == {"prefix_mismatch_behavior": "drop_block"}


# #546-T01
def test_thinking_blocks_of_a_claude_answer_come_back_unchanged_in_the_next_request(
    tmp_path: Path,
) -> None:
    run = native_run(tmp_path, "messages", steps=3, thinking="Let me look at the files.")

    last = sent(run)[-1]
    replayed = [
        [(block["type"], block.get("signature")) for block in message["content"]]
        for message in last["messages"]
        if message["role"] == "assistant"
    ]
    assert replayed == [[("thinking", f"sig-{n}"), ("tool_use", None)] for n in (1, 2, 3)]


# #546-T01
def test_gemini_thoughts_and_signatures_come_back_with_their_function_call(
    tmp_path: Path,
) -> None:
    run = native_run(tmp_path, "google", steps=2, thinking="Let me look at the files.")

    last = sent(run)[-1]
    parts = [content["parts"] for content in last["contents"] if content["role"] == "model"]
    assert [part.get("thoughtSignature") for turn in parts for part in turn] == [
        None,
        "tsig-glob",
        None,
        "tsig-read",
    ]
    assert next(part.get("thought") for turn in parts for part in turn) is True


# -- T07: faults -----------------------------------------------------------------------------


# #546-T07
def test_the_engine_retries_a_429_and_one_logical_call_becomes_two_upstream_calls(
    tmp_path: Path,
) -> None:
    run = native_run(tmp_path, "chat", steps=1, prepare=lambda up: up.fail_next(429))

    assert run.http_status == 200
    assert [seen.status for seen in run.relay.seen] == [429, 200, 200]
    assert [step.finish for step in run.assistants] == ["tool-calls", "stop"]


# #546-T07
def test_the_engine_gives_up_on_a_429_after_six_upstream_calls_and_reports_the_provider_error(
    tmp_path: Path,
) -> None:
    run = native_run(tmp_path, "chat", steps=1, prepare=lambda up: up.fail_next(*[429] * 20))

    assert run.http_status == 200  # the turn is answered; the failure is in the message
    assert [seen.status for seen in run.relay.seen] == [429] * 6
    (step,) = run.assistants
    assert step.error is not None
    assert step.error["name"] == "APIError"
    assert step.error["data"]["statusCode"] == 429
    assert step.error["data"]["isRetryable"] is True
    assert "fake upstream 429" in step.error["data"]["responseBody"]


# #546-T07
@pytest.mark.parametrize("family", FAMILIES)
def test_a_stream_cut_midway_is_asked_for_again_as_a_whole_new_call(
    tmp_path: Path, family: Family
) -> None:
    run = native_run(
        tmp_path, family, steps=1, prepare=lambda up: up.cut_streams(after_events=1, times=1)
    )

    assert run.http_status == 200
    assert [step.finish for step in run.assistants] == ["tool-calls", "stop"]
    assert len(run.relay.seen) == 3
    assert len(run.relay.seen[0].response_bytes) < len(run.relay.seen[1].response_bytes)


# -- T10: unknown model -----------------------------------------------------------------------


# #546-T03
def test_a_model_the_config_does_not_name_fails_before_any_upstream_call(tmp_path: Path) -> None:
    run = native_run(tmp_path, "chat", ask_model="no-such-model", steps=1)

    assert run.http_status == 500
    assert run.reply["name"] == "UnknownError"
    assert "ProviderModelNotFoundError: Model not found: acme-chat/no-such-model" in run.log
    assert run.upstream.records == [] and run.relay.seen == []


# #546-T03
def test_a_provider_the_config_does_not_name_fails_the_same_way(tmp_path: Path) -> None:
    run = native_run(tmp_path, "chat", ask_provider="no-such-provider", steps=1)

    assert run.http_status == 500
    assert "ProviderModelNotFoundError: Model not found: no-such-provider/" in run.log
    assert run.upstream.records == []
