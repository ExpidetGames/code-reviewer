# SPDX-License-Identifier: LicenseRef-Proprietary

"""The startup of `worker-once` (#324): the same hardened sequence as every mode, before any job.

The container's capabilities are fixed at its start, so `NET_ADMIN` and `SETPCAP` exist until the
entry point has installed the engine user's rules and dropped them. In `worker-once` the job
process is started by the Worker host; nothing of that may begin before the drop is confirmed.
"""

import io
import json
from typing import Any

import pytest

from code_reviewer_runner import cli, worker_cli
from code_reviewer_runner.dynamic_review.netguard import EgressMode, IsolationError
from code_reviewer_runner.dynamic_review.static_isolation import EgressSetup
from code_reviewer_runner.job_loop import service
from code_reviewer_runner.job_loop.worker import WorkerRequest
from code_reviewer_runner.job_loop.worker_errors import WorkerExit
from code_reviewer_runner.verdict import Verdict

CREDENTIAL = "crj_" + "Zq3_-" * 8 + "Zq3"
JOB_ID = "00000000-0000-4000-8000-000000000001"
DYNAMIC = {"RUNNER_DIFF_JOB_USER": "10001:10001"}


def start_document() -> io.StringIO:
    return io.StringIO(
        json.dumps({"appUrl": "http://127.0.0.1:4030", "jobId": JOB_ID, "credential": CREDENTIAL})
    )


class Recorder:
    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.events: list[str] = []
        self.engines_at_start: tuple[str, ...] = ()
        self.cannot_drop = False
        monkeypatch.setattr(service, "prepare_dynamic_runtime", self.prepare)
        monkeypatch.setattr(service, "check_dynamic_runner", self.check)
        monkeypatch.setattr(service, "write_engines_file", self.write)
        monkeypatch.setattr(service, "remove_engines_file", lambda: None)
        monkeypatch.setattr(worker_cli, "run_worker", self.run_worker)

    def write(self, verdict: Verdict) -> None:
        return None

    def prepare(self, settings: Any) -> EgressSetup:
        self.events.append("drop NET_ADMIN")
        if self.cannot_drop:
            raise IsolationError("a capability could not be dropped from the bounding set")
        return EgressSetup(True, EgressMode.FULL)

    def check(self, **facts: Any) -> None:
        self.events.append("self-check")

    async def run_worker(
        self, request: WorkerRequest, settings: Any, environment: Any, **options: Any
    ) -> int:
        # The Worker host starts the job process from here; this is the first moment one can exist.
        self.events.append("job process may start")
        self.engines_at_start = settings.engines
        return WorkerExit.OK


@pytest.fixture
def recorder(monkeypatch: pytest.MonkeyPatch) -> Recorder:
    return Recorder(monkeypatch)


# #324-T07
def test_net_admin_is_dropped_and_the_check_passed_before_a_job_process_can_exist(
    recorder: Recorder,
) -> None:
    code = cli.main(["worker-once"], environment=DYNAMIC, stdin=start_document())

    assert code == WorkerExit.OK
    assert recorder.events == ["drop NET_ADMIN", "self-check", "job process may start"]
    assert "opencode" in recorder.engines_at_start


# #324-T07: a Worker that cannot end its startup capabilities starts no job at all.
def test_a_worker_that_cannot_drop_net_admin_starts_nothing_and_exits_with_a_setup_error(
    recorder: Recorder,
) -> None:
    recorder.cannot_drop = True

    code = cli.main(["worker-once"], environment=DYNAMIC, stdin=start_document())

    assert code == WorkerExit.SETUP_ERROR
    assert recorder.events == ["drop NET_ADMIN"]


# #324-T07: the Worker modes ask for the read-only root of the hardened container spec.
def test_the_worker_asks_the_check_for_a_read_only_root(
    recorder: Recorder, monkeypatch: pytest.MonkeyPatch
) -> None:
    facts: list[dict[str, Any]] = []

    def check(**found: Any) -> None:
        facts.append(found)

    monkeypatch.setattr(service, "check_dynamic_runner", check)

    cli.main(["worker-once"], environment=DYNAMIC, stdin=start_document())

    assert callable(facts[0]["root_read_only"])


# #324-T04: `code-reviewer-worker --once` and `code-reviewer-runner worker-once` are one thing.
def test_both_ways_to_start_a_worker_run_the_same_startup(recorder: Recorder) -> None:
    worker_cli.main(["--once"], environment=DYNAMIC, stdin=start_document())

    assert recorder.events == ["drop NET_ADMIN", "self-check", "job process may start"]


class RecordingStdin(io.StringIO):
    def __init__(self, events: list[str]) -> None:
        super().__init__(start_document().getvalue())
        self._events = events

    def read(self, size: int | None = -1) -> str:
        self._events.append("read the start document")
        return super().read(size)


# #324-T07: startup is the first thing a container does; the start document is read after it, so a
# launcher that keeps stdin open still gets a hardened container (and its engines file) at once.
def test_the_start_document_is_read_only_after_the_startup_is_done(recorder: Recorder) -> None:
    cli.main(["worker-once"], environment=DYNAMIC, stdin=RecordingStdin(recorder.events))

    assert recorder.events == [
        "drop NET_ADMIN",
        "self-check",
        "read the start document",
        "job process may start",
    ]
