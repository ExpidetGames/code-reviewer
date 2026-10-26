# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down the job host together with the real job entry point (`code_reviewer_runner.runner`):
the host starts it as a process, the runner builds its result around PR-Agent's code with
`handle_request` replaced by the double of pr_agent_double.py, and the host delivers that result
to the API it was given. Nothing reaches a network."""

import asyncio
import json
import os
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest
from process_support import API_KEY, TOKEN, job_id, job_input

from code_reviewer_runner.job_loop.api import ClaimedJob, CompleteReply, HeartbeatReply
from code_reviewer_runner.job_loop.host import JobHost
from code_reviewer_runner.job_loop.masking import SecretMasker
from code_reviewer_runner.job_loop.process import SubprocessLauncher
from code_reviewer_runner.job_loop.settings import WorkerSettings

DOUBLE = Path(__file__).parent / "pr_agent_double.py"


class RecordingApi:
    """The API the host reports to: heartbeats are accepted, results are kept."""

    def __init__(self) -> None:
        self.completions: list[dict[str, Any]] = []

    async def heartbeat(self, job_id: str, lease_token: str) -> HeartbeatReply:
        return HeartbeatReply()

    async def complete(
        self, job_id: str, lease_token: str, result: Mapping[str, Any]
    ) -> CompleteReply:
        self.completions.append({"result": dict(result)})
        return CompleteReply("succeeded", False)


def run_job(tmp_path: Path, scenario: str, **settings: float) -> RecordingApi:
    api = RecordingApi()
    config = WorkerSettings(
        job_command=(sys.executable, str(DOUBLE), scenario, str(tmp_path / "report.json")),
        **settings,  # pyright: ignore[reportArgumentType]
    )

    async def go() -> None:
        host = JobHost(
            config,
            api,
            SubprocessLauncher(1.0),
            masker=SecretMasker([]),
            environment={"PATH": os.environ["PATH"], "HOME": str(tmp_path)},
        )
        claimed = ClaimedJob(
            id=job_id(1),
            lease_token="lease-token-0001-0123456789",
            heartbeat_interval=30.0,
            input=job_input(),
        )
        await asyncio.wait_for(host.run_job(claimed), 90)

    asyncio.run(go())
    assert len(api.completions) == 1, "the job was not reported"
    return api


# CR-29-T03
def test_a_review_run_by_the_real_entry_point_is_reported_with_its_comment_link(
    tmp_path: Path,
) -> None:
    api = run_job(tmp_path, "publish")

    result = api.completions[0]["result"]
    assert result["ok"] is True
    assert result["commentUrl"] == "https://github.com/octo/repo/pull/7#c1"
    seen = json.loads((tmp_path / "report.json").read_text())
    assert seen["request"] == ["review"]
    assert seen["secret_in_environ"] is False


def test_a_failure_comment_of_pr_agent_is_reported_as_a_failed_job(tmp_path: Path) -> None:
    api = run_job(tmp_path, "failure")

    result = api.completions[0]["result"]
    assert result["ok"] is False
    assert result["errorCode"] == "command_failed"


# CR-29-T14
def test_credentials_that_pr_agent_prints_never_reach_the_app(tmp_path: Path) -> None:
    api = run_job(tmp_path, "leak")

    sent = json.dumps(api.completions)
    assert TOKEN not in sent and API_KEY not in sent


# CR-29-T07, #387-T07
# The runner counts its soft timeout from the start of its process, so the clean result does not
# depend on how long the start-up takes. The 4 s timeout leaves the watchdog 7 s from the start, and
# `slow_start` (4.5 s of start-up, see the double) is the case a start-up counted on top of the
# timeout would lose. The start-up (the imports, 3 s on a loaded server) may take up to 7 s.
@pytest.mark.parametrize("scenario", ["slow", "slow_start"])
def test_the_runner_reports_its_own_timeout_before_the_host_has_to_end_it(
    tmp_path: Path, scenario: str
) -> None:
    api = run_job(tmp_path, scenario, job_timeout=4.0, kill_margin=30.0)

    result = api.completions[0]["result"]
    assert (result["ok"], result["errorCode"]) == (False, "timeout")
    # Written by the runner itself and not by its watchdog, which names a reason.
    assert result["logTail"].startswith("timeout: the command did not finish in time")
    assert "errorReason" not in result
