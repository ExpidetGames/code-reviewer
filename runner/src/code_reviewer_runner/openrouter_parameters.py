# SPDX-License-Identifier: Apache-2.0

"""OpenRouter's `provider.require_parameters`, the one routing field the runner sets itself (#270).

OpenRouter may send a request to a provider that silently ignores a parameter it does not support
(`tools`, `tool_choice`, `response_format`). With `provider.require_parameters: true` it routes only
to providers that support every parameter of the request, and answers 404 when there is none.

The field states a capability requirement: it selects no provider and expresses no preference, so
it is no provider-specific routing (epic #193, decision 6). It is added by the runner only, for
Diff Review through PR-Agent's request (`require_parameters_patch.py`) and for Dynamic Review by the
model proxy; the engine and the repository can never send `provider` or any routing field.
"""

import re
from typing import Final

REQUIRE_PARAMETERS: Final = {"require_parameters": True}

# OpenRouter's answer (HTTP 404) when no endpoint can serve what the request asks for. The text
# depends on the parameter that lacks support; each of these was seen in public reports of
# https://openrouter.ai/api/v1/chat/completions (404, followed by a pointer to the provider routing
# docs): "...that can handle the requested parameters", "...that support tool use" and "...that
# support the provided 'tool_choice' value". The family is "no endpoints found that can handle /
# support ..."; "No endpoints found for <model>" and "...matching your data policy" are not in it.
_NO_PROVIDER_FOR_PARAMETERS = re.compile(
    r"no endpoints found that (?:can handle|support)\b", re.IGNORECASE
)


def is_no_provider_for_parameters(text: str) -> bool:
    """True for the text of OpenRouter's "no endpoint can handle or support the request"."""
    return _NO_PROVIDER_FOR_PARAMETERS.search(text) is not None
