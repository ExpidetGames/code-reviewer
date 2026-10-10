# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false
"""The one place that calls PR-Agent's API.

PR-Agent ships no type information, so everything it returns is unknown to pyright. The checks are
relaxed for this file only, which keeps the untyped surface in one small module while the rest of
the runner stays strictly typed. The imports are inside `execute` on purpose: PR-Agent reads its
settings from the environment when it is first imported, so nothing may import it before the runner
has built the environment from the job.
"""

import copy
from typing import TYPE_CHECKING

from code_reviewer_runner.job import Job
from code_reviewer_runner.pr_agent_config import build_request, build_typed_settings
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


async def execute(job: Job) -> tuple[bool, bool, Usage | None]:
    """Run the command inside a request scope; returns (handled, command_failed, usage)."""
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
        settings = get_settings()
        for key, value in build_typed_settings().items():
            settings.set(key, value)
        init_run_details()
        # Awaited directly (no task): the run details live in a ContextVar of this task.
        handled = await PRAgent().handle_request(
            job.pr_url, build_request(job), propagate_tool_errors=True
        )
        return handled is True, command_failed(), _usage(get_run_details())
