# SPDX-License-Identifier: Apache-2.0

"""Which Claude models a Diff job on the Anthropic provider sends `temperature` to (#511).

The Claude API answers a non-default `temperature` or `top_p` with a 400 from Opus 4.7 on, so a
request that carries one is refused and the review fails. Unlike OpenRouter (#477), where the
runner decides by the version in the model name, here the decision is the flag of the model in the
list: `ClaudeModel.temperature`. A model the list does not know gets none, whatever its name
says."""

from collections.abc import Iterator
from importlib import import_module
from typing import Any

import pytest

from code_reviewer_runner.anthropic_models import MODELS, ClaudeModel
from code_reviewer_runner.llm_providers import ANTHROPIC, OPENROUTER, with_prefix
from code_reviewer_runner.temperature_patch import apply_temperature_patch

# PR-Agent ships no type information: the class is `Any` on purpose.
LiteLLMAIHandler: Any = import_module(
    "pr_agent.algo.ai_handlers.litellm_ai_handler"
).LiteLLMAIHandler


def install_probe(answer: bool) -> Iterator[None]:
    original = LiteLLMAIHandler.__dict__["_litellm_supports_temperature"]

    def probe(model: str, custom_llm_provider: str | None = None) -> bool:
        return answer

    LiteLLMAIHandler._litellm_supports_temperature = staticmethod(probe)
    try:
        yield
    finally:
        LiteLLMAIHandler._litellm_supports_temperature = original


@pytest.fixture
def probe_says_yes() -> Iterator[None]:
    """PR-Agent's probe answers True for everything, as litellm's metadata does for most models."""
    yield from install_probe(True)


@pytest.fixture
def probe_says_no() -> Iterator[None]:
    yield from install_probe(False)


# #511-T18
@pytest.mark.usefixtures("probe_says_yes")
@pytest.mark.parametrize("model", list(MODELS.values()), ids=list(MODELS))
def test_a_listed_model_gets_a_temperature_exactly_when_its_flag_says_so(
    model: ClaudeModel,
) -> None:
    undo = apply_temperature_patch(provider=ANTHROPIC)
    try:
        supports = LiteLLMAIHandler._litellm_supports_temperature
        prefixed = with_prefix(ANTHROPIC, model.id)

        assert supports(prefixed, "anthropic") is model.temperature
        assert supports(prefixed) is model.temperature
        # The name PR-Agent passes may already be without the routing prefix.
        assert supports(model.id, "anthropic") is model.temperature
    finally:
        undo()


# #511-T18
@pytest.mark.usefixtures("probe_says_yes")
@pytest.mark.parametrize(
    "model_id",
    [
        # Names the name rules would let through (older than 4.7), but the list does not know them.
        "claude-opus-4-5",
        "claude-sonnet-4-5-20250929",
        "claude-haiku-4-6",
        "claude-3-5-haiku-20241022",
        # Names the name rules would withhold: the answer is the same, with no rule involved.
        "claude-haiku-5-5-latest",
        "claude-future-9-9",
        "something-unheard-of",
        "",
    ],
)
def test_a_model_that_is_not_listed_gets_no_temperature_whatever_its_name_suggests(
    model_id: str,
) -> None:
    undo = apply_temperature_patch(provider=ANTHROPIC)
    try:
        supports = LiteLLMAIHandler._litellm_supports_temperature

        assert supports(f"anthropic/{model_id}", "anthropic") is False
    finally:
        undo()


# #511-T18: PR-Agent may know better than the list; the answer is "no" if either says no.
@pytest.mark.usefixtures("probe_says_no")
def test_a_model_the_flag_allows_still_gets_none_when_pr_agent_says_no() -> None:
    undo = apply_temperature_patch(provider=ANTHROPIC)
    try:
        supports = LiteLLMAIHandler._litellm_supports_temperature

        assert supports("anthropic/claude-opus-4-6", "anthropic") is False
    finally:
        undo()


# #511-T18: the first provider has no list of flags: the name rules decide, as before (#477).
@pytest.mark.usefixtures("probe_says_yes")
def test_a_provider_without_an_opinion_keeps_the_name_rules() -> None:
    undo = apply_temperature_patch(provider=OPENROUTER)
    try:
        supports = LiteLLMAIHandler._litellm_supports_temperature

        assert supports("openrouter/anthropic/claude-haiku-5.5", "openrouter") is False
        assert supports("openrouter/anthropic/claude-opus-4.6", "openrouter") is True
        assert supports("openrouter/openai/gpt-4o") is True
    finally:
        undo()


# #511-T18: a call site that names no provider keeps the behavior it had.
@pytest.mark.usefixtures("probe_says_yes")
def test_without_a_provider_the_name_rules_decide() -> None:
    undo = apply_temperature_patch()
    try:
        supports = LiteLLMAIHandler._litellm_supports_temperature

        assert supports("anthropic/claude-haiku-5-5", "anthropic") is False
        assert supports("anthropic/claude-haiku-4-5-20251001", "anthropic") is True
    finally:
        undo()
