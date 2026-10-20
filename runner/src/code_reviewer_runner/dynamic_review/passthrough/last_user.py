# SPDX-License-Identifier: Apache-2.0

"""The text of the last user message of a request body, per wire family (#552).

The adapter's "answer now" message is the last thing the engine adds to the conversation, so the
ledger binds the final call to a token that stands in the text of the **last user message** of the
request (`BudgetLedger.arm_final`). A token anywhere else in a body, in the system prompt, in a
tool result, in what the assistant said or earlier in the history, is not the adapter's message
being asked for. The body has passed the closed schema of its family (`body_schema.py`) before
this reads it, but the reading is defensive all the same: a shape it does not expect is `None`,
which marks nothing.

Only text parts count. A tool result is never text of the user: on Anthropic Messages it travels
inside a user message as its own block, and the same message can hold the adapter's text block
after it.
"""

from collections.abc import Mapping, Sequence
from typing import Any, cast

from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily
from code_reviewer_runner.job_loop.jsonvalues import as_object

_TEXT_PART_TYPES = ("text", "input_text")


def _items(value: Any) -> list[Any]:
    return cast("list[Any]", value) if isinstance(value, list) else []


def _joined(parts: Any, kinds: Sequence[str] = _TEXT_PART_TYPES) -> str:
    """The text of a content that is a string or a list of parts: the text parts, in order."""
    if isinstance(parts, str):
        return parts
    texts: list[str] = []
    for item in _items(parts):
        part = as_object(item)
        if part is None:
            continue
        value = part.get("text")
        kind = part.get("type")
        if isinstance(value, str) and (kind is None or kind in kinds):
            texts.append(value)
    return "\n".join(texts)


def _last(items: Any) -> Mapping[str, Any] | None:
    entries = _items(items)
    return as_object(entries[-1]) if entries else None


def last_user_text(family: WireFamily, document: Mapping[str, Any]) -> str | None:
    """The text parts of the last message of `document` when it is a user message that has any,
    else None."""
    return _last_user_text(family, document) or None


def _last_user_text(family: WireFamily, document: Mapping[str, Any]) -> str | None:
    if family is WireFamily.OPENAI_CHAT:
        message = _last(document.get("messages"))
        if message is None or message.get("role") != "user":
            return None
        return _joined(message.get("content"))
    if family is WireFamily.OPENAI_RESPONSES:
        item = _last(document.get("input"))
        if item is None or item.get("role") != "user" or item.get("type", "message") != "message":
            return None
        return _joined(item.get("content"))
    if family is WireFamily.ANTHROPIC_MESSAGES:
        message = _last(document.get("messages"))
        if message is None or message.get("role") != "user":
            return None
        return _joined(message.get("content"), ("text",))
    content = _last(document.get("contents"))
    if content is None or content.get("role") != "user":
        return None
    texts: list[str] = []
    for item in _items(content.get("parts")):
        part = as_object(item)
        value = part.get("text") if part is not None else None
        if isinstance(value, str) and part is not None and part.get("thought") is not True:
            texts.append(value)
    return "\n".join(texts)
