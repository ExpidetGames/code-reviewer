# SPDX-License-Identifier: Apache-2.0

"""The registry entry of the Anthropic provider (#511): what the runner needs to talk to the Claude
API in a Diff run (LiteLLM) and what it advertises."""

import pytest

from code_reviewer_runner import llm_providers
from code_reviewer_runner.anthropic_models import MODELS, ClaudeModel
from code_reviewer_runner.llm_providers import (
    ANTHROPIC,
    OPENROUTER,
    PROVIDERS,
    provider_for,
    registered_provider_ids,
    with_prefix,
    without_prefix,
)
from code_reviewer_runner.repo_settings_guard import protected_sections, protected_settings


# #511-T20
def test_the_runner_advertises_both_providers_in_the_order_of_the_app() -> None:
    assert registered_provider_ids() == ("openrouter", "anthropic")
    assert provider_for("anthropic") is ANTHROPIC


# #511-T20
def test_the_entry_carries_what_litellm_and_pr_agent_need() -> None:
    assert ANTHROPIC.litellm_prefix == "anthropic/"
    assert ANTHROPIC.default_api_base == "https://api.anthropic.com/v1"
    assert ANTHROPIC.key_setting == "anthropic.key"
    assert ANTHROPIC.settings_section == "anthropic"
    assert ANTHROPIC.api_base_setting.split(".")[0] == "anthropic"
    # LiteLLM reads the address from this variable and adds `/v1/messages` itself.
    assert ANTHROPIC.api_base_variable == "ANTHROPIC_API_BASE"
    # Anthropic has no routing to constrain and no "no endpoint" answer.
    assert ANTHROPIC.require_parameters is None
    assert not ANTHROPIC.no_endpoint_for_parameters("No endpoints found that can handle it")


# #511-T20
@pytest.mark.parametrize(
    ("base", "expected"),
    [
        ("https://api.anthropic.com/v1", "https://api.anthropic.com"),
        ("https://api.anthropic.com/v1/", "https://api.anthropic.com"),
        ("https://api.anthropic.com", "https://api.anthropic.com"),
        ("http://127.0.0.1:4010/api/v1", "http://127.0.0.1:4010/api"),
        ("http://127.0.0.1:4010/v1beta", "http://127.0.0.1:4010/v1beta"),
    ],
)
def test_litellm_gets_the_address_without_the_version_it_adds_itself(
    base: str, expected: str
) -> None:
    assert ANTHROPIC.litellm_api_base(base) == expected
    assert OPENROUTER.litellm_api_base(base) == base


# #511-T20
def test_the_model_name_gets_the_litellm_prefix_once() -> None:
    assert with_prefix(ANTHROPIC, "claude-haiku-5-5") == "anthropic/claude-haiku-5-5"
    assert with_prefix(ANTHROPIC, "anthropic/claude-haiku-5-5") == "anthropic/claude-haiku-5-5"
    assert without_prefix(ANTHROPIC, "anthropic/claude-haiku-5-5") == "claude-haiku-5-5"


# #511-T20
def test_the_repository_settings_guard_pins_the_key_the_base_and_the_section() -> None:
    providers = PROVIDERS.values()

    assert "anthropic.key" in protected_settings(providers)
    assert ANTHROPIC.api_base_setting in protected_settings(providers)
    assert "anthropic" in protected_sections(providers)


# #511-T18
@pytest.mark.parametrize("model", list(MODELS.values()), ids=list(MODELS))
def test_a_listed_model_takes_a_temperature_exactly_when_its_flag_says_so(
    model: ClaudeModel,
) -> None:
    assert ANTHROPIC.supports_temperature(model.id) is model.temperature


# #511-T18
@pytest.mark.parametrize(
    "model_id",
    [
        "",
        "claude-haiku-5-5-latest",
        "claude-opus-4-5",
        "claude-haiku-4-6",
        "claude-future-9-9",
        "anthropic/claude-sonnet-4-6",
        "something-else",
    ],
)
def test_a_model_that_is_not_listed_gets_no_temperature_whatever_its_name_suggests(
    model_id: str,
) -> None:
    assert ANTHROPIC.supports_temperature(model_id) is False


# #511-T18
def test_the_first_provider_leaves_the_decision_to_the_name_rules() -> None:
    assert OPENROUTER.supports_temperature("anthropic/claude-haiku-5.5") is None
    assert OPENROUTER.supports_temperature("vendor/model") is None


# #511-T19
def test_a_diff_run_asks_for_a_bounded_output_that_fits_the_model() -> None:
    for model in MODELS.values():
        limit = ANTHROPIC.diff_output_tokens(model.id)
        assert limit is not None
        assert 4096 < limit <= model.max_output_tokens
        assert limit <= 21_333  # a non-streaming request stays below the 10 minute guard of the API
    assert ANTHROPIC.diff_output_tokens("claude-future-9-9") is None
    assert OPENROUTER.diff_output_tokens("vendor/model") is None


# #511-T19
def test_the_window_of_a_listed_model_is_known_for_pr_agent() -> None:
    assert ANTHROPIC.context_window("claude-haiku-5-5") == 1_000_000
    assert ANTHROPIC.context_window("claude-opus-4-5-20251101") == 200_000
    assert ANTHROPIC.context_window("claude-future-9-9") is None
    assert OPENROUTER.context_window("vendor/model") is None


# #511-T16
def test_the_cost_of_a_call_is_computed_from_its_usage_for_the_listed_model_only() -> None:
    usage = {"prompt_tokens": 1000, "completion_tokens": 500}

    assert str(ANTHROPIC.cost_extractor("claude-haiku-5-5", usage)) == "0.00035"
    assert ANTHROPIC.cost_extractor("claude-future-9-9", usage) is None
    # A charge stated by a provider is not what Anthropic does, and is not trusted if it is there.
    assert ANTHROPIC.cost_extractor("claude-haiku-5-5", {**usage, "cost": 99}) is not None
    assert str(ANTHROPIC.cost_extractor("claude-haiku-5-5", {**usage, "cost": 99})) == "0.00035"


# #511-T20: the proxy needs one place that says how a provider is spoken to.
def test_the_registry_entries_are_the_two_real_providers() -> None:
    assert list(llm_providers.PROVIDERS) == ["openrouter", "anthropic"]
