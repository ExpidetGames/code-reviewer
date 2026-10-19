# SPDX-License-Identifier: Apache-2.0

"""Pins down how the output of a job process becomes the result sent to the app."""

import dataclasses
import json
import logging
from decimal import Decimal
from typing import Any

import pytest
from loop_support import outcome, result_line
from support import API_KEY, TOKEN

from code_reviewer_runner.dynamic_review.budget import (
    BudgetLedger,
    DynamicLimits,
    LimitError,
    UnitCosts,
)
from code_reviewer_runner.job_loop.process import ProcessOutcome
from code_reviewer_runner.job_loop.reporting import (
    MAX_LOG_TAIL_CHARS,
    MAX_REQUEST_BYTES,
    failure_result,
    fit_request,
    minimal,
    result_from_outcome,
)
from code_reviewer_runner.redaction import Redactor
from code_reviewer_runner.result import ErrorCode, JobResult, ReviewFindings, Usage

REDACTOR = Redactor([TOKEN, API_KEY])


# 1 USD per million input tokens, 4 USD per million output tokens: a call has a price.
UNIT_COSTS = UnitCosts(input_usd_per_mtok=Decimal(1), output_usd_per_mtok=Decimal(4))


def reported(process: ProcessOutcome) -> dict[str, Any]:
    return result_from_outcome(process, REDACTOR, 777)


def test_a_clean_result_line_is_passed_on_field_by_field() -> None:
    result = reported(outcome())

    assert result == {
        "ok": True,
        "durationMs": 1200,
        "commentUrl": "https://github.com/octo/repo/pull/7#c1",
        "errorCode": None,
        "logTail": "review published",
        "logTruncated": False,
        "usage": None,
    }


def test_only_the_last_line_counts_and_earlier_noise_is_ignored() -> None:
    noisy = b"library said hello\n" + result_line() + b"\n"

    assert reported(outcome(stdout=noisy))["ok"] is True


def test_a_result_with_fields_of_the_wrong_type_is_cleaned_not_trusted() -> None:
    line = result_line(
        commentUrl="javascript:alert(1)",
        errorCode=None,
        durationMs="a long time",
        usage={"model": 3},
        logTruncated="yes",
    )

    result = reported(outcome(stdout=line))

    assert result["commentUrl"] is None
    assert result["durationMs"] == 0
    assert result["usage"] is None
    assert result["logTruncated"] is False


def test_a_failed_result_without_a_usable_code_gets_the_code_unknown() -> None:
    result = reported(
        outcome(exit_code=1, stdout=result_line(ok=False, errorCode="Not A Code", commentUrl=None))
    )

    assert (result["ok"], result["errorCode"]) == (False, "unknown")


def test_a_result_and_an_exit_code_that_disagree_are_a_runner_error() -> None:
    result = reported(outcome(exit_code=1, stdout=result_line(ok=True)))

    assert (result["ok"], result["errorCode"]) == (False, "runner_error")


def test_a_process_ended_by_a_signal_is_a_runner_error_that_names_the_signal() -> None:
    result = reported(outcome(exit_code=-9, stdout=b"", stderr=b"Killed\n"))

    assert result["errorCode"] == "runner_error"
    assert "signal 9" in result["errorMessage"]


def test_a_process_without_any_output_is_a_runner_error() -> None:
    result = reported(outcome(exit_code=0, stdout=b"\n\n"))

    assert (result["ok"], result["errorCode"]) == (False, "runner_error")


def test_the_log_tail_is_redacted_cleaned_and_cut_to_the_limit() -> None:
    noisy = f"\x1b[31mred\x1b[0m\x00 {TOKEN} {API_KEY} " + "z" * 10_000
    result = reported(outcome(stdout=result_line(logTail=noisy)))

    assert len(result["logTail"]) == MAX_LOG_TAIL_CHARS
    assert "\x1b" not in result["logTail"] and "\x00" not in result["logTail"]
    short = reported(outcome(stdout=result_line(logTail=noisy[:200])))
    assert TOKEN not in short["logTail"] and API_KEY not in short["logTail"]
    assert "[REDACTED]" in short["logTail"]


def test_a_comment_url_that_holds_a_secret_is_dropped() -> None:
    line = result_line(commentUrl=f"https://github.com/x?token={TOKEN}")

    assert reported(outcome(stdout=line))["commentUrl"] is None


def test_a_failure_made_by_the_loop_carries_a_code_a_message_and_a_redacted_tail() -> None:
    result = failure_result(
        "timeout", f"too slow {TOKEN}", duration_ms=5, log_tail=f"x {API_KEY}", redactor=REDACTOR
    )

    assert result["errorCode"] == "timeout"
    assert TOKEN not in json.dumps(result) and API_KEY not in json.dumps(result)


def test_a_result_is_shrunk_before_sending_to_stay_under_the_request_limit() -> None:
    big = failure_result("runner_error", "x", duration_ms=1, log_tail="é" * 4096)
    big["logTail"] = "é" * 40_000

    fitted = fit_request(big)

    assert len(json.dumps(fitted, ensure_ascii=False).encode()) <= MAX_REQUEST_BYTES
    assert fitted["logTruncated"] is True
    assert (fitted["ok"], fitted["errorCode"]) == (False, "runner_error")


def test_the_bare_verdict_keeps_ok_and_code_and_drops_the_log() -> None:
    bare = minimal(reported(outcome()))

    assert bare["ok"] is True
    assert bare["logTail"] == ""


def _checkout_failure(**overrides: Any) -> bytes:
    fields: dict[str, Any] = {
        "ok": False,
        "errorCode": "checkout_incomplete",
        "errorReason": "budget_preparation",
        "commentUrl": None,
        "logTail": "checkout_incomplete [budget_preparation]: the pull request was not prepared",
    }
    fields.update(overrides)
    return result_line(**fields)


# #296-T10
def test_the_stable_reason_of_a_failure_is_passed_on() -> None:
    result = reported(outcome(exit_code=1, stdout=_checkout_failure()))

    assert result["errorCode"] == "checkout_incomplete"
    assert result["errorReason"] == "budget_preparation"


# #296-T10
@pytest.mark.parametrize("reason", ["Budget Prep", "x" * 65, 5, "", "has space", "../etc", None])
def test_a_reason_that_is_not_a_stable_name_is_dropped(reason: Any) -> None:
    result = reported(outcome(exit_code=1, stdout=_checkout_failure(errorReason=reason)))

    assert "errorReason" not in result


# #296-T10
def test_a_good_run_never_carries_a_reason() -> None:
    result = reported(outcome(stdout=result_line(errorReason="budget_preparation")))

    assert "errorReason" not in result


# #296-T10
def test_the_bare_verdict_keeps_the_reason_and_says_it_in_one_line() -> None:
    bare = minimal(reported(outcome(exit_code=1, stdout=_checkout_failure())))

    assert bare["errorReason"] == "budget_preparation"
    assert bare["logTail"] == "checkout_incomplete [budget_preparation]"


# #296-T10
def test_a_shrunk_result_keeps_the_reason() -> None:
    big = reported(outcome(exit_code=1, stdout=_checkout_failure()))
    big["logTail"] = "é" * 40_000

    assert fit_request(big)["errorReason"] == "budget_preparation"


# #267-T07
def test_the_exact_cost_of_a_dynamic_run_reaches_the_reported_result_unchanged() -> None:
    ledger = BudgetLedger(DynamicLimits(), unit_costs=UNIT_COSTS)
    for cost in ("0.000123", "0.000456"):
        reservation = ledger.reserve_call("a request", output_tokens=1)
        ledger.settle_call(reservation, prompt_tokens=9, completion_tokens=1, cost=Decimal(cost))
    usage = ledger.usage("vendor/model").to_json()

    result = reported(outcome(stdout=result_line(usage=usage)))

    assert result["usage"] is not None
    assert result["usage"]["costUsd"] == 0.000579
    assert result["usage"]["aiCalls"] == 2


# #267-T07
def test_an_unknown_cost_of_a_dynamic_run_stays_unknown_in_the_reported_result() -> None:
    ledger = BudgetLedger(DynamicLimits(), unit_costs=UNIT_COSTS)
    reservation = ledger.reserve_call("a request", output_tokens=1)
    # A call without a cost stops the run (#290), and the result still reports its tokens.
    with pytest.raises(LimitError):
        ledger.settle_call(reservation, prompt_tokens=9, completion_tokens=1)

    result = reported(outcome(stdout=result_line(usage=ledger.usage("vendor/model").to_json())))

    assert result["usage"] is not None
    assert result["usage"]["costUsd"] is None


def _failed_with_usage(cost: float | None = 0.0035) -> bytes:
    usage = {
        "model": "vendor/model",
        "promptTokens": 300,
        "completionTokens": 30,
        "totalTokens": 330,
        "aiCalls": 3,
        "fallbackUsed": False,
        "costUsd": cost,
    }
    return result_line(ok=False, errorCode="dynamic_budget_exceeded", usage=usage)


# #273-T01
def test_the_usage_of_a_failed_result_is_passed_on_with_its_cost_or_its_unknown_cost() -> None:
    known = reported(outcome(exit_code=1, stdout=_failed_with_usage()))
    unknown = reported(outcome(exit_code=1, stdout=_failed_with_usage(cost=None)))

    assert known["ok"] is False
    assert known["usage"]["costUsd"] == 0.0035
    assert known["usage"]["aiCalls"] == 3
    assert unknown["usage"]["costUsd"] is None
    assert unknown["usage"]["totalTokens"] == 330


# #273-T01: the bare verdict is sent when the app refuses the whole result; what the run cost is
# part of the verdict of a failure, and is small.
def test_the_bare_verdict_of_a_failure_keeps_its_usage() -> None:
    bare = minimal(reported(outcome(exit_code=1, stdout=_failed_with_usage())))

    assert bare["ok"] is False
    assert bare["logTail"] == "dynamic_budget_exceeded"
    assert bare["usage"]["costUsd"] == 0.0035
    assert bare["usage"]["aiCalls"] == 3


# #273-T08
def test_the_bare_verdict_of_a_success_still_carries_no_usage() -> None:
    usage = {
        "model": "vendor/model",
        "promptTokens": 9,
        "completionTokens": 1,
        "totalTokens": 10,
        "aiCalls": 1,
        "fallbackUsed": False,
        "costUsd": 0.01,
    }

    bare = minimal(reported(outcome(stdout=result_line(usage=usage))))

    assert bare["usage"] is None


# #273-T01
def test_a_shrunk_failure_keeps_its_usage() -> None:
    big = reported(outcome(exit_code=1, stdout=_failed_with_usage()))
    big["logTail"] = "é" * 40_000

    shrunk = fit_request(big)

    assert shrunk["usage"]["costUsd"] == 0.0035


# #273-T06: the loop's own failures for a job process that held the job and left no result say so,
# with one stable reason, so the app can count the run with an unknown cost instead of voiding it.
@pytest.mark.parametrize(
    "process",
    [
        outcome(exit_code=-9, stdout=b"", stderr=b"Killed\n"),
        outcome(exit_code=0, stdout=b"\n\n"),
        outcome(exit_code=1, stdout=b"not json at all\n"),
        outcome(exit_code=1, stdout=result_line(ok=True)),
    ],
    ids=["killed by a signal", "no output", "no result line", "result and exit code disagree"],
)
def test_a_process_that_leaves_no_usable_result_is_reported_with_the_no_result_reason(
    process: ProcessOutcome,
) -> None:
    result = reported(process)

    assert result["ok"] is False
    assert result["usage"] is None
    assert result["errorReason"] == "no_result_from_process"
    assert minimal(result)["errorReason"] == "no_result_from_process"


# #273-T06
def test_a_result_the_process_did_print_never_gets_the_no_result_reason() -> None:
    failed = reported(outcome(exit_code=1, stdout=result_line(ok=False, errorCode="timeout")))

    assert "errorReason" not in failed


# #273-T06: a failed result that sent a usage the loop cannot read still says a usage was sent.
def test_a_failed_result_with_an_unreadable_usage_gets_the_unreadable_usage_reason() -> None:
    damaged = {"model": "vendor/model", "promptTokens": "many", "aiCalls": 3}

    failed = reported(
        outcome(exit_code=1, stdout=result_line(ok=False, errorCode="timeout", usage=damaged))
    )

    assert failed["usage"] is None
    assert failed["errorReason"] == "unreadable_usage"


# #273-T06: the reason a job process gave stays its own.
def test_a_reason_the_process_gave_is_not_replaced_by_the_unreadable_usage_reason() -> None:
    line = result_line(
        ok=False,
        errorCode="checkout_incomplete",
        errorReason="budget_preparation",
        usage={"promptTokens": "many"},
    )

    assert reported(outcome(exit_code=1, stdout=line))["errorReason"] == "budget_preparation"


# #273-T08
def test_a_successful_result_with_an_unreadable_usage_gets_no_reason() -> None:
    assert "errorReason" not in reported(
        outcome(stdout=result_line(usage={"promptTokens": "many"}))
    )


_SEVERITIES = {"P0": 0, "P1": 0, "P2": 0, "P3": 3}


# #517-T01: the findings a review left open are what the app decides the verdict from; the job loop
# must hand on what the runner printed, for a Dynamic review, a Diff review and an incomplete one.
@pytest.mark.parametrize(
    "findings",
    [
        {"open": 3, "bySeverity": _SEVERITIES},
        {"open": 2, "bySeverity": None},
        {"open": 0, "bySeverity": {"P0": 0, "P1": 0, "P2": 0, "P3": 0}},
        {"open": 1, "bySeverity": None, "incomplete": True},
    ],
)
def test_the_findings_of_a_successful_review_are_passed_on_unchanged(
    findings: dict[str, Any],
) -> None:
    result = reported(outcome(stdout=result_line(findings=findings)))

    assert result["findings"] == findings


# #517-T01: the line the job process prints is built by `JobResult`, not by the test.
def test_the_findings_a_job_result_prints_reach_the_reported_result() -> None:
    printed = JobResult(
        ok=True,
        duration_ms=1200,
        comment_url="https://github.com/octo/repo/pull/7#c1",
        error_code=None,
        log_tail="review published",
        findings=ReviewFindings(open=3, by_severity=_SEVERITIES),
    ).to_json()

    result = reported(outcome(stdout=(json.dumps(printed) + "\n").encode()))

    assert result["findings"] == {"open": 3, "bySeverity": _SEVERITIES}


# #517-T01: a result that says nothing about findings says nothing to the app either.
def test_a_result_without_findings_reports_none() -> None:
    assert "findings" not in reported(outcome())
    assert "findings" not in reported(outcome(stdout=result_line(findings=None)))


# #517-T02
@pytest.mark.parametrize(
    "findings",
    [
        "3",
        [3],
        {"open": "3", "bySeverity": None},
        {"open": True, "bySeverity": None},
        {"open": -1, "bySeverity": None},
        {"open": 1.5, "bySeverity": None},
        {"open": 100_001, "bySeverity": None},
        {"bySeverity": None},
        {"open": 1},
        {"open": 1, "bySeverity": {"P0": 1}},
        {"open": 1, "bySeverity": {"P0": 1, "P1": 0, "P2": 0, "P3": 0, "P4": 0}},
        {"open": 1, "bySeverity": {"P0": -1, "P1": 0, "P2": 0, "P3": 0}},
        {"open": 1, "bySeverity": {"P0": "1", "P1": 0, "P2": 0, "P3": 0}},
        {"open": 1, "bySeverity": None, "incomplete": "yes"},
        {"open": 1, "bySeverity": None, "verdict": "approve"},
    ],
)
def test_findings_that_do_not_have_the_contract_shape_are_left_out(findings: Any) -> None:
    result = reported(outcome(stdout=result_line(findings=findings)))

    assert "findings" not in result
    assert result["ok"] is True
    assert result["commentUrl"] == "https://github.com/octo/repo/pull/7#c1"


# #517-T03: only a review that succeeded says which findings are open.
def test_a_failed_result_never_carries_findings() -> None:
    result = reported(
        outcome(
            exit_code=1,
            stdout=result_line(
                ok=False,
                errorCode="timeout",
                commentUrl=None,
                findings={"open": 1, "bySeverity": None},
            ),
        )
    )

    assert result["ok"] is False
    assert "findings" not in result


# #517-T04: neither a shrunk log nor the bare verdict loses what the verdict depends on.
def test_a_shrunk_result_and_the_bare_verdict_keep_the_findings() -> None:
    findings = {"open": 3, "bySeverity": _SEVERITIES}
    big = reported(outcome(stdout=result_line(findings=findings)))
    big["logTail"] = "é" * 40_000

    assert fit_request(big)["findings"] == findings
    assert minimal(big)["findings"] == findings
    assert minimal(big, keep_usage=False)["findings"] == findings


# #517-T04: a failure has none to keep.
def test_the_bare_verdict_of_a_result_without_findings_has_none() -> None:
    assert "findings" not in minimal(reported(outcome()))


def _usage(**overrides: Any) -> dict[str, Any]:
    usage: dict[str, Any] = {
        "model": "vendor/model",
        "promptTokens": 9,
        "completionTokens": 1,
        "totalTokens": 10,
        "aiCalls": 2,
        "fallbackUsed": False,
        "costUsd": 0.0035,
    }
    usage.update(overrides)
    return usage


# #517-B1: the app never approves a review that was wrapped up at its limit, but only when the
# reported usage says so; a usage that loses `stoppedEarly` turns that guard off.
@pytest.mark.parametrize("reason", ["cost_limit", "time_limit"])
def test_the_stopped_early_reason_of_a_run_reaches_the_reported_usage(reason: str) -> None:
    printed = JobResult(
        ok=True,
        duration_ms=1200,
        comment_url="https://github.com/octo/repo/pull/7#c1",
        error_code=None,
        log_tail="review published",
        usage=Usage("vendor/model", 9, 1, 10, 2, False, 0.0035, stopped_early=reason),
        findings=ReviewFindings(open=0, by_severity={"P0": 0, "P1": 0, "P2": 0, "P3": 0}),
    ).to_json()

    result = reported(outcome(stdout=(json.dumps(printed) + "\n").encode()))

    assert result["usage"]["stoppedEarly"] == reason


# #540-N4: by how much a run passed its cost limit is a fact of the usage, optional and additive.
def test_the_excess_over_the_cost_limit_reaches_the_reported_usage() -> None:
    printed = JobResult(
        ok=True,
        duration_ms=1200,
        comment_url="https://github.com/octo/repo/pull/7#c1",
        error_code=None,
        log_tail="review published",
        usage=Usage("vendor/model", 9, 1, 10, 2, False, 1.0123, limit_exceeded_by=0.0123),
        findings=ReviewFindings(open=0, by_severity={"P0": 0, "P1": 0, "P2": 0, "P3": 0}),
    ).to_json()

    result = reported(outcome(stdout=(json.dumps(printed) + "\n").encode()))

    assert result["usage"]["limitExceededBy"] == 0.0123


# #540-N4
@pytest.mark.parametrize("usage", [_usage(), _usage(limitExceededBy=None)])
def test_a_run_within_its_limit_reports_no_excess(usage: dict[str, Any]) -> None:
    assert "limitExceededBy" not in reported(outcome(stdout=result_line(usage=usage)))["usage"]


# #540-N4: the fact is dropped when it is malformed, the rest of the usage is still reported (the
# app never approves on it, and the tokens and the cost of the run are not lost).
@pytest.mark.parametrize("value", [-0.5, "0.01", True, [0.01], {}, float("nan"), float("inf")])
def test_a_malformed_excess_is_left_out_and_the_usage_is_kept(value: Any) -> None:
    result = reported(outcome(stdout=result_line(usage=_usage(limitExceededBy=value))))

    assert result["usage"] is not None
    assert "limitExceededBy" not in result["usage"]
    assert result["usage"]["costUsd"] == 0.0035


# #517-B1: a run that was not stopped says nothing, and an explicit null is the same as absent.
@pytest.mark.parametrize("usage", [_usage(), _usage(stoppedEarly=None)])
def test_a_run_that_was_not_stopped_early_reports_no_stopped_early(usage: dict[str, Any]) -> None:
    assert "stoppedEarly" not in reported(outcome(stdout=result_line(usage=usage)))["usage"]


# #517-B1: fail closed. The app refuses a usage whose `stoppedEarly` is not one of the contract's
# reasons, so it is never passed on as it is and never turned into "not stopped": the whole usage
# is left out, and a result with no usage has no model work behind it, so the app never approves it.
@pytest.mark.parametrize("value", ["budget", "", "COST_LIMIT", 1, True, ["cost_limit"], {}])
def test_a_malformed_stopped_early_leaves_the_whole_usage_out(value: Any) -> None:
    result = reported(outcome(stdout=result_line(usage=_usage(stoppedEarly=value))))

    assert result["usage"] is None
    assert result["ok"] is True


# #517-B1: a failed run with such a usage was at the model, like any usage nobody can read.
def test_a_failed_result_with_a_malformed_stopped_early_counts_as_an_unreadable_usage() -> None:
    result = reported(
        outcome(
            exit_code=1,
            stdout=result_line(ok=False, errorCode="timeout", usage=_usage(stoppedEarly="budget")),
        )
    )

    assert result["usage"] is None
    assert result["errorReason"] == "unreadable_usage"


# #517-B1: the bare verdict of a success has no usage, so it never approves either.
def test_the_bare_verdict_of_a_stopped_early_success_has_no_usage_to_approve_from() -> None:
    result = reported(outcome(stdout=result_line(usage=_usage(stoppedEarly="cost_limit"))))

    assert minimal(result)["usage"] is None


_LOGGER = "code_reviewer_runner.loop.reporting"


# #517-L1: a dropped value is logged once with a stable code and never with its content.
@pytest.mark.parametrize(
    ("line", "code"),
    [
        ({"findings": {"open": "SECRET-CONTENT", "bySeverity": None}}, "RESULT_FINDINGS_INVALID"),
        ({"findings": "SECRET-CONTENT"}, "RESULT_FINDINGS_INVALID"),
        ({"usage": _usage(stoppedEarly="SECRET-CONTENT")}, "RESULT_STOPPED_EARLY_INVALID"),
    ],
)
def test_a_dropped_malformed_value_is_logged_once_by_code_without_its_content(
    caplog: pytest.LogCaptureFixture, line: dict[str, Any], code: str
) -> None:
    with caplog.at_level(logging.INFO, logger=_LOGGER):
        reported(outcome(stdout=result_line(**line)))

    records = [record for record in caplog.records if record.name == _LOGGER]
    assert [record.getMessage() for record in records] == [code]


# #517-L1: well-formed, absent and (for findings) intentionally dropped values log nothing.
def test_values_that_are_fine_or_dropped_on_purpose_are_not_logged(
    caplog: pytest.LogCaptureFixture,
) -> None:
    findings = {"open": 1, "bySeverity": None}
    with caplog.at_level(logging.INFO, logger=_LOGGER):
        reported(
            outcome(stdout=result_line(findings=findings, usage=_usage(stoppedEarly="cost_limit")))
        )
        reported(outcome(stdout=result_line()))
        reported(
            outcome(
                exit_code=1, stdout=result_line(ok=False, errorCode="timeout", findings=findings)
            )
        )

    assert [record for record in caplog.records if record.name == _LOGGER] == []


def _paths(document: Any, prefix: str = "") -> dict[str, Any]:
    """Every leaf of a JSON document by its dotted path (a count per severity is a leaf)."""
    if not isinstance(document, dict):
        return {prefix: document}
    leaves: dict[str, Any] = {}
    members: dict[str, Any] = document  # type: ignore[assignment]  # a JSON object has str keys
    for key, value in members.items():
        leaves.update(_paths(value, f"{prefix}.{key}" if prefix else key))
    return leaves


# What the job loop leaves out of what `JobResult.to_json` prints, with the reason. A field that is
# not here must reach the app: adding one to `JobResult` fails the parity tests below until it is
# either passed on by `_sanitize` or listed here with the reason it is not.
INTENTIONAL_DROPS: dict[str, str] = {
    "errorReason": "a success never has a finer failure name; the loop names failures itself",
}


def _populated(ok: bool) -> JobResult:
    result = JobResult(
        ok=ok,
        duration_ms=1200,
        comment_url="https://github.com/octo/repo/pull/7#c1" if ok else None,
        error_code=None if ok else ErrorCode.TIMEOUT,
        log_tail="review published",
        log_truncated=True,
        usage=Usage(
            "vendor/model",
            9,
            1,
            10,
            2,
            True,
            0.0035,
            stopped_early="cost_limit",
            limit_exceeded_by=0.0123,
        ),
        error_reason="no_result_from_process",
        findings=ReviewFindings(
            open=3, by_severity={"P0": 0, "P1": 1, "P2": 1, "P3": 1}, incomplete=True
        )
        if ok
        else None,
    )
    # The fixture must set every field, or the parity would not cover a field added later. What a
    # success has no value for (an error code) and a failure has none for (a link, findings) is the
    # one exception (and `ok`, which is False for a failure).
    unset = {"error_code"} if ok else {"ok", "comment_url", "findings"}
    parts: list[Any] = [result, result.usage, result.findings or result]
    for part in parts:
        for field in dataclasses.fields(part):
            if field.name not in unset:
                assert getattr(part, field.name) not in (None, False, ""), field.name
    return result


# #517-B1: the parity of the printed result and the reported one, for a success.
def test_every_field_a_successful_job_result_prints_reaches_the_reported_result() -> None:
    printed = _populated(ok=True).to_json()

    result = reported(outcome(stdout=(json.dumps(printed) + "\n").encode()))

    expected = {
        path: value for path, value in _paths(printed).items() if path not in INTENTIONAL_DROPS
    }
    assert {path: _paths(result).get(path, "MISSING") for path in expected} == expected
    assert sorted(set(_paths(printed)) - set(_paths(result))) == sorted(INTENTIONAL_DROPS)


# #517-B1: the same for a failure, which keeps its usage and its finer name.
def test_every_field_a_failed_job_result_prints_reaches_the_reported_result() -> None:
    printed = _populated(ok=False).to_json()

    result = reported(outcome(exit_code=1, stdout=(json.dumps(printed) + "\n").encode()))

    assert {path: _paths(result).get(path, "MISSING") for path in _paths(printed)} == _paths(
        printed
    )


# The allow-list is not a place to forget things in: each entry is a field that is really printed.
def test_every_intentional_drop_is_a_field_a_job_result_can_print() -> None:
    printed = _paths(_populated(ok=True).to_json())

    assert set(INTENTIONAL_DROPS) <= set(printed)
    assert all(INTENTIONAL_DROPS.values())
