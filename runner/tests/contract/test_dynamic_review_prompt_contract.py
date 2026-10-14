# SPDX-License-Identifier: Apache-2.0

"""#198-T04: the DynamicFindings contract accepts an evidence-backed finding for every priority and
a location outside the reviewed diff. The schema has no inline-overlap requirement, so a
change-caused defect away from the diff is a first-class finding."""

import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from code_reviewer_runner.dynamic_findings import parse_dynamic_findings

CONTRACT = Path(__file__).resolve().parents[3] / "contracts" / "dynamic-review"


@pytest.mark.parametrize("priority", ["P0", "P1", "P2", "P3"])
def test_a_confidence_backed_finding_outside_the_diff_is_accepted(priority: str) -> None:
    schema = json.loads((CONTRACT / "schema.v1.json").read_text())
    definitions = {"$ref": "#/$defs/DynamicFindings", "$defs": schema["$defs"]}
    validator = Draft202012Validator(definitions)
    sha = "a" * 40
    document = {
        "schemaVersion": 1,
        "reviewedSha": sha,
        "resolvedIds": [],
        "findings": [
            {
                "id": f"f-{priority.lower()}",
                "priority": priority,
                "confidence": 0.6,
                "title": "A change-caused defect away from the diff",
                "body": "The change in src/a.ts breaks a caller in src/b.ts outside the diff.",
                "path": "src/b.ts",
                "lineStart": 10,
                "lineEnd": 12,
                "evidence": ["src/a.ts:3", "src/b.ts:10"],
                "reviewedSha": sha,
            }
        ],
    }

    assert bool(validator.is_valid(document))  # pyright: ignore[reportUnknownMemberType]
    parsed = parse_dynamic_findings(document)
    assert parsed.findings[0].priority == priority
    assert parsed.findings[0].path == "src/b.ts"
    assert parsed.findings[0].evidence == ("src/a.ts:3", "src/b.ts:10")
