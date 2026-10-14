# SPDX-License-Identifier: Apache-2.0

"""What the job loop answers when a Dynamic job process asks whether it still holds its job (#260).

The process never holds the lease token or the runner token; the loop does. Asked right before the
process writes its summary, the loop beats the heart once and tells the answer: the app answers
409 for a lease that was lost and for a job that was cancelled alike, so both are `lost`.
"""

from loop_support import Harness, make_claim, run
from test_dynamic_review_run import dynamic_document

from code_reviewer_runner.capabilities import ALL_ENGINES
from code_reviewer_runner.job_loop.api import ApiUnavailable, LeaseLost
from code_reviewer_runner.job_loop.process import ProcessSpec
from code_reviewer_runner.lease_check import LeaseState

USERS = {"diff_job_user": (10001, 10001), "dynamic_engine_user": (10101, 10101)}
OPERATOR = {
    "RUNNER_DYNAMIC_CAPABILITIES": '{"tool_choice_required": true}',
    "RUNNER_DYNAMIC_ENGINE_UID": "10101",
    "RUNNER_DYNAMIC_ENGINE_GID": "10101",
    "RUNNER_DYNAMIC_PROXY_PORT": "10180",
    "RUNNER_DYNAMIC_ENGINE_PORT": "10181",
}


def dynamic_harness() -> Harness:
    return Harness(
        **USERS,
        engines=ALL_ENGINES,
        dynamic_command=("/usr/local/bin/opencode",),
        dynamic_ripgrep="/usr/local/bin/rg",
        environment=OPERATOR,
    )


async def started_spec(harness: Harness) -> ProcessSpec:
    harness.api.claims = [make_claim(1, **dynamic_document())]
    await harness.start()
    return harness.launcher.processes[0].spec


# #260-T03
def test_a_job_that_is_still_held_is_confirmed_with_the_lease_of_its_own_claim() -> None:
    async def scenario() -> None:
        harness = dynamic_harness()
        spec = await started_spec(harness)
        assert spec.lease_check is not None
        before = len(harness.api.heartbeats)

        assert await spec.lease_check() is LeaseState.HELD

        claim = make_claim(1)
        assert harness.api.heartbeats[before:] == [(claim.id, claim.lease_token)]
        await harness.stop()

    run(scenario)


# #260-T01
def test_a_lease_the_app_no_longer_knows_is_lost() -> None:
    async def scenario() -> None:
        harness = dynamic_harness()
        spec = await started_spec(harness)
        assert spec.lease_check is not None
        harness.api.heartbeat_errors = [LeaseLost("not held", 409)]

        assert await spec.lease_check() is LeaseState.LOST
        await harness.stop()

    run(scenario)


# #260-T02: a cancelled job is answered with the same 409 as a lost lease.
def test_a_cancelled_job_is_lost_too_and_stays_lost_for_every_later_question() -> None:
    async def scenario() -> None:
        harness = dynamic_harness()
        spec = await started_spec(harness)
        assert spec.lease_check is not None
        harness.api.heartbeat_errors = [LeaseLost("not held", 409), LeaseLost("not held", 409)]

        assert await spec.lease_check() is LeaseState.LOST
        assert await spec.lease_check() is LeaseState.LOST
        await harness.stop()

    run(scenario)


# Not an issue case: an app that does not answer is no confirmation.
def test_an_app_that_does_not_answer_leaves_the_lease_unconfirmed() -> None:
    async def scenario() -> None:
        harness = dynamic_harness()
        spec = await started_spec(harness)
        assert spec.lease_check is not None
        harness.api.heartbeat_errors = [ApiUnavailable("no answer", 503)]

        assert await spec.lease_check() is LeaseState.UNCONFIRMED
        await harness.stop()

    run(scenario)


# Not an issue case: only a Dynamic job writes a comment of its own, a Diff job is not asked.
def test_a_diff_job_process_gets_no_lease_check() -> None:
    async def scenario() -> None:
        harness = dynamic_harness()
        harness.api.claims = [make_claim(1)]
        await harness.start()

        assert harness.launcher.processes[0].spec.lease_check is None
        await harness.stop()

    run(scenario)
