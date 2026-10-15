# SPDX-License-Identifier: Apache-2.0

"""The verdict of the startup self-check: engines and stable reasons, no value (#324)."""

import json

from code_reviewer_runner.verdict import Verdict


# #324-T02
def test_the_document_has_exactly_the_version_the_engines_and_the_reasons() -> None:
    verdict = Verdict(("pr-agent",), ("network_rules_not_installed", "capabilities_not_dropped"))

    assert verdict.document() == {
        "version": 1,
        "engines": ["pr-agent"],
        "reasons": ["network_rules_not_installed", "capabilities_not_dropped"],
    }


# #324-T02
def test_the_json_is_one_compact_line_that_parses_back_to_the_document() -> None:
    verdict = Verdict(("pr-agent", "opencode"))

    line = verdict.to_json()

    assert "\n" not in line
    assert json.loads(line) == verdict.document()
