# SPDX-License-Identifier: Apache-2.0

"""Makes every request of a Diff job carry the provider's require-parameters field (#270, #424).

For OpenRouter that is `provider.require_parameters: true`; the registry entry of the job's provider
(`llm_providers.py`) says which PR-Agent method to wrap and what to add to the request body.

PR-Agent 0.47.0 has no setting for it: `litellm.extra_body` accepts only three other keys, and the
`openrouter.provider_only` / `provider_order` settings are provider selectors the product must not
use (epic #193, decision 6). The one place that builds the OpenRouter-specific part of the request
is `LiteLLMAIHandler._apply_openrouter_request_controls`, which returns the call's keyword
arguments; LiteLLM sends their `extra_body` verbatim. The patch adds the field to that `extra_body`
after PR-Agent has built it and leaves everything else as it was.

The patch reaches into a private method, so it is tied to the version it was written and tested for
(`identity_patch.check_pr_agent_version` runs before it, and the signature of the method is
checked here).
Any other shape is refused instead of being patched blindly. A job with a destination that is not
the provider itself simply does not apply the patch.
"""

import inspect
from collections.abc import Callable
from importlib import import_module
from typing import Any

from code_reviewer_runner.llm_providers import OPENROUTER, LlmProviderSpec

_HANDLER_MODULE = "pr_agent.algo.ai_handlers.litellm_ai_handler"
_EXPECTED_SIGNATURE = ["self", "model", "kwargs", "inherited_reasoning_effort"]
# Set on the replacement, so a second application finds the real method instead of wrapping it.
_ORIGINAL_ATTRIBUTE = "__require_parameters_patch_original__"


class RequireParametersPatchError(Exception):
    """PR-Agent does not have the method the patch was written for."""


def apply_require_parameters_patch(
    handler_class: type[Any] | None = None, *, provider: LlmProviderSpec = OPENROUTER
) -> Callable[[], None]:
    """Wrap the request controls of the provider. Returns a function that undoes the patch.

    Everything the patch relies on is checked first, and a failed check changes nothing. Applying
    the patch twice does not wrap it twice.
    """
    mechanism = provider.require_parameters
    if mechanism is None:
        raise RequireParametersPatchError(f"provider {provider.id} has no require-parameters field")
    method = mechanism.request_controls_method
    # PR-Agent ships no type information: the class is `Any` on purpose.
    target: Any = handler_class or import_module(_HANDLER_MODULE).LiteLLMAIHandler
    current = getattr(target, method, None)
    if not callable(current):
        raise RequireParametersPatchError(f"{target.__name__}.{method} does not exist")
    original: Callable[..., Any] = getattr(current, _ORIGINAL_ATTRIBUTE, current)
    if list(inspect.signature(original).parameters) != _EXPECTED_SIGNATURE:
        raise RequireParametersPatchError(
            f"{target.__name__}.{method} has a different signature: expected "
            f"({', '.join(_EXPECTED_SIGNATURE)}), found {inspect.signature(original)}"
        )

    def with_required_parameters(
        self: object, model: str, kwargs: dict[str, Any], inherited_reasoning_effort: Any = None
    ) -> dict[str, Any]:
        controlled: dict[str, Any] = original(self, model, kwargs, inherited_reasoning_effort)
        extra_body: dict[str, Any] = controlled.get("extra_body") or {}
        routing: dict[str, Any] = extra_body.get(mechanism.body_field) or {}
        extra_body[mechanism.body_field] = {**routing, **mechanism.body_value}
        controlled["extra_body"] = extra_body
        return controlled

    setattr(with_required_parameters, _ORIGINAL_ATTRIBUTE, original)
    setattr(target, method, with_required_parameters)

    def undo() -> None:
        setattr(target, method, original)

    return undo
