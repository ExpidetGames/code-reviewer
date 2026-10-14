# SPDX-License-Identifier: Apache-2.0

"""The job loop.

Claims jobs while fewer than `concurrency` run, starts one process per job, beats the heart of
every running job, enforces the hard timeout, reports every outcome and shuts down in an orderly
way. All waiting goes through the injected `Clock`, all HTTP through `RunnerApi` and all process
handling through `ProcessLauncher`, so every rule here is tested without a network, a real
process or a real wait; the integration tests then run the same loop against real ones.

Rules the code below follows (see the CR-29 decisions):

- A job that is refused (unknown command, unsupported platform, invalid input) never starts a
  process: its `complete` carries the stable error code of the refusal.
- The secrets of a job (git token, LLM key, lease token) reach the process through its stdin only,
  and no log line or result the loop produces contains them.
- A lost lease (409 on a heartbeat) ends the process and sends nothing more for that job.
- SIGTERM: no new claims; running jobs may finish within the grace period; then they are ended
  and reported as `runner_shutdown`, which the app gives back to the queue (a repeated report may
  be answered with 409, which is fine).
"""

import asyncio
import json
import logging
import shlex
from collections.abc import Callable, Mapping
from typing import Any

from code_reviewer_runner.capabilities import (
    ENGINE_DYNAMIC,
    ENGINES_VARIABLE,
    OPENCODE_COMMAND_VARIABLE,
)
from code_reviewer_runner.dynamic_review.engine_user import sweep_user
from code_reviewer_runner.job import Job, JobError, ReviewKind, parse_job
from code_reviewer_runner.job_loop.api import (
    MAX_RETRY_AFTER_SECONDS,
    ApiError,
    ApiRejected,
    ApiUnavailable,
    ClaimedJob,
    LeaseLost,
    RunnerApi,
)
from code_reviewer_runner.job_loop.clock import Clock, RealClock
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.job_loop.masking import SafeLog, SecretMasker
from code_reviewer_runner.job_loop.process import (
    ProcessLauncher,
    ProcessOutcome,
    ProcessSpec,
    RunningProcess,
)
from code_reviewer_runner.job_loop.reporting import (
    RUNNER_SHUTDOWN,
    Result,
    TextRedactor,
    failure_result,
    fit_request,
    minimal,
    result_from_outcome,
)
from code_reviewer_runner.job_loop.settings import LoopSettings, default_job_command
from code_reviewer_runner.pr_agent_config import PASSTHROUGH_VARIABLES
from code_reviewer_runner.result import ErrorCode

TIMEOUT_VARIABLE = "RUNNER_JOB_TIMEOUT_SECONDS"
# The operator's non-secret Dynamic configuration, read by the Dynamic job process: the model
# description and the engine user and ports of the slot (the names of `supervisor.py` and
# `static_isolation.py`).
DYNAMIC_PASSTHROUGH_VARIABLES = (
    "RUNNER_DYNAMIC_CAPABILITIES",
    "RUNNER_DYNAMIC_ENGINE_UID",
    "RUNNER_DYNAMIC_ENGINE_GID",
    "RUNNER_DYNAMIC_PROXY_PORT",
    "RUNNER_DYNAMIC_ENGINE_PORT",
)
# The pause after a failure never starts below this, however short the poll interval is.
MIN_BACKOFF_SECONDS = 5.0
# A shutdown report is tried for this long; the process is going away either way.
SHUTDOWN_REPORT_WINDOW_SECONDS = 10.0
_FIRST_RETRY_SECONDS = 1.0


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


def _secrets_in(raw_input: Mapping[str, Any]) -> list[str]:
    """The credentials of a job input, found defensively (the input may not be valid)."""
    values: list[str] = []
    for section, key in (("git", "token"), ("llm", "apiKey")):
        part = as_object(raw_input.get(section))
        value = part.get(key) if part else None
        if isinstance(value, str) and value.strip():
            values.append(value)
    return values


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
        self._launcher = launcher
        self._clock: Clock = clock or RealClock()
        self._masker = masker or SecretMasker([settings.token])
        self._log = SafeLog(logger or logging.getLogger("code_reviewer_runner.loop"), self._masker)
        self._environment = dict(environment or {})
        self._stopping = asyncio.Event()
        self._hard_stop = asyncio.Event()
        self._force = asyncio.Event()
        self._tasks: set[asyncio.Task[None]] = set()
        # Ends everything the engine user runs (uid, gid); it is only called once no Dynamic job
        # process runs, under the lock that also guards the start of one.
        self._sweeper = sweeper
        self._engine_lock = asyncio.Lock()
        self._engine_jobs = 0

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
            self._hard_stop.set()
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    # -- one job ------------------------------------------------------------------------------

    async def _run_job_safely(self, claimed: ClaimedJob) -> None:
        self._masker.add(claimed.id, [claimed.lease_token, *_secrets_in(claimed.input)])
        try:
            await self._run_job(claimed)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            # Class name only: the text of an error may hold part of the input.
            self._log.error(
                "job %s: unexpected runner error (%s); the lease will run out and the job "
                "is tried again",
                claimed.id,
                type(error).__name__,
            )
        finally:
            self._masker.discard(claimed.id)

    def _child_environment(self, job: Job) -> dict[str, str]:
        """Only the plain runtime variables; never the runner token or anything of another job."""
        env = {
            name: self._environment[name]
            for name in PASSTHROUGH_VARIABLES
            if name in self._environment
        }
        env[TIMEOUT_VARIABLE] = f"{self._settings.job_timeout:g}"
        if job.review_kind is ReviewKind.DYNAMIC:
            env.update(self._dynamic_environment())
        return env

    def _dynamic_environment(self) -> dict[str, str]:
        """What only a Dynamic job process gets (#202), all of it decided by trusted configuration.

        The engines the startup self-check advertised, the engine command it verified (never one the
        operator typed) and the operator's description of the model and of the slot. A runner whose
        check failed hands over no command: the job process then refuses with
        `dynamic_engine_unavailable`.
        """
        env = {
            name: self._environment[name]
            for name in DYNAMIC_PASSTHROUGH_VARIABLES
            if name in self._environment
        }
        env[ENGINES_VARIABLE] = ",".join(self._settings.engines)
        if ENGINE_DYNAMIC in self._settings.engines and self._settings.dynamic_command:
            env[OPENCODE_COMMAND_VARIABLE] = shlex.join(self._settings.dynamic_command)
        return env

    def _ms_since(self, started: float) -> int:
        return int((self._clock.monotonic() - started) * 1000)

    async def _run_job(self, claimed: ClaimedJob) -> None:
        started = self._clock.monotonic()
        # Knows the runner token, the secrets of every running job and the lease tokens.
        redactor = self._masker
        try:
            job = parse_job(json.dumps(claimed.input))
        except JobError as error:
            self._log.warning("job %s refused: %s", claimed.id, error.code.value)
            result = failure_result(
                error.code.value, error.detail, duration_ms=self._ms_since(started)
            )
            await self._report(claimed, result, window=self._settings.complete_retry_window)
            return
        self._log.info("job %s claimed: %s", claimed.id, job.command.value)
        try:
            # ASCII escapes: a lone surrogate in a text cannot break the encoding, and the job
            # process reads the same JSON.
            spec = ProcessSpec(
                argv=self._settings.job_command,
                env=self._child_environment(job),
                stdin=json.dumps(claimed.input).encode("ascii"),
                # A Dynamic job is the root supervisor (it drops the engine to its own user); every
                # other job drops to the unprivileged job user when the loop itself is root.
                run_as=(
                    None if job.review_kind is ReviewKind.DYNAMIC else self._settings.diff_job_user
                ),
            )
            process = await self._start_process(spec, job)
        except Exception as error:
            self._log.error(
                "job %s: cannot start the job process (%s)", claimed.id, type(error).__name__
            )
            result = failure_result(
                ErrorCode.RUNNER_ERROR.value,
                "the job process could not be started",
                duration_ms=self._ms_since(started),
            )
            await self._report(claimed, result, window=self._settings.complete_retry_window)
            return
        try:
            result = await self._supervise(claimed, process, redactor, started)
        finally:
            await self._after_process(job)
        if result is None:
            return
        await self._report(
            claimed,
            result,
            window=(
                SHUTDOWN_REPORT_WINDOW_SECONDS
                if result["errorCode"] == RUNNER_SHUTDOWN
                else self._settings.complete_retry_window
            ),
            shutdown=result["errorCode"] == RUNNER_SHUTDOWN,
        )

    def _engine_user(self, job: Job) -> tuple[int, int] | None:
        """The engine user whose leftovers follow this job's process, if it has one."""
        if job.review_kind is not ReviewKind.DYNAMIC:
            return None
        return self._settings.dynamic_engine_user

    async def _start_process(self, spec: ProcessSpec, job: Job) -> RunningProcess:
        if self._engine_user(job) is None:
            return await self._launcher.start(spec)
        # Under the lock that guards the sweep: a sweep that runs while this process is being
        # started would end the engine of a job that has only just begun.
        async with self._engine_lock:
            process = await self._launcher.start(spec)
            self._engine_jobs += 1
            return process

    async def _after_process(self, job: Job) -> None:
        """The job process is gone (however it ended): end what its engine user still runs.

        A job killed outright (SIGKILL, an OOM kill) cannot clean up after itself, and a helper
        may have left the engine's process group. The loop is root and holds `KILL`; whatever it
        cannot end here is met by the next job, which sweeps again right after taking the lease
        and does not start while the user still runs something.
        """
        user = self._engine_user(job)
        if user is None:
            return
        async with self._engine_lock:
            self._engine_jobs -= 1
            if self._engine_jobs > 0:
                return  # the user belongs to another job's engine now; its end will sweep
            try:
                ended = await asyncio.shield(asyncio.to_thread(self._sweeper, *user))
            except Exception as error:
                self._log.error("the engine user could not be swept (%s)", type(error).__name__)
                return
        if not ended:
            self._log.warning("a process of the engine user survived the sweep")

    async def _supervise(
        self,
        claimed: ClaimedJob,
        process: RunningProcess,
        redactor: TextRedactor,
        started: float,
    ) -> Result | None:
        """Wait for the process, beat the heart, enforce the timeout. None: report nothing."""
        lost = asyncio.Event()
        finished = asyncio.ensure_future(process.wait())
        helpers: list[asyncio.Future[Any]] = [
            asyncio.ensure_future(self._heartbeats(claimed, lost)),
            asyncio.ensure_future(lost.wait()),
            asyncio.ensure_future(
                self._clock.sleep(self._settings.job_timeout + self._settings.kill_margin)
            ),
            asyncio.ensure_future(self._hard_stop.wait()),
        ]
        _, lost_wait, timeout, shutdown = helpers
        try:
            await asyncio.wait([finished, *helpers[1:]], return_when=asyncio.FIRST_COMPLETED)
        except asyncio.CancelledError:
            await self._end(process, finished)
            raise
        finally:
            for helper in helpers:
                helper.cancel()
            await asyncio.gather(*helpers, return_exceptions=True)
        if finished.done():
            outcome = finished.result()
            result = result_from_outcome(outcome, redactor, self._ms_since(started))
            self._log_outcome(claimed, result, outcome)
            return result
        outcome = await self._end(process, finished)
        tail = outcome.stderr.decode("utf-8", errors="replace") if outcome else ""
        if lost_wait.done() and not lost_wait.cancelled():
            self._log.warning("job %s: the lease is lost, the process was ended", claimed.id)
            return None
        if timeout.done() and not timeout.cancelled():
            self._log.warning("job %s: hard timeout, the process was ended", claimed.id)
            return failure_result(
                ErrorCode.TIMEOUT.value,
                "the job did not finish within the time limit and was ended",
                duration_ms=self._ms_since(started),
                log_tail=tail,
                redactor=redactor,
            )
        if shutdown.done() and not shutdown.cancelled():
            self._log.warning(
                "job %s: the runner is shutting down, the job is given back", claimed.id
            )
            return failure_result(
                RUNNER_SHUTDOWN,
                "the runner was shut down before the job finished",
                duration_ms=self._ms_since(started),
                log_tail=tail,
                redactor=redactor,
            )
        return None

    async def _end(
        self, process: RunningProcess, finished: asyncio.Future[ProcessOutcome]
    ) -> ProcessOutcome | None:
        """End the process and its children; its outcome (with the end of stderr) if available."""
        try:
            await process.terminate()
            return await finished
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self._log.error("the job process could not be ended cleanly (%s)", type(error).__name__)
            return None

    async def _heartbeats(self, claimed: ClaimedJob, lost: asyncio.Event) -> None:
        while True:
            await self._clock.sleep(claimed.heartbeat_interval)
            try:
                await self._api.heartbeat(claimed.id, claimed.lease_token)
            except LeaseLost:
                lost.set()
                return
            except Exception as error:
                # A missed beat is not yet a lost lease (it is two minutes long): keep going. Only
                # the class of an unexpected error is logged, its text may hold part of the input.
                detail = str(error) if isinstance(error, ApiError) else type(error).__name__
                self._log.warning("job %s: heartbeat failed (%s)", claimed.id, detail)

    def _log_outcome(self, claimed: ClaimedJob, result: Result, outcome: ProcessOutcome) -> None:
        if result["ok"]:
            self._log.info("job %s finished: ok in %d ms", claimed.id, result["durationMs"])
            return
        self._log.warning(
            "job %s finished: %s (exit code %d)", claimed.id, result["errorCode"], outcome.exit_code
        )

    # -- reporting ----------------------------------------------------------------------------

    async def _report(
        self, claimed: ClaimedJob, result: Result, *, window: float, shutdown: bool = False
    ) -> None:
        """Deliver the result. The heart keeps beating until the app has it (or we give up): a
        lease that lapses meanwhile would let another runner take the job a second time."""
        lost = asyncio.Event()
        beating = asyncio.ensure_future(self._heartbeats(claimed, lost))
        try:
            await self._deliver(claimed, result, window=window, shutdown=shutdown, lost=lost)
        finally:
            beating.cancel()
            await asyncio.gather(beating, return_exceptions=True)

    async def _sleep_unless(
        self, seconds: float, lost: asyncio.Event, *, until_hard_stop: bool
    ) -> bool:
        """Sleep; False if something ended the wait early (lost lease, or the end of the grace)."""
        sleeper = asyncio.ensure_future(self._clock.sleep(seconds))
        waiters: list[asyncio.Future[Any]] = [sleeper, asyncio.ensure_future(lost.wait())]
        if until_hard_stop:
            waiters.append(asyncio.ensure_future(self._hard_stop.wait()))
        try:
            await asyncio.wait(waiters, return_when=asyncio.FIRST_COMPLETED)
        finally:
            slept = sleeper.done() and not sleeper.cancelled()
            for waiter in waiters:
                waiter.cancel()
            await asyncio.gather(*waiters, return_exceptions=True)
        return slept

    async def _deliver(
        self,
        claimed: ClaimedJob,
        result: Result,
        *,
        window: float,
        shutdown: bool,
        lost: asyncio.Event,
    ) -> None:
        """Send the result until the app takes it, tells us it will never take it, or time is up."""
        body = fit_request(result)
        began = self._clock.monotonic()
        delay = _FIRST_RETRY_SECONDS
        reduced = False
        while True:
            if lost.is_set():
                self._log.info("job %s: the lease is lost, the result is not sent", claimed.id)
                return
            try:
                reply = await self._api.complete(claimed.id, claimed.lease_token, body)
            except LeaseLost:
                # Another result was stored, the lease ran out, or (after a shutdown report) the
                # job was already given back: in all cases there is nothing left to send.
                self._log.info("job %s: the app does not hold this job for us any more", claimed.id)
                return
            except ApiRejected as error:
                if error.status in (400, 413) and not reduced:
                    reduced = True
                    body = minimal(result)
                    self._log.warning(
                        "job %s: result refused (HTTP %d), sending the verdict only",
                        claimed.id,
                        error.status,
                    )
                    continue
                self._log.error(
                    "job %s: the result was refused (HTTP %d)", claimed.id, error.status
                )
                return
            except ApiUnavailable as error:
                remaining = window - (self._clock.monotonic() - began)
                if remaining <= 0 or (self._hard_stop.is_set() and not shutdown):
                    self._log.error(
                        "job %s: the result could not be delivered (%s); the lease will run out",
                        claimed.id,
                        error,
                    )
                    return
                pause = min(max(delay, error.retry_after or 0.0), remaining)
                self._log.warning(
                    "job %s: %s; sending the result again in %gs", claimed.id, error, pause
                )
                if not await self._sleep_unless(pause, lost, until_hard_stop=not shutdown):
                    self._log.warning("job %s: stopped waiting to send the result", claimed.id)
                    return
                delay = min(delay * 2, self._settings.backoff_max)
                continue
            if reply.status == "queued":
                self._log.info("job %s given back to the queue", claimed.id)
            else:
                self._log.info("job %s reported: %s", claimed.id, reply.status or "ok")
            return
