# SPDX-License-Identifier: Apache-2.0

"""What the job host does when the app says that a run was superseded (#396).

The process is told once, the host keeps beating and waits for it, delivers its result, and the loop
goes
on; a process that does not stop is ended after the drain bound with an unknown cost. A run that is
not
superseded behaves as it always did."""

import json
from typing import Any

from loop_support import Harness, make_claim, outcome, run, settle

from code_reviewer_runner.job_loop.host import (
    SUPERSEDE_MIN_PROCESS_AGE_SECONDS,
    SUPERSEDED_DRAIN_SECONDS,
)
from code_reviewer_runner.result import NO_RESULT_REASON


def superseded_line(**overrides: Any) -> bytes:
    result: dict[str, Any] = {
        "ok": False,
        "durationMs": 40_000,
        "commentUrl": None,
        "errorCode": "superseded",
        "logTail": "superseded: a newer push replaced this run",
        "logTruncated": False,
        "usage": {
            "model": "m",
            "promptTokens": 600,
            "completionTokens": 150,
            "totalTokens": 750,
            "aiCalls": 1,
            "fallbackUsed": False,
            "costUsd": 0.0042,
        },
    }
    result.update(overrides)
    return (json.dumps(result) + "\n").encode()


# #396-T03
def test_the_process_is_told_once_keeps_its_heartbeats_and_its_result_is_delivered() -> None:
    async def scenario() -> None:
        harness = Harness()
        harness.api.claims = [make_claim(1)]
        await harness.start()
        process = harness.launcher.processes[0]
        process.on_superseded = lambda p: p.finish(outcome(exit_code=1, stdout=superseded_line()))
        harness.api.superseded_from = 2

        await harness.clock.advance(30)  # first heartbeat: not superseded
        assert process.superseded_notices == 0
        await harness.clock.advance(30)  # second heartbeat: superseded
        await harness.clock.advance(SUPERSEDE_MIN_PROCESS_AGE_SECONDS)
        await settle()
        # A third beat in the meantime does not tell it twice.
        await settle()

        assert process.superseded_notices == 1
        assert len(harness.api.completions) == 1
        delivered = harness.api.completions[0][2]
        assert delivered["errorCode"] == "superseded"
        assert delivered["usage"]["costUsd"] == 0.0042
        assert not process.terminated
        await harness.stop()

    run(scenario)


# #396-T03
def test_a_young_process_is_not_told_before_it_can_have_its_handler() -> None:
    async def scenario() -> None:
        harness = Harness()
        harness.api.claims = [make_claim(1)]
        harness.api.superseded_from = 1
        await harness.start()
        process = harness.launcher.processes[0]

        await harness.clock.advance(30)  # heartbeat: superseded, but the process is only 30 s old
        await settle()
        assert process.superseded_notices == 1  # 30 s is older than the minimum age

    run(scenario)


# #396-T04
def test_a_process_that_does_not_stop_is_ended_after_the_drain_and_its_cost_is_unknown() -> None:
    async def scenario() -> None:
        harness = Harness()
        harness.api.claims = [make_claim(1)]
        harness.api.superseded_from = 1
        await harness.start()
        process = harness.launcher.processes[0]

        await harness.clock.advance(30)  # told
        await settle()
        assert process.superseded_notices == 1
        assert process.running
        await harness.clock.advance(SUPERSEDED_DRAIN_SECONDS - 1)
        await settle()
        assert process.running

        await harness.clock.advance(2)
        await settle()

        assert process.terminated
        assert len(harness.api.completions) == 1
        delivered = harness.api.completions[0][2]
        assert delivered["errorCode"] == "superseded"
        assert delivered["errorReason"] == NO_RESULT_REASON
        assert delivered.get("usage") is None
        await harness.stop()

    run(scenario)


# #396-T12
def test_the_loop_goes_on_to_the_next_job_after_a_superseded_one() -> None:
    async def scenario() -> None:
        harness = Harness()
        harness.api.claims = [make_claim(1), make_claim(2)]
        harness.api.superseded_from = 1
        await harness.start()
        first = harness.launcher.processes[0]
        first.on_superseded = lambda p: p.finish(outcome(exit_code=1, stdout=superseded_line()))

        await harness.clock.advance(30)
        await settle()

        assert len(harness.api.completions) == 1
        assert len(harness.launcher.processes) == 2
        await harness.stop()

    run(scenario)


# #396-T13
def test_a_heartbeat_without_the_field_changes_nothing() -> None:
    async def scenario() -> None:
        harness = Harness()
        harness.api.claims = [make_claim(1)]
        await harness.start()
        process = harness.launcher.processes[0]

        await harness.clock.advance(300)
        await settle()
        process.finish()
        await settle()

        assert process.superseded_notices == 0
        assert len(harness.api.heartbeats) >= 5
        assert harness.api.completions[0][2]["ok"] is True
        await harness.stop()

    run(scenario)
