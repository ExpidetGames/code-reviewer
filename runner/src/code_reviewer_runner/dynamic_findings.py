# SPDX-License-Identifier: Apache-2.0

"""The neutral findings of a Dynamic Review (`contracts/dynamic-review/schema.v1.json`), and the
semantic checks the schema cannot express (#195).

The JSON Schema enforces the shape and the lexical path safety; the ordered line range and the
membership in the verified export are semantic and live here, so the runner (#199) validates a model
answer before it is rendered or trusted. A path that is not in the export the runner prepared is
`checkout_incomplete` (the run cannot point at a file it did not review); any other violation is
`dynamic_policy_violation`. Nothing here echoes a value: the details name fields.
"""

import json
import re
from collections.abc import Collection
from dataclasses import dataclass
from typing import Any

from code_reviewer_runner.result import ErrorCode

MAX_FINDINGS = 30
MAX_RESOLVED_IDS = 500
MAX_PATH_CHARS = 1024
PRIORITIES = frozenset({"P0", "P1", "P2", "P3"})

# The same lexical rule as the contract's `Finding.path` pattern: repository-relative, no leading
# slash, no drive letter, no backslash, no `..` segment.
_PATH = re.compile(r"^(?!/)(?![A-Za-z]:)(?!.*\\)(?!.*(?:^|/)\.\.(?:/|$)).{1,1024}$")
_SHA = re.compile(r"[0-9a-f]{40}")


class FindingsError(Exception):
    """A finding output that is not valid. `code` is stable; `detail` names a field, not a value."""

    def __init__(self, code: ErrorCode, detail: str) -> None:
        super().__init__(f"{code.value}: {detail}")
        self.code = code
        self.detail = detail


def _invalid(detail: str) -> FindingsError:
    return FindingsError(ErrorCode.DYNAMIC_POLICY_VIOLATION, detail)


def location_problem(
    path: str,
    line_start: int,
    line_end: int,
    exported_paths: Collection[str] | None,
) -> FindingsError | None:
    """What is wrong with a location, or None. `exported_paths` None: membership is not checked.

    The schema already rejected the lexical path problems; this re-checks them for a caller that
    does not run the schema, then enforces the ordered range and the membership in the export.
    """
    if not _PATH.fullmatch(path):
        return _invalid("path is not a safe repository-relative path")
    if line_start < 1 or line_end < 1:
        return _invalid("the line range must be positive")
    if line_start > line_end:
        return _invalid("lineStart must not be after lineEnd")
    if exported_paths is not None and path not in exported_paths:
        return FindingsError(
            ErrorCode.CHECKOUT_INCOMPLETE,
            "the finding points at a file that is not in the verified export",
        )
    return None


@dataclass(frozen=True)
class Finding:
    id: str
    priority: str
    confidence: float
    title: str
    body: str
    path: str
    line_start: int
    line_end: int
    evidence: tuple[str, ...]
    reviewed_sha: str


@dataclass(frozen=True)
class DynamicFindings:
    reviewed_sha: str
    findings: tuple[Finding, ...]
    resolved_ids: tuple[str, ...]


def _object(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise _invalid(f"{path} must be an object")
    return value  # pyright: ignore[reportUnknownVariableType]


def _fields(data: dict[str, Any], allowed: set[str], prefix: str) -> None:
    for key in data:
        if key not in allowed:
            named = bool(re.fullmatch(r"[A-Za-z0-9_.-]{1,40}", key))
            raise _invalid(f"unknown field {prefix}{key if named else '<invalid name>'}")


def _string(data: dict[str, Any], key: str, *, max_chars: int) -> str:
    value = data.get(key)
    if not isinstance(value, str) or value == "" or len(value) > max_chars:
        raise _invalid(f"{key} must be a non-empty string of at most {max_chars} characters")
    return value


def _integer(data: dict[str, Any], key: str) -> int:
    value = data.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise _invalid(f"{key} must be an integer")
    return value


def _ids(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list):
        raise _invalid("resolvedIds must be a list")
    entries: list[Any] = value  # pyright: ignore[reportUnknownVariableType]
    if len(entries) > MAX_RESOLVED_IDS:
        raise _invalid(f"resolvedIds may hold at most {MAX_RESOLVED_IDS} ids")
    ids: list[str] = []
    for entry in entries:
        if not isinstance(entry, str) or entry == "" or len(entry) > 128:
            raise _invalid("resolvedIds must hold non-empty ids")
        if entry in ids:
            raise _invalid("resolvedIds must not repeat an id")
        ids.append(entry)
    return tuple(ids)


def _finding(
    data: dict[str, Any], reviewed_sha: str, exported_paths: Collection[str] | None
) -> Finding:
    _fields(
        data,
        {
            "id",
            "priority",
            "confidence",
            "title",
            "body",
            "path",
            "lineStart",
            "lineEnd",
            "evidence",
            "reviewedSha",
        },
        "",
    )
    finding_id = _string(data, "id", max_chars=128)
    priority = data.get("priority")
    if not isinstance(priority, str) or priority not in PRIORITIES:
        raise _invalid("priority must be one of P0, P1, P2, P3")
    confidence = data.get("confidence")
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
        raise _invalid("confidence must be a number")
    if not 0 <= float(confidence) <= 1:
        raise _invalid("confidence must be between 0 and 1")
    title = _string(data, "title", max_chars=300)
    body = data.get("body")
    if not isinstance(body, str) or len(body) > 8000:
        raise _invalid("body must be a string of at most 8000 characters")
    path = _string(data, "path", max_chars=MAX_PATH_CHARS)
    line_start = _integer(data, "lineStart")
    line_end = _integer(data, "lineEnd")
    evidence_value = data.get("evidence")
    if not isinstance(evidence_value, list):
        raise _invalid("evidence must be a list")
    evidence: list[str] = []
    for entry in evidence_value:  # pyright: ignore[reportUnknownVariableType]
        if not isinstance(entry, str) or len(entry) > 1024:
            raise _invalid("evidence entries must be strings of at most 1024 characters")
        evidence.append(entry)
    if len(evidence) > 20:
        raise _invalid("evidence may hold at most 20 entries")
    if data.get("reviewedSha") != reviewed_sha:
        raise _invalid("every finding must carry the reviewedSha of the run")
    problem = location_problem(path, line_start, line_end, exported_paths)
    if problem is not None:
        raise problem
    return Finding(
        id=finding_id,
        priority=priority,
        confidence=float(confidence),
        title=title,
        body=body,
        path=path,
        line_start=line_start,
        line_end=line_end,
        evidence=tuple(evidence),
        reviewed_sha=reviewed_sha,
    )


def parse_dynamic_findings(
    raw: str | dict[str, Any],
    *,
    exported_paths: Collection[str] | None = None,
) -> DynamicFindings:
    """Parse and validate the findings DTO. Raises `FindingsError`; never returns a half valid run.

    `exported_paths` is the set of files the runner prepared; a finding outside it fails with
    `checkout_incomplete`. Pass None to skip the membership check (for example a re-render of a
    previously validated output).
    """
    if isinstance(raw, str):
        try:
            value: Any = json.loads(raw)
        except (ValueError, RecursionError):
            raise _invalid("the findings are not valid JSON") from None
    else:
        value = raw
    document = _object(value, "the findings")
    _fields(document, {"schemaVersion", "reviewedSha", "findings", "resolvedIds"}, "")
    if document.get("schemaVersion") != 1:
        raise _invalid("schemaVersion must be 1")
    reviewed_sha = document.get("reviewedSha")
    if not isinstance(reviewed_sha, str) or not _SHA.fullmatch(reviewed_sha):
        raise _invalid("reviewedSha must be a 40 character lower-case commit id")
    findings_value = document.get("findings")
    if not isinstance(findings_value, list):
        raise _invalid("findings must be a list")
    entries: list[Any] = findings_value  # pyright: ignore[reportUnknownVariableType]
    if len(entries) > MAX_FINDINGS:
        raise _invalid(f"findings may hold at most {MAX_FINDINGS} entries")
    findings = tuple(
        _finding(_object(entry, "a finding"), reviewed_sha, exported_paths) for entry in entries
    )
    resolved_ids = _ids(document.get("resolvedIds"))
    return DynamicFindings(reviewed_sha=reviewed_sha, findings=findings, resolved_ids=resolved_ids)
