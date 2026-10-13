# SPDX-License-Identifier: Apache-2.0

"""The schema and findings parser give the same verdict at every shape boundary (#195)."""

import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator

from code_reviewer_runner.dynamic_findings import FindingsError, parse_dynamic_findings

CONTRACT = Path(__file__).resolve().parents[3] / "contracts" / "dynamic-review"


# #195-T10
@pytest.mark.parametrize(
    ("field", "value", "expected"),
    [
        ("resolvedIds", [""], False),
        ("resolvedIds", ["id", "id"], False),
        ("resolvedIds", ["x" * 128], True),
        ("resolvedIds", ["x" * 129], False),
        ("resolvedIds", [str(i) for i in range(500)], True),
        ("resolvedIds", [str(i) for i in range(501)], False),
        ("schemaVersion", True, False),
        ("schemaVersion", "1", False),
        ("schemaVersion", 1, True),
        ("schemaVersion", 1.0, True),
        ("schemaVersion", 2, False),
        ("id", "", False),
        ("id", "x" * 128, True),
        ("id", "x" * 129, False),
        ("lineStart", 1.0, True),
        ("lineEnd", 9.0, True),
        ("lineEnd", 1.5, False),
        ("lineStart", 0, False),
        ("lineStart", True, False),
        ("lineEnd", 10_000_000, True),
        ("lineEnd", 10_000_001, False),
        ("lineStart", 10_000_001, False),
        ("lineEnd", 0, False),
    ],
)
def test_findings_shape_boundaries_agree(field: str, value: Any, expected: bool) -> None:
    schema: dict[str, Any] = json.loads((CONTRACT / "schema.v1.json").read_text())
    validator = Draft202012Validator({"$ref": "#/$defs/DynamicFindings", "$defs": schema["$defs"]})
    document: dict[str, Any] = json.loads((CONTRACT / "example.v1.json").read_text())
    if field in {"id", "lineStart", "lineEnd"}:
        document["findings"][0][field] = value
        if field == "lineEnd":
            document["findings"][0]["lineStart"] = 1
        if field == "lineStart" and isinstance(value, int) and value > 0:
            document["findings"][0]["lineEnd"] = value
    else:
        document[field] = value
    schema_valid = bool(validator.is_valid(document))  # pyright: ignore[reportUnknownMemberType]
    try:
        parse_dynamic_findings(document)
        parser_valid = True
    except FindingsError:
        parser_valid = False
    assert (schema_valid, parser_valid) == (expected, expected)
