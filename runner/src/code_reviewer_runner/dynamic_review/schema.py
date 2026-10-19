# SPDX-License-Identifier: Apache-2.0

"""The findings schema in the form the pinned engine takes as its structured-output format (#197).

The contract schema (`contracts/dynamic-review/schema.v1.json`) keeps its definitions under `$defs`
and has no root type. The engine turns `format.schema` into the parameters of its `StructuredOutput`
tool, which a model provider only accepts as an object schema: a schema without a root `type` is
accepted by the engine, then fails (or validates nothing) at the provider. So the engine gets one
self-contained object schema: the `DynamicFindings` definition at the root, every `$ref` resolved
in place, no `$defs`, `$id` or `$schema` (a provider cannot resolve them and a validator may try).
The finding bound of the job narrows `maxItems`; it never widens the contract's own bound.

The constants the runner already knows (`schemaVersion`, the head as `reviewedSha` on the envelope
and on every finding) are not part of what the model is asked for (#530): the engine does not check
the arguments of its return tool, so a missing or wrong echo would only fail a run. The runner sets
them itself (`dynamic_findings.with_runner_constants`); the contract file keeps requiring them.
"""

import copy
from typing import Any

from code_reviewer_runner.dynamic_review.budget import LimitError
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.result import ErrorCode

ROOT_DEFINITION = "DynamicFindings"
_PREFIX = "#/$defs/"
_DROPPED = ("$schema", "$id", "$defs")
RUNNER_OWNED_ENVELOPE = ("schemaVersion", "reviewedSha")
RUNNER_OWNED_FINDING = ("reviewedSha",)


def _unusable(detail: str) -> LimitError:
    return LimitError(ErrorCode.DYNAMIC_CONFIG_INVALID, detail)


def _inline(node: Any, definitions: dict[str, Any], trail: tuple[str, ...]) -> Any:
    if isinstance(node, list):
        return [_inline(item, definitions, trail) for item in node]  # pyright: ignore[reportUnknownVariableType]
    mapping = as_object(node)
    if mapping is None:
        return node
    reference: Any = mapping.get("$ref")
    if isinstance(reference, str):
        if not reference.startswith(_PREFIX):
            raise _unusable("the findings schema has a reference outside its definitions")
        name = reference[len(_PREFIX) :]
        if name in trail or name not in definitions:
            raise _unusable("the findings schema has a recursive or missing definition")
        # A `$ref` with siblings keeps them (draft 2020-12): they apply next to the definition.
        resolved: Any = _inline(copy.deepcopy(definitions[name]), definitions, (*trail, name))
        siblings = {
            key: _inline(value, definitions, trail)
            for key, value in mapping.items()
            if key != "$ref"
        }
        target = as_object(resolved)
        return {**target, **siblings} if target is not None else resolved
    return {key: _inline(value, definitions, trail) for key, value in mapping.items()}


def _without(node: dict[str, Any], names: tuple[str, ...]) -> None:
    properties = as_object(node.get("properties"))
    if properties is not None:
        for name in names:
            properties.pop(name, None)
    required: Any = node.get("required")
    if isinstance(required, list):
        node["required"] = [name for name in required if name not in names]  # pyright: ignore[reportUnknownVariableType]


def engine_schema(schema: dict[str, Any], max_findings: int) -> dict[str, Any]:
    """A self-contained object schema for the engine, narrowed to the job's finding bound."""
    definitions = as_object(schema.get("$defs"))
    if definitions is None or ROOT_DEFINITION not in definitions:
        raise _unusable("the findings schema has no DynamicFindings definition")
    root = _inline(copy.deepcopy(definitions[ROOT_DEFINITION]), definitions, (ROOT_DEFINITION,))
    document = as_object(root)
    if document is None or document.get("type") != "object":
        raise _unusable("the findings schema root is not an object")
    properties = as_object(document.get("properties"))
    findings = as_object(properties.get("findings")) if properties else None
    if findings is None:
        raise _unusable("the findings schema has no findings")
    _without(document, RUNNER_OWNED_ENVELOPE)
    item = as_object(findings.get("items"))
    if item is not None:
        _without(item, RUNNER_OWNED_FINDING)
    current: Any = findings.get("maxItems")
    if not isinstance(current, int) or max_findings < current:
        findings["maxItems"] = max_findings
    for key in _DROPPED:
        document.pop(key, None)
    return document
