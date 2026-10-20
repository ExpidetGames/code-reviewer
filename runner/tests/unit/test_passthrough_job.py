# SPDX-License-Identifier: Apache-2.0

"""What a native job is made of around the proxy (#550): the output cap, the engine's config, the
transport switch and the code for a model the provider has retired.

The entry itself (`contracts/job-model-entry.v1.json`) and its reader belong to #548 (PR #564); the
shapes used here are the example of that contract.
"""

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.dynamic_review.config import (
    build_engine_config,
    build_native_engine_config,
    engine_environment,
)
from code_reviewer_runner.dynamic_review.job_model_entry import (
    native_model_reference,
    native_provider_config,
    parse_job_model_entry,
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
from code_reviewer_runner.dynamic_review.passthrough.families import (
    NPM_OF_FAMILY,
    WireFamily,
    spec_of,
)
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


PROXY = "http://127.0.0.1:4100"
ENTRY: dict[str, Any] = {
    "version": 1,
    "providerId": "deepseek",
    "npm": "@ai-sdk/openai-compatible",
    "family": "openai-chat",
    "authHeader": "Authorization",
    "upstreamBaseUrl": UPSTREAM,
    "modelId": "deepseek-v4-pro",
    "model": MODEL,
}


def provider_block(proxy_url: str = PROXY) -> dict[str, Any]:
    base = spec_of(WireFamily.OPENAI_CHAT).proxy_base_url(proxy_url)
    return {
        "deepseek": {
            "npm": "@ai-sdk/openai-compatible",
            "options": {"baseURL": base, "apiKey": CAPABILITY},
            "models": {"deepseek-v4-pro": MODEL},
        }
    }


def native(
    provider: dict[str, Any] | None = None,
    *,
    family: WireFamily = WireFamily.OPENAI_CHAT,
    reference: str = "deepseek/deepseek-v4-pro",
    proxy_url: str = PROXY,
    capability: str = CAPABILITY,
) -> dict[str, Any]:
    return build_native_engine_config(
        provider=provider if provider is not None else provider_block(),
        model_reference=reference,
        system_prompt="You review code.",
        family=family,
        proxy_url=proxy_url,
        capability=capability,
    )


# #550-T12
def test_the_engine_is_configured_with_the_proxy_the_capability_and_the_one_model() -> None:
    config = native()
    block = config["provider"]["deepseek"]
    assert block["options"] == {"baseURL": "http://127.0.0.1:4100/v1", "apiKey": CAPABILITY}
    assert list(block["models"]) == ["deepseek-v4-pro"]
    assert block["npm"] == "@ai-sdk/openai-compatible"
    assert list(config["provider"]) == ["deepseek"]
    assert config["enabled_providers"] == ["deepseek"]
    assert config["agent"]["review"]["model"] == "deepseek/deepseek-v4-pro"
    # The rest is the closed configuration of every Dynamic job.
    legacy = build_engine_config(
        proxy_url=PROXY, model="m", system_prompt="p", proxy_capability=CAPABILITY
    )
    for key in ("permission", "plugin", "mcp", "instructions", "compaction", "share", "snapshot"):
        assert config[key] == legacy[key]


# #550-T12
def test_the_provider_block_the_entry_makes_is_what_the_config_accepts() -> None:
    entry = parse_job_model_entry(ENTRY)
    provider = native_provider_config(
        entry, base_url=spec_of(WireFamily.OPENAI_CHAT).proxy_base_url(PROXY), api_key=CAPABILITY
    )
    config = native(provider, reference=native_model_reference(entry))
    assert config["provider"] == provider


# #550-T12
@pytest.mark.parametrize(
    ("family", "npm"),
    [
        (WireFamily.OPENAI_CHAT, "@ai-sdk/openai-compatible"),
        (WireFamily.OPENAI_CHAT, "@openrouter/ai-sdk-provider"),
        (WireFamily.OPENAI_CHAT, "@ai-sdk/groq"),
        (WireFamily.OPENAI_RESPONSES, "@ai-sdk/openai"),
        (WireFamily.OPENAI_RESPONSES, "@ai-sdk/xai"),
        (WireFamily.ANTHROPIC_MESSAGES, "@ai-sdk/anthropic"),
        (WireFamily.GOOGLE, "@ai-sdk/google"),
    ],
)
def test_every_family_is_configured_with_its_own_sdk_and_its_own_base_path(
    family: WireFamily, npm: str
) -> None:
    block = {
        "acme": {
            "npm": npm,
            "options": {"baseURL": spec_of(family).proxy_base_url(PROXY), "apiKey": CAPABILITY},
            "models": {"acme-model-9": {k: v for k, v in MODEL.items() if k != "interleaved"}},
        }
    }
    config = native(block, family=family, reference="acme/acme-model-9")
    assert config["provider"]["acme"]["options"]["baseURL"].endswith(spec_of(family).base_path)


# #550-T16
def test_the_real_key_and_the_upstream_are_in_nothing_the_engine_is_given() -> None:
    config = native()
    environment = engine_environment(proxy_url=PROXY, home="/tmp/h", scratch_dir="/tmp/s")
    everything = json.dumps(config) + json.dumps(environment)
    assert REAL_KEY not in everything
    assert UPSTREAM not in everything and "api.deepseek.com" not in everything


def with_block(**changes: Any) -> dict[str, Any]:
    provider = provider_block()
    block = provider["deepseek"]
    for key, value in changes.items():
        if value is _GONE:
            del block[key]
        else:
            block[key] = value
    return provider


_GONE = object()


def with_options(**changes: Any) -> dict[str, Any]:
    provider = provider_block()
    options = provider["deepseek"]["options"]
    for key, value in changes.items():
        if value is _GONE:
            del options[key]
        else:
            options[key] = value
    return provider


def with_model(**changes: Any) -> dict[str, Any]:
    provider = provider_block()
    provider["deepseek"]["models"]["deepseek-v4-pro"] = {**MODEL, **changes}
    return provider


def renamed_model(model_id: str) -> tuple[dict[str, Any], str]:
    provider = provider_block()
    provider["deepseek"]["models"] = {model_id: MODEL}
    return provider, f"deepseek/{model_id}"


REFUSED_BLOCKS: dict[str, dict[str, Any]] = {
    "base url is the upstream": with_options(baseURL=UPSTREAM),
    "base url is another loopback port": with_options(baseURL="http://127.0.0.1:9/v1"),
    "base url has another path": with_options(baseURL="http://127.0.0.1:4100/v2"),
    "base url has a query": with_options(baseURL="http://127.0.0.1:4100/v1?key=x"),
    "base url is missing": with_options(baseURL=_GONE),
    "api key is the real key": with_options(apiKey=REAL_KEY),
    "api key is another capability": with_options(apiKey=CAPABILITY + "x"),
    "api key is missing": with_options(apiKey=_GONE),
    "headers": with_options(headers={"x-api-key": REAL_KEY}),
    "a fetch": with_options(fetch="https://evil.example"),
    "a timeout": with_options(timeout=False),
    "a second base url spelling": with_options(baseUrl=UPSTREAM),
    "a block key api": with_block(api="https://evil.example"),
    "a block key env": with_block(env=["OPENAI_API_KEY"]),
    "a block key whitelist": with_block(whitelist=["a"]),
    "a block key id": with_block(id="other"),
    "no options": with_block(options=_GONE),
    "no models": with_block(models=_GONE),
    "no npm": with_block(npm=_GONE),
    "an npm of another family": with_block(npm="@ai-sdk/anthropic"),
    "an npm the engine does not bundle": with_block(npm="left-pad"),
    "an npm that is a url": with_block(npm="https://evil.example/pkg.tgz"),
    "model with a provider": with_model(provider={"npm": "@ai-sdk/anthropic", "api": "x"}),
    "model with an api": with_model(api="https://evil.example"),
    "model with options": with_model(options={"headers": {"x": "y"}}),
    "model with headers": with_model(headers={"x": "y"}),
    "model with an id": with_model(id="another-model"),
    "model with a cost": with_model(cost={"input": 0}),
    "model with variants": with_model(variants={"high": {}}),
    "a model that is not an object": with_model(),
}
REFUSED_BLOCKS["a model that is not an object"]["deepseek"]["models"]["deepseek-v4-pro"] = "x"


# #550-T12
@pytest.mark.parametrize("case", REFUSED_BLOCKS)
def test_a_provider_block_that_is_not_exactly_what_the_entry_makes_is_refused(case: str) -> None:
    with pytest.raises(ValueError, match="native job"):
        native(REFUSED_BLOCKS[case])


# #550-T12
@pytest.mark.parametrize(
    "model_id",
    ["", ".", "..", "a b", "a\nb", "a%2fb", "x" * 201, "-leading", "é", "a\x00", "a#b", "a?b"],
)
def test_a_model_id_that_is_not_a_plain_id_is_refused(model_id: str) -> None:
    provider, reference = renamed_model(model_id)
    with pytest.raises(ValueError, match="native job"):
        native(provider, reference=reference)


# #550-T12
@pytest.mark.parametrize("model_id", ["a/b", "a:b", "a@b", "gemini-2.5-pro:generateContent", "a+b"])
def test_a_model_id_goes_into_the_google_path_so_it_may_not_hold_a_path_or_a_method(
    model_id: str,
) -> None:
    # Fine for a chat model (OpenRouter names models `vendor/model`) ...
    provider, reference = renamed_model(model_id)
    native(provider, reference=reference)
    # ... never for Google, where it is a segment of the path the proxy compares as text.
    block = {
        "google": {
            "npm": "@ai-sdk/google",
            "options": {
                "baseURL": spec_of(WireFamily.GOOGLE).proxy_base_url(PROXY),
                "apiKey": CAPABILITY,
            },
            "models": {model_id: {k: v for k, v in MODEL.items() if k != "interleaved"}},
        }
    }
    with pytest.raises(ValueError, match="native job"):
        native(block, family=WireFamily.GOOGLE, reference=f"google/{model_id}")


# #550-T12
def test_the_agent_may_only_name_the_one_model_of_the_one_provider() -> None:
    for reference in ("deepseek/other-model", "other/deepseek-v4-pro", "deepseek", "", "a/b/c"):
        with pytest.raises(ValueError, match="native job"):
            native(reference=reference)


# #550-T12
@pytest.mark.parametrize(
    "proxy_url",
    ["https://127.0.0.1:4100", "http://example.com:4100", "http://10.0.0.1:4100", "127.0.0.1:4100"],
)
def test_the_engine_is_only_ever_pointed_at_a_loopback_proxy(proxy_url: str) -> None:
    provider = provider_block()
    provider["deepseek"]["options"]["baseURL"] = spec_of(WireFamily.OPENAI_CHAT).proxy_base_url(
        proxy_url
    )
    with pytest.raises(ValueError, match="native job"):
        native(provider, proxy_url=proxy_url)


# #550-T12
@pytest.mark.parametrize("capability", ["", "short", "x" * 20])
def test_a_capability_that_is_too_weak_is_refused(capability: str) -> None:
    provider = provider_block()
    provider["deepseek"]["options"]["apiKey"] = capability
    with pytest.raises(ValueError, match="native job"):
        native(provider, capability=capability)


# #550-T12
def test_a_provider_block_that_names_no_provider_or_two_is_refused() -> None:
    providers: list[dict[str, Any]] = [{}, {**provider_block(), "second": {}}]
    for provider in providers:
        with pytest.raises(ValueError, match="one provider"):
            native(provider)


# #550-T12
@pytest.mark.parametrize("provider_id", ["", "Deepseek", "a/b", "a b", "../x", "x" * 65])
def test_a_provider_id_that_is_not_a_plain_id_is_refused(provider_id: str) -> None:
    provider = {provider_id: provider_block()["deepseek"]}
    with pytest.raises(ValueError, match="native job"):
        native(provider, reference=f"{provider_id}/deepseek-v4-pro")


# #550-J01
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


# #550-J02
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


# #550-T12
def test_the_sdk_of_each_family_is_the_one_the_catalog_maps_to_it() -> None:
    """`NPM_OF_FAMILY` is the pairs of `contracts/opencode-providers.v1.json` (#548)."""
    catalog = json.loads(
        (
            Path(__file__).resolve().parents[3] / "contracts" / "opencode-providers.v1.json"
        ).read_text()
    )
    pairs = {
        (provider["npm"], provider["family"])
        for provider in catalog["providers"].values()
        if "npm" in provider
    }
    ours = {(npm, family.value) for family, npms in NPM_OF_FAMILY.items() for npm in npms}
    assert ours == pairs
