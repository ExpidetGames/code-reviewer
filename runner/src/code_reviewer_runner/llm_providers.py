# SPDX-License-Identifier: Apache-2.0

"""The registry of the LLM providers the runner can talk to (#424, ADR 0005 2.4).

One entry per provider, keyed by the slug the job names in `llm.provider`. What used to be
OpenRouter-specific code scattered over the runner is a field of the entry: the LiteLLM prefix, the
default API base, the names of the PR-Agent key and base settings, how a request is told to route
only to endpoints that support every parameter, the matcher for "no endpoint supports these
parameters", the cost of a call (a charge the provider states, or one computed from its usage and a
price list), whether a model takes `temperature`, the output a Diff run asks for, and how the
Dynamic proxy speaks to the provider (`provider_wire.py`). `job.py`, `pr_agent_config.py`, the
require-parameters patch, `temperature_patch.py`, `diff_cost.py`, `runner.py`, the Dynamic proxy and
`repo_settings_guard.py` read the entry of the job's provider; none of them names a provider.

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

from code_reviewer_runner.anthropic_cost import cost_of_usage
from code_reviewer_runner.anthropic_models import model_for as claude_model
from code_reviewer_runner.anthropic_wire import AnthropicMessagesWire
from code_reviewer_runner.dynamic_review.budget import exact_cost
from code_reviewer_runner.provider_wire import OpenAiChatWire, OpenRouterWire, UpstreamWire
from code_reviewer_runner.usage_access import usage_field

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


def _same_base(base: str) -> str:
    return base


def _no_opinion(model: str) -> bool | None:
    return None


def _no_limit(model: str) -> int | None:
    return None


def _no_cache_unit_costs(model: str) -> tuple[Decimal, Decimal] | None:
    return None


def _openai_chat_wire(model: str) -> UpstreamWire:
    return OpenAiChatWire()


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
    # The cost of one call to `model` (the bare name, no prefix) from the `usage` of its answer, a
    # mapping or an object: the charge the provider states, or one computed from the token counts.
    # None when the call cannot be priced exactly: an unknown cost, never zero.
    cost_extractor: Callable[[str, object], Decimal | None]
    # The API base as LiteLLM wants it, from the one of the job (which may carry a version path
    # that LiteLLM adds itself).
    litellm_api_base: Callable[[str], str] = _same_base
    # Whether a request to `model` may carry `temperature`: the provider's own knowledge of the
    # model. None leaves the decision to the name rules of `temperature_patch.py`.
    supports_temperature: Callable[[str], bool | None] = _no_opinion
    # The output a Diff run asks `model` for, in tokens; None leaves it to the provider's default.
    diff_output_tokens: Callable[[str], int | None] = _no_limit
    # The context window of `model` for PR-Agent, which does not know every model; None if unknown.
    context_window: Callable[[str], int | None] = _no_limit
    # How the Dynamic proxy speaks to the provider for `model`.
    wire: Callable[[str], UpstreamWire] = _openai_chat_wire
    # What a million tokens read from and written to the provider's cache cost for `model` (USD,
    # read then write), from the provider's own list; None when the runner has none (#540). The
    # cost guard of the Dynamic ledger prices the prompt of a call with them; the cost of a call
    # stays the charge or the exact price of its usage.
    cache_unit_costs: Callable[[str], tuple[Decimal, Decimal] | None] = _no_cache_unit_costs

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


def _openrouter_cost(model: str, usage: object) -> Decimal | None:
    """OpenRouter always returns `usage.cost`; there is no request flag to set. It is read, never
    computed: a call without it simply has no known cost."""
    return exact_cost(usage_field(usage, "cost"))


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
    # The chat protocol, with the breakpoints a Claude behind OpenRouter needs (#539).
    wire=OpenRouterWire,
)

# What a Diff run asks a Claude model for. Reasoning tokens count against the output limit, so
# LiteLLM's default of 4096 can be used up before the review is written. Below the size at which
# Anthropic's SDKs insist on streaming (21333 tokens), so a plain request is still fine.
_CLAUDE_DIFF_OUTPUT_TOKENS: Final = 16_000

# The API address of the job carries `/v1`; LiteLLM adds `/v1/messages` to the address it is given.
_VERSION_PATH = re.compile(r"/v1/?$")


def _anthropic_api_base(base: str) -> str:
    return _VERSION_PATH.sub("", base)


def _anthropic_supports_temperature(model: str) -> bool | None:
    """From the flag of the model in the list. A model that is not listed takes none: nothing is
    guessed from its name."""
    entry = claude_model(model)
    return entry is not None and entry.temperature


def _anthropic_diff_output_tokens(model: str) -> int | None:
    entry = claude_model(model)
    return None if entry is None else min(_CLAUDE_DIFF_OUTPUT_TOKENS, entry.max_output_tokens)


def _anthropic_context_window(model: str) -> int | None:
    entry = claude_model(model)
    return None if entry is None else entry.context_window_tokens


def _anthropic_cache_unit_costs(model: str) -> tuple[Decimal, Decimal] | None:
    """A cache write without a split is a five minute write, the lifetime the runner's requests use
    (`anthropic_cost.py`)."""
    entry = claude_model(model)
    return None if entry is None else (entry.prices.cache_read, entry.prices.cache_write_5m)


def _anthropic_cost(model: str, usage: object) -> Decimal | None:
    """Anthropic states token counts and no charge: the cost is computed from them and the price
    list of the model. Whatever else the answer says about a charge is not read."""
    return cost_of_usage(model, usage)


ANTHROPIC: Final = LlmProviderSpec(
    id="anthropic",
    litellm_prefix="anthropic/",
    default_api_base="https://api.anthropic.com/v1",
    key_setting="anthropic.key",
    api_base_setting="anthropic.api_base",
    # PR-Agent has no `anthropic.api_base`; its LiteLLM handler reads the address here.
    api_base_variable="ANTHROPIC_API_BASE",
    require_parameters=None,
    no_endpoint_for_parameters=lambda text: False,
    cost_extractor=_anthropic_cost,
    litellm_api_base=_anthropic_api_base,
    supports_temperature=_anthropic_supports_temperature,
    diff_output_tokens=_anthropic_diff_output_tokens,
    context_window=_anthropic_context_window,
    # The Messages API, not the OpenAI-compatible endpoint (not for production, no cache tokens).
    wire=AnthropicMessagesWire,
    cache_unit_costs=_anthropic_cache_unit_costs,
)

# A plain dict, so a test can register a second provider for the duration of one test.
PROVIDERS: Final[dict[str, LlmProviderSpec]] = {OPENROUTER.id: OPENROUTER, ANTHROPIC.id: ANTHROPIC}


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
