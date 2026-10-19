# SPDX-License-Identifier: Apache-2.0

"""What a native job is made of around the proxy (#550): the output cap, the engine's config, the
transport switch and the code for a model the provider has retired.

The entry itself (`contracts/job-model-entry.v1.json`) and its reader belong to #548 (PR #564); the
shapes used here are the example of that contract.
"""

import json
from dataclasses import dataclass
from typing import Any

import pytest

from code_reviewer_runner.dynamic_review.config import (
    build_engine_config,
    build_native_engine_config,
    engine_environment,
)
from code_reviewer_runner.dynamic_review.passthrough.admission import (
    ENGINE_OUTPUT_CAP,
    output_allowance,
    target_from_entry,
)
from code_reviewer_runner.dynamic_review.passthrough.engine_errors import (
    MODEL_NOT_FOUND,
    model_not_found_for_turn,
)
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily, spec_of
from code_reviewer_runner.dynamic_review.passthrough.transport import Transport, transport_of
from code_reviewer_runner.result import ErrorCode

REAL_KEY = "sk-real-key-0123456789abcdefABCDEF"
UPSTREAM = "https://api.deepseek.com"
CAPABILITY = "dummy-capability-0123456789abcdef0123456789"
# The example of contracts/job-model-entry.v1.json, as the provider block the entry makes.
MODEL = {
    "name": "DeepSeek V4 Pro",
    "status": "active",
    "tool_call": True,
    "reasoning": True,
    "temperature": True,
    "limit": {"context": 1000000, "output": 384000},
    "modalities": {"input": ["text"], "output": ["text"]},
    "interleaved": {"field": "reasoning_content"},
}


def provider_block(proxy_url: str) -> dict[str, Any]:
    base = spec_of(WireFamily.OPENAI_CHAT).proxy_base_url(proxy_url)
    return {
        "deepseek": {
            "npm": "@ai-sdk/openai-compatible",
            "options": {"baseURL": base, "apiKey": CAPABILITY},
            "models": {"deepseek-v4-pro": MODEL},
        }
    }


# #550-T12
def test_the_engine_is_configured_with_the_proxy_the_capability_and_the_one_model() -> None:
    config = build_native_engine_config(
        provider=provider_block("http://127.0.0.1:4100"),
        model_reference="deepseek/deepseek-v4-pro",
        system_prompt="You review code.",
    )
    block = config["provider"]["deepseek"]
    assert block["options"] == {"baseURL": "http://127.0.0.1:4100/v1", "apiKey": CAPABILITY}
    assert list(block["models"]) == ["deepseek-v4-pro"]
    assert block["npm"] == "@ai-sdk/openai-compatible"
    assert list(config["provider"]) == ["deepseek"]
    assert config["enabled_providers"] == ["deepseek"]
    assert config["agent"]["review"]["model"] == "deepseek/deepseek-v4-pro"
    # The rest is the closed configuration of every Dynamic job.
    legacy = build_engine_config(
        proxy_url="http://127.0.0.1:4100", model="m", system_prompt="p", proxy_capability=CAPABILITY
    )
    for key in ("permission", "plugin", "mcp", "instructions", "compaction", "share", "snapshot"):
        assert config[key] == legacy[key]


# #550-T12
def test_google_is_pointed_at_the_v1beta_base_of_the_proxy() -> None:
    assert spec_of(WireFamily.GOOGLE).proxy_base_url("http://127.0.0.1:4100") == (
        "http://127.0.0.1:4100/v1beta"
    )


# #550-T16
def test_the_real_key_and_the_upstream_are_in_nothing_the_engine_is_given() -> None:
    config = build_native_engine_config(
        provider=provider_block("http://127.0.0.1:4100"),
        model_reference="deepseek/deepseek-v4-pro",
        system_prompt="You review code.",
    )
    environment = engine_environment(
        proxy_url="http://127.0.0.1:4100", home="/tmp/h", scratch_dir="/tmp/s"
    )
    everything = json.dumps(config) + json.dumps(environment)
    assert REAL_KEY not in everything
    assert UPSTREAM not in everything and "api.deepseek.com" not in everything


# #550-T12
def test_a_provider_block_that_names_no_provider_or_two_is_refused() -> None:
    providers: list[dict[str, Any]] = [{}, {**provider_block("http://127.0.0.1:1"), "second": {}}]
    for provider in providers:
        with pytest.raises(ValueError, match="one provider"):
            build_native_engine_config(provider=provider, model_reference="a/b", system_prompt="p")


# #550-T13
def test_a_job_with_an_entry_is_passthrough_and_one_without_stays_on_the_legacy_wire() -> None:
    assert transport_of(object()) is Transport.PASSTHROUGH
    assert transport_of(None) is Transport.LEGACY_WIRE


def test_the_output_cap_is_what_the_engine_will_send() -> None:
    # The pinned engine sends min(limit.output, 32000), whatever the catalog says (spike #546).
    assert ENGINE_OUTPUT_CAP == 32_000
    assert output_allowance(384_000) == 32_000
    assert output_allowance(8_192) == 8_192
    assert output_allowance(0) == 1


# #550-T10
def test_a_model_the_provider_has_retired_has_the_code_model_unknown() -> None:
    assert MODEL_NOT_FOUND is ErrorCode.MODEL_UNKNOWN
    unknown: dict[str, Any] = {
        "name": "UnknownError",
        "data": {"message": "Unexpected server error"},
    }
    # The engine's own answer for a model its config does not offer: a 500, and no call upstream.
    assert model_not_found_for_turn(500, unknown, upstream_calls=0)
    assert not model_not_found_for_turn(500, unknown, upstream_calls=1)
    assert not model_not_found_for_turn(200, unknown, upstream_calls=0)
    assert not model_not_found_for_turn(500, {"name": "ConfigInvalidError"}, upstream_calls=0)
    assert not model_not_found_for_turn(500, "text", upstream_calls=0)


@dataclass(frozen=True)
class EntryLike:
    """The fields of the reader of #548 (`job_model_entry.JobModelEntry`) the proxy needs."""

    family: str
    model_id: str
    upstream_base_url: str
    model: dict[str, Any]


# #550-T13
def test_the_target_of_a_job_is_read_from_its_model_entry() -> None:
    entry = EntryLike("openai-chat", "deepseek-v4-pro", UPSTREAM, MODEL)
    target = target_from_entry(entry)
    assert target.family is WireFamily.OPENAI_CHAT
    assert target.model == "deepseek-v4-pro"
    # The engine asks for 32000 of the 384000 the catalog states.
    assert target.output_allowance == 32_000
    with pytest.raises(ValueError, match="family"):
        target_from_entry(EntryLike("openai-completions", "m", UPSTREAM, MODEL))
    with pytest.raises(ValueError, match="limit"):
        target_from_entry(EntryLike("google", "m", UPSTREAM, {"name": "x"}))
