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

An engine start costs about five seconds, so the suite starts few engines and asks them many things:

- four family loops, one engine each (started side by side): a six step tool loop per wire family
  with everything that can be read off those requests and answers;
- one engine that knows a dozen providers, for what needs a turn or only the engine's own listing
  of a model (`GET /config/providers`): how an entry is resolved, what the engine sends for it;
- one engine for the faults: statuses, cut streams, errors inside a stream;
- two single launches, because they need an environment of their own: a models file, and a config
  the engine refuses.

The support code is `opencode_native.py`. Run with `uv run pytest -m engine` and this file's path.
"""

import json
import sys
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.llm.anthropic_rules import StrictMessagesApi
from fakes.wire.formats import AUTH_HEADER, FAMILIES, Family, request_path, usage_for
from fakes.wire.upstream import ScriptedUpstream
from opencode_native import (
    DEFAULT_IDS,
    MINIMAL_ENTRY,
    NPM,
    REAL_KEY,
    Outcome,
    Provider,
    Step,
    native_engine,
    run_plan,
    single_run,
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
# What the engine offers every provider to read the answer with (the relay must not pass it on).
ACCEPT_ENCODING = "gzip, deflate, br, zstd"
KEY_HEADERS = {"authorization", "x-api-key", "x-goog-api-key"}
THINKING = "Let me look at the files."
LIMITS = {"context": 200000, "output": 8192}
REASONING_ENTRY: dict[str, Any] = {"limit": LIMITS, "reasoning": True}
VARIANTS = {
    "chat": ["low", "medium", "high"],
    "responses": ["low", "medium", "high"],
    "messages": ["low", "medium", "high", "xhigh", "max"],
    "google": ["low", "medium", "high"],
}


# -- the four family loops ----------------------------------------------------------------------


@dataclass
class LoopResult:
    """A six step loop, with the engine's view of its providers and its log."""

    provider: Provider
    outcome: Outcome
    listed: dict[str, dict[str, Any]]
    log: str

    @property
    def model(self) -> dict[str, Any]:
        return self.listed[self.provider.provider_id][self.provider.model_id]


def _frame(chunk: int, crlf: bool = False, cumulative: bool = False) -> Callable[..., None]:
    def tune(upstream: ScriptedUpstream) -> None:
        upstream.rechunk, upstream.crlf = chunk, crlf
        upstream.google_cumulative_usage = cumulative

    return tune


def _strict_messages() -> Provider:
    """`claude-fable-5-1` from the snapshot (an empty entry) under the Messages API's strict rules.

    Its flags refuse a forced tool choice and need the thinking blocks back unchanged, so a loop
    that completes is the Fable case of #533 under the native SDK.
    """
    strict = StrictMessagesApi()
    return Provider(
        "messages",
        id="anthropic",
        model="claude-fable-5-1",
        entry={},
        npm=False,
        thinking=THINKING,
        judge=lambda headers, body: strict.check(headers, body),
        on_answer=lambda body, reply: strict.record(body, reply),
    )


LOOPS: dict[Family, list[Provider]] = {
    # The chat stream arrives in pieces of five bytes, which cut every line and event. A second
    # provider only has to be listed: a snapshot model the snapshot flags deprecated, with an entry
    # that says `active`.
    "chat": [
        Provider("chat", tune=_frame(5)),
        Provider(
            "chat", id="deepseek", model="deepseek-v4-flash", npm=False, entry={"status": "active"}
        ),
    ],
    "responses": [Provider("responses")],
    "messages": [_strict_messages()],
    # Google's real stream has CRLF line ends and (documented, not captured) a `usageMetadata` on
    # every chunk; the model says it reasons, so it thinks.
    "google": [
        Provider(
            "google",
            entry=REASONING_ENTRY,
            thinking=THINKING,
            tune=_frame(64, crlf=True, cumulative=True),
        )
    ],
}


def _run_loop(scratch: Path, providers: list[Provider]) -> LoopResult:
    main = providers[0]
    with native_engine(scratch, providers) as engine:
        outcome = engine.turn(main.provider_id, main.model_id)
        return LoopResult(
            main,
            outcome,
            {p.provider_id: engine.listed(p.provider_id) for p in providers},
            engine.log(),
        )


@pytest.fixture(scope="module")
def loops(tmp_path_factory: pytest.TempPathFactory) -> dict[Family, LoopResult]:
    """One six step tool loop per family, the four engines started side by side."""

    scratch = {family: tmp_path_factory.mktemp(f"loop-{family}") for family in FAMILIES}

    def run(family: Family) -> LoopResult:
        return _run_loop(scratch[family], LOOPS[family])

    with ThreadPoolExecutor(max_workers=len(FAMILIES)) as pool:
        return dict(zip(FAMILIES, pool.map(run, FAMILIES), strict=True))


def output_cap(family: Family, body: dict[str, Any]) -> Any:
    value: Any = body
    for key in OUTPUT_CAP[family]:
        value = value[key]
    return value


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


# #546-T01, #546-T04
@pytest.mark.parametrize("family", FAMILIES)
def test_a_six_step_tool_loop_completes_through_the_relay_on_every_family(
    loops: dict[Family, LoopResult], family: Family
) -> None:
    run = loops[family].outcome

    assert run.http_status == 200
    assert [step.tools for step in run.assistants[:6]] == [[tool] for tool in TOOL_ORDER]
    assert [step.finish for step in run.assistants] == ["tool-calls"] * 6 + ["stop"]
    assert all(step.error is None for step in run.assistants)
    assert len(run.records) == 7
    assert [seen.status for seen in run.seen] == [200] * 7


# #546-T04
@pytest.mark.parametrize("family", ("chat", "responses", "google"))
def test_the_engine_lists_the_model_of_the_entry_with_the_limits_and_capabilities_it_states(
    loops: dict[Family, LoopResult], family: Family
) -> None:
    model = loops[family].model

    assert model["status"] == "active"
    assert model["limit"] == LIMITS
    assert model["capabilities"]["toolcall"] is True
    assert model["api"]["id"] == DEFAULT_IDS[family][1]
    assert model["api"]["npm"] == NPM[family]


# #546-T01
@pytest.mark.parametrize("family", FAMILIES)
def test_the_engine_sends_its_key_in_the_header_of_the_family_and_nowhere_else(
    loops: dict[Family, LoopResult], family: Family
) -> None:
    run = loops[family].outcome

    for seen in run.seen:
        assert seen.headers[AUTH_HEADER[family]] == "<dummy>"
        assert KEY_HEADERS & seen.headers.keys() == {AUTH_HEADER[family]}
    assert "dummy" not in json.dumps([record.headers for record in run.records])


# #546-T01
@pytest.mark.parametrize("family", FAMILIES)
def test_the_headers_the_engine_sends_are_a_closed_set_per_family(
    loops: dict[Family, LoopResult], family: Family
) -> None:
    for seen in loops[family].outcome.seen:
        assert set(seen.headers) == COMMON_HEADERS | FAMILY_HEADERS[family]
        assert seen.headers["user-agent"].startswith("opencode/1.19.0 ")
        assert seen.headers["accept-encoding"] == ACCEPT_ENCODING


# #546-T01
def test_the_messages_call_names_the_api_version_and_the_beta_features_it_uses(
    loops: dict[Family, LoopResult],
) -> None:
    headers = loops["messages"].outcome.seen[0].headers

    assert headers["anthropic-version"] == "2023-06-01"
    assert "thinking-binding-controls-2026-08-01" in headers["anthropic-beta"]


# #546-T02, #546-T09
@pytest.mark.parametrize("family", FAMILIES)
def test_the_engine_only_posts_one_streaming_chat_call_per_step_and_never_asks_anything_else(
    loops: dict[Family, LoopResult], family: Family
) -> None:
    run = loops[family].outcome
    path = request_path(family, loops[family].provider.model_id)

    assert {seen.method for seen in run.seen} == {"POST"}
    expected = path + ("?alt=sse" if family == "google" else "")
    assert {seen.target for seen in run.seen} == {expected}
    if family != "google":
        assert all(body["stream"] is True for body in run.bodies())


# #546-T02
def test_openai_chat_asks_for_the_usage_in_the_stream(loops: dict[Family, LoopResult]) -> None:
    bodies = loops["chat"].outcome.bodies()

    assert all(body["stream_options"] == {"include_usage": True} for body in bodies)


# #546-T08
@pytest.mark.parametrize(
    ("family", "cap"),
    [("chat", 8192), ("responses", 8192), ("google", 8192), ("messages", 32000)],
)
def test_the_output_cap_of_every_family_is_the_output_limit_of_the_entry_but_at_most_32000(
    loops: dict[Family, LoopResult], family: Family, cap: int
) -> None:
    # Fable's snapshot limit is 128000, and the engine sends the smaller of that and 32000.
    assert {output_cap(family, body) for body in loops[family].outcome.bodies()} == {cap}


# #546-T08
@pytest.mark.parametrize("family", FAMILIES)
def test_the_engine_lets_the_model_choose_its_tools_and_never_forces_one(
    loops: dict[Family, LoopResult], family: Family
) -> None:
    for body in loops[family].outcome.bodies():
        if family == "google":
            assert body["toolConfig"] == {"functionCallingConfig": {"mode": "AUTO"}}
        elif family == "messages":
            assert body["tool_choice"] == {"type": "auto"}
        else:
            assert body["tool_choice"] == "auto"


# #546-T08
@pytest.mark.parametrize("family", FAMILIES)
def test_the_relay_hands_on_every_request_body_byte_for_byte(
    loops: dict[Family, LoopResult], family: Family
) -> None:
    run = loops[family].outcome

    assert [seen.sha256 for seen in run.seen] == [record.sha256 for record in run.records]
    assert len(run.seen) == 7


# -- what the engine counts, and what it prices ----------------------------------------------------


def counted(family: Family) -> dict[str, Any]:
    """What the engine makes of the usage of the first call, differently per family (report, 5)."""
    usage = usage_for(1)
    if family == "messages":  # nothing is split off, and the two cache writes are summed
        return {
            "input": usage.input,
            "output": usage.output,
            "reasoning": 0,
            "cache": {
                "read": usage.cache_read,
                "write": usage.cache_write_5m + usage.cache_write_1h,
            },
        }
    if family == "google":  # the thoughts are not part of the candidates
        return {
            "input": usage.input - usage.cache_read,
            "output": usage.output,
            "reasoning": usage.reasoning,
            "cache": {"read": usage.cache_read, "write": 0},
        }
    return {  # chat and responses: the cached prompt and the reasoning are split off
        "input": usage.input - usage.cache_read,
        "output": usage.output - usage.reasoning,
        "reasoning": usage.reasoning,
        "cache": {"read": usage.cache_read, "write": 0},
    }


# #546-T02, #546-T06
@pytest.mark.parametrize("family", FAMILIES)
def test_the_engine_counts_the_usage_of_each_family_in_its_own_way(
    loops: dict[Family, LoopResult], family: Family
) -> None:
    first = loops[family].outcome.assistants[0].tokens
    expected = counted(family)

    assert {key: first[key] for key in expected} == expected


# #546-T06
def test_an_entry_without_cost_is_priced_at_zero_by_the_engine_while_the_usage_is_real(
    loops: dict[Family, LoopResult],
) -> None:
    run = loops["chat"].outcome

    assert [step.cost for step in run.assistants] == [0] * 7
    assert all(step.tokens["input"] > 0 for step in run.assistants)


# -- caching through a pure relay ------------------------------------------------------------------


# #546-T08
def test_the_engine_marks_the_system_prompt_and_the_last_two_messages_for_anthropic_caching(
    loops: dict[Family, LoopResult],
) -> None:
    bodies = loops["messages"].outcome.bodies()

    assert mark_places(bodies[0]) == {
        "/system[0]/cache_control",
        "/messages[0]/content[0]/cache_control",
    }
    messages = bodies[-1]["messages"]
    last_blocks = {
        index: len(messages[index]["content"]) - 1
        for index in (len(messages) - 2, len(messages) - 1)
    }
    assert mark_places(bodies[-1]) == {
        "/system[0]/cache_control",
        *(
            f"/messages[{index}]/content[{block}]/cache_control"
            for index, block in last_blocks.items()
        ),
    }


# #546-T08
def test_the_engine_keys_openai_prompt_caching_on_the_session(
    loops: dict[Family, LoopResult],
) -> None:
    for seen in loops["responses"].outcome.seen:
        assert seen.body["prompt_cache_key"] == seen.headers["x-session-id"]


# #546-T08
@pytest.mark.parametrize("family", ("chat", "google"))
def test_the_engine_adds_no_cache_mark_for_a_plain_model_of_these_families(
    loops: dict[Family, LoopResult], family: Family
) -> None:
    assert all(mark_places(body) == set() for body in loops[family].outcome.bodies())


# -- thinking and the tool loop ------------------------------------------------------------------


# #546-T01
def test_a_claude_model_that_refuses_a_forced_tool_choice_runs_the_loop_under_the_strict_rules(
    loops: dict[Family, LoopResult],
) -> None:
    run = loops["messages"].outcome

    assert [seen.status for seen in run.seen] == [200] * 7  # no 400 from the strict rules
    for body in run.bodies():
        assert body["tool_choice"] == {"type": "auto"}
        assert body["thinking"]["type"] == "adaptive"
        assert body["thinking"]["block_binding"] == {"prefix_mismatch_behavior": "drop_block"}


# #546-T01
def test_thinking_blocks_of_a_claude_answer_come_back_unchanged_in_the_next_request(
    loops: dict[Family, LoopResult],
) -> None:
    last = loops["messages"].outcome.bodies()[-1]

    replayed = [
        [(block["type"], block.get("signature")) for block in message["content"]]
        for message in last["messages"]
        if message["role"] == "assistant"
    ]
    assert replayed == [[("thinking", f"sig-{n}"), ("tool_use", None)] for n in range(1, 7)]


# #546-T08
def test_gemini_is_asked_to_think_at_a_high_level_by_default_when_the_entry_says_it_reasons(
    loops: dict[Family, LoopResult],
) -> None:
    for body in loops["google"].outcome.bodies():
        config = body["generationConfig"]
        assert config["thinkingConfig"] == {"includeThoughts": True, "thinkingLevel": "high"}


# #546-T01
def test_gemini_thoughts_and_signatures_come_back_with_their_function_call(
    loops: dict[Family, LoopResult],
) -> None:
    last = loops["google"].outcome.bodies()[-1]

    parts = [content["parts"] for content in last["contents"] if content["role"] == "model"]
    flat = [part for turn in parts for part in turn]
    expected = [signature for tool in TOOL_ORDER for signature in (None, f"tsig-{tool}")]
    assert [part.get("thoughtSignature") for part in flat] == expected
    assert all(part.get("thought") for part in flat if "thoughtSignature" not in part)


# #546-T08
def test_reasoning_variants_are_derived_for_a_model_that_says_it_reasons_on_google(
    loops: dict[Family, LoopResult],
) -> None:
    assert list(loops["google"].model["variants"]) == VARIANTS["google"]


# #546-T03
def test_an_explicit_status_in_the_entry_overrides_the_deprecated_status_of_the_snapshot(
    loops: dict[Family, LoopResult],
) -> None:
    listed = loops["chat"].listed["deepseek"]

    assert listed["deepseek-v4-flash"]["status"] == "active"


# -- one engine that knows many providers ------------------------------------------------------


def _reasoning_pair(family: Family, provider: str) -> Provider:
    """A plain main model and, next to it, one that says it reasons (listed, never asked)."""
    return Provider(
        family,
        id=provider,
        model=f"{provider}-9",
        steps=1,
        others={f"{provider}-think": REASONING_ENTRY},
    )


def multi_providers() -> list[Provider]:
    priced = {**MINIMAL_ENTRY, "cost": {"input": 3, "output": 15}}
    return [
        # Statuses: `beta` runs, `alpha` and `deprecated` are not offered; one model that reasons.
        Provider(
            "chat",
            id="acme-status",
            model="acme-status-9",
            entry={"status": "beta"},
            steps=1,
            others={
                "acme-alpha-9": {"status": "alpha"},
                "acme-dep-9": {"status": "deprecated"},
                "acme-think": REASONING_ENTRY,
            },
        ),
        Provider("chat", id="acme-empty", model="acme-empty-9", entry={}, steps=1),
        Provider("chat", id="acme-priced", model="acme-priced-9", entry=priced, steps=1),
        Provider(
            "chat",
            id="acme-notool",
            model="acme-notool-9",
            entry={**MINIMAL_ENTRY, "tool_call": False},
            steps=1,
        ),
        # The family of the relay is Messages, but the entry names no SDK: the engine speaks Chat.
        Provider("messages", id="acme-nonpm", model="acme-nonpm-9", npm=False, steps=1),
        Provider(
            "chat",
            id="acme-pinned",
            model="acme-pinned-9",
            others={"acme-pinned-10": {}},
            steps=1,
            pinned=True,
        ),
        _reasoning_pair("responses", "acme-resp"),
        _reasoning_pair("messages", "acme-claude"),
        _reasoning_pair("google", "acme-gemini"),
        # A provider the snapshot has, a model it lacks, no SDK named (the snapshot's SDK is used).
        Provider(
            "messages",
            id="anthropic",
            model="claude-spike-9",
            entry={"limit": {"context": 1000000, "output": 128000}},
            npm=False,
            steps=1,
            others={"claude-sonnet-5-5": {}},
        ),
        Provider("responses", id="openai", model="gpt-spike-9", npm=False, steps=1),
        Provider("google", id="google", model="gemini-spike-9", npm=False, steps=1),
        # The providers a managed catalog would use, and the caching rule: marks follow the model
        # id (`claude` in it), not the provider id.
        Provider(
            "chat",
            id="deepseek",
            model="deepseek-spike-9",
            entry={},
            npm=False,
            steps=1,
            served=("claude-ds-9",),
            others={"claude-ds-9": {}, "deepseek-v4-flash": {}},
        ),
        Provider(
            "chat",
            id="openrouter",
            model="vendor/model-9",
            entry={},
            npm=False,
            steps=1,
            served=("anthropic/claude-spike-9",),
            others={"anthropic/claude-spike-9": {}},
        ),
    ]


def _ask(provider: Provider, model: str | None = None, **options: Any) -> Step:
    key = f"{provider.provider_id}/{model or provider.model_id}"
    return Step(key, provider.provider_id, model or provider.model_id, **options)


@dataclass
class Multi:
    outcomes: dict[str, Outcome]
    listed: dict[str, dict[str, Any]]
    log: str

    def run(self, provider: str, model: str) -> Outcome:
        return self.outcomes[f"{provider}/{model}"]


@pytest.fixture(scope="module")
def multi(tmp_path_factory: pytest.TempPathFactory) -> Multi:
    providers = {p.provider_id: p for p in multi_providers()}
    asks = [
        _ask(providers["acme-status"]),
        _ask(providers["acme-status"], "acme-dep-9"),
        _ask(providers["acme-empty"]),
        Step("unknown-model", "acme-empty", "no-such-model"),
        Step("unknown-provider", "no-such-provider", "acme-empty-9"),
        _ask(providers["acme-priced"]),
        Step("priced-untitled", "acme-priced", "acme-priced-9", title=None),
        _ask(providers["acme-notool"]),
        _ask(providers["acme-nonpm"]),
        _ask(providers["acme-pinned"], "acme-pinned-10"),
        _ask(providers["acme-pinned"]),
        _ask(providers["acme-claude"]),
        _ask(providers["anthropic"]),
        _ask(providers["openai"]),
        _ask(providers["google"]),
        _ask(providers["deepseek"]),
        _ask(providers["deepseek"], "claude-ds-9"),
        _ask(providers["openrouter"]),
        _ask(providers["openrouter"], "anthropic/claude-spike-9"),
    ]
    with native_engine(tmp_path_factory.mktemp("multi"), list(providers.values())) as engine:
        outcomes = run_plan(engine, asks)
        listed = {name: engine.listed(name) for name in providers}
        return Multi(outcomes, listed, engine.log())


# #546-T03
@pytest.mark.parametrize(
    ("provider", "model", "path"),
    [
        ("anthropic", "claude-spike-9", "/v1/messages"),
        ("openai", "gpt-spike-9", "/v1/responses"),
        ("google", "gemini-spike-9", "/v1beta/models/gemini-spike-9:streamGenerateContent"),
    ],
)
def test_a_model_the_snapshot_lacks_runs_under_a_provider_the_snapshot_has_without_naming_the_sdk(
    multi: Multi, provider: str, model: str, path: str
) -> None:
    run = multi.run(provider, model)

    assert run.http_status == 200
    assert [step.finish for step in run.assistants] == ["tool-calls", "stop"]
    assert run.seen[0].target.split("?")[0] == path


# #546-T03
def test_a_model_that_is_in_the_snapshot_keeps_its_prices_and_limits_under_an_empty_entry(
    multi: Multi,
) -> None:
    model = multi.listed["anthropic"]["claude-sonnet-5-5"]

    assert model["cost"]["input"] == 2
    assert model["limit"]["output"] == 128000
    assert model["capabilities"]["reasoning"] is True


# #546-T04
def test_a_new_provider_without_an_sdk_name_speaks_openai_chat_whatever_the_family(
    multi: Multi,
) -> None:
    first = multi.run("acme-nonpm", "acme-nonpm-9").seen[0]

    assert first.target == "/v1/chat/completions"
    assert first.status == 401  # the relay wanted the dummy in x-api-key; the engine sent a bearer


# #546-T03
def test_an_empty_entry_is_enough_and_the_output_cap_falls_back_to_thirty_two_thousand(
    multi: Multi,
) -> None:
    run = multi.run("acme-empty", "acme-empty-9")

    assert run.http_status == 200
    assert run.bodies()[0]["max_tokens"] == 32000
    assert multi.listed["acme-empty"]["acme-empty-9"]["cost"]["input"] == 0


# #546-T03
def test_the_output_cap_of_a_request_is_at_most_thirty_two_thousand_whatever_the_limit(
    multi: Multi,
) -> None:
    run = multi.run("anthropic", "claude-spike-9")

    assert multi.listed["anthropic"]["claude-spike-9"]["limit"]["output"] == 128000
    assert run.bodies()[0]["max_tokens"] == 32000


# #546-T03
def test_a_model_marked_beta_runs_and_one_marked_alpha_or_deprecated_is_not_offered(
    multi: Multi,
) -> None:
    run = multi.run("acme-status", "acme-status-9")
    listed = multi.listed["acme-status"]

    assert run.http_status == 200
    assert listed["acme-status-9"]["status"] == "beta"
    assert "acme-alpha-9" not in listed and "acme-dep-9" not in listed


# #546-T03
def test_a_model_entry_marked_deprecated_fails_the_turn_before_any_upstream_call(
    multi: Multi,
) -> None:
    run = multi.run("acme-status", "acme-dep-9")

    assert run.http_status == 500
    assert "ProviderModelNotFoundError: Model not found: acme-status/acme-dep-9" in multi.log
    assert run.records == [] and run.seen == []


# #546-T03
def test_the_status_of_the_snapshot_applies_when_the_entry_states_none(multi: Multi) -> None:
    # `deepseek-v4-flash` is in the pinned snapshot with models.dev status `deprecated`; the entry
    # for it is empty, and the model is gone. (An entry that says `active` brings it back, above.)
    assert "deepseek-v4-flash" not in multi.listed["deepseek"]
    assert "deepseek-flash" in multi.listed["deepseek"]


# #546-T03
def test_a_model_the_config_does_not_name_fails_before_any_upstream_call(multi: Multi) -> None:
    run = multi.outcomes["unknown-model"]

    assert run.http_status == 500
    assert run.reply["name"] == "UnknownError"
    assert "ProviderModelNotFoundError: Model not found: acme-empty/no-such-model" in multi.log
    assert run.records == [] and run.seen == []


# #546-T03
def test_a_provider_the_config_does_not_name_fails_the_same_way(multi: Multi) -> None:
    run = multi.outcomes["unknown-provider"]

    assert run.http_status == 500
    assert "ProviderModelNotFoundError: Model not found: no-such-provider/" in multi.log


# #546-T03
def test_a_model_entry_that_says_it_cannot_call_tools_is_still_sent_the_tools(
    multi: Multi,
) -> None:
    run = multi.run("acme-notool", "acme-notool-9")

    assert multi.listed["acme-notool"]["acme-notool-9"]["capabilities"]["toolcall"] is False
    assert run.bodies()[0]["tools"]
    assert [step.tools for step in run.assistants[:1]] == [["glob"]]


# #546-T06
def test_the_engine_prices_the_usage_with_the_prices_of_the_entry_and_nothing_else(
    multi: Multi,
) -> None:
    first = multi.run("acme-priced", "acme-priced-9").assistants[0]

    # The first call states prompt 1010 (301 of them cached) and completion 21 (6 reasoning); the
    # cached tokens cost nothing here because the entry gives no cache price.
    assert first.cost == pytest.approx(((1010 - 301) * 3 + 21 * 15) / 1_000_000)


# #546-T02
def test_a_session_without_a_title_makes_one_extra_streamed_call_without_tools(
    multi: Multi,
) -> None:
    titled = multi.run("acme-priced", "acme-priced-9").bodies()
    untitled = multi.outcomes["priced-untitled"].bodies()

    assert len(titled) == 2 and len(untitled) == 3
    # The title call runs beside the first step, so its place in the order is not fixed.
    assert all("tools" in body for body in titled)
    assert sorted("tools" in body for body in untitled) == [False, True, True]
    assert all(body["stream"] is True for body in untitled)


# #546-T08
@pytest.mark.parametrize(
    ("provider", "family"),
    [("acme-resp", "responses"), ("acme-claude", "messages"), ("acme-gemini", "google")],
)
def test_reasoning_variants_are_derived_for_a_model_that_says_it_reasons(
    multi: Multi, provider: str, family: Family
) -> None:
    assert list(multi.listed[provider][f"{provider}-think"]["variants"]) == VARIANTS[family]


# #546-T08
def test_reasoning_variants_are_derived_on_chat_too(multi: Multi) -> None:
    assert list(multi.listed["acme-status"]["acme-think"]["variants"]) == VARIANTS["chat"]


# #546-T08
@pytest.mark.parametrize("provider", ("acme-status", "acme-resp", "acme-claude", "acme-gemini"))
def test_a_model_without_the_reasoning_flag_has_no_variants(multi: Multi, provider: str) -> None:
    main = {"acme-status": "acme-status-9"}.get(provider, f"{provider}-9")

    assert multi.listed[provider][main].get("variants", {}) == {}


# #546-T08
def test_an_anthropic_model_that_does_not_reason_is_still_sent_adaptive_thinking(
    multi: Multi,
) -> None:
    run = multi.run("acme-claude", "acme-claude-9")

    assert multi.listed["acme-claude"]["acme-claude-9"]["capabilities"]["reasoning"] is False
    assert run.http_status == 200
    for body in run.bodies():
        assert body["thinking"]["type"] == "adaptive"
        assert body["max_tokens"] == 8192


# #546-T08
@pytest.mark.parametrize(
    ("provider", "model", "marked"),
    [
        ("deepseek", "deepseek-spike-9", False),
        ("deepseek", "claude-ds-9", True),
        ("openrouter", "vendor/model-9", False),
        ("openrouter", "anthropic/claude-spike-9", True),
    ],
)
def test_the_engine_marks_a_chat_model_for_caching_by_the_claude_in_its_id_not_by_its_provider(
    multi: Multi, provider: str, model: str, marked: bool
) -> None:
    run = multi.run(provider, model)

    assert run.http_status == 200
    assert all((mark_places(body) != set()) is marked for body in run.bodies())
    assert [seen.sha256 for seen in run.seen] == [record.sha256 for record in run.records]


# #546-T02
def test_the_openrouter_provider_of_the_snapshot_asks_for_its_usage_in_its_own_way(
    multi: Multi,
) -> None:
    # The snapshot gives `openrouter` its own SDK, which says `usage: {include: true}` and not
    # `stream_options`; the usage is still read from the last chunk.
    run = multi.run("openrouter", "vendor/model-9")

    assert (
        multi.listed["openrouter"]["vendor/model-9"]["api"]["npm"] == "@openrouter/ai-sdk-provider"
    )
    for body in run.bodies():
        assert body["usage"] == {"include": True}
        assert "stream_options" not in body
    assert run.assistants[0].tokens["input"] > 0


# #546-T08
def test_a_relay_pinned_to_the_model_of_the_job_refuses_another_model_the_engine_asks_for(
    multi: Multi,
) -> None:
    other = multi.run("acme-pinned", "acme-pinned-10")
    own = multi.run("acme-pinned", "acme-pinned-9")

    # A real provider serves every model its key can reach, so the proxy has to read the model out
    # of the request and refuse any other; the engine does not retry that.
    assert other.bodies()[0]["model"] == "acme-pinned-10"
    assert [seen.status for seen in other.seen] == [403]
    assert other.records == []
    (step,) = other.assistants
    assert step.error is not None and step.error["data"]["statusCode"] == 403
    assert step.error["data"]["isRetryable"] is False
    assert [seen.status for seen in own.seen] == [200, 200]


# -- one engine for the faults -------------------------------------------------------------------


def _fail(
    *statuses: int, retry_after: str | None = None, quote: bool = False
) -> Callable[..., None]:
    def faults(upstream: ScriptedUpstream) -> None:
        upstream.quote_key = quote
        upstream.fail_next(*statuses, retry_after=retry_after)

    return faults


def _cut(upstream: ScriptedUpstream) -> None:
    upstream.cut_streams(after_events=1, times=1)


def _error_in_stream(upstream: ScriptedUpstream) -> None:
    upstream.error_in_stream(after_events=1, times=1)


FAULT_PROVIDERS = [
    Provider(family, id=f"fault-{family}", model=f"fault-{family}-9", steps=1)
    for family in FAMILIES
]


def fault_steps() -> list[Step]:
    steps: list[Step] = []
    for family in FAMILIES:
        provider, model = f"fault-{family}", f"fault-{family}-9"
        steps.append(Step(f"cut/{family}", provider, model, _cut))
        steps.append(Step(f"error-event/{family}", provider, model, _error_in_stream))
    chat, model = "fault-chat", "fault-chat-9"
    steps += [
        Step("429-once", chat, model, _fail(429)),
        Step("429-always", chat, model, _fail(*[429] * 6, quote=True)),
        Step("503-retry-after", chat, model, _fail(503, retry_after="1")),
        Step("500", chat, model, _fail(500)),
        Step("529", "fault-messages", "fault-messages-9", _fail(529)),
    ]
    return steps


@pytest.fixture(scope="module")
def faults(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Outcome]:
    with native_engine(tmp_path_factory.mktemp("faults"), FAULT_PROVIDERS) as engine:
        return run_plan(engine, fault_steps())


def gaps(run: Outcome) -> list[float]:
    return [round(seen.at - run.seen[0].at, 1) for seen in run.seen]


# #546-T07
def test_the_engine_retries_a_429_and_one_logical_call_becomes_two_upstream_calls(
    faults: dict[str, Outcome],
) -> None:
    run = faults["429-once"]

    assert run.http_status == 200
    assert [seen.status for seen in run.seen] == [429, 200, 200]
    assert [step.finish for step in run.assistants] == ["tool-calls", "stop"]


# #546-T07
def test_the_engine_gives_up_on_a_429_after_six_upstream_calls_and_reports_the_provider_error(
    faults: dict[str, Outcome],
) -> None:
    run = faults["429-always"]

    assert run.http_status == 200  # the turn is answered; the failure is in the message
    assert [seen.status for seen in run.seen] == [429] * 6
    (step,) = run.assistants
    assert step.error is not None
    assert step.error["name"] == "APIError"
    assert step.error["data"]["statusCode"] == 429
    assert step.error["data"]["isRetryable"] is True
    assert "fake upstream 429" in step.error["data"]["responseBody"]


# #546-T07
def test_an_error_body_that_quotes_the_key_reaches_the_engines_error_unredacted(
    faults: dict[str, Outcome],
) -> None:
    # Nothing in a pure relay removes it: #550 has to redact it before anything is shown.
    (step,) = faults["429-always"].assistants

    assert step.error is not None
    assert REAL_KEY in step.error["data"]["responseBody"]


# #546-T07
def test_the_engine_waits_for_the_retry_after_a_503_states(faults: dict[str, Outcome]) -> None:
    run = faults["503-retry-after"]

    assert [seen.status for seen in run.seen] == [503, 200, 200]
    assert gaps(run)[1] >= 1.0
    assert run.seen[0].response_headers["retry-after"] == "1"


# #546-T07
def test_the_engine_retries_a_500_without_retry_after_after_a_pause_of_its_own(
    faults: dict[str, Outcome],
) -> None:
    # Giving up on a 500 that never goes away took about 70 s when measured by hand; one retry
    # already waits about two seconds.
    run = faults["500"]

    assert [seen.status for seen in run.seen] == [500, 200, 200]
    assert gaps(run)[1] >= 1.5


# #546-T07
def test_the_engine_retries_an_overloaded_529_of_the_messages_api(
    faults: dict[str, Outcome],
) -> None:
    run = faults["529"]

    assert [seen.status for seen in run.seen] == [529, 200, 200]
    assert json.loads(run.seen[0].response_bytes)["error"]["type"] == "overloaded_error"


# #546-T07
@pytest.mark.parametrize("family", FAMILIES)
def test_a_stream_cut_midway_is_asked_for_again_as_a_whole_new_call(
    faults: dict[str, Outcome], family: Family
) -> None:
    run = faults[f"cut/{family}"]

    assert run.http_status == 200
    assert [step.finish for step in run.assistants] == ["tool-calls", "stop"]
    assert len(run.seen) == 3
    assert len(run.seen[0].response_bytes) < len(run.seen[1].response_bytes)


# #546-T07
@pytest.mark.parametrize("family", ("chat", "responses", "messages"))
def test_an_error_event_inside_a_200_stream_is_retried_as_a_whole_new_call(
    faults: dict[str, Outcome], family: Family
) -> None:
    run = faults[f"error-event/{family}"]

    assert run.http_status == 200
    assert [step.finish for step in run.assistants] == ["tool-calls", "stop"]
    assert [seen.status for seen in run.seen] == [200] * 3  # the status never shows the failure
    assert b"overloaded" in run.seen[0].response_bytes
    assert b"overloaded" not in run.seen[1].response_bytes


# #546-T07
def test_a_google_function_call_that_arrived_before_the_error_event_is_acted_on_first(
    faults: dict[str, Outcome],
) -> None:
    # The first chunk holds a whole function call, so the engine runs the tool and records that
    # step as finished for no known reason; the loop then asks again and goes on.
    run = faults["error-event/google"]

    assert [step.finish for step in run.assistants] == ["unknown", "tool-calls", "stop"]
    assert [step.tools for step in run.assistants[:2]] == [["glob"], ["glob"]]
    assert [seen.status for seen in run.seen] == [200] * 3
    assert b"UNAVAILABLE" in run.seen[0].response_bytes


# -- two single launches --------------------------------------------------------------------------


# #546-T05
def test_a_minimal_models_file_resolves_the_model_when_the_config_has_only_the_options(
    tmp_path: Path,
) -> None:
    run = single_run(tmp_path, Provider("messages", steps=1), minimal_models_file=True)

    assert run.http_status == 200
    assert [step.finish for step in run.assistants] == ["tool-calls", "stop"]


# #546-T03
def test_an_entry_with_a_limit_must_state_both_the_context_and_the_output(tmp_path: Path) -> None:
    only_context = Provider("chat", id="acme-context", entry={"limit": {"context": 200000}})
    only_output = Provider("chat", id="acme-output", entry={"limit": {"output": 8192}})

    with (
        native_engine(tmp_path, [only_context, only_output]) as engine,
        pytest.raises(AssertionError, match="ConfigInvalidError") as refused,
    ):
        # The config is checked when the first session is made, and every issue is named at once.
        engine.turn("acme-context", "acme-chat-9")

    message = str(refused.value)
    assert message.count("Missing key") == 2
    assert "'acme-context', 'models', 'acme-chat-9', 'limit', 'output'" in message
    assert "'acme-output', 'models', 'acme-chat-9', 'limit', 'context'" in message
