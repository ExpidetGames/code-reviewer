# SPDX-License-Identifier: LicenseRef-Proprietary

"""What the job loop answers when a Dynamic job process asks whether it still holds its job (#260).

The process never holds the lease token or the runner token; the loop does. Asked right before the
process writes its summary, the loop beats the heart once and tells the answer: the app answers
409 for a lease that was lost and for a job that was cancelled alike, so both are `lost`.
"""

import asyncio

from loop_support import Harness, make_claim, run, settle
from test_dynamic_review_run import dynamic_document

from code_reviewer_runner.capabilities import ALL_ENGINES
from code_reviewer_runner.job_loop.api import ApiRejected, ApiUnavailable, LeaseLost
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


# Not an issue case: an app that keeps not answering is no confirmation, after a few tries.
def test_an_app_that_keeps_not_answering_leaves_the_lease_unconfirmed_after_three_tries() -> None:
    async def scenario() -> None:
        harness = dynamic_harness()
        spec = await started_spec(harness)
        assert spec.lease_check is not None
        harness.api.heartbeat_errors = [ApiUnavailable("no answer", 503) for _ in range(9)]
        before = len(harness.api.heartbeats)

        asked = asyncio.ensure_future(spec.lease_check())
        await harness.clock.advance(10)

        assert await asked is LeaseState.UNCONFIRMED
        assert len(harness.api.heartbeats) - before == 3
        await harness.stop()

    run(scenario)


# #260: one 502 during an app redeploy must not cost a finished review.
def test_a_transient_failure_is_tried_again_after_a_short_pause() -> None:
    async def scenario() -> None:
        harness = dynamic_harness()
        spec = await started_spec(harness)
        assert spec.lease_check is not None
        harness.api.heartbeat_errors = [ApiUnavailable("bad gateway", 502)]
        before = len(harness.api.heartbeats)

        asked = asyncio.ensure_future(spec.lease_check())
        await settle()
        assert not asked.done()  # waiting out the pause, not answering yet
        await harness.clock.advance(1)

        assert await asked is LeaseState.HELD
        assert len(harness.api.heartbeats) - before == 2
        await harness.stop()

    run(scenario)


# #260: a 409 or 404 is the app's answer; asking again cannot change it.
def test_a_lost_lease_and_a_refusal_are_final_at_once() -> None:
    async def scenario() -> None:
        harness = dynamic_harness()
        spec = await started_spec(harness)
        assert spec.lease_check is not None
        before = len(harness.api.heartbeats)

        harness.api.heartbeat_errors = [LeaseLost("not held", 404)]
        assert await spec.lease_check() is LeaseState.LOST
        harness.api.heartbeat_errors = [ApiRejected("refused", 400, None)]
        assert await spec.lease_check() is LeaseState.UNCONFIRMED

        assert len(harness.api.heartbeats) - before == 2
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


# #396-T11
def test_a_run_the_app_says_was_superseded_stays_superseded_without_asking_again() -> None:
    async def scenario() -> None:
        harness = dynamic_harness()
        spec = await started_spec(harness)
        assert spec.lease_check is not None
        harness.api.superseded_from = len(harness.api.heartbeats) + 1

        assert await spec.lease_check() is LeaseState.SUPERSEDED
        asked = len(harness.api.heartbeats)
        assert await spec.lease_check() is LeaseState.SUPERSEDED

        assert len(harness.api.heartbeats) == asked
        await harness.stop()

    run(scenario)
