# SPDX-License-Identifier: Apache-2.0

"""How a job on the Anthropic provider becomes PR-Agent configuration (#511): the model name LiteLLM
routes by, the address it is given (without the version path it adds itself), the key as a typed
secret, the output a Diff run asks for and the window of the model."""

import json
from typing import Any

import pytest

from code_reviewer_runner.anthropic_models import MODELS
from code_reviewer_runner.job import Job, parse_job
from code_reviewer_runner.pr_agent_config import (
    build_environment,
    build_secret_settings,
    build_typed_settings,
)

TOKEN = "dummy-installation-token-0123456789"
KEY = "dummy-anthropic-dummy-0123456789abcdef"


def make_job(model: str = "claude-haiku-5-5", **llm: Any) -> Job:
    return parse_job(
        json.dumps(
            {
                "prUrl": "https://github.com/octo/repo/pull/7",
                "command": "review",
                "git": {
                    "provider": "github",
                    "baseUrl": "https://api.github.com",
                    "token": TOKEN,
                    "botLogin": "code-reviewer[bot]",
                },
                "llm": {"provider": "anthropic", "model": model, "apiKey": KEY, **llm},
            }
        )
    )


# #511-T19
def test_all_three_model_roles_are_the_prefixed_model_of_the_job() -> None:
    env = build_environment(make_job("claude-sonnet-4-6"), {})

    for role in ("CONFIG__MODEL", "CONFIG__MODEL_WEAK", "CONFIG__MODEL_REASONING"):
        assert env[role] == "anthropic/claude-sonnet-4-6"


# #511-T20
def test_litellm_gets_the_address_without_the_version_it_adds_itself() -> None:
    env = build_environment(make_job(), {})

    assert env["ANTHROPIC_API_BASE"] == "https://api.anthropic.com"
    assert "OPENROUTER__API_BASE" not in env


# #511-T20
def test_a_loopback_address_of_a_test_double_is_given_the_same_way() -> None:
    env = build_environment(make_job(baseUrl="http://127.0.0.1:4010/api/v1"), {})

    assert env["ANTHROPIC_API_BASE"] == "http://127.0.0.1:4010/api"


# #511-T20
def test_the_key_is_a_typed_secret_and_never_part_of_the_environment() -> None:
    job = make_job()

    secrets = build_secret_settings(job)
    env = build_environment(job, {})

    assert secrets["anthropic.key"] == KEY
    assert KEY not in "\n".join(env.values())
    assert "openrouter.key" not in secrets


# #511-T19
@pytest.mark.parametrize("model", list(MODELS.values()), ids=list(MODELS))
def test_a_diff_run_asks_for_an_output_that_fits_the_model(model: Any) -> None:
    settings = build_typed_settings(make_job(model.id))

    limit = settings["config.max_output_tokens"]
    assert isinstance(limit, int)
    assert 4096 < limit <= model.max_output_tokens


# #511-T19
def test_a_model_the_list_does_not_know_asks_for_no_output_limit_of_its_own() -> None:
    settings = build_typed_settings(make_job("claude-future-9-9"))

    assert "config.max_output_tokens" not in settings
    assert "config.custom_model_max_tokens" not in settings


# #511-T19
def test_the_window_of_a_listed_model_is_given_to_pr_agent_unless_the_job_has_a_budget() -> None:
    without_budget = build_typed_settings(make_job("claude-opus-4-5-20251101"))
    with_budget = build_typed_settings(make_job("claude-opus-4-5-20251101", maxTokens=50_000))

    assert without_budget["config.custom_model_max_tokens"] == 200_000
    assert "config.max_model_tokens" not in without_budget
    assert with_budget["config.custom_model_max_tokens"] == 50_000
    assert with_budget["config.max_model_tokens"] == 50_000


# #511-T19: unchanged for the first provider.
def test_the_first_provider_asks_for_no_output_limit_and_no_window() -> None:
    job = parse_job(
        json.dumps(
            {
                "prUrl": "https://github.com/octo/repo/pull/7",
                "command": "review",
                "git": {
                    "provider": "github",
                    "baseUrl": "https://api.github.com",
                    "token": TOKEN,
                    "botLogin": "code-reviewer[bot]",
                },
                "llm": {"provider": "openrouter", "model": "vendor/model", "apiKey": "k" * 20},
            }
        )
    )

    settings = build_typed_settings(job)

    assert "config.max_output_tokens" not in settings
    assert "config.custom_model_max_tokens" not in settings
