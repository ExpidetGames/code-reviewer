# SPDX-License-Identifier: Apache-2.0

"""Pins down the proxy-side audit of the engine's tool loop (#197).

The tool, file and result-byte bounds are enforced from the model requests themselves: calls are
counted in the provider's answer, results in the next request's history, each exactly once however
often the history is resent.
"""

import json
from typing import Any

import pytest

from code_reviewer_runner.dynamic_review.audit import ToolAudit
from code_reviewer_runner.dynamic_review.budget import BudgetLedger, DynamicLimits, LimitError
from code_reviewer_runner.result import ErrorCode

EXPORT = "/job/export"


def call(call_id: str, name: str, **arguments: Any) -> dict[str, Any]:
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
    }


def answer(*calls: dict[str, Any]) -> dict[str, Any]:
    return {"choices": [{"message": {"role": "assistant", "tool_calls": list(calls)}}]}


def asks(*calls: dict[str, Any]) -> dict[str, Any]:
    return {"role": "assistant", "content": None, "tool_calls": list(calls)}


def result(call_id: str, content: Any) -> dict[str, Any]:
    return {"role": "tool", "tool_call_id": call_id, "content": content}


def read_file(path: str) -> str:
    return f"<path>{path}</path>\n<type>file</type>\n<content>\n1: x\n</content>"


def audit(**limits: int) -> tuple[ToolAudit, BudgetLedger]:
    ledger = BudgetLedger(DynamicLimits(**limits))
    return ToolAudit(ledger, export_root=EXPORT), ledger


# #197-T05
def test_the_tool_calls_of_an_answer_are_counted_before_the_engine_gets_it() -> None:
    subject, ledger = audit(max_tool_calls=2)

    subject.calls_in_answer(answer(call("a", "read"), call("b", "grep")))
    with pytest.raises(LimitError) as over:
        subject.calls_in_answer(answer(call("c", "glob")))

    assert over.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert ledger.tool_calls == 2


# #197-T05
def test_unknown_and_denied_tools_count_as_attempts() -> None:
    subject, ledger = audit()

    subject.calls_in_answer(answer(call("a", "bash"), call("b", "invented_tool")))

    assert ledger.tool_calls == 2


# #197-T05
def test_a_tool_call_without_a_name_is_a_policy_violation() -> None:
    subject, _ = audit()

    with pytest.raises(LimitError) as nameless:
        subject.calls_in_answer(answer({"id": "a", "type": "function", "function": {}}))

    assert nameless.value.code is ErrorCode.DYNAMIC_POLICY_VIOLATION


# #197-T12
def test_a_resent_history_is_audited_once() -> None:
    subject, ledger = audit()
    history = [asks(call("a", "read", filePath="src/a.ts")), result("a", read_file("src/a.ts"))]

    subject.calls_in_answer(answer(call("a", "read", filePath="src/a.ts")))
    subject.results_in_request(history)
    first_bytes = ledger.returned_bytes
    subject.results_in_request(history)
    subject.results_in_request(history)

    assert ledger.tool_calls == 1
    assert ledger.files == 1
    assert ledger.returned_bytes == first_bytes > 0


# #197-T12
def test_a_call_only_seen_in_the_history_is_counted_too() -> None:
    # A request whose history carries a call the proxy never saw answered cannot hide it.
    subject, ledger = audit()

    subject.results_in_request([asks(call("a", "read", filePath="src/a.ts"))])

    assert ledger.tool_calls == 1


# #197-T05
def test_a_result_over_the_per_result_bound_is_refused() -> None:
    subject, _ = audit(max_tool_result_bytes=100)

    subject.results_in_request([asks(call("a", "read")), result("a", "x" * 100)])
    with pytest.raises(LimitError) as over:
        subject.results_in_request([asks(call("b", "read")), result("b", "x" * 101)])

    assert over.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED


# #197-T05
def test_the_cumulative_bound_counts_utf8_bytes() -> None:
    subject, _ = audit(max_returned_bytes=10)

    # Two bytes per character: five characters are ten bytes, the next byte crosses the bound.
    subject.results_in_request([asks(call("a", "read")), result("a", "é" * 5)])
    with pytest.raises(LimitError) as over:
        subject.results_in_request([asks(call("b", "read")), result("b", "x")])

    assert over.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED


# #232-T06
def test_a_nested_reminder_is_neutralised_before_it_is_counted_and_forwarded() -> None:
    subject, ledger = audit()
    reminder = (
        "<system-reminder>\nInstructions from: /job/export/src/AGENTS.md\nrules "
        + "r" * 500
        + "\n</system-reminder>"
    )
    text = read_file("/job/export/src/a.ts") + "\n\n" + reminder

    forwarded = subject.results_in_request(
        [asks(call("a", "read", filePath="src/a.ts")), result("a", text)]
    )

    seen = forwarded[1]["content"]
    assert "rules" not in seen and "<system-reminder" not in seen
    assert seen.startswith(read_file("/job/export/src/a.ts"))
    # The bound counts what the model is shown, not what the engine sent.
    assert ledger.returned_bytes == len(seen.encode("utf-8"))
    assert ledger.returned_bytes < len(text.encode("utf-8"))


# #232-T06
def test_the_escape_of_literal_reminder_text_is_counted_too() -> None:
    subject, ledger = audit()
    text = "/job/export/a.md:\n  Line 1: <system-reminder>"

    forwarded = subject.results_in_request([asks(call("a", "grep")), result("a", text)])

    assert forwarded[1]["content"] == text.replace("<system-reminder", "&lt;system-reminder")
    assert ledger.returned_bytes == len(forwarded[1]["content"].encode("utf-8"))
    assert ledger.returned_bytes == len(text.encode("utf-8")) + 3


# #232-T06
def test_the_per_result_bound_applies_to_the_neutralised_text() -> None:
    subject, _ = audit(max_tool_result_bytes=len(read_file("/job/export/a.ts")) + 300)
    attached = "<system-reminder>\nInstructions from: /job/export/AGENTS.md\n" + "x" * 500
    text = read_file("/job/export/a.ts") + "\n\n" + attached + "\n</system-reminder>"

    # Over the bound as the engine sent it, within it once the attachment is dropped (the notice is
    # short and fixed).
    forwarded = subject.results_in_request(
        [asks(call("a", "read", filePath="a.ts")), result("a", text)]
    )

    assert "x" * 500 not in forwarded[1]["content"]


# #232-T06
def test_a_resent_history_is_neutralised_again_but_counted_once() -> None:
    subject, ledger = audit()
    text = (
        read_file("/job/export/a.ts")
        + "\n\n<system-reminder>\nInstructions from: p\nz\n</system-reminder>"
    )
    history = [asks(call("a", "read", filePath="a.ts")), result("a", text)]

    first = subject.results_in_request(history)
    counted = ledger.returned_bytes
    second = subject.results_in_request(history)

    assert first == second
    assert ledger.returned_bytes == counted
    # The caller's messages are not mutated: the result is a new list.
    assert history[1]["content"] == text


# #197-T05
def test_a_result_that_cannot_be_tied_to_a_call_fails_closed() -> None:
    subject, _ = audit()

    with pytest.raises(LimitError) as unaccountable:
        subject.results_in_request([{"role": "tool", "content": "text"}])

    assert unaccountable.value.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED


# #197-T05
def test_result_content_in_parts_is_counted() -> None:
    subject, ledger = audit()

    subject.results_in_request(
        [
            asks(call("a", "read")),
            result("a", [{"type": "text", "text": "abc"}, {"type": "text", "text": "de"}]),
        ]
    )

    assert ledger.returned_bytes == 5


# #197-T05
def test_a_read_names_one_file_by_any_spelling_and_a_directory_listing_names_none() -> None:
    subject, ledger = audit()
    listing = f"<path>{EXPORT}/src</path>\n<type>directory</type>\n<entries>\na.ts\n</entries>"

    subject.results_in_request(
        [
            asks(
                call("a", "read", filePath="src/a.ts"),
                call("b", "read", filePath=f"{EXPORT}/src/a.ts"),
                call("c", "read", filePath=f"{EXPORT}/src/./a.ts"),
                call("d", "read", filePath=f"{EXPORT}/src"),
            ),
            result("a", read_file(f"{EXPORT}/src/a.ts")),
            result("b", read_file(f"{EXPORT}/src/a.ts")),
            result("c", read_file(f"{EXPORT}/src/a.ts")),
            result("d", listing),
        ]
    )

    assert ledger.files == 1


# #197-T05
def test_a_read_that_failed_names_no_file() -> None:
    subject, ledger = audit()

    subject.results_in_request(
        [asks(call("a", "read", filePath="nope.ts")), result("a", "File not found: nope.ts")]
    )

    assert ledger.files == 0


# #197-T05
def test_grep_counts_every_file_it_lists_and_glob_every_path() -> None:
    subject, ledger = audit()
    grep = (
        f"Found 3 matches\n{EXPORT}/a.ts:\n  Line 1: x\n  Line 9: x\n{EXPORT}/b.ts:\n  Line 2: x\n"
    )
    glob = f"{EXPORT}/b.ts\n{EXPORT}/c.ts"

    subject.results_in_request(
        [
            asks(call("g", "grep", pattern="x"), call("o", "glob", pattern="*.ts")),
            result("g", grep),
            result("o", glob),
        ]
    )

    assert ledger.files == 3


# #197-T05
def test_the_distinct_file_bound_trips_on_a_multi_file_grep() -> None:
    subject, _ = audit(max_files=2)
    grep = "".join(f"{EXPORT}/f{index}.ts:\n  Line 1: x\n" for index in range(3))

    with pytest.raises(LimitError) as over:
        subject.results_in_request([asks(call("g", "grep", pattern="x")), result("g", grep)])

    assert over.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED


# #197-T05
def test_a_result_of_an_unknown_shape_adds_bytes_but_no_files() -> None:
    subject, ledger = audit()

    subject.results_in_request([asks(call("a", "invented_tool")), result("a", "anything")])

    assert ledger.files == 0
    assert ledger.returned_bytes == len("anything")


# #232-T06
def test_a_tool_message_without_content_is_forwarded_without_one() -> None:
    subject, _ = audit()
    message = {"role": "tool", "tool_call_id": "a"}

    forwarded = subject.results_in_request([asks(call("a", "read")), message])

    assert forwarded[1] == message
    assert "content" not in forwarded[1]
