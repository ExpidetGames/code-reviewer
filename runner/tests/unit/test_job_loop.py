# SPDX-License-Identifier: Apache-2.0

"""Pins down the rules of the job loop with a clock, a runner API and processes that the test
controls: slots, heartbeats, outcomes, back-off, shutdown and what is reported when. Real processes
and a real HTTP server are in tests/integration."""

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
        harness = Harness(concurrency=3)
        claim = make_claim(1, command="improve")
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


# CR-29-T05
def test_no_more_processes_than_slots_run_and_a_full_loop_does_not_claim() -> None:
    async def scenario() -> None:
        harness = Harness(concurrency=2)
        harness.api.claims = [make_claim(1), make_claim(2), make_claim(3)]
        await harness.start()

        assert len(harness.launcher.running) == 2
        assert harness.api.claim_calls == 2
        await harness.clock.advance(600)
        assert harness.api.claim_calls == 2
        assert len(harness.launcher.processes) == 2

        harness.launcher.processes[0].finish()
        await settle()

        assert harness.api.claim_calls == 3
        assert len(harness.launcher.processes) == 3
        assert len(harness.launcher.running) == 2
        await harness.stop()

    run(scenario)


# CR-29-T06
def test_without_a_job_the_loop_waits_for_the_poll_interval_between_claims() -> None:
    async def scenario() -> None:
        harness = Harness(poll_interval=5.0)
        await harness.start()
        assert harness.api.claim_calls == 1

        await harness.clock.advance(4.9)
        assert harness.api.claim_calls == 1
        await harness.clock.advance(0.2)
        assert harness.api.claim_calls == 2
        await harness.clock.advance(5)
        assert harness.api.claim_times == [0.0, 5.0, 10.0]
        await harness.stop()

    run(scenario)


def test_a_finished_job_makes_the_loop_ask_again_at_once() -> None:
    async def scenario() -> None:
        harness = Harness(concurrency=3, poll_interval=5.0)
        harness.api.claims = [make_claim(1)]
        await harness.start()
        assert harness.api.claim_calls == 2  # the job, then 204

        only(harness.launcher.processes).finish()
        await settle()

        assert harness.api.claim_calls == 3
        assert harness.clock.now == 0.0
        await harness.stop()

    run(scenario)


# CR-29-T08
def test_after_a_stop_request_no_job_is_claimed_and_the_running_one_is_finished_and_reported() -> (
    None
):
    async def scenario() -> None:
        harness = Harness()
        harness.api.claims = [make_claim(1)]
        await harness.start()
        process = only(harness.launcher.processes)
        calls = harness.api.claim_calls

        harness.loop.request_stop()
        await settle()
        assert harness.task is not None and not harness.task.done()
        await harness.clock.advance(20)
        assert harness.api.claim_calls == calls
        assert not process.terminated

        process.finish()
        await settle()

        assert harness.task.done()
        assert harness.task.exception() is None
        assert len(harness.api.completions) == 1
        assert harness.api.completions[0][2]["ok"] is True
        assert harness.api.claim_calls == calls

    run(scenario)


def test_a_stop_request_without_a_running_job_ends_the_loop_at_once() -> None:
    async def scenario() -> None:
        harness = Harness()
        await harness.start()

        harness.loop.request_stop()
        await settle()

        assert harness.task is not None and harness.task.done()

    run(scenario)


# CR-29-T09
def test_a_job_that_outlasts_the_grace_period_is_ended_and_reported_as_a_shutdown() -> None:
    async def scenario() -> None:
        harness = Harness(shutdown_grace=60.0)
        claim = make_claim(1)
        harness.api.claims = [claim]
        await harness.start()
        process = only(harness.launcher.processes)

        harness.loop.request_stop()
        await harness.clock.advance(59)
        assert not process.terminated
        assert harness.api.completions == []
        await harness.clock.advance(2)

        assert process.terminated
        assert harness.task is not None and harness.task.done()
        (job_id, lease, result) = harness.api.completions[0]
        assert (job_id, lease) == (claim.id, claim.lease_token)
        assert result["ok"] is False
        assert result["errorCode"] == "runner_shutdown"

    run(scenario)


def test_a_second_stop_request_ends_the_running_jobs_without_waiting() -> None:
    async def scenario() -> None:
        harness = Harness(shutdown_grace=600.0)
        harness.api.claims = [make_claim(1)]
        await harness.start()
        process = only(harness.launcher.processes)

        harness.loop.request_stop()
        await settle()
        assert not process.terminated
        harness.loop.request_force()
        await settle()

        assert process.terminated
        assert harness.api.completions[0][2]["errorCode"] == "runner_shutdown"

    run(scenario)


def test_a_shutdown_report_that_the_app_answers_with_conflict_is_not_an_error() -> None:
    async def scenario() -> None:
        harness = Harness(shutdown_grace=0.0)
        harness.api.claims = [make_claim(1)]
        harness.api.complete_errors = [LeaseLost("conflict", 409)]
        await harness.start()

        harness.loop.request_stop()
        await settle()

        assert harness.task is not None and harness.task.done()
        assert harness.task.exception() is None
        assert len(harness.api.completions) == 1  # once, not retried

    run(scenario)


def test_a_complete_answer_saying_the_job_was_queued_again_is_accepted() -> None:
    async def scenario() -> None:
        harness = Harness(shutdown_grace=0.0)
        harness.api.claims = [make_claim(1)]
        harness.api.complete_reply = CompleteReply("queued", False)
        await harness.start()

        harness.loop.request_stop()
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


# CR-29-T11
def test_an_app_that_is_down_makes_the_loop_wait_longer_each_time_and_leaves_the_running_job() -> (
    None
):
    async def scenario() -> None:
        harness = Harness(poll_interval=5.0, backoff_max=60.0, concurrency=3)
        harness.api.claims = [make_claim(1)]
        await harness.start()
        process = only(harness.launcher.processes)
        harness.api.claims = [ApiUnavailable("down", 503) for _ in range(8)]

        await harness.clock.advance(400)

        gaps = [
            round(b - a)
            for a, b in zip(harness.api.claim_times[2:], harness.api.claim_times[3:], strict=False)
        ]
        assert gaps[:6] == [5, 10, 20, 40, 60, 60]
        assert process.running and not process.terminated
        assert harness.api.completions == []
        await harness.stop()

    run(scenario)


def test_a_retry_after_from_the_app_is_respected() -> None:
    async def scenario() -> None:
        harness = Harness(poll_interval=5.0)
        harness.api.claims = [ApiUnavailable("busy", 503, retry_after=30.0)]
        await harness.start()

        await harness.clock.advance(29)
        assert harness.api.claim_calls == 1
        await harness.clock.advance(2)
        assert harness.api.claim_calls == 2
        await harness.stop()

    run(scenario)


def test_after_a_successful_claim_the_pause_after_a_failure_starts_small_again() -> None:
    async def scenario() -> None:
        harness = Harness(poll_interval=5.0)
        harness.api.claims = [ApiUnavailable("down", 503), ApiUnavailable("down", 503), None]
        await harness.start()
        await harness.clock.advance(5 + 10)
        harness.api.claims = [ApiUnavailable("down", 503)]
        await harness.clock.advance(5)  # the poll after the 204
        await harness.clock.advance(5)  # first pause of the new failure

        assert harness.api.claim_times[-1] - harness.api.claim_times[-2] == 5.0
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
        await harness.stop()

    run(scenario)


# CR-29-T13
def test_a_process_gets_only_plain_runtime_variables_and_never_the_runner_token() -> None:
    async def scenario() -> None:
        harness = Harness(concurrency=2)
        first, second = make_claim(1), make_claim(2)
        second.input["git"]["token"] = "second-job-installation-token-9876543210"
        harness.api.claims = [first, second]
        await harness.start()

        assert len(harness.launcher.processes) == 2
        for process in harness.launcher.processes:
            names = set(process.spec.env)
            assert names <= {*PASSTHROUGH_VARIABLES, "RUNNER_JOB_TIMEOUT_SECONDS"}
            blob = json.dumps(dict(process.spec.env))
            for secret in (RUNNER_TOKEN, TOKEN, API_KEY, "second-job-installation-token"):
                assert secret not in blob
        stdin_of_first = harness.launcher.processes[0].spec.stdin.decode()
        assert "second-job-installation-token" not in stdin_of_first
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


def test_a_second_stop_signal_ends_the_wait_between_two_attempts_to_send_a_result() -> None:
    async def scenario() -> None:
        harness = Harness(shutdown_grace=600.0)
        harness.api.claims = [make_claim(1)]
        harness.api.complete_errors = [ApiUnavailable("busy", 503, retry_after=900.0)]
        await harness.start()
        only(harness.launcher.processes).finish()
        await settle()
        harness.loop.request_stop()
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


# CR-29: a lone surrogate in the input or in the output is not a poison value.
def test_a_question_with_a_lone_surrogate_is_passed_on_and_reported_normally() -> None:
    async def scenario() -> None:
        harness = Harness()
        harness.api.claims = [make_claim(1, command="ask", args=["why \ud800 this?"])]
        await harness.start()
        process = only(harness.launcher.processes)
        assert json.loads(process.spec.stdin)["args"] == ["why \ud800 this?"]

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


def test_the_pause_after_a_failed_claim_never_starts_below_five_seconds() -> None:
    async def scenario() -> None:
        harness = Harness(poll_interval=0.1)
        harness.api.claims = [ApiUnavailable("down", 503), ApiUnavailable("down", 503)]
        await harness.start()

        await harness.clock.advance(4.9)
        assert harness.api.claim_calls == 1
        await harness.clock.advance(0.2)
        assert harness.api.claim_calls == 2
        await harness.stop()

    run(scenario)


def test_a_job_command_other_than_the_entry_point_is_announced_with_a_warning(
    caplog: Any,
) -> None:
    async def scenario() -> None:
        harness = Harness(job_command=("/fakes/fake_pr_agent.py", "--mode", "succeed"))
        await harness.start()

        assert "PR_AGENT_COMMAND is set" in caplog.text
        assert "/fakes/fake_pr_agent.py" in caplog.text
        assert "--mode" not in caplog.text
        await harness.stop()

    caplog.set_level(logging.WARNING, logger="code_reviewer_runner.loop")
    run(scenario)
