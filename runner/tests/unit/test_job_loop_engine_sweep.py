# SPDX-License-Identifier: LicenseRef-Proprietary

"""The job loop ends what the engine user still runs after every Dynamic job process (#197).

The loop is root in the Dynamic runner and holds `KILL`. A job process that was killed outright
(SIGKILL, an OOM kill) leaves its engine behind with nothing to clean up; the loop is the one
process that sees every end of a job process, so it runs the sweep, whatever way the job ended.
"""

import pytest
from loop_support import Harness, make_claim, outcome, run, settle
from test_dynamic_review_run import dynamic_document

USERS = {"diff_job_user": (10001, 10001), "dynamic_engine_user": (10101, 10102)}


def dynamic_claim(number: int) -> object:
    return make_claim(number, **dynamic_document())


# #197-T07
def test_a_dynamic_job_that_ends_is_followed_by_the_sweep_of_the_engine_user() -> None:
    async def scenario() -> None:
        harness = Harness(**USERS)
        harness.api.claims = [dynamic_claim(1)]  # type: ignore[list-item]
        await harness.start()
        assert harness.sweeps == []  # the job is still running

        harness.launcher.processes[0].finish()
        await settle()

        assert harness.sweeps == [(10101, 10102)]
        await harness.stop()

    run(scenario)


# #197-T07
def test_a_dynamic_job_that_was_killed_is_swept_too() -> None:
    async def scenario() -> None:
        harness = Harness(**USERS)
        harness.api.claims = [dynamic_claim(1)]  # type: ignore[list-item]
        await harness.start()

        harness.launcher.processes[0].finish(outcome(exit_code=-9, stdout=b""))  # SIGKILL
        await settle()

        assert harness.sweeps == [(10101, 10102)]
        await harness.stop()

    run(scenario)


# #197-T07
def test_a_dynamic_job_that_the_loop_ends_on_timeout_or_lease_loss_is_swept_too() -> None:
    async def scenario() -> None:
        harness = Harness(**USERS, job_timeout=100.0, kill_margin=10.0, terminate_grace=0.0)
        harness.api.claims = [dynamic_claim(1)]  # type: ignore[list-item]
        await harness.start()

        await harness.clock.advance(111.0)  # the hard timeout ends the process

        assert harness.launcher.processes[0].terminated
        assert harness.sweeps == [(10101, 10102)]
        await harness.stop()

    run(scenario)


# #197-T07
def test_a_diff_job_or_a_loop_without_an_engine_user_sweeps_nothing() -> None:
    async def scenario() -> None:
        diff = Harness(**USERS)
        diff.api.claims = [make_claim(1)]
        await diff.start()
        diff.launcher.processes[0].finish()
        await settle()
        assert diff.sweeps == []
        await diff.stop()

        plain = Harness()  # not the Dynamic runner: no engine user is configured
        plain.api.claims = [dynamic_claim(2)]  # type: ignore[list-item]
        await plain.start()
        plain.launcher.processes[0].finish()
        await settle()
        assert plain.sweeps == []
        await plain.stop()

    run(scenario)


# #197-T07
def test_the_sweep_waits_for_the_last_dynamic_job_so_it_never_kills_a_running_engine() -> None:
    async def scenario() -> None:
        harness = Harness(**USERS)
        harness.api.claims = [dynamic_claim(1), dynamic_claim(2)]  # type: ignore[list-item]
        await harness.start()
        first, second = harness.launcher.processes

        first.finish()
        await settle()
        assert harness.sweeps == []  # the second job's engine may be running as that user now

        second.finish()
        await settle()
        assert harness.sweeps == [(10101, 10102)]
        await harness.stop()

    run(scenario)


# #197-T07
@pytest.mark.parametrize("works", [False, True])
def test_a_failed_sweep_does_not_stop_the_result_from_being_reported(works: bool) -> None:
    async def scenario() -> None:
        harness = Harness(**USERS)
        harness.sweeps_ok = works
        harness.api.claims = [dynamic_claim(1)]  # type: ignore[list-item]
        await harness.start()

        harness.launcher.processes[0].finish()
        await settle()

        # The next Dynamic job sweeps again right after its lease and refuses to start if it cannot.
        assert len(harness.api.completions) == 1
        await harness.stop()

    run(scenario)
