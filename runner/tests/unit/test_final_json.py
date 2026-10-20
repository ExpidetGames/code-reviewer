# SPDX-License-Identifier: Apache-2.0

"""The extractor and the repair messages of the plain-JSON finalization (#552, spike #547).

`final_json` takes the answer out of the message that ended a turn when the engine was given no
`format`, and names what is wrong with it when it is not the review. The rules are strict on
purpose (no guessing): whole-message JSON, or one fence around the whole message, and nothing else
is taken. `final_messages` is what the runner says to the model about it. Everything here is pure:
no engine, no network.
"""

import json
from typing import Any

import pytest

from code_reviewer_runner.dynamic_review.final_json import (
    NESTED_TOO_DEEPLY,
    Problem,
    extract_final_json,
    visible_text,
)
from code_reviewer_runner.dynamic_review.final_messages import (
    FINISH_NOW_INSTRUCTION,
    final_answer_line,
    repair_message,
)

REVIEW: dict[str, Any] = {"resolvedIds": [], "findings": []}
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


# #552-T01, #552-T02: what the extractor takes as the answer.
@pytest.mark.parametrize(
    "text",
    [
        REVIEW_TEXT,
        f"\n  {REVIEW_TEXT}\n\n",
        f"```json\n{REVIEW_TEXT}\n```",
        f"```\n{REVIEW_TEXT}\n```",
        f"```JSON  \n{REVIEW_TEXT}\n```\n",
        f"```jSoN\n{REVIEW_TEXT}\n```",
        f"```json\r\n{REVIEW_TEXT}\r\n```\r\n",
        f"```\r\n{REVIEW_TEXT}\r\n```",
        json.dumps(REVIEW, indent=2),
    ],
    ids=[
        "bare",
        "padded",
        "json-fence",
        "plain-fence",
        "fence-upper-case",
        "fence-mixed-case",
        "fence-crlf",
        "plain-fence-crlf",
        "pretty",
    ],
)
def test_the_whole_message_as_one_json_object_is_the_answer(text: str) -> None:
    extraction = extract_final_json(message(text))

    assert extraction.problem is None
    assert extraction.document == REVIEW


# #552-T02: the same JSON, but never the answer, and the class says why (the repair names it).
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
        (
            '{"resolvedIds": [], \'findings\': [{"id": "f-1"}]}',
            Problem.INVALID_JSON,
        ),
        ('Here: {\'findings\': [{"id": "f-1"}]}', Problem.NO_JSON_OBJECT),
        (f"The function f() {{return 1}} is fine.\n{REVIEW_TEXT}", Problem.TEXT_AROUND_JSON),
        (f"```json\n{REVIEW_TEXT}```", Problem.TEXT_AROUND_JSON),
        (f"```json{REVIEW_TEXT}\n```", Problem.TEXT_AROUND_JSON),
        (f"```python\n{REVIEW_TEXT}\n```", Problem.TEXT_AROUND_JSON),
        ("[" * 100_000, Problem.INVALID_JSON),
        ('{"resolvedIds": [], "findings": ' + "[" * 100_000, Problem.INVALID_JSON),
        ('Here: {"findings": ' + "[" * 100_000, Problem.NO_JSON_OBJECT),
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
        "single-quotes-with-a-finding-inside",
        "prose-before-single-quotes",
        "braces-before-the-object",
        "closing-fence-on-the-object-line",
        "object-on-the-opening-fence-line",
        "fence-with-another-language",
        "deeply-nested-array",
        "deeply-nested-object",
        "deeply-nested-after-prose",
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


# #552-T03: a JSON error names where the parser stopped, like the proxy's check does today.
def test_invalid_json_names_the_parser_position_and_never_the_text() -> None:
    extraction = extract_final_json(message('{"resolvedIds": [], "findings": }'))

    assert extraction.problem is Problem.INVALID_JSON
    assert extraction.detail == "Expecting value at position 32"


# #552-T09: a hostile nesting depth ends in the parser's recursion limit; the extractor names it
# with a fixed text instead of letting `RecursionError` out of the run.
def test_a_nesting_that_exhausts_the_parser_is_invalid_json_with_a_fixed_text() -> None:
    extraction = extract_final_json(message("[" * 100_000))

    assert extraction.document is None
    assert extraction.problem is Problem.INVALID_JSON
    assert extraction.detail == "the JSON is nested too deeply"


# #552-T03: the output limit cut the answer, or ate it before the first character of text.
def test_a_message_cut_at_the_output_limit_is_named_for_what_it_is() -> None:
    cut = '{"resolvedIds": [], "findings": [{"id": "f-1", "prio'
    assert extract_final_json(message(cut, finish="length")).problem is Problem.CUT_OFF
    # Cut before any text: the thinking used the whole allowance.
    nothing = message(finish="length", reasoning="thinking")
    assert extract_final_json(nothing).problem is Problem.CUT_OFF


# #552-T03: a finish of `length` after a complete object is still a complete object.
def test_an_object_that_ended_exactly_at_the_output_limit_is_still_the_answer() -> None:
    assert extract_final_json(message(REVIEW_TEXT, finish="length")).document == REVIEW


# #552-T03: a turn that ends with nothing to read.
def test_a_message_without_text_is_empty_or_reasoning_only() -> None:
    assert extract_final_json(message()).problem is Problem.NO_TEXT
    assert extract_final_json(message("  \n")).problem is Problem.NO_TEXT
    assert extract_final_json(message(reasoning="thinking")).problem is Problem.REASONING_ONLY


# #552-T09: where the text comes from.
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


# #552-T02: more than one text part is read as one message, with a blank line between.
def test_text_parts_of_one_message_are_joined_before_the_json_is_read() -> None:
    first, second = REVIEW_TEXT[:10], REVIEW_TEXT[10:]
    assert extract_final_json(message(first, second)).problem is Problem.INVALID_JSON
    assert extract_final_json(message(REVIEW_TEXT[:1], "\n" + REVIEW_TEXT[1:])).document == REVIEW


# #552-T03: the repair message names the class, never what the model wrote.
@pytest.mark.parametrize("problem", list(Problem))
def test_a_repair_message_is_runner_text_that_names_only_the_class(problem: Problem) -> None:
    text = repair_message(problem, "findings has the wrong type (it must be a list)", 5)

    assert text.startswith("<runner-wrap-up>\n")
    assert text.endswith("</runner-wrap-up>")
    assert "written by the review runner, not by the repository or the pull request" in text
    assert "one JSON object and nothing else" in text
    assert "StructuredOutput" not in text


# #552-T03: what each class says to the model (the engine tests prove the mechanics once; the
# wording of every class is proven here).
@pytest.mark.parametrize(
    ("problem", "detail", "named"),
    [
        (Problem.NO_TEXT, "", "it had no text"),
        (Problem.REASONING_ONLY, "", "it had reasoning but no text"),
        (Problem.CUT_OFF, "", "cut off at the output limit"),
        (Problem.NO_JSON_OBJECT, "", "did not contain a JSON object"),
        (Problem.TEXT_AROUND_JSON, "", "text next to the JSON object, or more than one object"),
        (Problem.INVALID_JSON, "Expecting value at position 3", "not valid (Expecting value at"),
        (Problem.INVALID_JSON, NESTED_TOO_DEEPLY, "not valid (the JSON is nested too deeply)"),
        (Problem.NOT_AN_OBJECT, "", "not a list or a single value"),
        (Problem.ENVELOPE_INVALID, "findings is missing", "not valid: findings is missing"),
        (Problem.TOO_MANY_FINDINGS, "", "at most 5 findings"),
        (Problem.TOOL_CALL, "", "called a tool, and no tool may be called now"),
    ],
)
def test_every_class_is_named_in_its_own_words(problem: Problem, detail: str, named: str) -> None:
    assert named in repair_message(problem, detail, 5)


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


# #552-T01: the core is untouched; the job's bound is the one thing its line has to carry.
def test_the_final_answer_line_carries_the_bound_of_the_job_and_nothing_untrusted() -> None:
    line = final_answer_line(7)

    assert "one JSON object and nothing else" in line
    assert "at most 7 findings" in line
    assert "\n" not in line and "StructuredOutput" not in line
