# SPDX-License-Identifier: LicenseRef-Proprietary

"""The parts of an Implementer turn that need no engine (#764): the summary, the bounds on tool
results, and the codes a turn can end with."""

import time
from collections.abc import Callable
from decimal import Decimal

import pytest

from code_reviewer_runner.dynamic_review.adapter import EngineError
from code_reviewer_runner.dynamic_review.budget import BudgetLedger, LimitError, UnitCosts
from code_reviewer_runner.dynamic_review.netguard import IsolationError
from code_reviewer_runner.dynamic_review.tool_part_audit import ToolPartAudit
from code_reviewer_runner.implementer.session import (
    COST_LIMIT_DETAIL,
    DEADLINE_DETAIL,
    MAX_RETURNED_BYTES,
    MAX_TOOL_RESULT_BYTES,
    TOKEN_CAP_DETAIL,
    agent_limits,
    classify,
)
from code_reviewer_runner.implementer.turn_result import MAX_SUMMARY_CHARS, clip_summary
from code_reviewer_runner.job import JobError
from code_reviewer_runner.redaction import REDACTED
from code_reviewer_runner.result import ErrorCode

PRICES = UnitCosts(input_usd_per_mtok=Decimal(3), output_usd_per_mtok=Decimal(15))
TOKEN = "ghs_dummy-installation-token-0123456789"
KEY = "sk-or-v1-" + "dummykey0123456789abcdef"  # built, so the secret scan sees no key


def make_ledger(
    *,
    max_cost: str = "5",
    deadline: float = 600.0,
    clock: Callable[[], float] = time.monotonic,
) -> BudgetLedger:
    limits = agent_limits(deadline, Decimal(max_cost), "cost_limit")
    return BudgetLedger(limits, unit_costs=PRICES, clock=clock)


# -- the summary --------------------------------------------------------------------------------


# #764-T13
def test_the_summary_is_cut_at_the_bound_of_the_contract() -> None:
    summary = clip_summary("x" * (MAX_SUMMARY_CHARS * 3), [])

    assert len(summary) == MAX_SUMMARY_CHARS == 8192
    assert summary.endswith("[...]")


# #764-T13
def test_a_short_summary_is_kept_as_it_is() -> None:
    assert clip_summary("  Done.\n", []) == "Done."


# #764-T13
def test_the_secrets_of_the_job_are_gone_before_the_cut_so_a_cut_cannot_split_one() -> None:
    padding = "p" * (MAX_SUMMARY_CHARS - 10)
    text = f"{padding}{TOKEN} and later {KEY}"

    summary = clip_summary(text, [TOKEN, KEY])

    assert TOKEN not in summary and KEY not in summary
    assert TOKEN[:12] not in summary, "not even the start of one"
    assert REDACTED[:4] in summary, "the marker may be cut, the secret is not there to be cut"


# #764-T13
def test_a_secret_in_its_encoded_forms_is_gone_too() -> None:
    assert TOKEN not in clip_summary(f"token={TOKEN}", [TOKEN])
    assert clip_summary("Authorization: Bearer abcdef0123456789", []).count("abcdef") == 0


# -- the bounds on tool results ----------------------------------------------------------------


def tool_event(identity: str, output: str, name: str = "bash") -> dict[str, object]:
    return {
        "type": "message.part.updated",
        "properties": {
            "sessionID": "ses_1",
            "part": {
                "type": "tool",
                "callID": identity,
                "tool": name,
                "state": {"status": "completed", "input": {"command": "x"}, "output": output},
            },
        },
    }


# #764-T11
def test_a_bash_result_over_64_kib_ends_the_turn_and_one_at_the_bound_does_not() -> None:
    ledger = make_ledger()
    audit = ToolPartAudit(ledger, "ses_1", export_root="/work/repo")

    audit.feed(tool_event("call_1", "o" * MAX_TOOL_RESULT_BYTES))
    with pytest.raises(LimitError) as refused:
        audit.feed(tool_event("call_2", "o" * (MAX_TOOL_RESULT_BYTES + 1)))

    assert MAX_TOOL_RESULT_BYTES == 64 * 1024
    assert refused.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert classify(refused.value)[0] is ErrorCode.RUNNER_ERROR, "a bound, not a limit of the job"


# #764-T11
def test_the_cumulative_bound_of_the_results_applies_to_bash_output_too() -> None:
    ledger = make_ledger()
    audit = ToolPartAudit(ledger, "ses_1", export_root="/work/repo")
    full = "o" * MAX_TOOL_RESULT_BYTES
    calls = MAX_RETURNED_BYTES // MAX_TOOL_RESULT_BYTES

    for number in range(calls):
        audit.feed(tool_event(f"call_{number}", full))
    with pytest.raises(LimitError) as refused:
        audit.feed(tool_event("call_last", "x"))

    assert refused.value.detail == "the cumulative content bound is used up"
    assert classify(refused.value)[0] is ErrorCode.RUNNER_ERROR


# -- the codes ----------------------------------------------------------------------------------


# #764-T06
def test_the_ledgers_words_for_the_cost_limit_and_the_clock_are_the_ones_classify_reads() -> None:
    cheap = make_ledger(max_cost="0.0000001")
    with pytest.raises(LimitError) as cost:
        cheap.reserve_call("x" * 4000)
    expired = make_ledger(deadline=0.0)
    with pytest.raises(LimitError) as clock:
        expired.check_deadline()

    assert cost.value.detail == COST_LIMIT_DETAIL
    assert clock.value.detail == DEADLINE_DETAIL
    assert classify(cost.value) == (
        ErrorCode.COST_LIMIT_REACHED,
        "the cost limit of the turn was reached",
    )
    assert classify(clock.value)[0] is ErrorCode.TIME_LIMIT_REACHED


# #764-T06
def test_the_token_cap_of_an_own_key_is_the_cost_limit() -> None:
    error = LimitError(ErrorCode.DYNAMIC_BUDGET_EXCEEDED, TOKEN_CAP_DETAIL)

    assert classify(error)[0] is ErrorCode.COST_LIMIT_REACHED


# #764-T12
@pytest.mark.parametrize(
    ("error", "code"),
    [
        (
            LimitError(ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "the engine's event stream ended"),
            ErrorCode.RUNNER_ERROR,
        ),
        (
            EngineError(ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "engine_exited: gone"),
            ErrorCode.RUNNER_ERROR,
        ),
        (LimitError(ErrorCode.DYNAMIC_CONFIG_INVALID, "no"), ErrorCode.IMPLEMENTER_CONFIG_INVALID),
        (
            LimitError(ErrorCode.LLM_AUTH, "the model provider refused the request"),
            ErrorCode.LLM_AUTH,
        ),
        (
            LimitError(ErrorCode.DYNAMIC_ACCOUNTING_FAILED, "a cost"),
            ErrorCode.DYNAMIC_ACCOUNTING_FAILED,
        ),
        (JobError(ErrorCode.BRANCH_VIOLATION, "rewritten"), ErrorCode.BRANCH_VIOLATION),
        (JobError(ErrorCode.PUSH_REJECTED, "refused"), ErrorCode.PUSH_REJECTED),
        (
            IsolationError("the engine ports are not the ones the network rules allow"),
            ErrorCode.SETUP_FAILED,
        ),
        (OSError("disk"), ErrorCode.RUNNER_ERROR),
    ],
)
def test_what_ends_a_turn_has_a_stable_code(error: BaseException, code: ErrorCode) -> None:
    assert classify(error)[0] is code


# #764-T12
def test_the_sentence_of_a_classified_error_never_carries_the_text_of_an_unknown_exception() -> (
    None
):
    assert classify(RuntimeError("secret-from-the-repo"))[1] == "the turn could not be run"
