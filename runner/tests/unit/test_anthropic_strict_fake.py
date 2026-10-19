# SPDX-License-Identifier: Apache-2.0

"""The strict Claude Messages fake of the Python suites (#533).

It refuses what the real API refuses with a 400 (a forced tool choice on a model that has none,
`thinking: disabled` on a model that always thinks, thinking blocks that do not come back as they
were issued, a binding to another conversation), by the flags of the model in the contract file.
The TypeScript fake answers the same table of cases
(`app/src/test-support/llm-fake-messages.integration.test.ts`)."""

import json
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.llm.anthropic_rules import StrictMessagesApi, models

CASES = json.loads(
    (
        Path(__file__).resolve().parents[3] / "fakes" / "llm" / "anthropic-rule-cases.json"
    ).read_text()
)["cases"]


# #533-T14
@pytest.mark.parametrize("case", CASES, ids=[case["id"] for case in CASES])
def test_the_fake_answers_the_status_of_the_real_api_for_every_case_of_the_table(
    case: dict[str, Any],
) -> None:
    api = StrictMessagesApi()

    for step in case["steps"]:
        refusal = api.check(step["headers"], step["body"])

        assert (refusal[0] if refusal else 200) == step["status"], refusal
        if refusal:
            assert refusal[1]["type"] == "error"
            assert refusal[1]["error"]["type"] == "invalid_request_error"
        elif "answer" in step:
            api.record(step["body"], step["answer"])


# #533-T14
def test_the_flags_come_from_the_contract_file_not_from_a_second_list() -> None:
    listed = models()

    assert listed["claude-opus-5-5"]["supports"]["forcedToolChoice"] is False
    assert listed["claude-sonnet-5"]["supports"]["forcedToolChoice"] is True
    assert listed["claude-fable-5"]["supports"]["thinkingDisabled"] is False
