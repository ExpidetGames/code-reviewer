# SPDX-License-Identifier: Apache-2.0

"""Pins down how the output of a job process becomes the result sent to the app."""

import json
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
