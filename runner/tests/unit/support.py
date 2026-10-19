# SPDX-License-Identifier: Apache-2.0

"""Helpers shared by the unit tests that run PR-Agent's real settings code (not a test file)."""

import copy
import importlib
import json
from collections.abc import Generator
from contextlib import contextmanager
from typing import Any

from starlette_context import request_cycle_context  # pyright: ignore[reportUnknownVariableType]

from code_reviewer_runner.dynamic_review.budget import exact_cost
from code_reviewer_runner.job import Job, parse_job
from code_reviewer_runner.llm_providers import LlmProviderSpec, RequireParameters

TOKEN = "dummy-installation-token-0123456789"
API_KEY = "dummy-openrouter-key-0123456789"


def make_job_dict(**extra: Any) -> dict[str, Any]:
    job: dict[str, Any] = {
        "prUrl": "https://github.com/octo/repo/pull/7",
        "command": "review",
        "git": {
            "provider": "github",
            "baseUrl": "https://api.github.com",
            "token": TOKEN,
            "botLogin": "code-reviewer[bot]",
        },
        "llm": {"provider": "openrouter", "model": "deepseek/deepseek-chat", "apiKey": API_KEY},
    }
    job.update(extra)
    return job


def make_job(**extra: Any) -> Job:
    return parse_job(json.dumps(make_job_dict(**extra)))


def current() -> Any:  # Any: PR-Agent ships no type information
    from pr_agent.config_loader import get_settings

    return get_settings()  # pyright: ignore[reportUnknownVariableType]


@contextmanager
def request_scope() -> Generator[Any]:
    """A request scope like the runner's: a copy of PR-Agent's own settings, loaded first."""
    global_settings = current()
    global_settings.get("CONFIG.MODEL")  # Dynaconf loads lazily; a copy of an unread one is empty
    with request_cycle_context({"settings": copy.deepcopy(global_settings)}):
        yield current()


def pr_agent_module(name: str) -> Any:  # Any: PR-Agent ships no type information
    return importlib.import_module(name)


def fake_provider() -> LlmProviderSpec:
    """A second provider that shares nothing with OpenRouter, to prove the seam (#424)."""
    return LlmProviderSpec(
        id="fakeai",
        litellm_prefix="fakeai/",
        default_api_base="https://fakeai.invalid/v1",
        key_setting="fakeai.key",
        api_base_setting="fakeai.api_base",
        api_base_variable="FAKEAI__API_BASE",
        require_parameters=RequireParameters(
            request_controls_method="apply_fakeai_request_controls",
            body_field="routing",
            body_value={"strict": True},
        ),
        no_endpoint_for_parameters=lambda text: "nothing can serve" in text,
        cost_extractor=lambda usage: exact_cost(usage.get("price")),
    )
