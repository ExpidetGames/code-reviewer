# SPDX-License-Identifier: Apache-2.0

"""Pins down the findings schema as the pinned engine takes it (#197).

The contract schema keeps its definitions under `$defs` and has no root type. A model provider
only takes an object schema as tool parameters, so the engine gets one self-contained object.
"""

import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator

from code_reviewer_runner.dynamic_review import findings_schema
from code_reviewer_runner.dynamic_review.budget import LimitError
from code_reviewer_runner.dynamic_review.schema import engine_schema
from code_reviewer_runner.result import ErrorCode

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts" / "dynamic-review"


def as_model_answers(document: dict[str, Any]) -> dict[str, Any]:
    """An example of the contract as the model returns it: without what the runner sets (#530)."""
    answer = {k: v for k, v in document.items() if k not in ("schemaVersion", "reviewedSha")}
    answer["findings"] = [
        {k: v for k, v in finding.items() if k != "reviewedSha"} for finding in document["findings"]
    ]
    return answer


def references(node: Any) -> list[str]:
    found: list[str] = []
    if isinstance(node, dict):
        for key, value in node.items():  # pyright: ignore[reportUnknownVariableType]
            if key == "$ref":
                found.append(str(value))  # pyright: ignore[reportUnknownArgumentType]
            found += references(value)
    elif isinstance(node, list):
        for item in node:  # pyright: ignore[reportUnknownVariableType]
            found += references(item)
    return found


# #197-T13
def test_the_engine_schema_is_one_self_contained_object() -> None:
    schema = engine_schema(findings_schema(), 30)

    assert schema["type"] == "object"
    assert schema["additionalProperties"] is False
    # The runner sets `schemaVersion` and `reviewedSha` itself (#530): the model is not asked.
    assert set(schema["required"]) == {"findings", "resolvedIds"}
    for dropped in ("$defs", "$id", "$schema"):
        assert dropped not in schema
    assert references(schema) == []
    finding = schema["properties"]["findings"]["items"]
    assert finding["type"] == "object"
    assert finding["properties"]["priority"]["enum"] == ["P0", "P1", "P2", "P3"]


# #197-T13
@pytest.mark.parametrize("example", ["example.v1.json", "example-resolved.v1.json"])
def test_the_engine_schema_accepts_what_the_contract_accepts(example: str) -> None:
    document = json.loads((CONTRACTS / example).read_text(encoding="utf-8"))

    validator = Draft202012Validator(engine_schema(findings_schema(), 30))
    validator.validate(as_model_answers(document))  # pyright: ignore[reportUnknownMemberType]


# #197-T13
def test_the_engine_schema_still_refuses_what_the_contract_refuses() -> None:
    document = json.loads((CONTRACTS / "example.v1.json").read_text(encoding="utf-8"))
    document["findings"][0]["priority"] = "P9"
    document["findings"][0]["path"] = "../escape"
    validator = Draft202012Validator(engine_schema(findings_schema(), 30))

    assert len(list(validator.iter_errors(as_model_answers(document)))) == 2  # pyright: ignore[reportUnknownMemberType]


# #197-T13
def test_the_job_bound_narrows_the_findings_and_never_widens_them() -> None:
    contract = findings_schema()
    before = json.dumps(contract)

    narrowed = engine_schema(contract, 5)
    widened = engine_schema(contract, 500)

    assert narrowed["properties"]["findings"]["maxItems"] == 5
    assert widened["properties"]["findings"]["maxItems"] == 30
    assert json.dumps(contract) == before


# #197-T13
def test_a_schema_the_engine_cannot_use_is_a_config_error() -> None:
    broken_schemas: tuple[dict[str, Any], ...] = (
        {},
        {"$defs": {}},
        {"$defs": {"DynamicFindings": {"type": "string"}}},
        {
            "$defs": {
                "DynamicFindings": {
                    "type": "object",
                    "properties": {"findings": {"$ref": "#/$defs/Nope"}},
                }
            }
        },
        {
            "$defs": {
                "DynamicFindings": {
                    "type": "object",
                    "properties": {"findings": {"$ref": "https://x/y"}},
                }
            }
        },
        {
            "$defs": {
                "DynamicFindings": {
                    "type": "object",
                    "properties": {"findings": {"$ref": "#/$defs/A"}},
                },
                "A": {"$ref": "#/$defs/A"},
            }
        },
    )
    for broken in broken_schemas:
        with pytest.raises(LimitError) as unusable:
            engine_schema(broken, 5)

        assert unusable.value.code is ErrorCode.DYNAMIC_CONFIG_INVALID
