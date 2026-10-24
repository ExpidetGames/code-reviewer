# SPDX-License-Identifier: LicenseRef-Proprietary

"""Keeps `temperature` out of the request for the models that do not take it (#477).

OpenRouter lists no `temperature` among the `supported_parameters` of any Claude model from 4.7 on
(Opus 4.7 and 4.8, and the 5.x models of every family; 4.6 and older list it), nor of any OpenAI
GPT-6 model (`gpt-6-luna`, `gpt-6-sol`, `gpt-6.1-sol`, ...). A Diff job asks for
`provider.require_parameters: true` (#270), so a request that carries `temperature` finds no
endpoint and ends as a 404 that looks like an unknown model.

PR-Agent 0.47.0 withholds the parameter for a fixed list of families
(`claude-(opus-4-7|4-8|(opus|sonnet|fable)-5)`, `gpt-5*`, `gpt-6-astra`) and otherwise asks
litellm's metadata, which says yes for every `openrouter/*` model. So Haiku 5.x, the other GPT-6
models and every later family would carry it. Its `config.no_temperature_models` setting would work
for the ids known today, but it matches whole ids (exact or after a `/`), so every new point
release, `:variant` and future family would fail the same way until somebody added it. The runner
decides by version instead: the one place that asks whether a model takes `temperature`,
`LiteLLMAIHandler._litellm_supports_temperature`, answers no for a Claude model from 4.7 on, for a
GPT model from 6 on and for the `latest` aliases of both, and leaves every other answer to PR-Agent.

For a provider that knows its models (`LlmProviderSpec.supports_temperature`, the Anthropic list
of #511) the decision is the provider's flag for the model, never the name: the rules above are
not consulted, a model the provider does not list gets none, and PR-Agent's own answer can still
say no. A provider without an opinion keeps the rules above.

The patch reaches into a private method, so it is tied to the version it was written and tested for
(`identity_patch.check_pr_agent_version` runs before it, and the signature of the method is
checked here). Any other shape is refused instead of being patched blindly.
"""

import inspect
import re
from collections.abc import Callable
from importlib import import_module
from typing import Any

from code_reviewer_runner.llm_providers import LlmProviderSpec, without_prefix

_HANDLER_MODULE = "pr_agent.algo.ai_handlers.litellm_ai_handler"
_METHOD = "_litellm_supports_temperature"
_EXPECTED_SIGNATURE = ["model", "custom_llm_provider"]
# Set on the replacement, so a second application finds the real method instead of wrapping it.
_ORIGINAL_ATTRIBUTE = "__temperature_patch_original__"

# The first Claude model without `temperature`: Opus 4.7.
_FIRST_CLAUDE_WITHOUT_TEMPERATURE = (4, 7)
# The first GPT model PR-Agent does not know to be without it: GPT-6 (GPT-5 is covered by PR-Agent).
_FIRST_GPT_WITHOUT_TEMPERATURE = 6
# `claude-<family>-<major>[.-<minor>]` (OpenRouter, Anthropic) or
# `claude-<major>[.-<minor>]-<family>` (the 3.x ids). `claude` starts the id or follows a `/` or a
# `.` (`anthropic.claude-...` of Bedrock), so a word that merely ends in it is no Claude model. A
# minor version has at most two digits: a longer number is the date of a snapshot
# (`claude-sonnet-4-20250514` is 4.0).
_CLAUDE_VERSION = re.compile(r"(?:^|[/.])claude-(?:[a-z]+-)?(\d+)(?:[-.](\d{1,2})(?!\d))?")
# `gpt-<major>[.<minor>][-<name>]`: `gpt-6-luna`, `gpt-6.1-sol`. Starts the id or follows a `/`.
_GPT_VERSION = re.compile(r"(?:^|/)gpt-(\d+)")
# OpenRouter's rolling aliases carry no version and list no `temperature` either:
# `~anthropic/claude-haiku-latest`, `~openai/gpt-luna-latest`, `openai/gpt-chat-latest`. They point
# at the newest model of a family, which is past the versions above. The other vendors' aliases
# (`~google/gemini-pro-latest`) do take it and are left alone. A job refuses a model id that starts
# with `~` (`job.py`), so the `~` is matched only in case that pattern is ever widened.
_ALIAS = re.compile(
    r"(?:^|/)~?(?:anthropic/claude-[a-z]+|openai/gpt-(?:[a-z]+-)?)-?latest(?::[a-z0-9-]+)?$"
)


class TemperaturePatchError(Exception):
    """PR-Agent does not have the method the patch was written for."""


def withholds_temperature(model: str) -> bool:
    """True for a Claude model from 4.7 on and a GPT model from 6 on, whatever the provider prefix
    or `:variant`, and for the `latest` aliases of both."""
    normalized = model.lower().replace("_", "-")
    claude = _CLAUDE_VERSION.search(normalized)
    if claude is not None:
        version = (int(claude.group(1)), int(claude.group(2) or 0))
        return version >= _FIRST_CLAUDE_WITHOUT_TEMPERATURE
    gpt = _GPT_VERSION.search(normalized)
    if gpt is not None:
        return int(gpt.group(1)) >= _FIRST_GPT_WITHOUT_TEMPERATURE
    return _ALIAS.search(normalized) is not None


def apply_temperature_patch(
    handler_class: type[Any] | None = None, *, provider: LlmProviderSpec | None = None
) -> Callable[[], None]:
    """Wrap PR-Agent's temperature probe. Returns a function that undoes the patch.

    `provider` is the provider of the job. Without one the rules of the model name decide.

    Everything the patch relies on is checked first, and a failed check changes nothing. Applying
    the patch twice does not wrap it twice.
    """
    # PR-Agent ships no type information: the class is `Any` on purpose.
    target: Any = handler_class or import_module(_HANDLER_MODULE).LiteLLMAIHandler
    current = getattr(target, _METHOD, None)
    if not callable(current):
        raise TemperaturePatchError(f"{target.__name__}.{_METHOD} does not exist")
    original: Callable[..., Any] = getattr(current, _ORIGINAL_ATTRIBUTE, current)
    if list(inspect.signature(original).parameters) != _EXPECTED_SIGNATURE:
        raise TemperaturePatchError(
            f"{target.__name__}.{_METHOD} has a different signature: expected "
            f"({', '.join(_EXPECTED_SIGNATURE)}), found {inspect.signature(original)}"
        )

    def supports_temperature(model: str, custom_llm_provider: str | None = None) -> bool:
        opinion = (
            None
            if provider is None
            else provider.supports_temperature(without_prefix(provider, model))
        )
        if opinion is False:
            return False
        if opinion is None and withholds_temperature(model):
            return False
        return bool(original(model, custom_llm_provider))

    setattr(supports_temperature, _ORIGINAL_ATTRIBUTE, original)
    setattr(target, _METHOD, staticmethod(supports_temperature))

    def undo() -> None:
        setattr(target, _METHOD, staticmethod(original))

    return undo
