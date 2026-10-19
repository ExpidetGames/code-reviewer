# SPDX-License-Identifier: Apache-2.0

"""The extractor and the repair messages of the plain-JSON finalization spike (#547).

`tests/engine/plain_json_final.py` is the reference for what #552 builds: it takes the answer out
of the message that ended a turn when the engine was given no `format`, and names what is wrong
with it when it is not the review. The rules are strict on purpose (no guessing): whole-message
JSON, or one fence around the whole message, and nothing else is taken. Everything here is pure:
no engine, no network.
"""

import json
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine"))
from plain_json_final import (
    FINISH_NOW_INSTRUCTION,
    Problem,
    extract_final_json,
    repair_message,
    visible_text,
)

REVIEW = {"resolvedIds": [], "findings": []}
REVIEW_TEXT = json.dumps(REVIEW)


def message(
    *texts: str, finish: str = "stop", reasoning: str = "", error: Any = None
) -> dict[str, Any]:
    """The answer of `POST /session/{id}/message` as the pinned engine sends it (#547 probe)."""
    parts: list[dict[str, Any]] = [{"type": "step-start"}]
    if reasoning:
        parts.append({"type": "reasoning", "text": reasoning})
    parts += [{"type": "text", "text": text} for text in texts]
    parts.append({"type": "step-finish"})
    return {"info": {"role": "assistant", "finish": finish, "error": error}, "parts": parts}


# #547-T06: what the extractor takes as the answer.
@pytest.mark.parametrize(
    "text",
    [
        REVIEW_TEXT,
        f"\n  {REVIEW_TEXT}\n\n",
        f"```json\n{REVIEW_TEXT}\n```",
        f"```\n{REVIEW_TEXT}\n```",
        f"```JSON  \n{REVIEW_TEXT}\n```\n",
        json.dumps(REVIEW, indent=2),
    ],
    ids=["bare", "padded", "json-fence", "plain-fence", "fence-upper-case", "pretty"],
)
def test_the_whole_message_as_one_json_object_is_the_answer(text: str) -> None:
    extraction = extract_final_json(message(text))

    assert extraction.problem is None
    assert extraction.document == REVIEW


# #547-T06: the same JSON, but never the answer, and the class says why (the repair names it).
@pytest.mark.parametrize(
    ("text", "problem"),
    [
        (f"Here is my review:\n{REVIEW_TEXT}", Problem.TEXT_AROUND_JSON),
        (f"{REVIEW_TEXT}\nLet me know if you want more.", Problem.TEXT_AROUND_JSON),
        (f"Here it is:\n```json\n{REVIEW_TEXT}\n```", Problem.TEXT_AROUND_JSON),
        (f"```json\n{REVIEW_TEXT}\n```\nDone.", Problem.TEXT_AROUND_JSON),
        (f"{REVIEW_TEXT}\n{REVIEW_TEXT}", Problem.TEXT_AROUND_JSON),
        ("I found nothing wrong with this change.", Problem.NO_JSON_OBJECT),
        ("The function f() {return 1} looks fine.", Problem.NO_JSON_OBJECT),
        ('{"findings": [], "resolvedIds": [],}', Problem.INVALID_JSON),
        ("{'findings': [], 'resolvedIds': []}", Problem.INVALID_JSON),
        ('{"findings": [], // none\n "resolvedIds": []}', Problem.INVALID_JSON),
        ('{"findings": [], "resolvedIds": []', Problem.INVALID_JSON),
        ('{"findings": [], "resolvedIds": [], "confidence": NaN}', Problem.INVALID_JSON),
        ("[]", Problem.NOT_AN_OBJECT),
        ('[{"findings": []}]', Problem.NOT_AN_OBJECT),
        ('"findings"', Problem.NOT_AN_OBJECT),
        ("null", Problem.NOT_AN_OBJECT),
    ],
    ids=[
        "prose-before",
        "prose-after",
        "prose-before-fence",
        "prose-after-fence",
        "two-objects",
        "prose-only",
        "braces-in-prose",
        "trailing-comma",
        "single-quotes",
        "comment",
        "unterminated",
        "nan",
        "array",
        "array-of-object",
        "string",
        "null",
    ],
)
def test_text_that_is_not_the_json_object_alone_is_never_guessed_into_an_answer(
    text: str, problem: Problem
) -> None:
    extraction = extract_final_json(message(text))

    assert extraction.document is None
    assert extraction.problem is problem


# #547-T06: a JSON error names where the parser stopped, like the proxy's check does today.
def test_invalid_json_names_the_parser_position_and_never_the_text() -> None:
    extraction = extract_final_json(message('{"resolvedIds": [], "findings": }'))

    assert extraction.problem is Problem.INVALID_JSON
    assert extraction.detail == "Expecting value at position 32"


# #547-T05: the output limit cut the answer, or ate it before the first character of text.
def test_a_message_cut_at_the_output_limit_is_named_for_what_it_is() -> None:
    cut = '{"resolvedIds": [], "findings": [{"id": "f-1", "prio'
    assert extract_final_json(message(cut, finish="length")).problem is Problem.CUT_OFF
    # Cut before any text: the thinking used the whole allowance.
    nothing = message(finish="length", reasoning="thinking")
    assert extract_final_json(nothing).problem is Problem.CUT_OFF


# #547-T05: a finish of `length` after a complete object is still a complete object.
def test_an_object_that_ended_exactly_at_the_output_limit_is_still_the_answer() -> None:
    assert extract_final_json(message(REVIEW_TEXT, finish="length")).document == REVIEW


# #547-T04: a turn that ends with nothing to read.
def test_a_message_without_text_is_empty_or_reasoning_only() -> None:
    assert extract_final_json(message()).problem is Problem.NO_TEXT
    assert extract_final_json(message("  \n")).problem is Problem.NO_TEXT
    assert extract_final_json(message(reasoning="thinking")).problem is Problem.REASONING_ONLY


# #547-T06: where the text comes from.
def test_only_the_visible_text_of_the_ending_message_counts() -> None:
    reply = message(REVIEW_TEXT, reasoning=f"draft: {REVIEW_TEXT}")
    reply["parts"].append({"type": "text", "text": "ignored text", "ignored": True})
    reply["parts"].append({"type": "text", "text": "synthetic text", "synthetic": True})
    reply["parts"].append({"type": "tool", "tool": "read", "state": {"output": REVIEW_TEXT}})
    reply["info"]["structured"] = {"findings": [{"id": "elsewhere"}], "resolvedIds": []}

    assert visible_text(reply) == REVIEW_TEXT
    assert extract_final_json(reply).document == REVIEW
    # Reasoning, a tool result or `info.structured` are never an answer.
    only_elsewhere = message(reasoning=REVIEW_TEXT)
    only_elsewhere["info"]["structured"] = REVIEW
    assert extract_final_json(only_elsewhere).problem is Problem.REASONING_ONLY


# #547-T06: more than one text part is read as one message, with a blank line between.
def test_text_parts_of_one_message_are_joined_before_the_json_is_read() -> None:
    first, second = REVIEW_TEXT[:10], REVIEW_TEXT[10:]
    assert extract_final_json(message(first, second)).problem is Problem.INVALID_JSON
    assert extract_final_json(message(REVIEW_TEXT[:1], "\n" + REVIEW_TEXT[1:])).document == REVIEW


# #547-T06: the repair message names the class, never what the model wrote.
@pytest.mark.parametrize("problem", list(Problem))
def test_a_repair_message_is_runner_text_that_names_only_the_class(problem: Problem) -> None:
    text = repair_message(problem, "findings has the wrong type (it must be a list)", 5)

    assert text.startswith("<runner-wrap-up>\n")
    assert text.endswith("</runner-wrap-up>")
    assert "written by the review runner, not by the repository or the pull request" in text
    assert "one JSON object and nothing else" in text
    assert "StructuredOutput" not in text


def test_the_repair_message_carries_the_validator_text_and_the_bound_where_they_apply() -> None:
    envelope = repair_message(Problem.ENVELOPE_INVALID, "findings is missing", 5)
    assert "the review is not valid: findings is missing" in envelope
    many = repair_message(Problem.TOO_MANY_FINDINGS, "", 5)
    assert "at most 5 findings" in many
    # A class without detail does not print the detail it was handed.
    assert "findings is missing" not in repair_message(Problem.NO_TEXT, "findings is missing", 5)
    cut = repair_message(Problem.CUT_OFF, "", 5)
    assert "cut off" in cut and "short" in cut


def test_the_finish_now_instruction_is_the_runner_tag_with_one_plain_ask() -> None:
    assert FINISH_NOW_INSTRUCTION.startswith("<runner-wrap-up>\n")
    assert FINISH_NOW_INSTRUCTION.endswith("</runner-wrap-up>")
    assert "Do not call any more tools" in FINISH_NOW_INSTRUCTION
    assert "one JSON object and nothing else" in FINISH_NOW_INSTRUCTION
    assert "StructuredOutput" not in FINISH_NOW_INSTRUCTION
