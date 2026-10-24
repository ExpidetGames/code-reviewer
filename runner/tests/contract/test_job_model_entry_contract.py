# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down `contracts/job-model-entry.v1.json` (#548) from the runner's side, the reader.

The app writes the entry and checks it against the file (app/integration-tests/compatibility/
job-model-entry-contract.integration.test.ts). The runner reads it with a validator of its own (it
has no schema library at run time), so here the two must give the same verdict for the same
documents: the example, and every way of breaking the closed object.
"""

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from code_reviewer_runner.dynamic_review.job_model_entry import (
    BUNDLED_NPM,
    INTERLEAVED_FIELDS,
    JobModelEntryError,
    parse_job_model_entry,
)

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"
SCHEMA: dict[str, Any] = json.loads(
    (CONTRACTS / "job-model-entry.v1.json").read_text(encoding="utf-8")
)
EXAMPLE: dict[str, Any] = json.loads(
    (CONTRACTS / "examples/job-model-entry/JobModelEntry.json").read_text(encoding="utf-8")
)


def _registry() -> Registry[Any]:
    registry: Registry[Any] = Registry()
    return registry.with_resource(SCHEMA["$id"], Resource.from_contents(SCHEMA))


_REGISTRY = _registry()


def _contract_accepts(document: Any) -> bool:
    validator = Draft202012Validator(
        {"$ref": f"{SCHEMA['$id']}#/$defs/JobModelEntry"}, registry=_REGISTRY
    )
    return bool(validator.is_valid(document))  # pyright: ignore[reportUnknownMemberType]


def _reader_accepts(document: Any) -> bool:
    try:
        parse_job_model_entry(document)
    except JobModelEntryError:
        return False
    return True


def _with(**top: Any) -> dict[str, Any]:
    document = copy.deepcopy(EXAMPLE)
    document.update(top)
    return document


def _model(**changes: Any) -> dict[str, Any]:
    document = copy.deepcopy(EXAMPLE)
    document["model"].update(changes)
    return document


def _without_model_key(key: str) -> dict[str, Any]:
    document = copy.deepcopy(EXAMPLE)
    del document["model"][key]
    return document


GOOD: list[dict[str, Any]] = [
    EXAMPLE,
    _model(status="beta"),
    _model(limit={"context": 1000, "output": 100, "input": 900}),
    _model(interleaved=True),
    _with(providerId="openai", npm="@ai-sdk/openai", family="openai-responses", modelId="gpt-5.5"),
    _with(authHeader="x-goog-api-key", family="google", providerId="google"),
    _with(modelId="claude-opus-4-8@eu"),
    _model(interleaved={"field": "reasoning_content"}),
    _model(interleaved={"field": "reasoning_details"}),
    *[_with(npm=npm) for npm in BUNDLED_NPM],
    # A name is counted in code points: 120 characters outside the basic plane are 240 UTF-16 units.
    _model(name="\U0001f600" * 120),
]
BAD: list[dict[str, Any]] = [
    _with(apiKey="sk-live-1"),
    _with(npm=""),
    _with(family="cohere-chat"),
    _with(authHeader="api-key"),
    _with(upstreamBaseUrl="http://api.deepseek.com"),
    _with(upstreamBaseUrl="https://user:pw@api.deepseek.com"),
    _with(upstreamBaseUrl="https://api.deepseek.com/v1?key=1"),
    _with(modelId="bad id"),
    _with(providerId="Bad"),
    _with(version=2),
    _model(limit={"context": 1000}),
    _model(limit={"output": 100}),
    _model(limit={"context": 0, "output": 0}),
    _model(status="deprecated"),
    _model(status="alpha"),
    _model(tool_call=False),
    _model(cost={"input": 1, "output": 2}),
    _model(modalities={"input": ["text", "smell"], "output": ["text"]}),
    _model(interleaved={"field": "<script>"}),
    _model(interleaved={"field": "reasoning_text"}),
    _with(npm="left-pad"),
    _with(npm="git+https://evil.example/x.git"),
    _with(npm="@ai-sdk/openai "),
    _model(name="\U0001f600" * 121),
    _without_model_key("limit"),
    _without_model_key("status"),
]


@pytest.mark.contract
@pytest.mark.parametrize("document", GOOD)
# #548-T10
def test_a_document_the_contract_accepts_is_read(document: dict[str, Any]) -> None:
    assert _contract_accepts(document)
    assert _reader_accepts(document)


@pytest.mark.contract
@pytest.mark.parametrize("document", BAD)
# #548-T10
def test_a_document_the_contract_refuses_is_refused_by_the_reader(document: dict[str, Any]) -> None:
    assert not _contract_accepts(document)
    assert not _reader_accepts(document)


@pytest.mark.contract
# #548-T10
def test_the_reader_names_the_same_sdks_and_fields_as_the_contract() -> None:
    entry = SCHEMA["$defs"]["JobModelEntry"]["properties"]["npm"]["enum"]
    field = SCHEMA["$defs"]["Interleaved"]["oneOf"][1]["properties"]["field"]["enum"]

    assert list(BUNDLED_NPM) == entry
    assert list(INTERLEAVED_FIELDS) == field
