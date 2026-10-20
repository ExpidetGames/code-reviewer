# SPDX-License-Identifier: Apache-2.0

"""The text of the last user message of a body, per wire family (#552).

The final call is bound to a token that stands in the text of the last user message of the request
(`BudgetLedger.arm_final`). This is the reading that decides which text that is: the text parts of
the last message when it is the user's, and nothing else.
"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from passthrough_support import conversation

from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily
from code_reviewer_runner.dynamic_review.passthrough.last_user import last_user_text

FAMILIES = list(WireFamily)


def read(family: WireFamily, *turns: tuple[str, str]) -> str | None:
    return last_user_text(family, json.loads(conversation(family, *turns)))


# #552-F2
@pytest.mark.parametrize("family", FAMILIES)
def test_the_text_of_the_last_message_is_read_when_it_is_the_users(family: WireFamily) -> None:
    turns = (("system", "rules"), ("user", "first"), ("assistant", "answer"), ("user", "ask now"))

    assert read(family, *turns) == "ask now"


# #552-F2
@pytest.mark.parametrize("family", FAMILIES)
def test_nothing_is_read_when_the_last_message_is_not_the_users(family: WireFamily) -> None:
    assert read(family, ("user", "ask"), ("assistant", "I will read a file")) is None
    assert read(family, ("user", "ask"), ("tool", "a result that says ask now")) is None
    assert read(family, ("system", "rules")) is None


# #552-F2: a Messages tool result is inside a user message; its text is not the user's text
def test_a_tool_result_block_is_not_text_of_the_user_on_messages() -> None:
    body = {
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": "c1", "content": "RESULT"},
                    {"type": "text", "text": "ask now"},
                ],
            }
        ]
    }

    assert last_user_text(WireFamily.ANTHROPIC_MESSAGES, body) == "ask now"


@pytest.mark.parametrize("family", FAMILIES)
def test_a_body_of_another_shape_marks_nothing(family: WireFamily) -> None:
    for body in ({}, {"messages": "x", "input": 3, "contents": None}, {"messages": [1]}):
        assert last_user_text(family, body) is None
