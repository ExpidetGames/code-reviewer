# SPDX-License-Identifier: LicenseRef-Proprietary

"""The per-job model entry on the runner's side (#548, part E).

The app writes the entry (`contracts/job-model-entry.v1.json`); the runner reads it strictly and
turns it into the `provider.<id>` block of the engine's configuration: the SDK (`npm`, always,
because the pinned engine speaks Chat to a provider it does not know), the loopback address of the
per-job proxy as `options.baseURL`, a dummy `options.apiKey`, and `models.<m>` exactly as the entry
says, with a status the engine does not drop and both limits. The real key and the upstream address
never enter the block. This is the data half of the native path: wiring it into the job is #550.
"""

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.dynamic_review.job_model_entry import (
    BUNDLED_NPM,
    INTERLEAVED_FIELDS,
    JobModelEntryError,
    native_model_reference,
    native_provider_config,
    parse_job_model_entry,
)

EXAMPLE = (
    Path(__file__).resolve().parents[3] / "contracts/examples/job-model-entry/JobModelEntry.json"
)
PROXY = "http://127.0.0.1:41234/v1"
DUMMY = "job-capability-0123456789abcdef"


def example() -> dict[str, Any]:
    return json.loads(EXAMPLE.read_text(encoding="utf-8"))


def doc(
    top: dict[str, Any] | None = None,
    model: dict[str, Any] | None = None,
    drop_top: str | None = None,
    drop_model: str | None = None,
) -> dict[str, Any]:
    """The example with some fields set or removed."""
    document = copy.deepcopy(example())
    document.update(top or {})
    document["model"].update(model or {})
    if drop_top is not None:
        del document[drop_top]
    if drop_model is not None:
        del document["model"][drop_model]
    return document


# #548-T10
def test_a_valid_entry_is_read() -> None:
    entry = parse_job_model_entry(example())

    assert entry.provider_id == "deepseek"
    assert entry.npm == "@ai-sdk/openai-compatible"
    assert entry.family == "openai-chat"
    assert entry.auth_header == "Authorization"
    assert entry.upstream_base_url == "https://api.deepseek.com"
    assert entry.model_id == "deepseek-v4-pro"


@pytest.mark.parametrize(
    "document",
    [
        doc(top={"apiKey": "sk-live-1"}),
        doc(model={"cost": {"input": 1, "output": 2}}),
        doc(drop_top="npm"),
        doc(top={"npm": ""}),
        doc(top={"family": "cohere-chat"}),
        doc(top={"authHeader": "api-key"}),
        doc(top={"upstreamBaseUrl": "http://api.deepseek.com"}),
        doc(top={"upstreamBaseUrl": "https://user:pw@api.deepseek.com"}),
        doc(top={"upstreamBaseUrl": "https://api.deepseek.com/v1?key=1"}),
        doc(top={"modelId": "bad id"}),
        doc(top={"providerId": "Bad Id"}),
        doc(top={"version": 2}),
        doc(top={"version": True}),
        doc(model={"limit": {"context": 1000}}),
        doc(model={"limit": {"output": 100}}),
        doc(drop_model="limit"),
        doc(model={"limit": {"context": 0, "output": 0}}),
        doc(model={"limit": {"context": True, "output": 1}}),
        doc(model={"status": "deprecated"}),
        doc(model={"status": "alpha"}),
        doc(model={"tool_call": False}),
        doc(model={"reasoning": "yes"}),
        doc(model={"modalities": {"input": ["text", "smell"], "output": ["text"]}}),
        doc(model={"interleaved": {"field": "<script>"}}),
        doc(model={"interleaved": {"field": "reasoning_text"}}),
        doc(model={"interleaved": {"field": "reasoning"}}),
        doc(top={"npm": "left-pad"}),
        doc(top={"npm": "@ai-sdk/not-a-sdk"}),
        doc(top={"npm": "git+https://evil.example/x.git"}),
        doc(top={"npm": "../../etc/passwd"}),
        doc(top={"npm": "@ai-sdk/openai "}),
    ],
)
# #548-T10
def test_an_entry_that_breaks_the_contract_is_refused(document: dict[str, Any]) -> None:
    with pytest.raises(JobModelEntryError) as raised:
        parse_job_model_entry(document)

    assert raised.value.code == "job_model_entry_invalid"


@pytest.mark.parametrize("document", [None, [], "text", 7])
# #548-T10
def test_something_that_is_not_an_object_is_refused(document: Any) -> None:
    with pytest.raises(JobModelEntryError):
        parse_job_model_entry(document)


# #548-T10
def test_the_provider_block_has_what_the_pinned_engine_needs_and_nothing_secret() -> None:
    entry = parse_job_model_entry(example())

    config = native_provider_config(entry, base_url=PROXY, api_key=DUMMY)

    block = config["deepseek"]
    assert block["npm"] == "@ai-sdk/openai-compatible"
    assert block["options"] == {"baseURL": PROXY, "apiKey": DUMMY}
    assert list(block["models"]) == ["deepseek-v4-pro"]
    model = block["models"]["deepseek-v4-pro"]
    assert model["limit"] == {"context": 1000000, "output": 384000}
    assert model["status"] == "active"
    assert model["tool_call"] is True
    assert model["interleaved"] == {"field": "reasoning_content"}
    text = json.dumps(config)
    assert "api.deepseek.com" not in text
    assert "Authorization" not in text


# #548-T10
def test_the_block_carries_npm_even_for_a_provider_the_engine_knows() -> None:
    document = doc(
        top={
            "providerId": "openai",
            "npm": "@ai-sdk/openai",
            "family": "openai-responses",
            "upstreamBaseUrl": "https://api.openai.com/v1",
            "modelId": "gpt-5.5",
        }
    )

    block = native_provider_config(parse_job_model_entry(document), base_url=PROXY, api_key=DUMMY)[
        "openai"
    ]

    assert block["npm"] == "@ai-sdk/openai"


# #548-T10
def test_a_beta_model_runs_as_beta_and_the_status_is_never_one_the_engine_drops() -> None:
    entry = parse_job_model_entry(doc(model={"status": "beta"}))

    model = native_provider_config(entry, base_url=PROXY, api_key=DUMMY)["deepseek"]["models"][
        "deepseek-v4-pro"
    ]

    assert model["status"] == "beta"


# #548-T10
def test_the_limit_keeps_both_values_or_the_optional_input_and_nothing_else() -> None:
    entry = parse_job_model_entry(
        doc(model={"limit": {"context": 1000, "output": 100, "input": 900}})
    )

    model = native_provider_config(entry, base_url=PROXY, api_key=DUMMY)["deepseek"]["models"][
        "deepseek-v4-pro"
    ]

    assert model["limit"] == {"context": 1000, "output": 100, "input": 900}


# #548-T10
def test_the_model_reference_is_provider_and_model() -> None:
    assert native_model_reference(parse_job_model_entry(example())) == "deepseek/deepseek-v4-pro"


# #548-T10
def test_the_block_is_built_from_a_copy_so_that_a_later_change_does_not_reach_the_entry() -> None:
    entry = parse_job_model_entry(example())
    config = native_provider_config(entry, base_url=PROXY, api_key=DUMMY)

    config["deepseek"]["models"]["deepseek-v4-pro"]["limit"]["context"] = 1

    assert (
        native_provider_config(entry, base_url=PROXY, api_key=DUMMY)["deepseek"]["models"][
            "deepseek-v4-pro"
        ]["limit"]["context"]
        == 1000000
    )


# #548-T10
@pytest.mark.parametrize(
    "base_url",
    ["", "http://169.254.169.254/v1", "https://api.deepseek.com/v1", "ftp://127.0.0.1/v1"],
)
def test_the_engine_is_only_ever_pointed_at_loopback(base_url: str) -> None:
    entry = parse_job_model_entry(example())

    with pytest.raises(JobModelEntryError) as raised:
        native_provider_config(entry, base_url=base_url, api_key=DUMMY)

    assert raised.value.code == "job_model_proxy_not_loopback"


@pytest.mark.parametrize("npm", BUNDLED_NPM)
# #548-T10
def test_every_bundled_sdk_is_read(npm: str) -> None:
    assert parse_job_model_entry(doc(top={"npm": npm})).npm == npm


@pytest.mark.parametrize("field", INTERLEAVED_FIELDS)
# #548-T10
def test_the_interleaved_fields_of_the_engine_are_read(field: str) -> None:
    entry = parse_job_model_entry(doc(model={"interleaved": {"field": field}}))

    assert entry.model["interleaved"] == {"field": field}
