# SPDX-License-Identifier: Apache-2.0

"""Doubles for the job loop tests (not a test file): a clock that only moves when told to, an
in-memory runner API and a process launcher whose processes end when the test says so."""

import asyncio
import heapq
import json
from collections.abc import Callable, Coroutine, Mapping
from typing import Any

from support import API_KEY, TOKEN, make_job_dict

from code_reviewer_runner.job_loop.api import ApiError, ClaimedJob, CompleteReply
from code_reviewer_runner.job_loop.loop import RunnerLoop
from code_reviewer_runner.job_loop.process import ProcessOutcome, ProcessSpec, RunningProcess
from code_reviewer_runner.job_loop.settings import LoopSettings

RUNNER_TOKEN = "dummy-runner-token-0123456789-abcdef-0123456789"


async def settle(rounds: int = 40) -> None:
    for _ in range(rounds):
        await asyncio.sleep(0)


class ManualClock:
    """Sleeping tasks wake up when `advance` moves time past their due time, in order."""

    def __init__(self) -> None:
        self.now = 0.0
        self._waiters: list[tuple[float, int, asyncio.Future[None]]] = []
        self._counter = 0

    def monotonic(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        if seconds <= 0:
            await asyncio.sleep(0)
            return
        future: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._counter += 1
        heapq.heappush(self._waiters, (self.now + seconds, self._counter, future))
        await future

    async def advance(self, seconds: float) -> None:
        target = self.now + seconds
        while True:
            await settle()
            while self._waiters and self._waiters[0][2].cancelled():
                heapq.heappop(self._waiters)
            if not self._waiters or self._waiters[0][0] > target:
                break
            due, _, future = heapq.heappop(self._waiters)
            self.now = max(self.now, due)
            if not future.done():
                future.set_result(None)
        self.now = target
        await settle()


def make_settings(**overrides: Any) -> LoopSettings:
    values: dict[str, Any] = {
        "api_url": "http://127.0.0.1:9",
        "token": RUNNER_TOKEN,
        "runner_id": "test-runner",
        "concurrency": 3,
        "poll_interval": 5.0,
        "job_timeout": 1200.0,
        "shutdown_grace": 60.0,
        "kill_margin": 10.0,
        "terminate_grace": 5.0,
        "backoff_max": 60.0,
        "complete_retry_window": 600.0,
        "job_command": ("fake-job-process",),
    }
    values.update(overrides)
    return LoopSettings(**values)


def make_claim(number: int = 1, **job_overrides: Any) -> ClaimedJob:
    return ClaimedJob(
        id=f"00000000-0000-4000-8000-{number:012d}",
        lease_token=f"lease-token-{number:04d}-0123456789",
        heartbeat_interval=30.0,
        input=make_job_dict(**job_overrides),
    )


def result_line(**overrides: Any) -> bytes:
    result: dict[str, Any] = {
        "ok": True,
        "durationMs": 1200,
        "commentUrl": "https://github.com/octo/repo/pull/7#c1",
        "errorCode": None,
        "logTail": "review published",
        "logTruncated": False,
        "usage": None,
    }
    result.update(overrides)
    return (json.dumps(result) + "\n").encode()


def outcome(exit_code: int = 0, stdout: bytes | None = None, stderr: bytes = b"") -> ProcessOutcome:
    return ProcessOutcome(
        exit_code=exit_code,
        stdout=result_line() if stdout is None and exit_code == 0 else (stdout or b""),
        stderr=stderr,
        stdout_truncated=False,
        stderr_truncated=False,
    )


class FakeProcess:
    def __init__(self, spec: ProcessSpec) -> None:
        self.spec = spec
        self.terminated = False
        self._done: asyncio.Future[ProcessOutcome] = asyncio.get_running_loop().create_future()

    def finish(self, result: ProcessOutcome | None = None) -> None:
        if not self._done.done():
            self._done.set_result(result or outcome())

    async def wait(self) -> ProcessOutcome:
        return await asyncio.shield(self._done)

    async def terminate(self) -> None:
        self.terminated = True
        self.finish(outcome(exit_code=-15, stdout=b"", stderr=b"terminated\n"))

    @property
    def running(self) -> bool:
        return not self._done.done()


class FakeLauncher:
    def __init__(self) -> None:
        self.processes: list[FakeProcess] = []
        self.fail_with: OSError | None = None

    async def start(self, spec: ProcessSpec) -> RunningProcess:
        if self.fail_with is not None:
            raise self.fail_with
        process = FakeProcess(spec)
        self.processes.append(process)
        return process

    @property
    def running(self) -> list[FakeProcess]:
        return [process for process in self.processes if process.running]


class FakeApi:
    """The runner API in memory. `claims` is a queue of what the next claims answer (a job, None
    for 204, or an exception to raise); an empty queue answers 204."""

    def __init__(self) -> None:
        self.claims: list[ClaimedJob | ApiError | None] = []
        self.claim_calls = 0
        self.heartbeats: list[tuple[str, str]] = []
        self.heartbeat_errors: list[ApiError] = []
        self.completions: list[tuple[str, str, Mapping[str, Any]]] = []
        self.complete_errors: list[ApiError] = []
        self.complete_reply = CompleteReply("succeeded", False)
        self.claim_times: list[float] = []
        self.clock: ManualClock | None = None

    async def claim(self) -> ClaimedJob | None:
        self.claim_calls += 1
        if self.clock is not None:
            self.claim_times.append(self.clock.now)
        if not self.claims:
            return None
        item = self.claims.pop(0)
        if isinstance(item, ApiError):
            raise item
        return item

    async def heartbeat(self, job_id: str, lease_token: str) -> None:
        self.heartbeats.append((job_id, lease_token))
        if self.heartbeat_errors:
            raise self.heartbeat_errors.pop(0)

    async def complete(
        self, job_id: str, lease_token: str, result: Mapping[str, Any]
    ) -> CompleteReply:
        self.completions.append((job_id, lease_token, dict(result)))
        if self.complete_errors:
            raise self.complete_errors.pop(0)
        return self.complete_reply


class Harness:
    """A loop with fakes, started as a task on the running event loop."""

    def __init__(self, **settings: Any) -> None:
        # The kill of the engine user's leftovers: calls are recorded, the answer is `sweeps_ok`.
        self.sweeps: list[tuple[int, int]] = []
        self.sweeps_ok = True
        self.clock = ManualClock()
        self.api = FakeApi()
        self.api.clock = self.clock
        self.launcher = FakeLauncher()
        self.settings = make_settings(**settings)
        self.loop = RunnerLoop(
            self.settings,
            self.api,
            self.launcher,
            clock=self.clock,
            sweeper=self._sweep,
            environment={
                "PATH": "/usr/bin",
                "HOME": "/home/runner",
                "RUNNER_TOKEN": RUNNER_TOKEN,
                "GITHUB__USER_TOKEN": TOKEN,
                "OPENROUTER__KEY": API_KEY,
            },
        )
        self.task: asyncio.Task[None] | None = None

    def _sweep(self, uid: int, gid: int) -> bool:
        self.sweeps.append((uid, gid))
        return self.sweeps_ok

    async def start(self) -> None:
        self.task = asyncio.create_task(self.loop.run())
        await settle()

    async def stop(self) -> None:
        self.loop.request_force()
        if self.task is not None:
            await asyncio.wait_for(self.task, 5)


def run(scenario: Callable[[], Coroutine[Any, Any, None]]) -> None:
    asyncio.run(scenario())
