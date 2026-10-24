# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down which models a Diff job sends no `temperature` to (#477).

OpenRouter lists no `temperature` for any Claude model from 4.7 on (checked against its public
model list on 2026-10-18: Opus 4.7 and 4.8, every 5.x model of Opus, Sonnet, Haiku and Fable, and
every OpenAI GPT-6 model; Claude 4.6 and older list it). With `provider.require_parameters: true`
such a request finds no endpoint. PR-Agent 0.47.0 withholds it for a fixed list of families
(`claude-(opus-4-7|4-8|(opus|sonnet|fable)-5)`, `gpt-5*`, `gpt-6-astra`), which misses Haiku 5.x,
the other GPT-6 models and every later family, so the runner decides by version instead."""

from collections.abc import Iterator
from importlib import import_module
from typing import Any

import pytest

from code_reviewer_runner.temperature_patch import (
    TemperaturePatchError,
    apply_temperature_patch,
    withholds_temperature,
)

# PR-Agent ships no type information: the class is `Any` on purpose.
LiteLLMAIHandler: Any = import_module(
    "pr_agent.algo.ai_handlers.litellm_ai_handler"
).LiteLLMAIHandler


class NoProbe:
    """A handler class from a PR-Agent version that no longer probes temperature support."""


class WrongSignature:
    @staticmethod
    def _litellm_supports_temperature(only: str) -> bool:
        return True


# #477-T01
@pytest.mark.parametrize(
    "model",
    [
        "openrouter/anthropic/claude-haiku-5.5",
        "openrouter/anthropic/claude-haiku-5.5:batch",
        "openrouter/anthropic/claude-sonnet-5.5",
        "openrouter/anthropic/claude-opus-5",
        "openrouter/anthropic/claude-fable-5.1",
        "openrouter/anthropic/claude-opus-4.7",
        "openrouter/anthropic/claude-opus-4.8",
        "anthropic/claude-haiku-5-5",
        "anthropic/claude-opus-4-8-20260101",
        "anthropic/claude-sonnet-5-20260101",
        # A later family or version is covered without a list entry.
        "openrouter/anthropic/claude-haiku-6",
        "openrouter/anthropic/claude-opus-4.9",
        "openrouter/anthropic/claude-newfamily-7.2",
        "OPENROUTER/ANTHROPIC/CLAUDE_HAIKU_5.5",
        # OpenAI GPT-6, by version as well.
        "openrouter/openai/gpt-6-luna",
        "openrouter/openai/gpt-6-sol",
        "openrouter/openai/gpt-6.1-sol",
        "openrouter/openai/gpt-6.1-sol-pro:batch",
        "openrouter/openai/gpt-6-astra",
        "openrouter/openai/gpt-7-luna",
        "openrouter/openai/gpt-10",
        # OpenRouter's rolling aliases have no version in their id and list no temperature either.
        "openrouter/~anthropic/claude-haiku-latest",
        "openrouter/~anthropic/claude-fable-latest",
        "openrouter/~anthropic/claude-opus-latest",
        "openrouter/~anthropic/claude-sonnet-latest",
        "openrouter/~openai/gpt-luna-latest",
        "openrouter/~openai/gpt-sol-latest",
        "openrouter/~openai/gpt-mini-latest",
        "openrouter/openai/gpt-chat-latest",
        "~anthropic/claude-haiku-latest:batch",
    ],
)
def test_claude_models_from_4_7_on_get_no_temperature(model: str) -> None:
    assert withholds_temperature(model) is True


# #477-T03
@pytest.mark.parametrize(
    "model",
    [
        "openrouter/anthropic/claude-haiku-4.5",
        "openrouter/anthropic/claude-opus-4.6",
        "openrouter/anthropic/claude-sonnet-4.6",
        "openrouter/anthropic/claude-opus-4.1",
        "openrouter/anthropic/claude-3.7-sonnet",
        "openrouter/anthropic/claude-3.5-haiku",
        "openrouter/anthropic/claude-sonnet-4",
        # The date of a snapshot is no minor version.
        "anthropic/claude-sonnet-4-20250514",
        "anthropic/claude-opus-4-1-20250805",
        "anthropic/claude-3-5-sonnet-20241022",
        "openrouter/openai/gpt-4o",
        "openrouter/openai/gpt-4.1",
        "openrouter/openai/gpt-oss-120b",
        # GPT-5 is left to PR-Agent, which handles it.
        "openrouter/openai/gpt-5.5",
        "openrouter/vendor/notgpt-6",
        "openrouter/google/gemini-2.5-pro",
        # Aliases of models that do take temperature.
        "openrouter/~google/gemini-pro-latest",
        "openrouter/~x-ai/grok-latest",
        "openrouter/~deepseek/deepseek-flash-latest",
        "openrouter/vendor/claude-latest",
        "openrouter/x-ai/grok-5",
        "openrouter/vendor/not-claude-5",
        "claude",
        "",
    ],
)
def test_other_models_keep_the_temperature_decision_of_pr_agent(model: str) -> None:
    assert withholds_temperature(model) is False


@pytest.fixture
def probe_says_yes() -> Iterator[None]:
    """PR-Agent's probe answers True for everything, as litellm's metadata does for Haiku 5.5."""
    original = LiteLLMAIHandler.__dict__["_litellm_supports_temperature"]

    def always(model: str, custom_llm_provider: str | None = None) -> bool:
        return True

    LiteLLMAIHandler._litellm_supports_temperature = staticmethod(always)
    try:
        yield
    finally:
        LiteLLMAIHandler._litellm_supports_temperature = original


# #477-T01
@pytest.mark.usefixtures("probe_says_yes")
def test_the_patched_probe_says_no_for_a_withheld_model_and_defers_for_every_other() -> None:
    undo = apply_temperature_patch()
    try:
        supports = LiteLLMAIHandler._litellm_supports_temperature
        assert supports("openrouter/anthropic/claude-haiku-5.5", "openrouter") is False
        assert supports("openrouter/anthropic/claude-haiku-5.5") is False
        assert supports("openrouter/anthropic/claude-haiku-4.5", "openrouter") is True
        assert supports("openrouter/openai/gpt-4o") is True
    finally:
        undo()


@pytest.mark.usefixtures("probe_says_yes")
def test_undo_puts_the_probe_back_and_applying_twice_wraps_once() -> None:
    original = LiteLLMAIHandler.__dict__["_litellm_supports_temperature"].__func__
    first = apply_temperature_patch()
    second = apply_temperature_patch()
    try:
        patched = LiteLLMAIHandler.__dict__["_litellm_supports_temperature"].__func__
        assert patched is not original
        assert patched.__temperature_patch_original__ is original
        assert patched("openrouter/anthropic/claude-opus-5.5") is False
    finally:
        second()
        first()
    assert LiteLLMAIHandler.__dict__["_litellm_supports_temperature"].__func__ is original


def test_a_handler_without_the_probe_is_refused_and_nothing_changes() -> None:
    with pytest.raises(TemperaturePatchError, match="does not exist"):
        apply_temperature_patch(NoProbe)
    assert not hasattr(NoProbe, "_litellm_supports_temperature")


def test_a_probe_with_another_signature_is_refused_and_nothing_changes() -> None:
    before = WrongSignature.__dict__["_litellm_supports_temperature"]
    with pytest.raises(TemperaturePatchError, match="different signature"):
        apply_temperature_patch(WrongSignature)
    assert WrongSignature.__dict__["_litellm_supports_temperature"] is before
