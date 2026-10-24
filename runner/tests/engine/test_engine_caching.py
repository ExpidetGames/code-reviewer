# SPDX-License-Identifier: LicenseRef-Proprietary

"""Prompt caching of a Diff job (#539): the real PR-Agent and LiteLLM, run through the real job
entry point, against the fake LLM with the cache rules of the docs.

What a Diff run asks the provider to cache is the system message, the instructions of the tool;
the diff in the user message is unique and is never marked. The cost of the run is the exact price
of what the call wrote to the cache and did not cache, and a second run on the same workspace
within five minutes reads the system message instead of paying for it again."""

import json
import sys
from decimal import Decimal
from pathlib import Path
from typing import Any

from fake_github import FakeGithub
from fake_llm import FakeLlm, LlmRequest, real_anthropic_usage
from harness import Engine

from code_reviewer_runner.anthropic_models import model_for

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.llm.anthropic_cache import PromptCache

KEY = "dummy-anthropic-api03-dummy-engine-key-0123456789"
MARK = {"type": "ephemeral"}
HAIKU = "claude-haiku-5-5"


def anthropic_job(engine: Engine, model: str = HAIKU) -> dict[str, Any]:
    job = engine.job("review")
    job["llm"]["provider"] = "anthropic"
    job["llm"]["model"] = model
    job["llm"]["apiKey"] = KEY
    return job


def openrouter_job(engine: Engine, model: str) -> dict[str, Any]:
    job = engine.job("review")
    job["llm"]["model"] = model
    return job


def marks_in(body: dict[str, Any]) -> list[str]:
    """Where a request carries `cache_control`: a Messages body or a chat body."""
    found: list[str] = []
    system: Any = body.get("system")
    if isinstance(system, list):
        blocks: list[dict[str, Any]] = system  # pyright: ignore[reportUnknownVariableType]
        found += [
            f"system.{index}" for index, block in enumerate(blocks) if "cache_control" in block
        ]
    for index, message in enumerate(body.get("messages", [])):
        if "cache_control" in message:
            found.append(f"messages.{index}")
        content = message.get("content")
        if isinstance(content, list):
            parts: list[dict[str, Any]] = content  # pyright: ignore[reportUnknownVariableType]
            found += [
                f"messages.{index}.{position}"
                for position, part in enumerate(parts)
                if "cache_control" in part
            ]
    if "cache_control" in body:
        found.append("top-level")
    return found


def price_of(model_id: str, usage: dict[str, Any]) -> Decimal:
    entry = model_for(model_id)
    assert entry is not None
    prices = entry.prices
    return (
        Decimal(usage["input_tokens"]) * prices.input
        + Decimal(usage["cache_read_input_tokens"]) * prices.cache_read
        + Decimal(usage["cache_creation"]["ephemeral_5m_input_tokens"]) * prices.cache_write_5m
        + Decimal(usage["cache_creation"]["ephemeral_1h_input_tokens"]) * prices.cache_write_1h
        + Decimal(usage["output_tokens"]) * prices.output
    ) / Decimal(1_000_000)


def replay(request: LlmRequest) -> dict[str, Any]:
    """What a cold cache reports for a request that was sent."""
    return PromptCache().usage(request.body, real_anthropic_usage(0, 50))


# #539-T10
def test_a_claude_diff_review_marks_the_system_message_and_nothing_else(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.prompt_cache = PromptCache()

    result = engine.run(job=anthropic_job(engine)).result

    assert result["ok"] is True, result
    assert not llm.refused
    assert llm.requests
    for request in llm.requests:
        assert request.is_messages
        assert marks_in(request.body) == ["system.0"]
        assert request.body["system"][0]["cache_control"] == MARK
        assert "ttl" not in json.dumps(request.body["system"])


# #539-T10
def test_the_cost_of_a_diff_run_that_wrote_the_cache_is_the_exact_price_of_it(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.prompt_cache = PromptCache()

    result = engine.run(job=anthropic_job(engine)).result

    assert result["ok"] is True, result
    cold = replay(llm.requests[0])
    assert cold["cache_creation_input_tokens"] > 0, "the system prompt is below the cache minimum"
    assert cold["input_tokens"] > 0
    usage = result["usage"]
    assert usage["aiCalls"] == len(llm.requests) == 1
    assert Decimal(repr(usage["costUsd"])) == price_of(HAIKU, cold)
    assert usage["promptTokens"] == (
        cold["input_tokens"] + cold["cache_creation_input_tokens"] + cold["cache_read_input_tokens"]
    )


# #539-T10
def test_a_second_run_within_five_minutes_reads_the_system_message_and_costs_less(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.prompt_cache = PromptCache()

    first = engine.run(job=anthropic_job(engine)).result
    second = engine.run(job=anthropic_job(engine)).result

    assert first["ok"] is True and second["ok"] is True
    cold = replay(llm.requests[0])
    warm = llm.prompt_cache.usage(llm.requests[1].body, real_anthropic_usage(0, 50))
    assert warm["cache_read_input_tokens"] == cold["cache_creation_input_tokens"] > 0
    first_cost = Decimal(repr(first["usage"]["costUsd"]))
    second_cost = Decimal(repr(second["usage"]["costUsd"]))
    assert second_cost < first_cost
    # The system message was read, the diff was paid for: the run costs what the warm usage costs.
    assert second_cost == price_of(HAIKU, warm)


# #539-T10
def test_the_diff_of_the_pull_request_is_never_marked(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.prompt_cache = PromptCache()

    engine.run(job=anthropic_job(engine))

    for request in llm.requests:
        for message in request.body["messages"]:
            assert "cache_control" not in json.dumps(message)


# #539-T14
def test_a_claude_behind_openrouter_gets_the_mark_on_the_system_content(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.prompt_cache = PromptCache()

    result = engine.run(job=openrouter_job(engine, "anthropic/claude-sonnet-4.5")).result

    assert result["ok"] is True, result
    assert not llm.refused
    for request in llm.requests:
        assert not request.is_messages
        assert marks_in(request.body) == ["messages.0.0"]
        system = request.body["messages"][0]
        assert system["role"] == "system"
        assert system["content"][0]["cache_control"] == MARK


# #539-T14
def test_a_model_that_caches_by_itself_is_sent_no_mark(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.prompt_cache = PromptCache()

    result = engine.run(job=openrouter_job(engine, "deepseek/deepseek-chat")).result

    assert result["ok"] is True, result
    for request in llm.requests:
        assert marks_in(request.body) == []
        assert "cache_control" not in json.dumps(request.body)


# #539-T13
def test_the_cost_of_an_openrouter_run_is_the_charge_it_states_with_the_discount(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.prompt_cache = PromptCache()

    first = engine.run(job=openrouter_job(engine, "anthropic/claude-sonnet-4.5")).result
    second = engine.run(job=openrouter_job(engine, "anthropic/claude-sonnet-4.5")).result

    assert first["ok"] is True and second["ok"] is True
    assert Decimal(repr(first["usage"]["costUsd"])) > Decimal(repr(second["usage"]["costUsd"])) > 0


# #539-T16
def test_a_diff_run_logs_what_it_read_wrote_and_paid_in_full_in_counts_only(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.prompt_cache = PromptCache()

    first = engine.run(job=anthropic_job(engine)).result
    second = engine.run(job=anthropic_job(engine)).result

    cold = replay(llm.requests[0])
    warm = llm.prompt_cache.usage(llm.requests[1].body, real_anthropic_usage(0, 50))
    assert first["logTail"].count("prompt cache: ") == 1
    assert (
        f"prompt cache: 1 call, 0 input tokens read from the cache, "
        f"{cold['cache_creation_input_tokens']} written to the cache, "
        f"{cold['input_tokens']} not cached"
    ) in first["logTail"]
    assert (
        f"prompt cache: 1 call, {warm['cache_read_input_tokens']} input tokens read from the "
        f"cache, 0 written to the cache, {warm['input_tokens']} not cached"
    ) in second["logTail"]
    for tail in (first["logTail"], second["logTail"]):
        assert KEY not in tail
        line = next(line for line in tail.splitlines() if "prompt cache: " in line)
        assert "You are" not in line


# #539-T16
def test_an_openrouter_run_logs_the_cached_and_written_tokens_it_states(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.prompt_cache = PromptCache()

    first = engine.run(job=openrouter_job(engine, "anthropic/claude-sonnet-4.5")).result
    second = engine.run(job=openrouter_job(engine, "anthropic/claude-sonnet-4.5")).result

    assert "prompt cache: 1 call, 0 input tokens read from the cache" in first["logTail"]
    assert "prompt cache: 1 call, 0 input tokens read" not in second["logTail"]
    assert "prompt cache: 1 call, " in second["logTail"]
    assert " written to the cache, " in second["logTail"]
