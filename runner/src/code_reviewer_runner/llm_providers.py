# SPDX-License-Identifier: Apache-2.0

"""The registry of the LLM providers the runner can talk to (#424, ADR 0005 2.4).

One entry per provider, keyed by the slug the job names in `llm.provider`. What used to be
OpenRouter-specific code scattered over the runner is a field of the entry: the LiteLLM prefix, the
default API base, the names of the PR-Agent key and base settings, how a request is told to route
only to endpoints that support every parameter, the matcher for "no endpoint supports these
parameters" and the extractor of the cost a provider states. `job.py`, `pr_agent_config.py`, the
require-parameters patch, `runner.py`, the Dynamic proxy and `repo_settings_guard.py` read the entry
of the job's provider; none of them names a provider.

The registry is also what the runner advertises (`llmProviders` of a claim and of the Worker's
details request), so an app never hands it a job for a provider it cannot read. A slug has the form
`PROVIDER_ID_PATTERN`, the same pattern as `LlmProviderId` in `contracts/runner-api.v1.json`; the
contract lists the slugs this release knows (`KnownLlmProvider`) and a test compares the two lists.
"""

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import Final

from code_reviewer_runner.dynamic_review.budget import exact_cost

PROVIDER_ID_PATTERN: Final = re.compile(r"^[a-z][a-z0-9_]{1,31}$")

# The only request fields the Dynamic proxy copies from the engine's request to the provider (the
# rest is dropped; `stream` and `stream_options` are absent on purpose). It lives here because a
# provider's `body_field` must not be one of them: the proxy sets that field after the copy and
# would overwrite what the engine sent.
PROXY_FORWARDED_FIELDS: Final = frozenset(
    {
        "messages",
        "tools",
        "tool_choice",
        "parallel_tool_calls",
        "temperature",
        "top_p",
        "frequency_penalty",
        "presence_penalty",
        "seed",
        "stop",
        "response_format",
    }
)


@dataclass(frozen=True)
class RequireParameters:
    """How a request says "route only to endpoints that support every parameter of it".

    The field states a capability requirement: it selects no endpoint and expresses no preference
    (epic #193, decision 6). `request_controls_method` is the PR-Agent handler method that builds
    the provider-specific part of a Diff request (the patch wraps it); `body_field` and `body_value`
    are what is added to the request body, by that patch and by the Dynamic proxy.
    """

    request_controls_method: str
    body_field: str
    body_value: Mapping[str, object]

    def __post_init__(self) -> None:
        if self.body_field in PROXY_FORWARDED_FIELDS:
            raise ValueError(
                f"require-parameters field {self.body_field!r} is a field the proxy forwarded"
            )


@dataclass(frozen=True)
class LlmProviderSpec:
    id: str
    # LiteLLM's routing prefix of a model name, with the trailing slash (`openrouter/`).
    litellm_prefix: str
    default_api_base: str
    # PR-Agent's settings for this provider: `<section>.key` and `<section>.api_base`, and the
    # environment variable that gives the API base (the environment wins over a repository file).
    key_setting: str
    api_base_setting: str
    api_base_variable: str
    # None: the provider has no such mechanism, so a job asking for it is refused by the patch.
    require_parameters: RequireParameters | None
    # True for the text of the provider's answer "no endpoint can serve the requested parameters".
    no_endpoint_for_parameters: Callable[[str], bool]
    # The charge the provider states in the `usage` object of an answer, None when it states none.
    cost_extractor: Callable[[Mapping[str, object]], Decimal | None]

    @property
    def settings_section(self) -> str:
        """The PR-Agent settings section of the provider (`openrouter`)."""
        return self.key_setting.split(".")[0]


# OpenRouter's answer (HTTP 404) when no endpoint can serve what the request asks for. The text
# depends on the parameter that lacks support; each of these was seen in public reports of
# https://openrouter.ai/api/v1/chat/completions (404, followed by a pointer to the provider routing
# docs): "...that can handle the requested parameters", "...that support tool use" and "...that
# support the provided 'tool_choice' value". The family is "no endpoints found that can handle /
# support ..."; "No endpoints found for <model>" and "...matching your data policy" are not in it.
_OPENROUTER_NO_ENDPOINT = re.compile(
    r"no endpoints found that (?:can handle|support)\b", re.IGNORECASE
)


def _openrouter_no_endpoint_for_parameters(text: str) -> bool:
    return _OPENROUTER_NO_ENDPOINT.search(text) is not None


def _openrouter_cost(usage: Mapping[str, object]) -> Decimal | None:
    """OpenRouter always returns `usage.cost`; there is no request flag to set. It is read, never
    computed: a call without it simply has no known cost."""
    return exact_cost(usage.get("cost"))


OPENROUTER: Final = LlmProviderSpec(
    id="openrouter",
    litellm_prefix="openrouter/",
    default_api_base="https://openrouter.ai/api/v1",
    key_setting="openrouter.key",
    api_base_setting="openrouter.api_base",
    api_base_variable="OPENROUTER__API_BASE",
    # OpenRouter may send a request to an endpoint that silently ignores a parameter it does not
    # support (`tools`, `tool_choice`, `response_format`). With `provider.require_parameters: true`
    # it routes only to endpoints that support every one, and answers 404 when there is none (#270).
    require_parameters=RequireParameters(
        request_controls_method="_apply_openrouter_request_controls",
        body_field="provider",
        body_value={"require_parameters": True},
    ),
    no_endpoint_for_parameters=_openrouter_no_endpoint_for_parameters,
    cost_extractor=_openrouter_cost,
)

# A plain dict, so a test can register a second provider for the duration of one test.
PROVIDERS: Final[dict[str, LlmProviderSpec]] = {OPENROUTER.id: OPENROUTER}


def provider_for(provider_id: str) -> LlmProviderSpec | None:
    """The entry of a slug, or None when the runner has none (also for a slug of the wrong form)."""
    return PROVIDERS.get(provider_id)


def require_provider(provider_id: str) -> LlmProviderSpec:
    """The entry of a slug for code that holds a parsed job (`parse_job` refused the rest)."""
    provider = PROVIDERS.get(provider_id)
    if provider is None:
        raise ValueError("unregistered LLM provider")
    return provider


def registered_provider_ids() -> tuple[str, ...]:
    """The slugs this runner advertises as `llmProviders`, in registration order."""
    return tuple(PROVIDERS)


def with_prefix(provider: LlmProviderSpec, model: str) -> str:
    """The model name as PR-Agent needs it to route through the provider."""
    prefix = provider.litellm_prefix
    return model if model.startswith(prefix) else f"{prefix}{model}"


def without_prefix(provider: LlmProviderSpec, model: str) -> str:
    """The model name without the routing prefix, to compare two names."""
    return model.removeprefix(provider.litellm_prefix)
