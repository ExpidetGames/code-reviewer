# SPDX-License-Identifier: Apache-2.0

"""Why a call ended, as the provider's answer states it, in the words of the chat protocol (#578).

The call trace (`call_trace.py`) and the finalization line of a native run name a finish with the
four words of the chat protocol (`stop`, `tool_calls`, `length`, `content_filter`). The other three
families say it in their own words, so the usage tap reads the one place each puts it and maps it
here: Messages `stop_reason`, Responses `status` and `incomplete_details.reason`, Google
`finishReason`. A word that is not known is `other`; nothing is ever read as `stop` by default, and
nothing the model wrote is looked at (the words are the provider's structure).

Responses and Google end a call that asked for a tool as they end any other (`completed`, `STOP`),
so they cannot say `tool_calls`; the finish that matters to the run, `length`, is the same for all.
"""

from typing import Any, Final, cast

__all__ = [
    "OTHER",
    "chat_finish",
    "google_finish",
    "messages_finish",
    "responses_finish",
]

OTHER: Final = "other"
_CHAT: Final = frozenset({"stop", "tool_calls", "length", "content_filter"})
_MESSAGES: Final = {
    "end_turn": "stop",
    "stop_sequence": "stop",
    "pause_turn": "stop",
    "tool_use": "tool_calls",
    "max_tokens": "length",
    "model_context_window_exceeded": "length",
    "refusal": "content_filter",
}
_RESPONSES_INCOMPLETE: Final = {"max_output_tokens": "length", "content_filter": "content_filter"}
_GOOGLE: Final = {
    "STOP": "stop",
    "MAX_TOKENS": "length",
    "SAFETY": "content_filter",
    "RECITATION": "content_filter",
    "BLOCKLIST": "content_filter",
    "PROHIBITED_CONTENT": "content_filter",
    "SPII": "content_filter",
    "IMAGE_SAFETY": "content_filter",
}


def chat_finish(reason: Any) -> str | None:
    """`finish_reason` of a Chat choice: None until the choice has one."""
    if not isinstance(reason, str) or not reason:
        return None
    return reason if reason in _CHAT else OTHER


def messages_finish(reason: Any) -> str | None:
    """`stop_reason` of a Messages answer: null until the message stops."""
    if not isinstance(reason, str) or not reason:
        return None
    return _MESSAGES.get(reason, OTHER)


def responses_finish(response: dict[str, Any]) -> str | None:
    """A finished Responses object: `completed` ended on its own, `incomplete` says why it did
    not."""
    status = response.get("status")
    if status == "completed":
        return "stop"
    if status != "incomplete":
        return None
    details = response.get("incomplete_details")
    reason: Any = None
    if isinstance(details, dict):
        reason = cast("dict[str, Any]", details).get("reason")
    return _RESPONSES_INCOMPLETE.get(reason, OTHER) if isinstance(reason, str) else OTHER


def google_finish(reason: Any) -> str | None:
    """`finishReason` of a Google candidate: absent until the candidate ends."""
    if not isinstance(reason, str) or not reason:
        return None
    return _GOOGLE.get(reason, OTHER)
