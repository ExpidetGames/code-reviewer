# SPDX-License-Identifier: Apache-2.0

"""The audit of the tool parts the engine reports, on the adapter's side (#552).

The legacy proxy counted the tool calls and results of a request. The passthrough proxy relays
bytes and counts nothing of the sort, so the count and the bounds (64 KiB per result, 4 MiB
cumulative, the files a run read) are enforced where the adapter sees the parts the engine reports:
once per call id, from the part that is complete. An engine that reports a result over a bound ends
the run with a stable code; a result it does not report is bounded by the request byte bound of the
proxy, which no history can pass.
"""

from decimal import Decimal
from typing import Any

import pytest

from code_reviewer_runner.dynamic_review.budget import (
    MAX_RETURNED_BYTES,
    MAX_TOOL_RESULT_BYTES,
    BudgetLedger,
    DynamicLimits,
    LimitError,
    UnitCosts,
)
from code_reviewer_runner.dynamic_review.tool_part_audit import ToolPartAudit
from code_reviewer_runner.result import ErrorCode

SESSION = "ses_1"
ROOT = "/export"
UNIT_COSTS = UnitCosts(input_usd_per_mtok=Decimal(1), output_usd_per_mtok=Decimal(4))


def ledger() -> BudgetLedger:
    return BudgetLedger(DynamicLimits(), unit_costs=UNIT_COSTS)


def part(
    call: str,
    tool: str,
    status: str,
    *,
    output: str | None = None,
    error: str | None = None,
    arguments: dict[str, Any] | None = None,
    session: str = SESSION,
) -> dict[str, Any]:
    """A `message.part.updated` event of the pinned engine for a tool part."""
    state: dict[str, Any] = {"status": status, "input": arguments or {}}
    if output is not None:
        state["output"] = output
    if error is not None:
        state["error"] = error
    return {
        "type": "message.part.updated",
        "properties": {
            "sessionID": session,
            "part": {"type": "tool", "tool": tool, "callID": call, "state": state},
        },
    }


# #552-T09: a call is counted when it is first seen, a result when it is complete, each once
def test_a_call_and_its_result_are_counted_once_however_often_the_part_is_updated() -> None:
    budget = ledger()
    audit = ToolPartAudit(budget, SESSION, export_root=ROOT)
    arguments = {"filePath": f"{ROOT}/src/app.py"}
    body = f"<path>{ROOT}/src/app.py</path>\n<type>file</type>\n<content>x = 1</content>"

    audit.feed(part("c1", "read", "pending", arguments={}))
    audit.feed(part("c1", "read", "running", arguments=arguments))
    audit.feed(part("c1", "read", "completed", output=body, arguments=arguments))
    audit.feed(part("c1", "read", "completed", output=body, arguments=arguments))

    assert budget.tool_calls == 1
    assert budget.returned_bytes == len(body.encode())
    assert budget.files == 1


# #552-T09
def test_the_files_a_result_names_are_counted_like_the_legacy_audit_counts_them() -> None:
    budget = ledger()
    audit = ToolPartAudit(budget, SESSION, export_root=ROOT)

    audit.feed(
        part(
            "c1",
            "grep",
            "completed",
            output=f"Found 3 matches\n{ROOT}/a.py:\n  Line 1: x\n{ROOT}/b.py:\n  Line 2: y",
        )
    )
    audit.feed(part("c2", "glob", "completed", output=f"{ROOT}/a.py\n{ROOT}/c.py"))

    assert budget.files == 3  # a, b and c; a once


# #552-T09
def test_a_result_over_the_per_result_bound_ends_the_run_with_a_stable_code() -> None:
    audit = ToolPartAudit(ledger(), SESSION)

    with pytest.raises(LimitError) as raised:
        audit.feed(part("c1", "read", "completed", output="x" * (MAX_TOOL_RESULT_BYTES + 1)))

    assert raised.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert "per-result" in raised.value.detail


# #552-T09
def test_the_cumulative_bound_counts_bytes_not_characters() -> None:
    budget = ledger()
    audit = ToolPartAudit(budget, SESSION)
    # 'ä' is two bytes: 32,000 of them are a result of 64,000 bytes.
    chunk = "ä" * (MAX_TOOL_RESULT_BYTES // 2)
    results = MAX_RETURNED_BYTES // MAX_TOOL_RESULT_BYTES

    for index in range(results):
        audit.feed(part(f"c{index}", "read", "completed", output=chunk))
    assert budget.returned_bytes == results * MAX_TOOL_RESULT_BYTES

    with pytest.raises(LimitError) as raised:
        audit.feed(part("last", "read", "completed", output="x"))
    assert raised.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert "cumulative" in raised.value.detail


# #552-T09: a tool that failed shows the model its error text: that text is a result too
def test_the_error_text_of_a_failed_tool_is_a_result_of_its_own_size() -> None:
    budget = ledger()
    audit = ToolPartAudit(budget, SESSION)

    audit.feed(part("c1", "bash", "error", error="permission denied"))

    assert budget.tool_calls == 1  # an attempt is an attempt, a denied tool included
    assert budget.returned_bytes == len(b"permission denied")


# #552-T09: a result that cannot be tied to a call id is not accounted for
def test_a_finished_part_without_a_call_id_fails_closed() -> None:
    audit = ToolPartAudit(ledger(), SESSION)
    event = part("", "read", "completed", output="x")

    with pytest.raises(LimitError) as raised:
        audit.feed(event)

    assert raised.value.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED


# #552-T09: what is not a tool part of this session is none of the audit's business
@pytest.mark.parametrize(
    "event",
    [
        part("c1", "read", "completed", output="x" * (MAX_TOOL_RESULT_BYTES + 1), session="other"),
        {
            "type": "message.part.updated",
            "properties": {"sessionID": SESSION, "part": {"type": "text"}},
        },
        {"type": "session.idle", "properties": {"sessionID": SESSION}},
        {"type": "message.part.updated", "properties": "not an object"},
        {"type": "message.part.updated"},
    ],
    ids=["other-session", "text-part", "other-event", "properties-not-an-object", "no-properties"],
)
def test_events_that_are_not_tool_parts_of_the_session_are_ignored(event: dict[str, Any]) -> None:
    budget = ledger()

    ToolPartAudit(budget, SESSION).feed(event)

    assert budget.tool_calls == 0 and budget.returned_bytes == 0
