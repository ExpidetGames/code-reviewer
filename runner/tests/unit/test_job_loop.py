# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down the rules of the job host with a clock, an API and a process that the test controls:
heartbeats, outcomes, back-off, shutdown and what is reported when. Real processes and a real HTTP
server are in tests/integration."""

import json
import logging
from typing import Any

from loop_support import (
    RUNNER_TOKEN,
    FakeProcess,
    Harness,
    make_claim,
    outcome,
    result_line,
    run,
    settle,
)
from support import API_KEY, TOKEN

from code_reviewer_runner.job_loop.api import (
    ApiRejected,
    ApiUnavailable,
    CompleteReply,
    LeaseLost,
)
from code_reviewer_runner.pr_agent_config import PASSTHROUGH_VARIABLES


def only(items: list[FakeProcess]) -> FakeProcess:
    assert len(items) == 1
    return items[0]


# CR-29-T01
def test_a_free_slot_and_a_waiting_job_start_exactly_one_process_with_the_input_of_that_job() -> (
    None
):
    async def scenario() -> None:
        harness = Harness()
        claim = make_claim(1)
        harness.api.claims = [claim]
        await harness.start()

        process = only(harness.launcher.processes)
        assert process.spec.argv == ("fake-job-process",)
        assert json.loads(process.spec.stdin) == claim.input
        assert harness.api.completions == []

        process.finish()
        await settle()

        assert [(job, lease) for job, lease, _ in harness.api.completions] == [
            (claim.id, claim.lease_token)
        ]
        await harness.stop()

    run(scenario)


# CR-29-T02
def test_a_heartbeat_goes_out_every_thirty_seconds_while_the_process_runs_and_none_after_it() -> (
    None
):
    async def scenario() -> None:
        harness = Harness()
        claim = make_claim(1)
        harness.api.claims = [claim]
        await harness.start()
        process = only(harness.launcher.processes)

        await harness.clock.advance(29)
        assert harness.api.heartbeats == []
        await harness.clock.advance(1)
        assert len(harness.api.heartbeats) == 1
        await harness.clock.advance(60)
        assert harness.api.heartbeats == [(claim.id, claim.lease_token)] * 3

        process.finish()
        await settle()
        await harness.clock.advance(300)

        assert len(harness.api.heartbeats) == 3
        await harness.stop()

    run(scenario)


# CR-29-T03
def test_a_process_that_exits_with_zero_is_reported_as_a_success_with_its_result() -> None:
    async def scenario() -> None:
        harness = Harness()
        harness.api.claims = [make_claim(1)]
        await harness.start()
        only(harness.launcher.processes).finish(
            outcome(
                stdout=result_line(
                    durationMs=4321,
                    usage={
                        "model": "vendor/model",
                        "promptTokens": 10,
                        "completionTokens": 5,
                        "totalTokens": 15,
                        "aiCalls": 1,
                        "fallbackUsed": False,
                        "costUsd": 0.01,
                    },
                )
            )
        )
        await settle()

        (_, _, result) = harness.api.completions[0]
        assert result["ok"] is True
        assert result["errorCode"] is None
        assert result["commentUrl"] == "https://github.com/octo/repo/pull/7#c1"
        assert result["durationMs"] == 4321
        assert result["usage"]["totalTokens"] == 15
        await harness.stop()

    run(scenario)


# CR-29-T04
def test_a_process_that_fails_without_a_result_is_reported_with_a_code_and_the_end_of_stderr() -> (
    None
):
    async def scenario() -> None:
        harness = Harness()
        harness.api.claims = [make_claim(1)]
        await harness.start()
        stderr = ("line %d\n" * 1).encode() * 1 + b"".join(
            f"error line {number:05d} {'x' * 90}\n".encode() for number in range(300)
        )
        only(harness.launcher.processes).finish(outcome(exit_code=3, stdout=b"", stderr=stderr))
        await settle()

        (_, _, result) = harness.api.completions[0]
        assert result["ok"] is False
        assert result["errorCode"] == "runner_error"
        assert len(result["logTail"]) <= 4096
        assert result["logTail"].rstrip().endswith("x" * 90)
        assert "error line 00299" in result["logTail"]
        assert "error line 00000" not in result["logTail"]
        await harness.stop()

    run(scenario)


def test_a_process_that_reports_a_failure_keeps_its_own_error_code() -> None:
    async def scenario() -> None:
        harness = Harness()
        harness.api.claims = [make_claim(1)]
        await harness.start()
        only(harness.launcher.processes).finish(
            outcome(
                exit_code=1,
                stdout=result_line(ok=False, errorCode="llm_auth", commentUrl=None, logTail="no"),
            )
        )
        await settle()

        (_, _, result) = harness.api.completions[0]
        assert (result["ok"], result["errorCode"]) == (False, "llm_auth")
        await harness.stop()

    run(scenario)


def test_a_shutdown_report_that_the_app_answers_with_conflict_is_not_an_error() -> None:
    async def scenario() -> None:
        harness = Harness()
        harness.api.claims = [make_claim(1)]
        harness.api.complete_errors = [LeaseLost("conflict", 409)]
        await harness.start()

        harness.loop.request_force()
        await settle()

        assert harness.task is not None and harness.task.done()
        assert harness.task.exception() is None
        assert len(harness.api.completions) == 1  # once, not retried

    run(scenario)


def test_a_complete_answer_saying_the_job_was_queued_again_is_accepted() -> None:
    async def scenario() -> None:
        harness = Harness()
        harness.api.claims = [make_claim(1)]
        harness.api.complete_reply = CompleteReply("queued", False)
        await harness.start()

        harness.loop.request_force()
        await settle()

        assert harness.task is not None and harness.task.done()
        assert harness.task.exception() is None
        assert len(harness.api.completions) == 1

    run(scenario)


# CR-29-T10
def test_a_lost_lease_ends_the_process_and_nothing_is_reported() -> None:
    async def scenario() -> None:
        harness = Harness()
        harness.api.claims = [make_claim(1)]
        harness.api.heartbeat_errors = [LeaseLost("not held", 409)]
        await harness.start()
        process = only(harness.launcher.processes)

        await harness.clock.advance(30)

        assert process.terminated
        await harness.clock.advance(300)
        assert harness.api.completions == []
        assert len(harness.api.heartbeats) == 1
        await harness.stop()

    run(scenario)


def test_a_failed_heartbeat_is_tried_again_at_the_next_beat_and_does_not_end_the_process() -> None:
    async def scenario() -> None:
        harness = Harness()
        harness.api.claims = [make_claim(1)]
        harness.api.heartbeat_errors = [ApiUnavailable("down", 503)]
        await harness.start()
        process = only(harness.launcher.processes)

        await harness.clock.advance(65)

        assert len(harness.api.heartbeats) == 2
        assert not process.terminated
        await harness.stop()

    run(scenario)


# CR-29-T12
def test_a_result_that_could_not_be_sent_is_sent_again_until_the_app_takes_it() -> None:
    async def scenario() -> None:
        harness = Harness()
        harness.api.claims = [make_claim(1)]
        harness.api.complete_errors = [ApiUnavailable("down"), ApiUnavailable("down")]
        await harness.start()
        only(harness.launcher.processes).finish()
        await settle()
        assert len(harness.api.completions) == 1

        await harness.clock.advance(1)
        assert len(harness.api.completions) == 2
        await harness.clock.advance(2)
        assert len(harness.api.completions) == 3

        first, second, third = (entry[2] for entry in harness.api.completions)
        assert first == second == third
        await harness.clock.advance(100)
        assert len(harness.api.completions) == 3
        await harness.stop()

    run(scenario)


def test_resending_stops_when_the_app_says_the_lease_is_gone() -> None:
    async def scenario() -> None:
        harness = Harness()
        harness.api.claims = [make_claim(1)]
        harness.api.complete_errors = [ApiUnavailable("down"), LeaseLost("gone", 409)]
        await harness.start()
        only(harness.launcher.processes).finish()
        await settle()
        await harness.clock.advance(1)
        await harness.clock.advance(100)

        assert len(harness.api.completions) == 2
        await harness.stop()

    run(scenario)


def test_resending_gives_up_after_the_retry_window() -> None:
    async def scenario() -> None:
        harness = Harness(complete_retry_window=30.0, backoff_max=8.0)
        harness.api.claims = [make_claim(1)]
        harness.api.complete_errors = [ApiUnavailable("down") for _ in range(100)]
        await harness.start()
        only(harness.launcher.processes).finish()
        await settle()
        await harness.clock.advance(200)
        sent = len(harness.api.completions)
        await harness.clock.advance(200)

        assert 3 <= sent <= 10
        assert len(harness.api.completions) == sent
        await harness.stop()

    run(scenario)


def test_a_result_the_app_finds_too_large_is_sent_again_as_a_bare_verdict() -> None:
    async def scenario() -> None:
        harness = Harness()
        harness.api.claims = [make_claim(1)]
        harness.api.complete_errors = [ApiRejected("too large", 413, "RUNNER_BODY_TOO_LARGE")]
        await harness.start()
        only(harness.launcher.processes).finish()
        await settle()

        assert len(harness.api.completions) == 2
        assert harness.api.completions[1][2]["logTail"] == ""
        assert harness.api.completions[1][2]["ok"] is True
        await harness.stop()

    run(scenario)


# #273-T01: the usage is what the app may refuse; the verdict is never lost because of it.
def test_a_verdict_that_is_refused_with_its_usage_is_sent_once_more_without_it() -> None:
    async def scenario() -> None:
        harness = Harness()
        harness.api.claims = [make_claim(1)]
        harness.api.complete_errors = [
            ApiRejected("bad", 400, "RUNNER_REQUEST_INVALID"),
            ApiRejected("bad", 400, "RUNNER_REQUEST_INVALID"),
        ]
        await harness.start()
        usage = {
            "model": "vendor/model",
            "promptTokens": 300,
            "completionTokens": 30,
            "totalTokens": 330,
            "aiCalls": 3,
            "fallbackUsed": False,
            "costUsd": 0.0035,
        }
        only(harness.launcher.processes).finish(
            outcome(
                exit_code=1,
                stdout=result_line(
                    ok=False, errorCode="timeout", commentUrl=None, usage=usage, logTail="long"
                ),
            )
        )
        await settle()

        assert len(harness.api.completions) == 3
        assert harness.api.completions[0][2]["usage"]["aiCalls"] == 3
        assert harness.api.completions[1][2]["usage"]["aiCalls"] == 3
        last = harness.api.completions[2][2]
        assert last["usage"] is None
        assert (last["ok"], last["errorCode"]) == (False, "timeout")
        await harness.stop()

    run(scenario)


# #296-T10
def test_the_reason_reaches_the_app_even_when_the_full_result_is_refused() -> None:
    async def scenario() -> None:
        harness = Harness()
        harness.api.claims = [make_claim(1)]
        harness.api.complete_errors = [ApiRejected("bad", 400, "RUNNER_BAD_REQUEST")]
        await harness.start()
        only(harness.launcher.processes).finish(
            outcome(
                exit_code=1,
                stdout=result_line(
                    ok=False,
                    errorCode="checkout_incomplete",
                    errorReason="budget_preparation",
                    commentUrl=None,
                    logTail="a long log",
                ),
            )
        )
        await settle()

        assert len(harness.api.completions) == 2
        bare = harness.api.completions[1][2]
        assert bare["errorCode"] == "checkout_incomplete"
        assert bare["errorReason"] == "budget_preparation"
        assert bare["logTail"] == "checkout_incomplete [budget_preparation]"
        await harness.stop()

    run(scenario)


# #296-T09
def test_the_finished_line_of_a_failed_job_names_the_reason(caplog: Any) -> None:
    async def scenario() -> None:
        harness = Harness()
        harness.api.claims = [make_claim(1)]
        await harness.start()
        only(harness.launcher.processes).finish(
            outcome(
                exit_code=1,
                stdout=result_line(
                    ok=False,
                    errorCode="checkout_incomplete",
                    errorReason="budget_preparation",
                    commentUrl=None,
                ),
            )
        )
        await settle()
        assert "finished: checkout_incomplete [budget_preparation] (exit code 1)" in caplog.text
        await harness.stop()

    caplog.set_level(logging.INFO, logger="code_reviewer_runner.loop")
    run(scenario)


# CR-29-T17
def test_a_job_with_a_command_that_is_not_allowed_starts_no_process_and_fails_with_a_code() -> None:
    async def scenario() -> None:
        harness = Harness()
        harness.api.claims = [make_claim(1, command="merge")]
        await harness.start()

        assert harness.launcher.processes == []
        (_, _, result) = harness.api.completions[0]
        assert (result["ok"], result["errorCode"]) == (False, "invalid_command")
        await harness.stop()

    run(scenario)


# CR-29-T20
def test_a_job_from_an_unknown_platform_starts_no_process_and_fails_with_a_code() -> None:
    async def scenario() -> None:
        harness = Harness()
        claim = make_claim(1)
        claim.input["git"]["provider"] = "gitlab"
        harness.api.claims = [claim]
        await harness.start()

        assert harness.launcher.processes == []
        (_, _, result) = harness.api.completions[0]
        assert (result["ok"], result["errorCode"]) == (False, "invalid_job")
        assert "gitlab" not in json.dumps(result)
        await harness.stop()

    run(scenario)


def test_a_process_that_cannot_be_started_is_reported_as_a_runner_error() -> None:
    async def scenario() -> None:
        harness = Harness()
        harness.launcher.fail_with = FileNotFoundError("no such program")
        harness.api.claims = [make_claim(1)]
        await harness.start()

        (_, _, result) = harness.api.completions[0]
        assert (result["ok"], result["errorCode"]) == (False, "runner_error")
        # The process never started: no model was reached, so this is no "no result" of a run.
        assert "errorReason" not in result
        await harness.stop()

    run(scenario)


def test_the_hard_timeout_ends_a_process_that_does_not_stop_and_reports_a_timeout() -> None:
    async def scenario() -> None:
        harness = Harness(job_timeout=100.0, kill_margin=10.0)
        harness.api.claims = [make_claim(1)]
        await harness.start()
        process = only(harness.launcher.processes)
        assert process.spec.env["RUNNER_JOB_TIMEOUT_SECONDS"] == "100"

        await harness.clock.advance(109)
        assert not process.terminated
        await harness.clock.advance(2)

        assert process.terminated
        (_, _, result) = harness.api.completions[0]
        assert (result["ok"], result["errorCode"]) == (False, "timeout")
        # #273-T06: the loop ended a job process that held the job; the model may have been used.
        assert result["errorReason"] == "no_result_from_process"
        await harness.stop()

    run(scenario)


# CR-29-T13
def test_a_process_gets_only_plain_runtime_variables_and_never_the_runner_token() -> None:
    async def scenario() -> None:
        harness = Harness()
        harness.api.claims = [make_claim(1)]
        await harness.start()

        process = only(harness.launcher.processes)
        names = set(process.spec.env)
        assert names <= {*PASSTHROUGH_VARIABLES, "RUNNER_JOB_TIMEOUT_SECONDS"}
        blob = json.dumps(dict(process.spec.env))
        for secret in (RUNNER_TOKEN, TOKEN, API_KEY):
            assert secret not in blob
        await harness.stop()

    run(scenario)


# CR-29-T14
def test_secrets_of_a_job_are_masked_in_the_result_and_in_the_runner_log(
    caplog: Any,
) -> None:
    async def scenario() -> None:
        harness = Harness()
        claim = make_claim(1)
        harness.api.claims = [claim]
        await harness.start()
        leak = f"token {TOKEN} key {API_KEY} lease {claim.lease_token} runner {RUNNER_TOKEN}"
        only(harness.launcher.processes).finish(
            outcome(
                exit_code=1,
                stdout=result_line(
                    ok=False, errorCode="command_failed", commentUrl=None, logTail=leak
                ),
                stderr=leak.encode(),
            )
        )
        await settle()
        refused = make_claim(2, command="merge")  # a refusal is logged too
        harness.api.claims = [refused]
        await harness.clock.advance(5)

        body = json.dumps(harness.api.completions)
        for secret in (TOKEN, API_KEY, RUNNER_TOKEN):
            assert secret not in body
            assert secret not in caplog.text
        # The lease token is in the request that carries it, but not in what the result says.
        assert claim.lease_token not in json.dumps([entry[2] for entry in harness.api.completions])
        assert claim.lease_token not in caplog.text
        await harness.stop()

    caplog.set_level(logging.DEBUG, logger="code_reviewer_runner.loop")
    run(scenario)


# CR-29-T12: the heart keeps beating while the result is retried, so the lease cannot lapse and
# another runner cannot take the same job.
def test_heartbeats_continue_while_the_result_is_retried_until_the_app_takes_it() -> None:
    async def scenario() -> None:
        harness = Harness(complete_retry_window=600.0, backoff_max=60.0)
        claim = make_claim(1)
        harness.api.claims = [claim]
        harness.api.complete_errors = [ApiUnavailable("down") for _ in range(10)]
        await harness.start()
        only(harness.launcher.processes).finish()
        await settle()
        assert harness.api.heartbeats == []

        await harness.clock.advance(300)

        # Longer than the two minute lease, and still beating every 30 seconds.
        assert len(harness.api.heartbeats) == 10
        assert len(harness.api.completions) == 10  # the app has not taken it yet
        await harness.clock.advance(10)
        assert len(harness.api.completions) == 11  # the first answer after the outage
        beats = len(harness.api.heartbeats)
        await harness.clock.advance(300)
        assert len(harness.api.heartbeats) == beats  # nothing more once the result is in
        await harness.stop()

    run(scenario)


def test_a_lease_lost_while_the_result_is_retried_stops_the_retries() -> None:
    async def scenario() -> None:
        harness = Harness()
        harness.api.claims = [make_claim(1)]
        harness.api.complete_errors = [ApiUnavailable("down") for _ in range(100)]
        harness.api.heartbeat_errors = [LeaseLost("gone", 409)]
        await harness.start()
        only(harness.launcher.processes).finish()
        await settle()

        await harness.clock.advance(400)
        sent = len(harness.api.completions)
        await harness.clock.advance(400)

        assert sent <= 8
        assert len(harness.api.completions) == sent
        await harness.stop()

    run(scenario)


def test_a_long_retry_after_is_bounded_by_the_retry_window() -> None:
    async def scenario() -> None:
        harness = Harness(complete_retry_window=100.0)
        harness.api.claims = [make_claim(1)]
        harness.api.complete_errors = [ApiUnavailable("busy", 503, retry_after=900.0)]
        await harness.start()
        only(harness.launcher.processes).finish()
        await settle()

        await harness.clock.advance(100)

        assert len(harness.api.completions) == 2
        await harness.stop()

    run(scenario)


def test_a_stop_signal_ends_the_wait_between_two_attempts_to_send_a_result() -> None:
    async def scenario() -> None:
        harness = Harness()
        harness.api.claims = [make_claim(1)]
        harness.api.complete_errors = [ApiUnavailable("busy", 503, retry_after=900.0)]
        await harness.start()
        only(harness.launcher.processes).finish()
        await settle()
        assert harness.task is not None and not harness.task.done()

        harness.loop.request_force()
        await settle()

        assert harness.task.done()
        assert len(harness.api.completions) == 1

    run(scenario)


# CR-29: an unexpected error in the heartbeat does not stop the beating.
def test_a_heartbeat_that_fails_in_an_unexpected_way_does_not_stop_the_beating(
    caplog: Any,
) -> None:
    async def scenario() -> None:
        harness = Harness()
        harness.api.claims = [make_claim(1)]
        harness.api.heartbeat_errors = [RuntimeError(f"boom {TOKEN}")]  # type: ignore[list-item]
        await harness.start()
        process = only(harness.launcher.processes)

        await harness.clock.advance(95)

        assert len(harness.api.heartbeats) == 3
        assert not process.terminated
        assert "RuntimeError" in caplog.text
        assert TOKEN not in caplog.text
        await harness.stop()

    caplog.set_level(logging.DEBUG, logger="code_reviewer_runner.loop")
    run(scenario)


# CR-29: a lone surrogate in the output is not a poison value.
def test_a_lone_surrogate_in_the_output_is_reported_normally() -> None:
    async def scenario() -> None:
        harness = Harness()
        harness.api.claims = [make_claim(1)]
        await harness.start()
        process = only(harness.launcher.processes)

        process.finish(outcome(stdout=result_line(logTail="broken \ud800 text")))
        await settle()

        (_, _, result) = harness.api.completions[0]
        assert result["ok"] is True
        result["logTail"].encode("utf-8")  # does not raise
        await harness.stop()

    run(scenario)


def test_any_failure_to_start_the_process_is_reported_as_a_runner_error() -> None:
    async def scenario() -> None:
        harness = Harness()
        harness.launcher.fail_with = RuntimeError("not an OSError")  # type: ignore[assignment]
        harness.api.claims = [make_claim(1)]
        await harness.start()

        (_, _, result) = harness.api.completions[0]
        assert (result["ok"], result["errorCode"]) == (False, "runner_error")
        await harness.stop()

    run(scenario)


# #197-T04
def test_a_root_worker_drops_diff_jobs_to_the_job_user_and_keeps_dynamic_ones_as_supervisor() -> (
    None
):
    from test_dynamic_review_run import dynamic_document

    async def scenario() -> None:
        diff_harness = Harness(diff_job_user=(10001, 10001))
        diff_harness.api.claims = [make_claim(1)]
        await diff_harness.start()
        dynamic_harness = Harness(diff_job_user=(10001, 10001))
        dynamic_harness.api.claims = [make_claim(2, **dynamic_document())]
        await dynamic_harness.start()

        assert only(diff_harness.launcher.processes).spec.run_as == (10001, 10001)
        assert only(dynamic_harness.launcher.processes).spec.run_as is None
        await diff_harness.stop()
        await dynamic_harness.stop()

    run(scenario)


# #517-T05: a job process that ends: its findings are in the body that completes the job, and stay
# in it when the app refuses the full result and the bare verdict is sent.
def test_the_findings_of_a_review_are_in_the_body_that_completes_the_job() -> None:
    async def scenario() -> None:
        harness = Harness()
        harness.api.claims = [make_claim(1)]
        harness.api.complete_errors = [ApiRejected("bad", 400, "RUNNER_REQUEST_INVALID")]
        await harness.start()
        findings = {"open": 3, "bySeverity": {"P0": 0, "P1": 0, "P2": 0, "P3": 3}}
        only(harness.launcher.processes).finish(outcome(stdout=result_line(findings=findings)))
        await settle()

        assert len(harness.api.completions) == 2
        assert harness.api.completions[0][2]["findings"] == findings
        assert harness.api.completions[1][2]["findings"] == findings
        await harness.stop()

    run(scenario)
