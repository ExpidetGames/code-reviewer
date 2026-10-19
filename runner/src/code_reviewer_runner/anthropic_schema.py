# SPDX-License-Identifier: Apache-2.0

"""A tool schema reduced to what Anthropic's strict tool use accepts (#533).

A model that refuses a forced tool choice is asked for its final answer with `tool_choice: auto`,
and the return tool is marked `strict: true` so that the arguments of the call follow the schema
(grammar constrained sampling). The strict mode takes a subset of JSON Schema and answers a 400 to
anything else (`https://platform.claude.com/docs/en/build-with-claude/structured-outputs`, "JSON
Schema limitations", read on 2026-10-19):

- no numeric constraints (`minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`,
  `multipleOf`), no string constraints (`minLength`, `maxLength`), no array constraint beyond a
  `minItems` of 0 or 1, no `uniqueItems`, no `maxItems`;
- a `pattern` only as a simple regular expression (no look-around, no back-references);
- `additionalProperties` set to `false` on every object, and no free-form objects.

The reduction keeps what the grammar can hold (types, `enum`, `const`, `required`, the shape) and
moves every limit it has to drop into the `description` of the field, so the model still reads it.
Nothing is weakened where it counts: the runner validates the answer against the full schema as
before (`parse_dynamic_findings`), and a schema that cannot be reduced safely (a keyword this
module does not know) gets no strict mode and is sent as it is, which the API takes as any tool.
"""

import copy
from typing import Any, Final

# Limits the strict mode cannot express; each one is named in the description of the field.
_MOVED_TO_DESCRIPTION: Final = (
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "uniqueItems",
    "pattern",
)
# Keywords that stay as they are.
_KEPT: Final = frozenset(
    {
        "type",
        "properties",
        "required",
        "additionalProperties",
        "items",
        "enum",
        "const",
        "description",
        "title",
        "default",
        "anyOf",
        "allOf",
        "format",
    }
)
_SUPPORTED_FORMATS: Final = frozenset(
    {"date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"}
)


class _Unreducible(Exception):
    """The schema has something the strict mode cannot take and this module cannot reduce."""


def strict_input_schema(schema: dict[str, Any]) -> dict[str, Any] | None:
    """The reduced copy of a tool's input schema, or None when it cannot be reduced safely."""
    if schema.get("type") != "object":
        return None
    try:
        reduced = _reduce(copy.deepcopy(schema))
    except _Unreducible:
        return None
    return reduced


def _holds_one_of(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []  # pyright: ignore[reportUnknownVariableType]


def _reduce(node: dict[str, Any]) -> dict[str, Any]:
    moved: list[str] = []
    for keyword in _MOVED_TO_DESCRIPTION:
        if keyword not in node:
            continue
        value = node.pop(keyword)
        if keyword == "minItems" and value in (0, 1):
            node[keyword] = value  # the one array bound the grammar has
            continue
        moved.append(f"{keyword} {_shown(value)}")
    if node.get("format") not in (None, *_SUPPORTED_FORMATS):
        moved.append(f"format {_shown(node.pop('format'))}")
    for keyword in node:
        if keyword not in _KEPT and keyword != "minItems":
            raise _Unreducible
    _reduce_shape(node)
    if moved:
        existing = node.get("description")
        text = existing.rstrip() + " " if isinstance(existing, str) and existing.strip() else ""
        node["description"] = f"{text}(Limits: {', '.join(moved)}.)"
    return node


def _reduce_shape(node: dict[str, Any]) -> None:
    kind = node.get("type")
    if kind == "object" or "properties" in node:
        properties = node.get("properties")
        if not isinstance(properties, dict) or node.get("additionalProperties") not in (
            None,
            False,
        ):
            raise _Unreducible  # a free-form object has no strict form
        reduced: dict[str, Any] = {}
        for name, child in properties.items():  # pyright: ignore[reportUnknownVariableType]
            if not isinstance(child, dict):
                raise _Unreducible
            reduced[str(name)] = _reduce(child)  # pyright: ignore[reportUnknownArgumentType]
        node["properties"] = reduced
        node["additionalProperties"] = False
    items = node.get("items")
    if items is not None:
        if not isinstance(items, dict):
            raise _Unreducible
        node["items"] = _reduce(items)  # pyright: ignore[reportUnknownArgumentType]
    for combiner in ("anyOf", "allOf"):
        if combiner in node:
            options = _holds_one_of(node[combiner])
            if not options or not all(isinstance(option, dict) for option in options):
                raise _Unreducible
            node[combiner] = [_reduce(option) for option in options]


def _shown(value: Any) -> str:
    if isinstance(value, bool):
        return str(value).lower()
    return str(value)
