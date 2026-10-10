# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false
"""The one place that calls PR-Agent's API.

PR-Agent ships no type information, so everything it returns is unknown to pyright. The checks are
relaxed for this file only, which keeps the untyped surface in one small module while the rest of
the runner stays strictly typed. The imports are inside `execute` on purpose: PR-Agent reads its
settings from the environment when it is first imported, so nothing may import it before the runner
has built the environment from the job.
"""

import asyncio
import copy
from typing import TYPE_CHECKING, Any

from code_reviewer_runner.job import Job
from code_reviewer_runner.pr_agent_config import (
    build_option_settings,
    build_request,
    build_secret_settings,
    build_typed_settings,
)
from code_reviewer_runner.repo_settings_guard import RepoSettingsGuard
from code_reviewer_runner.result import Usage

if TYPE_CHECKING:
    from pr_agent.algo.run_details import RunDetails


def _usage(details: "RunDetails | None") -> Usage | None:
    if details is None:
        return None
    return Usage(
        model=details.model_used,
        prompt_tokens=details.prompt_tokens,
        completion_tokens=details.completion_tokens,
        total_tokens=details.total_tokens,
        ai_calls=details.num_ai_calls,
        fallback_used=details.fallback_used,
        cost_usd=float(details.total_cost_usd) if details.known_cost_call_count else None,
    )


class JobTimeout(Exception):
    """The command did not finish within the time the runner was given."""


def configure_settings(job: Job, settings: Any, guard: RepoSettingsGuard) -> None:
    """Set everything the job decides on the settings of the current request scope.

    Typed values only, in this order: the switch that stops Dynaconf from evaluating texts, the
    other pins, the secrets, then the options of the job. Raises `InvalidOption` for an option
    value that does not fit the type of its option. The guard is told which settings were set, so it
    can put them back after a repository settings file was merged.
    """
    for key, value in build_typed_settings(job).items():
        settings.set(key, value)
    for key, value in build_secret_settings(job).items():
        settings.set(key, value)
    options = build_option_settings(job.env, lambda name: settings.get(name, None))
    for key, value in options.items():
        settings.set(key, value)
    guard.snapshot(settings, extra_keys=options)


async def execute(
    job: Job, guard: RepoSettingsGuard, timeout_seconds: float | None = None
) -> tuple[bool, bool, Usage | None]:
    """Run the command inside a request scope; returns (handled, command_failed, usage).

    `guard` is told which settings the runner has configured, right before the command starts, so
    it can put them back after a repository settings file was merged.

    Raises `InvalidOption` (before anything is sent anywhere) for an option of the job whose value
    does not fit its type.
    """
    from pr_agent.agent.pr_agent import PRAgent
    from pr_agent.algo.run_details import command_failed, get_run_details, init_run_details
    from pr_agent.config_loader import get_settings
    from starlette_context import request_cycle_context

    # The `settings` key is mandatory: provider caching and `get_settings()` both read it from the
    # context. The copy keeps the typed overrides off the module-global settings.
    global_settings = get_settings()
    # Dynaconf loads lazily on first access, and a copy of a settings object that was never
    # accessed is empty. Touch it first so the copy carries the environment and the defaults.
    global_settings.get("CONFIG.MODEL")
    with request_cycle_context({"settings": copy.deepcopy(global_settings)}):
        configure_settings(job, get_settings(), guard)
        init_run_details()
        # Awaited directly (no task): the run details live in a ContextVar of this task.
        # Only an await can be cancelled; the hard timeout of the entry point covers a call that
        # blocks the event loop.
        timeout = asyncio.timeout(timeout_seconds)
        try:
            async with timeout:
                handled = await PRAgent().handle_request(
                    job.pr_url, build_request(job), propagate_tool_errors=True
                )
        except TimeoutError:
            if timeout.expired():
                raise JobTimeout from None
            raise
        return handled is True, command_failed(), _usage(get_run_details())
