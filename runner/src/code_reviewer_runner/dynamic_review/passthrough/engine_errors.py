# SPDX-License-Identifier: Apache-2.0

"""What the engine's own answers say about the model (#550).

A turn for a model the engine's configuration does not offer (for example one the provider has
retired and the catalog dropped) fails before any request: `POST /session/{id}/message` answers
HTTP 500 with `{"name": "UnknownError"}`, and nothing reaches the proxy (spike #546, section 3).
The text names the model and is never shown; the case has the one stable code the legacy path uses
for a provider's 404, `model_unknown`.
"""

from typing import Any, Final

from code_reviewer_runner.result import ErrorCode

MODEL_NOT_FOUND: Final = ErrorCode.MODEL_UNKNOWN


def model_not_found_for_turn(http_status: int, error: Any, *, upstream_calls: int) -> bool:
    """Whether a turn that the engine answered with this status and error body failed because the
    model is unknown: a 500 `UnknownError` and no call to the provider during the turn."""
    if http_status != 500 or upstream_calls != 0 or not isinstance(error, dict):
        return False
    name: Any = error.get("name")  # pyright: ignore[reportUnknownMemberType, reportUnknownVariableType]
    return name == "UnknownError"
