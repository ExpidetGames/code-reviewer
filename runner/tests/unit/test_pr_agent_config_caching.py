# SPDX-License-Identifier: Apache-2.0

"""Prompt caching of a Diff job (#539): the typed settings the runner gives PR-Agent.

PR-Agent calls the model once per tool through LiteLLM with a system message (the instructions of
the tool) and a user message (the pull request). LiteLLM adds a `cache_control` breakpoint where
`litellm.cache_control_injection_points` says, and PR-Agent passes the setting on only for a model
whose name says `claude`. The system message is what the calls of a run, and the runs of one
workspace within five minutes, have in common; the user message holds the diff, which is unique,
so caching it would only add the write premium to a prompt that is read once. A model that caches
by itself (OpenAI, DeepSeek, Gemini 2.5 and newer) needs no setting, and one it does not know is
never sent the Anthropic-only parameter."""

import json
from typing import Any

import pytest

from code_reviewer_runner.job import Job, parse_job
from code_reviewer_runner.pr_agent_config import build_typed_settings

SETTING = "litellm.cache_control_injection_points"
SYSTEM_POINT = {"location": "message", "role": "system"}


def make_job(provider: str, model: str, **llm: Any) -> Job:
    return parse_job(
        json.dumps(
            {
                "prUrl": "https://github.com/octo/repo/pull/7",
                "command": "review",
                "git": {
                    "provider": "github",
                    "baseUrl": "https://api.github.com",
                    "token": "dummy-installation-token-0123456789",
                    "botLogin": "code-reviewer[bot]",
                },
                "llm": {
                    "provider": provider,
                    "model": model,
                    "apiKey": "dummy-key-0123456789abcdef",
                    **llm,
                },
            }
        )
    )


# #539-T09
@pytest.mark.parametrize(
    ("provider", "model"),
    [
        ("anthropic", "claude-haiku-5-5"),
        ("anthropic", "claude-sonnet-5"),
        ("anthropic", "claude-opus-4-6"),
        ("anthropic", "claude-a-model-the-list-does-not-know"),
        ("openrouter", "anthropic/claude-sonnet-4.5"),
        ("openrouter", "anthropic/claude-haiku-4.5"),
    ],
)
def test_a_claude_job_caches_the_system_message_and_nothing_else(provider: str, model: str) -> None:
    settings = build_typed_settings(make_job(provider, model))

    assert settings[SETTING] == [SYSTEM_POINT]


# #539-T09
@pytest.mark.parametrize(
    "model",
    [
        "deepseek/deepseek-chat",
        "openai/gpt-5.1",
        "google/gemini-2.5-pro",
        "x-ai/grok-4",
        "moonshotai/kimi-k2",
    ],
)
def test_a_model_that_caches_by_itself_gets_no_injection_point(model: str) -> None:
    assert SETTING not in build_typed_settings(make_job("openrouter", model))


# #539-T09
def test_each_job_gets_its_own_list() -> None:
    first = build_typed_settings(make_job("anthropic", "claude-haiku-5-5"))[SETTING]
    second = build_typed_settings(make_job("anthropic", "claude-haiku-5-5"))[SETTING]
    assert isinstance(first, list) and isinstance(second, list)
    assert first == second and first is not second
    assert first[0] is not second[0]


# #539-T09
def test_a_name_that_only_looks_like_a_provider_does_not_make_a_claude() -> None:
    # The decision is the model, not the provider: Anthropic's own list holds only Claude models,
    # and an OpenRouter model of another vendor with the word elsewhere in its id is still Claude
    # by name, which is the rule PR-Agent applies when it forwards the setting.
    assert SETTING not in build_typed_settings(make_job("openrouter", "vendor/cl-aude-lite"))
    assert SETTING in build_typed_settings(make_job("openrouter", "vendor/claude-clone"))
