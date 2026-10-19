# SPDX-License-Identifier: Apache-2.0

"""Runs one PR-Agent command for one job. One process per job.

Reads the job (JSON) from stdin, runs `PRAgent().handle_request` in user mode with the installation
token of the job, and prints exactly one line of result JSON on stdout. Everything else (PR-Agent's
own prints, log lines, tracebacks) goes through a redacting filter to stderr or into the log tail of
the result. Exit code 0 means the command succeeded, 1 means it did not.

Order matters here and is why the PR-Agent imports sit inside `run_job`:

1. validate the job (a refused job never loads PR-Agent and opens no connection),
2. replace the process environment with the minimal one built from the job (PR-Agent's settings
   are read from the environment when it is first imported),
3. install the log sink (before the import, so import-time warnings are captured too),
4. import PR-Agent, apply the identity patch and the comment recorder, run the command.
"""

import argparse
import asyncio
import logging
import os
import shlex
import signal
import sys
import threading
import time
from collections.abc import Callable, Generator, Mapping, Sequence
from contextlib import ExitStack, contextmanager
from dataclasses import replace
from pathlib import Path
from typing import Any, TextIO

from loguru import logger

from code_reviewer_runner import __version__
from code_reviewer_runner.capabilities import (
    ENGINE_DYNAMIC,
    OPENCODE_COMMAND_VARIABLE,
    RIPGREP_PATH_VARIABLE,
    engines_from_environment,
)
from code_reviewer_runner.comment_recorder import CommentRecorder, install_comment_recorder
from code_reviewer_runner.diff_cost import CostMeterError, DiffCostMeter, install_cost_meter
from code_reviewer_runner.dynamic_findings import (
    DROPPED_INVALID,
    DROPPED_OUTSIDE_EXPORT,
    DynamicFindings,
)
from code_reviewer_runner.dynamic_review import findings_schema
from code_reviewer_runner.dynamic_review.adapter import DynamicEngine, shutdown_engines
from code_reviewer_runner.dynamic_review.budget import (
    TOTAL_DEADLINE_SECONDS,
    BudgetLedger,
    DynamicLimits,
    LimitError,
    max_cost_from_environment,
)
from code_reviewer_runner.dynamic_review.config import new_proxy_capability
from code_reviewer_runner.dynamic_review.failure_note import FAILURE_SENTENCES
from code_reviewer_runner.dynamic_review.inputs import review_inputs
from code_reviewer_runner.dynamic_review.limits import CheckoutError
from code_reviewer_runner.dynamic_review.prompts import compose_system_prompt
from code_reviewer_runner.dynamic_review.proxy import (
    DynamicCapabilities,
    ModelProxy,
    capabilities_for_job,
    with_cache_unit_costs,
    with_reserved_output,
)
from code_reviewer_runner.dynamic_review.publish import (
    STATE_RESET_CODE,
    Published,
    PublishError,
    publish_failure_note,
    publish_run,
)
from code_reviewer_runner.dynamic_review.supervisor import (
    ContentPreparer,
    Prepared,
    production_preparer,
)
from code_reviewer_runner.error_mapping import classify_failure
from code_reviewer_runner.identity_patch import (
    IdentityPatchError,
    apply_identity_patch,
    check_pr_agent_version,
)
from code_reviewer_runner.job import (
    MAX_JOB_BYTES,
    Command,
    Job,
    JobError,
    ReviewKind,
    parse_job,
)
from code_reviewer_runner.lease_check import (
    LeaseCheck,
    LeaseState,
    lease_check_from_environment,
)
from code_reviewer_runner.llm_providers import require_provider
from code_reviewer_runner.log_capture import (
    MAX_TAIL_BYTES,
    LogCapture,
    StdlibLogHandler,
    fit_to_bytes,
)
from code_reviewer_runner.pr_agent_config import InvalidOption, build_environment
from code_reviewer_runner.pr_agent_runtime import JobTimeout, execute
from code_reviewer_runner.redaction import REDACTED, RedactingStream, Redactor
from code_reviewer_runner.repo_settings_guard import install_repo_settings_guard
from code_reviewer_runner.require_parameters_patch import (
    RequireParametersPatchError,
    apply_require_parameters_patch,
)
from code_reviewer_runner.result import (
    NO_RESULT_REASON,
    ErrorCode,
    JobResult,
    ReviewFindings,
    Usage,
)
from code_reviewer_runner.review_state_watch import (
    ReviewStateWatch,
    WatchError,
    install_review_state_watch,
)
from code_reviewer_runner.supersede import (
    PROCESS_SIGNAL,
    SupersedeSignal,
    WriteGuardError,
    handling_the_signal,
    install_write_guard,
)
from code_reviewer_runner.supersede_timing import SUPERSEDED_DRAIN_SECONDS
from code_reviewer_runner.temperature_patch import TemperaturePatchError, apply_temperature_patch
from code_reviewer_runner.usage_probe import UsageProbe

PROGRAM_NAME = "code-reviewer-run-job"
_ERROR_LEVEL = 40
TIMEOUT_VARIABLE = "RUNNER_JOB_TIMEOUT_SECONDS"
# How long the watchdog waits after the soft timeout before it ends a command that does not react.
HARD_TIMEOUT_GRACE_SECONDS = 3.0


def _elapsed_ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)


def _failure(
    code: ErrorCode,
    detail: str,
    started: float,
    capture: LogCapture | None,
    *,
    reason: str | None = None,
    facts: Sequence[str] = (),
    usage: Usage | None = None,
) -> JobResult:
    """A failed result. `reason` is the stable finer name of the failure; `facts` are extra lines
    that belong with the verdict (counts and stable names only, never repository content).
    `usage` is what the run used before it failed, when it reached the model (#273)."""
    tail, truncated = capture.snapshot() if capture is not None else ("", False)
    # The code, the reason and the detail are the most important part: they stay, the old log
    # lines make room.
    header = f"{code.value}{f' [{reason}]' if reason else ''}: {detail}"
    header = "\n".join([header, *facts])
    room = max(MAX_TAIL_BYTES - len(header.encode("utf-8")) - 1, 0)
    fitted = fit_to_bytes(tail, room)
    return JobResult(
        ok=False,
        duration_ms=_elapsed_ms(started),
        comment_url=None,
        error_code=code,
        log_tail=fit_to_bytes(header + (f"\n{fitted}" if fitted else ""), MAX_TAIL_BYTES),
        log_truncated=truncated or fitted != tail,
        usage=usage,
        error_reason=reason,
    )


class MeterSlot:
    """Where the meter of the Diff run in progress is found by the watchdog thread (#363).

    `main` creates it before it starts the watchdog and hands it to `run_job`, which fills it as
    soon as the meter is installed: the way a Dynamic run hands its `UsageProbe` over. The meter is
    guarded by a lock and its counters are read without any await or I/O, so the watchdog can read
    it from its own thread while the event loop is blocked. Empty means no request can have been
    sent.
    """

    def __init__(self) -> None:
        self.meter: DiffCostMeter | None = None


def _unreported_use(usage: Usage | None, meter: DiffCostMeter | None) -> str | None:
    """The reason of a failed Diff run whose model use PR-Agent did not measure (#363).

    PR-Agent counts only the calls that came back. A run that ends while a request is in flight (or
    after an answer it threw away) has no usage, but the model may have worked on it, so the result
    says that and the app counts the run with an unknown cost instead of voiding it. A run that
    reported usage needs no reason, and one that sent no request (or only requests the provider
    refused) stays without one.
    """
    if usage is not None or meter is None or not meter.may_have_used_the_model:
        return None
    return NO_RESULT_REASON


def _may_write(superseded: SupersedeSignal) -> Callable[[], bool]:
    return lambda: not superseded.is_set()


def _publish_checked(
    superseded: SupersedeSignal,
) -> Callable[[Job, DynamicFindings], Published]:
    def publish(job: Job, findings: DynamicFindings) -> Published:
        return publish_run(job, findings, may_write=_may_write(superseded))

    return publish


def as_superseded(result: JobResult, started: float, detail: str) -> JobResult:
    """The result of a run that was told it was superseded (#396), whatever else it came to.

    A run that published before it heard of it (`ok`) stays what it is: its review is on the pull
    request. Any other end is `superseded`: nothing was published after the signal (the write guard,
    and the Dynamic path checks first), and the usage the run measured stays, with the reason it
    carries (an unmeasured request in flight makes the cost unknown, as for any run).
    """
    if result.ok:
        return result
    header = f"{ErrorCode.SUPERSEDED.value}: {detail}"
    tail = fit_to_bytes(f"{header}\n{result.log_tail}", MAX_TAIL_BYTES)
    return replace(
        result,
        comment_url=None,
        error_code=ErrorCode.SUPERSEDED,
        log_tail=tail,
        log_truncated=result.log_truncated or tail != f"{header}\n{result.log_tail}",
    )


SUPERSEDED_DETAIL = (
    "a newer push replaced this run; no further model request was made and nothing was published"
)


def run_job(
    job: Job,
    capture: LogCapture,
    started: float,
    timeout_seconds: float | None = None,
    meter_slot: MeterSlot | None = None,
    superseded: SupersedeSignal = PROCESS_SIGNAL,
) -> JobResult:
    """Run the job's command with PR-Agent. Never raises: every failure becomes a result.

    `meter_slot` is given the meter of the run as soon as it exists, so the watchdog can tell
    whether a request was sent when it has to end a command that blocks the event loop (#363).

    A run that is superseded meanwhile (#396) finishes the model requests in flight, sends no more,
    writes nothing to GitHub and ends `superseded` with the usage it measured."""
    result = _run_diff_job(job, capture, started, timeout_seconds, meter_slot, superseded)
    return as_superseded(result, started, SUPERSEDED_DETAIL) if superseded.is_set() else result


def _run_diff_job(
    job: Job,
    capture: LogCapture,
    started: float,
    timeout_seconds: float | None,
    meter_slot: MeterSlot | None,
    superseded: SupersedeSignal,
) -> JobResult:
    # Everything that is patched into PR-Agent is undone in the end, whichever install fails.
    patches = ExitStack()
    try:
        try:
            check_pr_agent_version()
            import litellm

            litellm.suppress_debug_info = True
            patches.callback(apply_identity_patch(job.git.bot_login))
            provider = require_provider(job.llm.provider)
            # No temperature for a model that does not take it (#477): by the version of its name,
            # or by the flag of the provider's own list.
            patches.callback(apply_temperature_patch(provider=provider))
            if job.llm.require_parameters:
                # Every request carries the provider's require-parameters field (#270).
                patches.callback(apply_require_parameters_patch(provider=provider))
            # The cost of the run is what the provider states for every answer (#274), or, for a
            # provider that states none, what its usage costs by the price list (#511).
            meter, undo_meter = install_cost_meter(superseded=superseded, provider=provider)
            patches.callback(undo_meter)
            if meter_slot is not None:
                meter_slot.meter = meter
        except IdentityPatchError as error:
            return _failure(error.code, error.detail, started, capture)
        except CostMeterError as error:
            # Fails closed: a run that cannot be measured is not started.
            return _failure(
                ErrorCode.RUNNER_ERROR,
                f"cannot measure the model cost of PR-Agent: {error}",
                started,
                capture,
            )
        except RequireParametersPatchError as error:
            # Fails closed: no request goes out without the field. The cause is named in the result.
            return _failure(
                ErrorCode.RUNNER_ERROR,
                f"cannot patch the OpenRouter request controls of PR-Agent: {error}",
                started,
                capture,
            )
        except TemperaturePatchError as error:
            # Fails closed, like the patch above: a request that would carry `temperature` to a
            # model that does not take it never goes out. The cause is named in the result.
            return _failure(
                ErrorCode.RUNNER_ERROR,
                f"cannot patch the temperature handling of PR-Agent: {error}",
                started,
                capture,
            )
        except Exception as error:
            capture.add(_ERROR_LEVEL, "ERROR", "cannot load PR-Agent", error)
            return _failure(ErrorCode.RUNNER_ERROR, "cannot load PR-Agent", started, capture)

        # Only a review keeps a record of findings that can outgrow the comment.
        watch = ReviewStateWatch()
        if job.command is Command.REVIEW:
            try:
                watch, undo_watch = install_review_state_watch()
            except WatchError as error:
                capture.add(_ERROR_LEVEL, "ERROR", "cannot watch the review state", error)
                return _failure(
                    ErrorCode.RUNNER_ERROR, "cannot watch the review state", started, capture
                )
            patches.callback(undo_watch)

        recorder: CommentRecorder
        recorder, undo_recorder = install_comment_recorder()
        patches.callback(undo_recorder)
        guard, undo_guard = install_repo_settings_guard()
        patches.callback(undo_guard)
        try:
            # Last, so it is the outermost: once the run is superseded nothing reaches GitHub
            # (#396).
            _writes, undo_writes = install_write_guard(superseded)
        except WriteGuardError as error:
            return _failure(
                ErrorCode.RUNNER_ERROR,
                f"cannot guard the writes of PR-Agent: {error}",
                started,
                capture,
            )
        patches.callback(undo_writes)
        # What PR-Agent measured is kept for a command that fails after its model call (#273).
        probe = UsageProbe()
        try:
            # The soft timeout counts from `started`, like the watchdog (#387).
            deadline = None if timeout_seconds is None else started + timeout_seconds
            handled, failed_flag, usage = asyncio.run(execute(job, guard, deadline, probe, meter))
        except JobTimeout:
            usage = probe.usage()
            return _failure(
                ErrorCode.TIMEOUT,
                "the command did not finish in time",
                started,
                capture,
                usage=usage,
                reason=_unreported_use(usage, meter),
            )
        except InvalidOption as error:
            # The key is an env name that parse_job validated; the value is never echoed.
            return _failure(
                ErrorCode.INVALID_JOB,
                f"the value of env option {error.key} does not fit the type of the option",
                started,
                capture,
            )
        except KeyboardInterrupt:
            raise
        except BaseException as error:  # SystemExit and friends from a library included
            capture.add(_ERROR_LEVEL, "ERROR", "handle_request raised", error)
            code = classify_failure(capture.exceptions, capture.error_messages)
            usage = probe.usage()
            return _failure(
                code or ErrorCode.UNKNOWN,
                "the command raised",
                started,
                capture,
                usage=usage,
                reason=_unreported_use(usage, meter),
            )
    finally:
        patches.close()

    failure_comment = recorder.failure_comment_posted()
    comment_url = None if failure_comment else recorder.comment_url()
    ok = handled and not failed_flag and not failure_comment
    error_code: ErrorCode | None = None
    truncation = _truncation(job.command, watch, recorder) if ok else None
    if truncation is not None:
        # PR-Agent shortened the review to fit GitHub's limit and went on as if nothing happened:
        # findings are lost, which the caller must see. The comment, if one was found, stays.
        ok = False
        error_code = truncation
    elif ok and job.command is Command.REVIEW and comment_url is None:
        # handle_request returned normally but nothing was posted: a failure the caller must see.
        ok = False
        error_code = ErrorCode.REVIEW_NOT_PUBLISHED
    elif not ok:
        messages = [*capture.error_messages, *recorder.failure_comment_texts()]
        error_code = classify_failure(capture.exceptions, messages)
        if error_code in (None, ErrorCode.UNKNOWN) and (failed_flag or failure_comment):
            error_code = ErrorCode.COMMAND_FAILED
        error_code = error_code or ErrorCode.UNKNOWN
    log_tail, log_truncated = capture.snapshot()
    # A failed command reports usage only when it reached the model.
    reported = usage if ok else probe.usage()
    return JobResult(
        ok=ok,
        duration_ms=_elapsed_ms(started),
        comment_url=comment_url,
        error_code=error_code,
        log_tail=log_tail,
        log_truncated=log_truncated,
        usage=reported,
        error_reason=None if ok else _unreported_use(reported, meter),
        findings=_diff_findings(ok, job.command, watch),
    )


DYNAMIC_CAPABILITIES_VARIABLE = "RUNNER_DYNAMIC_CAPABILITIES"
DYNAMIC_MAX_COST_VARIABLE = "RUNNER_DYNAMIC_MAX_COST_USD"
DYNAMIC_NODE_BIN_VARIABLE = "RUNNER_DYNAMIC_NODE_BIN"


def dynamic_ledger(
    capabilities: DynamicCapabilities, environment: Mapping[str, str], deadline: float
) -> BudgetLedger:
    """The ledger of one Dynamic run, from trusted runner configuration only (#290).

    The window and the unit costs are the model's (its descriptor, and a model without unit costs
    is refused); the cost limit is the operator's (`RUNNER_DYNAMIC_MAX_COST_USD`, up to a ceiling
    in code). Nothing of the job takes part: the project's Diff "Token budget" (`llm.maxTokens`)
    is not the window of a Dynamic run, and neither the claim nor the repository can name a limit.
    """
    # A model that cannot serve the run at all is named first, then one that cannot be priced.
    capabilities.check_required()
    limits = DynamicLimits(
        deadline_seconds=deadline,
        max_cost_usd=max_cost_from_environment(environment.get(DYNAMIC_MAX_COST_VARIABLE)),
    )
    # A cost that cannot be priced cannot be bounded before it is spent: a model without unit
    # costs (only the default model has them built in) does not run, and nothing is assumed.
    if capabilities.unit_costs is None:
        raise LimitError(
            ErrorCode.DYNAMIC_CONFIG_INVALID,
            "the capability descriptor of the model has no unit costs "
            "(input_usd_per_mtok and output_usd_per_mtok)",
        )
    return BudgetLedger(
        limits,
        window_tokens=capabilities.context_window_tokens,
        output_tokens=capabilities.max_output_tokens,
        reserved_output_tokens=capabilities.reserved_output_tokens,
        unit_costs=capabilities.unit_costs,
    )


def _turn_note(turn_seconds: Sequence[float]) -> str:
    """How long each engine message call took: numbers only, never text from the repository."""
    if not turn_seconds:
        return ""
    return "engine message call: " + ", ".join(f"{seconds:.1f} s" for seconds in turn_seconds)


def run_dynamic_job(
    job: Job,
    capture: LogCapture | None,
    started: float,
    environment: Mapping[str, str],
    timeout_seconds: float | None = None,
    *,
    engines: Sequence[str] = (),
    prepare: ContentPreparer | None = None,
    publish: Callable[[Job, DynamicFindings], Published] | None = None,
    lease_check: LeaseCheck | None = None,
    publish_failure: Callable[[Job, ErrorCode, str | None], Published | None] | None = None,
    usage_probe: UsageProbe | None = None,
    superseded: SupersedeSignal = PROCESS_SIGNAL,
) -> JobResult:
    """Run a Dynamic job with the read-only stock engine (#197) and publish its summary (#201).

    Everything that decides what the run may do comes from trusted runner configuration here: the
    engine command, the prepared checkout, the model capability descriptor and the model endpoint
    are environment and claim fields, never repository content. Anything missing is a stable
    refusal, never a fallback to PR-Agent or to Diff Review.

    The engine is stock and is never started in production until #202 proves the isolation
    (`capabilities.py` stays fail-closed, so `opencode` is not advertised and no Dynamic job
    reaches a runner). This function does not rely on that alone: `engines` is what the runner
    advertised, and a Dynamic job is refused unless it contains `opencode`, whatever else is
    configured. The default (nothing advertised) refuses.

    A failure that a developer can understand or act on also leaves a short note in the pull
    request's summary comment (#299, `add_failure_note`); the note never changes the result.

    A run that fails after at least one model call reports what it used (#273): the counters of the
    ledger, and the cost only when every call was priced. `usage_probe` lets the caller read the
    same from outside when the run does not end by returning (an error nobody expected, the
    watchdog).
    """
    result = _run_dynamic_job(
        job,
        capture,
        started,
        environment,
        timeout_seconds,
        engines=engines,
        prepare=prepare,
        publish=publish,
        lease_check=lease_check,
        usage_probe=usage_probe or UsageProbe(),
        superseded=superseded,
    )
    # A run that was superseded (#396) ends `superseded` with its ledger's usage and writes nothing,
    # not even the note of a failure: that code has no sentence.
    if superseded.is_set():
        result = as_superseded(result, started, SUPERSEDED_DETAIL)

    def note(job: Job, code: ErrorCode, reason: str | None) -> Published | None:
        # The last check, right before the one write (see "publishes nothing" in the README).
        return publish_failure_note(job, code, reason, may_write=_may_write(superseded))

    return add_failure_note(
        job, result, lease_check, publish_failure or note, started=started, superseded=superseded
    )


def add_failure_note(
    job: Job,
    result: JobResult,
    lease_check: LeaseCheck | None,
    write: Callable[[Job, ErrorCode, str | None], Published | None],
    *,
    started: float = 0.0,
    superseded: SupersedeSignal = PROCESS_SIGNAL,
) -> JobResult:
    """Leaves the note of a failed run in the summary comment and returns the result unchanged but
    for one line of the log (#299).

    A run the host knows to be superseded (the lease check answers so, which can be before the
    process got the signal) is a `superseded` run, not a failure with its old code (#396).

    Only a code with a fixed sentence writes (`failure_note.FAILURE_SENTENCES`); `lease_lost`, a
    refused token and the rest stay in the Runs view. A job that is no longer ours writes nothing,
    like a review (#260). Fail closed: whatever goes wrong while writing, the run keeps its code and
    its reason, and the log names only a stable code, never the failure's text.
    """
    code = result.error_code
    if result.ok or code is None or code not in FAILURE_SENTENCES:
        return result
    if lease_check is not None and (state := lease_check()) is not LeaseState.HELD:
        if state is LeaseState.SUPERSEDED:
            superseded.set()
            return as_superseded(result, started, SUPERSEDED_DETAIL)
        return result
    try:
        written = write(job, code, result.error_reason)
    except PublishError as error:
        if error.code is ErrorCode.SUPERSEDED:
            # The re-check right before the write found the run replaced: nothing was written.
            superseded.set()
            return as_superseded(result, started, SUPERSEDED_DETAIL)
        return _with_note_line(result, f"failure note: not written ({error.code.value})")
    except Exception:
        return _with_note_line(result, "failure note: not written")
    if written is None:
        return result
    return _with_note_line(result, "failure note: written")


def _with_note_line(result: JobResult, line: str) -> JobResult:
    tail = f"{result.log_tail}\n{line}"
    # The verdict at the top of the log matters more than this line: this one is dropped, never it.
    return result if len(tail.encode("utf-8")) > MAX_TAIL_BYTES else replace(result, log_tail=tail)


def _run_dynamic_job(
    job: Job,
    capture: LogCapture | None,
    started: float,
    environment: Mapping[str, str],
    timeout_seconds: float | None = None,
    *,
    engines: Sequence[str] = (),
    prepare: ContentPreparer | None = None,
    publish: Callable[[Job, DynamicFindings], Published] | None = None,
    lease_check: LeaseCheck | None = None,
    usage_probe: UsageProbe,
    superseded: SupersedeSignal = PROCESS_SIGNAL,
) -> JobResult:
    dynamic = job.dynamic
    base = job.base
    assert dynamic is not None and base is not None  # parse_job guarantees the tagged shape

    if ENGINE_DYNAMIC not in engines:
        return _failure(
            ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE,
            "the Dynamic engine is not advertised by this runner",
            started,
            capture,
        )

    command = shlex.split(environment.get(OPENCODE_COMMAND_VARIABLE, "").strip())
    if not command:
        return _failure(
            ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE,
            "no Dynamic engine is configured",
            started,
            capture,
        )
    # The `rg` the startup self-check verified, named by the loop and not looked up along the PATH.
    # Without one the adapter refuses to start the engine.
    ripgrep = (
        Path(named_ripgrep) if (named_ripgrep := environment.get(RIPGREP_PATH_VARIABLE)) else None
    )
    # The descriptor describes the destination the request really goes to, so it is chosen by the
    # upstream model (`llm.model`); `dynamic.model` is the logical name the engine sees, and the app
    # sends the same name in both.
    # The app's reading of the provider's metadata (#279) is narrowed by the operator's variable
    # and never widens it; without one this is the operator's descriptor alone, as before.
    try:
        capabilities = capabilities_for_job(
            environment.get(DYNAMIC_CAPABILITIES_VARIABLE), job.llm.model, dynamic.capabilities
        )
        # The cache is priced from the provider's own list (#540), never from the job.
        provider = require_provider(job.llm.provider)
        capabilities = with_cache_unit_costs(capabilities, provider.cache_unit_costs(job.llm.model))
        # The most a call reserves of its output allowance is the model's wire's to say (#533).
        capabilities = with_reserved_output(capabilities, provider.wire(job.llm.model))
    except LimitError as error:
        return _failure(error.code, error.detail, started, capture)

    # The run has what is left of the timeout, which counts from `started` (the first line of
    # `main()`) like the watchdog's does (#387). A run that starts late is therefore stopped by its
    # own deadline, with the clean result and what it used, before the watchdog could end it; the
    # wrap-up and the recovery reserve of the ledger are taken from this deadline, so they stay
    # consistent with it.
    deadline = TOTAL_DEADLINE_SECONDS
    if timeout_seconds is not None:
        remaining = timeout_seconds - (time.monotonic() - started)
        if remaining <= 0:
            return _failure(
                ErrorCode.TIMEOUT,
                "the command did not finish in time",
                started,
                capture,
                usage=usage_probe.usage(),
            )
        deadline = min(deadline, remaining)
    try:
        ledger = dynamic_ledger(capabilities, environment, deadline)
    except LimitError as error:
        return _failure(error.code, error.detail, started, capture)
    # From here on every failure says what the model calls so far cost (nothing before the first).
    usage_probe.watch(lambda: ledger.usage(job.llm.model))
    provider = require_provider(job.llm.provider)
    upstream = job.llm.base_url or provider.default_api_base
    # One unguessable capability per job: the proxy demands it, the engine config carries it.
    capability = new_proxy_capability()
    try:
        proxy = ModelProxy(
            ledger=ledger,
            base_path="/v1",
            model=dynamic.model,
            upstream_url=provider.wire(job.llm.model).url(upstream),
            upstream_api_key=job.llm.api_key,
            upstream_model=job.llm.model,
            capabilities=capabilities,
            capability=capability,
            require_parameters=job.llm.require_parameters,
            provider=provider,
            # Once superseded (#396) the proxy refuses every new request; one in flight finishes.
            superseded=superseded.is_set,
        )
    except LimitError as error:
        # The destination cannot serve the run: fail before the engine starts, with no fallback.
        return _failure(error.code, error.detail, started, capture)
    # Without an injected preparer this is the root supervisor: the export is prepared and sealed
    # for the dedicated engine user, and the engine is launched as that user (#197). A process
    # that is not the supervisor is refused there; the engine never runs unconfined.
    prepare = prepare or production_preparer(
        environment, cancelled=lambda: ledger.remaining_seconds() <= 0
    )
    try:
        with prepare(job) as prepared:
            prepared = prepared if isinstance(prepared, Prepared) else Prepared(prepared)
            content = prepared.content
            # The export is the one directory the engine may read; the audit names files relative
            # to it, and a finding may only point at a file it really holds.
            proxy.audit.set_export_root(str(content.export))
            # With the dedicated engine user the proxy listens on the slot's fixed port: the
            # engine user's static network rules name it. Somebody else holding it is a slot that
            # is not clean, and the job does not start.
            try:
                server = proxy.serve(
                    "127.0.0.1", prepared.launch.proxy_port if prepared.launch else 0
                ).start()
            except OSError:
                return _failure(
                    ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED,
                    "the model proxy port of the slot is not free",
                    started,
                    capture,
                )
            try:
                engine = DynamicEngine(
                    job,
                    ledger=ledger,
                    command=command,
                    directory=str(content.export),
                    proxy_url=server.url,
                    proxy_capability=capability,
                    agent_prompt=compose_system_prompt(dynamic.skill, base.head_sha),
                    model_schema=findings_schema(),
                    inputs=review_inputs(job.pr_url, content),
                    exported_paths=frozenset(content.files),
                    launch=prepared.launch,
                    node_bin=environment.get(DYNAMIC_NODE_BIN_VARIABLE) or None,
                    ripgrep=ripgrep,
                    superseded=superseded.is_set,
                )
                answer = engine.run()
                turn_note = _turn_note(engine.turn_seconds)
                recovery_note = engine.recovery
            finally:
                # A request the engine had in flight when the run ended is waited for if the run was
                # superseded: its answer is measured, so the cost is known instead of lost (#396).
                server.stop(drain_seconds=SUPERSEDED_DRAIN_SECONDS if superseded.is_set() else 0.0)
    except CheckoutError as error:
        return _failure(
            error.code,
            "the pull request could not be prepared",
            started,
            capture,
            reason=error.reason.value,
            facts=[f"checkout: {error.metrics.describe()}"] if error.metrics else [],
            usage=usage_probe.usage(),
        )

    if answer.error is not None:
        detail = answer.error.detail + (f" [{turn_note}]" if turn_note else "")
        return _failure(answer.error.code, detail, started, capture, usage=usage_probe.usage())
    assert answer.findings is not None
    # The summary is written by this supervisor, never by the engine, and only for a run whose
    # findings passed every check above: any earlier failure leaves the previous comment untouched.
    # A run whose job is no longer ours (lease lost, cancelled) writes nothing (#260). Without a
    # check (a process the loop did not start) there is no lease to ask about.
    if superseded.is_set():
        return _failure(
            ErrorCode.SUPERSEDED, SUPERSEDED_DETAIL, started, capture, usage=usage_probe.usage()
        )
    if lease_check is not None and (state := lease_check()) is not LeaseState.HELD:
        if state is LeaseState.SUPERSEDED:
            return _failure(
                ErrorCode.SUPERSEDED, SUPERSEDED_DETAIL, started, capture, usage=usage_probe.usage()
            )
        detail = (
            "the lease could not be confirmed, so nothing was written"
            if state is LeaseState.UNCONFIRMED
            else "the job is no longer held by this runner, so nothing was written"
        )
        return _failure(ErrorCode.LEASE_LOST, detail, started, capture, usage=usage_probe.usage())
    try:
        # A review that was wrapped up at its limit says so in the summary; the reason is the
        # ledger's, never the model's.
        findings = replace(answer.findings, stopped_early=ledger.stopped_early)
        # The check is repeated right before the one write (`may_write`); a signal after it is too
        # late for any process, and is the reason the README does not call "publishes nothing"
        # absolute.
        published = (publish or _publish_checked(superseded))(job, findings)
    except PublishError as error:
        return _failure(error.code, error.detail, started, capture, usage=usage_probe.usage())
    summary = (
        f"dynamic review: {len(answer.findings.findings)} findings against {base.head_sha}; "
        f"{ledger.model_calls} model calls, {ledger.tool_calls} tool calls, {ledger.files} files"
    )
    if answer.findings.dropped_outside_export:
        summary += (
            f"; dropped {answer.findings.dropped_outside_export} finding(s): "
            f"{DROPPED_OUTSIDE_EXPORT}"
        )
    if answer.findings.dropped_invalid:
        reasons = "; ".join(answer.findings.dropped_invalid_reasons)
        summary += (
            f"; dropped {answer.findings.dropped_invalid} finding(s): {DROPPED_INVALID} ({reasons})"
        )
    if answer.findings.envelope_overrides:
        # The runner owns these constants (#530); the log says which the model left out or got
        # wrong, never what it wrote.
        summary += f"; envelope set by the runner ({', '.join(answer.findings.envelope_overrides)})"
    if published.reset:
        summary += f"; {STATE_RESET_CODE}"
    if findings.stopped_early is not None:
        summary += f"; stopped early ({findings.stopped_early})"
    if recovery_note is not None:
        # A turn ended without an answer and one more turn returned it (#309): a complete review,
        # not a limit, so it is in the log and not in the comment.
        summary += f"; recovered after a turn without an answer ({recovery_note})"
    if turn_note:
        summary += f"; {turn_note}"
    summary += f"\ncheckout: {content.metrics.describe()}"
    return JobResult(
        ok=True,
        duration_ms=_elapsed_ms(started),
        comment_url=published.comment_url,
        error_code=None,
        log_tail=summary,
        usage=ledger.usage(job.llm.model),
        findings=published.findings,
    )


def _diff_findings(ok: bool, command: Command, watch: ReviewStateWatch) -> ReviewFindings | None:
    """The findings PR-Agent holds as active after a successful review, for the verdict (#405).

    PR-Agent gives its findings no severity, so there is a count and no breakdown. None when the run
    failed or the review tool wrote no record: the app then submits no verdict.
    """
    if not ok or command is not Command.REVIEW or watch.active_findings is None:
        return None
    return ReviewFindings(
        open=watch.active_findings,
        by_severity=None,
        # A failed chunk or a file left out may hide a finding: zero active is then not "none".
        incomplete=watch.coverage_complete is not True,
    )


def _truncation(
    command: Command, watch: ReviewStateWatch, recorder: CommentRecorder
) -> ErrorCode | None:
    """The code for a review that was shortened to fit the comment limit, or None.

    A lost record is the worse loss (findings are forgotten from now on), so it is named first. A
    review comment the provider had to cut by itself is a cut review too, however it got there.
    """
    if command is not Command.REVIEW:
        return None
    if watch.state_did_not_fit:
        return ErrorCode.REVIEW_STATE_TRUNCATED
    if watch.text_cut or recorder.cut_comment_posted():
        return ErrorCode.REVIEW_TEXT_TRUNCATED
    return None


def _ensure_clean(result: JobResult, secrets: Sequence[str]) -> JobResult:
    """Last line of defence: no secret of the job may be in the line that is printed."""
    line = result.to_line()
    if not any(secret and secret in line for secret in secrets):
        return result
    return replace(result, log_tail=REDACTED, log_truncated=True, comment_url=None)


class _ResultChannel:
    """Writes the result line exactly once, however the normal path and the watchdog race."""

    def __init__(self, out: TextIO) -> None:
        self._out = out
        self._lock = threading.Lock()
        self._written = False

    def write(self, result: JobResult, secrets: Sequence[str] = ()) -> int | None:
        """Print the result. Returns the exit code, or None if a result was printed before."""
        with self._lock:
            if self._written:
                return None
            self._written = True
            result = _ensure_clean(result, secrets)
            self._out.write(result.to_line() + "\n")
            self._out.flush()
            return result.exit_code


def _read_stdin(stdin: TextIO) -> str:
    return stdin.read(MAX_JOB_BYTES + 1)


def _timeout_from(environment: Mapping[str, str]) -> float | None:
    """RUNNER_JOB_TIMEOUT_SECONDS of the parent process; missing or unusable means no timeout."""
    raw = environment.get(TIMEOUT_VARIABLE, "").strip()
    try:
        seconds = float(raw)
    except ValueError:
        return None
    return seconds if 0 < seconds < float("inf") else None


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=PROGRAM_NAME,
        description="Runs one PR-Agent command. The job is read as JSON from stdin; the result "
        "is printed as one line of JSON on stdout.",
    )
    parser.add_argument("--version", action="version", version=f"{PROGRAM_NAME} {__version__}")
    return parser


# After a SIGTERM the job unwinds (engine, proxy, export and leases are released by the `finally`
# blocks); if that has not finished in this time the engines are killed and the process ends. The
# job loop sends SIGKILL after its own grace (five seconds by default), so this is shorter.
SIGTERM_BACKSTOP_SECONDS = 3.0


def _stop_hard() -> None:
    shutdown_engines()
    os._exit(128 + signal.SIGTERM)


@contextmanager
def _unwind_on_sigterm() -> Generator[None]:
    """A Dynamic job that gets SIGTERM ends its engine, helpers, proxy and export (#197-T07).

    The job loop ends a job this way on lease loss, shutdown and timeout. The engine leads a
    process group of its own (and runs as another user), so the default action (die at once) would
    leave it running. The handler unwinds the job as a `KeyboardInterrupt` and arms a backstop
    that kills everything if the unwinding takes too long.
    """

    def on_term(signum: int, frame: object) -> None:
        backstop = threading.Timer(SIGTERM_BACKSTOP_SECONDS, _stop_hard)
        backstop.daemon = True
        backstop.start()
        raise KeyboardInterrupt

    try:
        previous = signal.signal(signal.SIGTERM, on_term)
    except ValueError:  # not the main thread: nothing to install
        yield
        return
    try:
        yield
    finally:
        signal.signal(signal.SIGTERM, previous)


def _probe_usage(probe: UsageProbe | None) -> Usage | None:
    """The usage a failure may carry. Reading it must never stop the failure from being reported."""
    try:
        return probe.usage() if probe is not None else None
    except Exception:
        return None


def _watchdog_reason(probe: UsageProbe | None, meter_slot: MeterSlot | None) -> str | None:
    """The `errorReason` of a run the watchdog ends. A Dynamic run (a probe) reads its ledger."""
    if probe is not None:
        return None
    if meter_slot is None:
        return NO_RESULT_REASON
    try:
        return _unreported_use(None, meter_slot.meter)
    except Exception:
        # Reading must never stop the failure from being reported; unreadable means unknown.
        return NO_RESULT_REASON


def _start_watchdog(
    seconds: float,
    channel: _ResultChannel,
    started: float,
    capture: LogCapture | None,
    secrets: Sequence[str],
    probe: UsageProbe | None = None,
    meter_slot: MeterSlot | None = None,
) -> threading.Timer:
    """Last resort for a command that blocks the event loop and so ignores the soft timeout.

    A Dynamic run hands over its `probe`: the ledger can be read from this thread, so the result
    still says what the run used (#273). A Diff command keeps its measurements in the context of
    the blocked event loop, which this thread cannot read; its timeout result carries none, but the
    meter of its model function is lock guarded and safe to read from here: a run that sent no
    request stays void, and one with a request open (or answered but uncounted) is reported as
    possibly used (#363). A watchdog without a meter slot cannot tell and reports the reason.
    """

    def fire() -> None:
        # A Dynamic engine runs in its own process group (it can outlive this process); end it
        # before this process ends, so no engine or helper survives the timeout (#197-T07).
        shutdown_engines()
        usage = _probe_usage(probe)
        # A Diff command's usage lives in the blocked event loop and cannot be read from here, but
        # its meter can: the reason says that the model may have been used (#273, #363).
        reason = _watchdog_reason(probe, meter_slot)
        try:
            result = _failure(
                ErrorCode.TIMEOUT,
                "the command did not stop in time",
                started,
                capture,
                usage=usage,
                reason=reason,
            )
        except Exception:
            result = JobResult(
                ok=False,
                duration_ms=_elapsed_ms(started),
                comment_url=None,
                error_code=ErrorCode.TIMEOUT,
                log_tail="timeout: the command did not stop in time",
                log_truncated=True,
                usage=usage,
                error_reason=reason,
            )
        try:
            written = channel.write(result, secrets)
        except Exception:
            written = 1
        if written is not None:
            os._exit(1)

    timer = threading.Timer(seconds + HARD_TIMEOUT_GRACE_SECONDS, fire)
    timer.daemon = True
    timer.start()
    return timer


def main(
    argv: Sequence[str] | None = None,
    *,
    stdin: TextIO | None = None,
    stdout: TextIO | None = None,
) -> int:
    """Entry point of the console script. Returns the process exit code.

    `SIGUSR1` means that the run was superseded (#396): the handler is in place for the whole
    run."""
    with handling_the_signal():
        return _main(argv, stdin=stdin, stdout=stdout)


def _main(
    argv: Sequence[str] | None = None,
    *,
    stdin: TextIO | None = None,
    stdout: TextIO | None = None,
) -> int:
    started = time.monotonic()
    try:
        _build_parser().parse_args(argv)
    except SystemExit as exit_request:
        return exit_request.code if isinstance(exit_request.code, int) else 1

    channel = _ResultChannel(stdout or sys.stdout)
    real_stderr = sys.stderr
    # loguru's default handler writes DEBUG records (prompts, diffs) to stderr unredacted.
    logger.remove()

    try:
        job = parse_job(_read_stdin(stdin or sys.stdin))
    except JobError as error:
        return _exit_code(channel.write(_failure(error.code, error.detail, started, None)))
    except UnicodeDecodeError:
        return _exit_code(
            channel.write(_failure(ErrorCode.INVALID_JOB, "stdin is not UTF-8 text", started, None))
        )
    except Exception:
        return _exit_code(
            channel.write(_failure(ErrorCode.RUNNER_ERROR, "cannot read the job", started, None))
        )

    saved_env = dict(os.environ)
    if job.review_kind is ReviewKind.DYNAMIC:
        # A Dynamic job is never run by PR-Agent (#195/#197). It gets the same process-level timeout
        # as a Diff job; on expiry the watchdog ends the engine's process group too (#197-T07).
        dynamic_timeout = _timeout_from(saved_env)
        # What the run used so far, for the paths that end it without a normal return (#273).
        dynamic_probe = UsageProbe()
        dynamic_watchdog = (
            _start_watchdog(dynamic_timeout, channel, started, None, job.secrets, dynamic_probe)
            if dynamic_timeout
            else None
        )
        try:
            with _unwind_on_sigterm():
                result = run_dynamic_job(
                    job,
                    None,
                    started,
                    saved_env,
                    dynamic_timeout,
                    engines=engines_from_environment(saved_env),
                    lease_check=lease_check_from_environment(saved_env, required=True),
                    usage_probe=dynamic_probe,
                )
        except KeyboardInterrupt:
            raise
        except BaseException:
            result = _failure(
                ErrorCode.RUNNER_ERROR,
                "unexpected runner error",
                started,
                None,
                usage=_probe_usage(dynamic_probe),
            )
        finally:
            if dynamic_watchdog is not None:
                dynamic_watchdog.cancel()
        return _exit_code(channel.write(result, job.secrets))

    redactor = Redactor(job.secrets)
    capture = LogCapture(redactor)
    saved_streams: tuple[Any, Any] = (sys.stdout, sys.stderr)
    timeout_seconds = _timeout_from(saved_env)
    # Where the watchdog finds the meter of the run, once `run_job` has installed it (#363).
    meter_slot = MeterSlot()
    watchdog = (
        _start_watchdog(timeout_seconds, channel, started, capture, job.secrets, None, meter_slot)
        if timeout_seconds
        else None
    )
    # Anything that prints (PR-Agent, LiteLLM, a library) must neither pollute stdout, which carries
    # the result, nor leak a secret to stderr.
    guarded = RedactingStream(real_stderr, redactor)
    sys.stdout = guarded  # type: ignore[assignment]
    sys.stderr = guarded  # type: ignore[assignment]
    sink_id = logger.add(capture, level="INFO", format="{message}")
    stdlib_handler = StdlibLogHandler(capture)
    logging.getLogger().addHandler(stdlib_handler)
    try:
        os.environ.clear()
        os.environ.update(build_environment(job, saved_env))
        try:
            result = run_job(job, capture, started, timeout_seconds, meter_slot=meter_slot)
        except KeyboardInterrupt:
            raise
        except BaseException as error:
            capture.add(_ERROR_LEVEL, "ERROR", "unexpected runner error", error)
            result = _failure(ErrorCode.RUNNER_ERROR, "unexpected runner error", started, capture)
    finally:
        if watchdog is not None:
            watchdog.cancel()
        logging.getLogger().removeHandler(stdlib_handler)
        logger.remove(sink_id)
        guarded.close()
        sys.stdout, sys.stderr = saved_streams
        os.environ.clear()
        os.environ.update(saved_env)
    return _exit_code(channel.write(result, job.secrets))


def _exit_code(written: int | None) -> int:
    # None: the watchdog printed the result first and ends the process itself.
    return 1 if written is None else written


if __name__ == "__main__":
    sys.exit(main())
