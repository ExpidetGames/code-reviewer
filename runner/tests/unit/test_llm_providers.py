# SPDX-License-Identifier: Apache-2.0

"""Pins down the runner's provider registry (#424, ADR 0005 2.4): what the OpenRouter entry carries,
how an id is checked, and that the runner advertises exactly its registry."""

import inspect
from decimal import Decimal

import pytest
from support import fake_provider

from code_reviewer_runner import llm_providers
from code_reviewer_runner.dynamic_review.proxy import ModelProxy
from code_reviewer_runner.llm_providers import (
    OPENROUTER,
    PROVIDER_ID_PATTERN,
    PROVIDERS,
    PROXY_FORWARDED_FIELDS,
    RequireParameters,
    provider_for,
    registered_provider_ids,
    with_prefix,
    without_prefix,
)


# #424-T04
def test_the_openrouter_entry_carries_what_the_runner_used_to_hard_code() -> None:
    assert provider_for("openrouter") is OPENROUTER
    assert OPENROUTER.litellm_prefix == "openrouter/"
    assert OPENROUTER.default_api_base == "https://openrouter.ai/api/v1"
    assert OPENROUTER.key_setting == "openrouter.key"
    assert OPENROUTER.api_base_setting == "openrouter.api_base"
    assert OPENROUTER.api_base_variable == "OPENROUTER__API_BASE"
    mechanism = OPENROUTER.require_parameters
    assert mechanism is not None
    assert mechanism.request_controls_method == "_apply_openrouter_request_controls"
    assert mechanism.body_field == "provider"
    assert mechanism.body_value == {"require_parameters": True}


# #424-T03
@pytest.mark.parametrize("name", ["openai", "OpenRouter", "OPENROUTER", "", "open router", "x"])
def test_an_id_that_is_not_registered_has_no_entry(name: str) -> None:
    assert provider_for(name) is None


# #424-T07
def test_every_registered_id_has_the_form_the_contract_allows() -> None:
    assert PROVIDER_ID_PATTERN.pattern == "^[a-z][a-z0-9_]{1,31}$"
    assert registered_provider_ids() == ("openrouter",)
    for name in registered_provider_ids():
        assert PROVIDER_ID_PATTERN.fullmatch(name)
    assert PROVIDER_ID_PATTERN.fullmatch(fake_provider().id)


# #424-T03
def test_a_provider_added_to_the_registry_is_found_and_advertised(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = fake_provider()
    monkeypatch.setitem(llm_providers.PROVIDERS, fake.id, fake)

    assert provider_for("fakeai") is fake
    assert registered_provider_ids() == ("openrouter", "fakeai")


# #424-T04
def test_the_model_name_gets_the_prefix_of_its_provider_once() -> None:
    assert with_prefix(OPENROUTER, "vendor/model") == "openrouter/vendor/model"
    assert with_prefix(OPENROUTER, "openrouter/vendor/model") == "openrouter/vendor/model"
    assert without_prefix(OPENROUTER, "openrouter/vendor/model") == "vendor/model"
    assert without_prefix(OPENROUTER, "vendor/model") == "vendor/model"
    fake = fake_provider()
    assert with_prefix(fake, "model-1") == "fakeai/model-1"


# #424-T05
def test_the_openrouter_matcher_knows_no_endpoint_supports_the_parameters() -> None:
    assert OPENROUTER.no_endpoint_for_parameters(
        "No endpoints found that can handle the requested parameters."
    )
    assert OPENROUTER.no_endpoint_for_parameters("No endpoints found that support tool use")
    assert not OPENROUTER.no_endpoint_for_parameters("No endpoints found for deepseek/x")


# #424-T04
def test_the_openrouter_cost_extractor_reads_the_stated_usage_cost_only() -> None:
    assert OPENROUTER.cost_extractor({"cost": 0.25, "total_tokens": 3}) == Decimal("0.25")
    assert OPENROUTER.cost_extractor({"cost": "0.25"}) is None
    assert OPENROUTER.cost_extractor({"cost": -1}) is None
    assert OPENROUTER.cost_extractor({"total_tokens": 3}) is None


# #424-T03: the section is derived from the key setting, so the base setting must live in it too.
@pytest.mark.parametrize("provider", [OPENROUTER, fake_provider()], ids=lambda entry: entry.id)
def test_the_key_and_the_base_setting_of_a_provider_share_its_section(
    provider: llm_providers.LlmProviderSpec,
) -> None:
    assert provider.api_base_setting.split(".")[0] == provider.settings_section
    assert provider.key_setting == f"{provider.settings_section}.key"


# #424-T03: every entry the runner registers, not only the two above.
def test_every_registered_provider_keeps_its_settings_in_one_section() -> None:
    for provider in PROVIDERS.values():
        assert provider.api_base_setting.split(".")[0] == provider.settings_section


# #424-T05: the proxy sets the field after it copied the allow-list, so a field of the allow-list
# would overwrite what the engine sent.
def test_no_provider_adds_a_field_the_proxy_forwards_from_the_engine() -> None:
    for provider in PROVIDERS.values():
        mechanism = provider.require_parameters
        if mechanism is not None:
            assert mechanism.body_field not in PROXY_FORWARDED_FIELDS


# #424-T05
@pytest.mark.parametrize("field", ["seed", "tools", "messages", "response_format"])
def test_a_mechanism_whose_field_collides_with_a_forwarded_field_cannot_be_built(
    field: str,
) -> None:
    with pytest.raises(ValueError, match="forwarded"):
        RequireParameters(
            request_controls_method="apply_controls", body_field=field, body_value={"on": True}
        )


# #424-T05: a call site that forgets the provider must not silently get OpenRouter's mechanism.
def test_the_proxy_and_the_patch_have_no_default_provider() -> None:
    from code_reviewer_runner.require_parameters_patch import apply_require_parameters_patch

    for function in (ModelProxy.__init__, apply_require_parameters_patch):
        assert inspect.signature(function).parameters["provider"].default is inspect.Parameter.empty
