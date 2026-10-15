# SPDX-License-Identifier: Apache-2.0

"""The job loop.

Claims jobs while fewer than `concurrency` run, starts one process per job, beats the heart of
every running job, enforces the hard timeout, reports every outcome and shuts down in an orderly
way. All waiting goes through the injected `Clock`, all HTTP through `RunnerApi` and all process
handling through `ProcessLauncher`, so every rule here is tested without a network, a real
process or a real wait; the integration tests then run the same loop against real ones.

What happens to one job (the process, the heartbeats, the timeout, the delivery) is the `JobHost`
of host.py, shared with the Worker (#323). The rules the loop itself follows (see the CR-29
decisions):

- SIGTERM: no new claims; running jobs may finish within the grace period; then they are ended
  and reported as `runner_shutdown`, which the app gives back to the queue (a repeated report may
  be answered with 409, which is fine).
"""

import asyncio
import logging
from collections.abc import Callable, Mapping
from typing import Any

from code_reviewer_runner.dynamic_review.engine_user import sweep_user
from code_reviewer_runner.job_loop.api import (
    MAX_RETRY_AFTER_SECONDS,
    ApiError,
    ApiUnavailable,
    ClaimedJob,
    RunnerApi,
)
from code_reviewer_runner.job_loop.clock import Clock, RealClock
from code_reviewer_runner.job_loop.host import JobHost
from code_reviewer_runner.job_loop.masking import SafeLog, SecretMasker
from code_reviewer_runner.job_loop.process import ProcessLauncher
from code_reviewer_runner.job_loop.settings import LoopSettings, default_job_command

# The pause after a failure never starts below this, however short the poll interval is.
MIN_BACKOFF_SECONDS = 5.0


class Backoff:
    """Growing pause after a failure; `reset` after a success."""

    def __init__(self, base: float, maximum: float) -> None:
        self._base = base
        self._maximum = max(base, maximum)
        self._current = base

    def next(self, retry_after: float | None = None) -> float:
        delay = self._current
        if retry_after is not None:
            delay = max(delay, min(retry_after, MAX_RETRY_AFTER_SECONDS))
        self._current = min(self._current * 2, self._maximum)
        return delay

    def reset(self) -> None:
        self._current = self._base


class RunnerLoop:
    def __init__(
        self,
        settings: LoopSettings,
        api: RunnerApi,
        launcher: ProcessLauncher,
        *,
        clock: Clock | None = None,
        logger: logging.Logger | None = None,
        environment: Mapping[str, str] | None = None,
        masker: SecretMasker | None = None,
        sweeper: Callable[[int, int], bool] = sweep_user,
    ) -> None:
        self._settings = settings
        self._api = api
        self._clock: Clock = clock or RealClock()
        self._masker = masker or SecretMasker([settings.token])
        self._log = SafeLog(logger or logging.getLogger("code_reviewer_runner.loop"), self._masker)
        self._stopping = asyncio.Event()
        self._force = asyncio.Event()
        self._tasks: set[asyncio.Task[None]] = set()
        # What happens to one job, once claimed, is the host's: the same code the Worker runs.
        self._host = JobHost(
            settings,
            api,
            launcher,
            masker=self._masker,
            clock=self._clock,
            logger=logger,
            environment=environment,
            sweeper=sweeper,
        )

    # -- control ------------------------------------------------------------------------------

    def request_stop(self) -> None:
        """Stop claiming. Running jobs may finish within the grace period (the first SIGTERM)."""
        self._stopping.set()

    def request_force(self) -> None:
        """Do not wait for running jobs any longer (a second SIGTERM)."""
        self._stopping.set()
        self._force.set()

    @property
    def running_jobs(self) -> int:
        return len(self._tasks)

    # -- the loop -----------------------------------------------------------------------------

    async def run(self) -> None:
        """Run until a stop is requested and every job is reported or given up."""
        settings = self._settings
        backoff = Backoff(max(MIN_BACKOFF_SECONDS, settings.poll_interval), settings.backoff_max)
        self._log.info(
            "runner %s started: %d slots, poll interval %gs, job timeout %gs",
            settings.runner_id,
            settings.concurrency,
            settings.poll_interval,
            settings.job_timeout,
        )
        if tuple(settings.job_command) != default_job_command():
            self._log.warning(
                "PR_AGENT_COMMAND is set: jobs, with their credentials on stdin, go to %s instead "
                "of the runner entry point. This is meant for test stacks, never for production.",
                settings.job_command[0] if settings.job_command else "(empty)",
            )
        while not self._stopping.is_set():
            if len(self._tasks) >= settings.concurrency:
                await self._pause(None, wake_on_finish=True)
                continue
            try:
                claimed = await self._api.claim()
            except ApiUnavailable as error:
                delay = backoff.next(error.retry_after)
                self._log.warning("%s; trying again in %gs", error, delay)
                await self._pause(delay, wake_on_finish=False)
                continue
            except ApiError as error:
                delay = backoff.next()
                self._log.error("claim failed: %s; trying again in %gs", error, delay)
                await self._pause(delay, wake_on_finish=False)
                continue
            backoff.reset()
            if claimed is None:
                await self._pause(settings.poll_interval, wake_on_finish=True)
                continue
            self._start(claimed)
        await self._drain()
        self._log.info("runner %s stopped", settings.runner_id)

    def _start(self, claimed: ClaimedJob) -> None:
        task = asyncio.create_task(self._run_job_safely(claimed))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _pause(self, seconds: float | None, *, wake_on_finish: bool) -> None:
        """Wait for `seconds`, a stop request and (if asked) the end of any running job.

        `seconds=None` waits for a stop request or a job ending only (all slots are taken).
        """
        waiters: set[asyncio.Future[Any]] = {asyncio.ensure_future(self._stopping.wait())}
        if seconds is not None:
            waiters.add(asyncio.ensure_future(self._clock.sleep(seconds)))
        if wake_on_finish:
            waiters |= set(self._tasks)
        try:
            await asyncio.wait(waiters, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for waiter in waiters:
                if waiter not in self._tasks:
                    waiter.cancel()
            await asyncio.gather(
                *(w for w in waiters if w not in self._tasks), return_exceptions=True
            )

    async def _drain(self) -> None:
        if not self._tasks:
            return
        grace = self._settings.shutdown_grace
        self._log.info("stopping: %d job(s) may finish within %gs", len(self._tasks), grace)
        if not self._force.is_set() and grace > 0:
            waiters: set[asyncio.Future[Any]] = {
                asyncio.ensure_future(self._clock.sleep(grace)),
                asyncio.ensure_future(self._force.wait()),
            }
            tasks_done = asyncio.ensure_future(
                asyncio.wait(set(self._tasks), return_when=asyncio.ALL_COMPLETED)
            )
            waiters.add(tasks_done)
            try:
                await asyncio.wait(waiters, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for waiter in waiters:
                    waiter.cancel()
                await asyncio.gather(*waiters, return_exceptions=True)
        if self._tasks:
            self._log.warning("%d job(s) did not finish in time and are ended", len(self._tasks))
            self._host.request_hard_stop()
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    async def _run_job_safely(self, claimed: ClaimedJob) -> None:
        await self._host.run_job(claimed)
