# SPDX-License-Identifier: Apache-2.0

"""Makes every OpenRouter request of a Diff job carry `provider.require_parameters: true` (#270).

PR-Agent 0.47.0 has no setting for it: `litellm.extra_body` accepts only three other keys, and the
`openrouter.provider_only` / `provider_order` settings are provider selectors the product must not
use (epic #193, decision 6). The one place that builds the OpenRouter-specific part of the request
is `LiteLLMAIHandler._apply_openrouter_request_controls`, which returns the call's keyword
arguments; LiteLLM sends their `extra_body` verbatim. The patch adds the field to that `extra_body`
after PR-Agent has built it and leaves everything else as it was.

The patch reaches into a private method, so it is tied to the version it was written and tested for
(`identity_patch.check_pr_agent_version` runs before it, and the method's signature is checked here).
Any other shape is refused instead of being patched blindly. A job with a destination that is not
OpenRouter simply does not apply the patch.
"""

import inspect
from collections.abc import Callable
from typing import Any

from code_reviewer_runner.openrouter_parameters import REQUIRE_PARAMETERS

_METHOD = "_apply_openrouter_request_controls"
_EXPECTED_SIGNATURE = ["self", "model", "kwargs", "inherited_reasoning_effort"]
# Set on the replacement, so a second application finds the real method instead of wrapping it.
_ORIGINAL_ATTRIBUTE = "__require_parameters_patch_original__"


class RequireParametersPatchError(Exception):
    """PR-Agent does not have the method the patch was written for."""


def apply_require_parameters_patch(handler_class: type[Any] | None = None) -> Callable[[], None]:
    """Wrap the OpenRouter request controls. Returns a function that undoes the patch.

    Everything the patch relies on is checked first, and a failed check changes nothing. Applying
    the patch twice does not wrap it twice.
    """
    if handler_class is None:
        from pr_agent.algo.ai_handlers.litellm_ai_handler import LiteLLMAIHandler

        handler_class = LiteLLMAIHandler
    current = getattr(handler_class, _METHOD, None)
    if not callable(current):
        raise RequireParametersPatchError(f"{handler_class.__name__}.{_METHOD} does not exist")
    original = getattr(current, _ORIGINAL_ATTRIBUTE, current)
    if list(inspect.signature(original).parameters) != _EXPECTED_SIGNATURE:
        raise RequireParametersPatchError(
            f"{handler_class.__name__}.{_METHOD} has a different signature: expected "
            f"({', '.join(_EXPECTED_SIGNATURE)}), found {inspect.signature(original)}"
        )

    def with_required_parameters(
        self: object, model: str, kwargs: dict[str, Any], inherited_reasoning_effort: Any = None
    ) -> dict[str, Any]:
        controlled: dict[str, Any] = original(self, model, kwargs, inherited_reasoning_effort)
        extra_body: dict[str, Any] = controlled.get("extra_body") or {}
        provider: dict[str, Any] = extra_body.get("provider") or {}
        extra_body["provider"] = {**provider, **REQUIRE_PARAMETERS}
        controlled["extra_body"] = extra_body
        return controlled

    setattr(with_required_parameters, _ORIGINAL_ATTRIBUTE, original)
    setattr(handler_class, _METHOD, with_required_parameters)

    def undo() -> None:
        setattr(handler_class, _METHOD, original)

    return undo
