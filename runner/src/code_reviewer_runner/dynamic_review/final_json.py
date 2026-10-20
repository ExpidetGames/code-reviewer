# SPDX-License-Identifier: Apache-2.0

"""Finalization as plain JSON text: the extractor (#552, spike #547).

The engine is given no `format` on the native path, so there is no `StructuredOutput` tool and no
forced tool choice: the review is the text of the message that ended the turn (the turn ends when
the model answers without a tool call). The adapter takes the JSON out of that text with
`extract_final_json`, validates it with the envelope check (`parse_dynamic_findings`; the runner
sets `schemaVersion` and `reviewedSha` itself), and on a failure sends exactly one more user message
(`final_messages.repair_message`) that names the `Problem`.

The rules of the extractor are strict on purpose. It takes the whole text as one JSON object, or
one Markdown fence around the whole text, and nothing else. Text before or after the object, two
objects, a JSON that needs repairing (trailing comma, single quotes, comments, a cut-off tail) are
not taken: they are named (`Problem`) so that the one repair message can say what is wrong. The
extractor never looks at reasoning, tool results, `info.structured` or an earlier message.
"""

import json
import re
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, cast

# One fence around the whole text. The opening line holds nothing but an optional language tag
# (`\n` or `\r\n` ends it), the closing fence starts a line of its own.
_FENCED = re.compile(r"```(?P<tag>[^\r\n`]*)\r?\n(?P<body>.*?)\r?\n[ \t]*```", re.DOTALL)
_FENCE_MARK = "```"
# What a nesting that exhausts the parser is called in the repair message (no text of the model).
NESTED_TOO_DEEPLY = "the JSON is nested too deeply"


class Problem(StrEnum):
    """What is wrong with the message that ended a turn; the repair message branches on it."""

    NO_TEXT = "no_text"
    REASONING_ONLY = "reasoning_only"
    CUT_OFF = "cut_off"
    NO_JSON_OBJECT = "no_json_object"
    TEXT_AROUND_JSON = "text_around_json"
    INVALID_JSON = "invalid_json"
    NOT_AN_OBJECT = "not_an_object"
    ENVELOPE_INVALID = "envelope_invalid"
    TOO_MANY_FINDINGS = "too_many_findings"
    # The final turn called a tool, which the guard refuses: not an answer, not text to read.
    TOOL_CALL = "tool_call"


@dataclass(frozen=True)
class Extraction:
    """The JSON object the message holds, or the one problem with it. Never both."""

    document: dict[str, Any] | None
    problem: Problem | None = None
    # Parser text for `INVALID_JSON` only (message and position, never a value).
    detail: str = ""


def _objects(parts: list[Any]) -> list[dict[str, Any]]:
    return [cast("dict[str, Any]", part) for part in parts if isinstance(part, dict)]


def _parts(message: dict[str, Any]) -> list[dict[str, Any]]:
    parts: Any = message.get("parts")
    return _objects(cast("list[Any]", parts)) if isinstance(parts, list) else []


def _texts(message: dict[str, Any], kind: str) -> list[str]:
    return [
        text
        for part in _parts(message)
        if part.get("type") == kind
        and part.get("ignored") is not True
        and part.get("synthetic") is not True
        and isinstance(text := part.get("text"), str)
    ]


def visible_text(message: dict[str, Any]) -> str:
    """The text the model ended the turn with: the visible text parts of the last message, joined
    by a blank line. Reasoning, tool parts and `info.structured` are not part of it."""
    return "\n\n".join(_texts(message, "text"))


def _finish(message: dict[str, Any]) -> object:
    info: Any = message.get("info")
    return cast("dict[str, Any]", info).get("finish") if isinstance(info, dict) else None


def _reject_constant(name: str) -> object:
    raise ValueError(f"{name} is not JSON")


def _loads(text: str) -> object:
    """Strict JSON: the constants `NaN` and `Infinity`, which Python accepts, are not JSON."""
    return json.loads(text, parse_constant=_reject_constant)


def _unfenced(text: str) -> str:
    """The text inside one fence that wraps the whole message, or the text itself."""
    fenced = _FENCED.fullmatch(text)
    if fenced is None or _FENCE_MARK in fenced["body"]:
        return text
    tag = fenced["tag"].strip()
    if tag and not re.fullmatch(r"json", tag, re.IGNORECASE):
        return text
    return fenced["body"].strip()


def _holds_a_review_object(text: str) -> bool:
    """True when some `{` in the text starts a complete JSON object with a `findings` key. Naming
    only: this never produces an answer, it tells text around an object from text with none. An
    object inside a broken one (a finding inside a review with single quotes) is not a review."""
    decoder = json.JSONDecoder(parse_constant=_reject_constant)
    start = text.find("{")
    while start != -1:
        try:
            value, end = decoder.raw_decode(text, start)
        except (ValueError, RecursionError):
            start = text.find("{", start + 1)
            continue
        if isinstance(value, dict) and "findings" in cast("dict[str, Any]", value):
            return True
        start = text.find("{", end)
    return False


def _object_with_trailing_text(text: str) -> bool:
    """True when the text starts with a complete JSON object and holds more after it."""
    try:
        _, end = json.JSONDecoder(parse_constant=_reject_constant).raw_decode(text)
    except (ValueError, RecursionError):
        return False
    return end < len(text)


def extract_final_json(message: dict[str, Any]) -> Extraction:
    """The review object out of the message that ended a turn, or what is wrong with the message."""
    cut = _finish(message) == "length"
    text = visible_text(message).strip()
    if not text:
        if cut:
            return Extraction(None, Problem.CUT_OFF)
        reasoning = any(part.strip() for part in _texts(message, "reasoning"))
        return Extraction(None, Problem.REASONING_ONLY if reasoning else Problem.NO_TEXT)
    candidate = _unfenced(text)
    try:
        value = _loads(candidate)
    except (ValueError, RecursionError) as error:
        if cut:
            return Extraction(None, Problem.CUT_OFF)
        if isinstance(error, RecursionError):
            return Extraction(None, Problem.INVALID_JSON, NESTED_TOO_DEEPLY)
        if candidate.startswith("{"):
            if _object_with_trailing_text(candidate):
                return Extraction(None, Problem.TEXT_AROUND_JSON)
            return Extraction(None, Problem.INVALID_JSON, _parser_detail(error))
        if _holds_a_review_object(candidate):
            return Extraction(None, Problem.TEXT_AROUND_JSON)
        return Extraction(None, Problem.NO_JSON_OBJECT)
    if not isinstance(value, dict):
        return Extraction(None, Problem.NOT_AN_OBJECT)
    return Extraction(cast("dict[str, Any]", value))


def _parser_detail(error: Exception) -> str:
    if isinstance(error, json.JSONDecodeError):
        return f"{error.msg} at position {error.pos}"
    return "not valid JSON"


_IDENTIFIER = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,39}")


def engine_error_name(message: dict[str, Any]) -> str | None:
    """The name of the engine's own error in the message that ended a turn, as a plain identifier
    (`other` when it is not one), or None when there is none. The engine's text next to it (its
    sentence, the body of a provider's answer) is never read: it can carry anything."""
    info: Any = message.get("info")
    error: Any = cast("dict[str, Any]", info).get("error") if isinstance(info, dict) else None
    if error is None:
        return None
    name: Any = cast("dict[str, Any]", error).get("name") if isinstance(error, dict) else None
    return name if isinstance(name, str) and _IDENTIFIER.fullmatch(name) else "other"
