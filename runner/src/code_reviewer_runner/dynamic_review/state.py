# SPDX-License-Identifier: Apache-2.0

# pyright: reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false
"""The persistent Dynamic Review state that survives from one review into the next (#199).

The state is what makes a re-review possible: the ids and findings of the earlier runs, the ids this
run affirmatively resolved, and the exact head reviewed. It lives in **one** place: a hidden HTML
comment at the end of the bot-owned summary comment. There is no second comment and no second
database (the issue's rule); the visible part of the comment is the reader's view and the hidden
marker is the runner's own record.

Two forms of the same object exist:

- the stored form, a base64 payload inside a fixed marker, so no finding text can forge a second
  marker and no JSON escape can break the comment's framing (`encode_state` / `decode_state`), and
- the prompt form, the bounded text handed to the model as "previous review state", which lists the
  active findings with their stable ids and never their full history (`render_previous_state`).

The stored state is untrusted input: it is validated exactly like model output. An unknown version,
an unknown field, an out-of-range value, a path that is not repository-relative or a state that does
not fit the byte budget fails closed with `dynamic_policy_violation` — never an empty state that
would silently forget the history.
"""

import base64
import json
import re
from dataclasses import dataclass
from typing import Any

from code_reviewer_runner.dynamic_findings import Finding, FindingsError, parse_finding
from code_reviewer_runner.result import ErrorCode

STATE_SCHEMA_VERSION = 1
MARKER_PREFIX = "<!-- code-reviewer:dynamic-review-state:v1 "
MARKER_SUFFIX = " -->"
# The stored payload is base64 text; this is its hard limit in characters. The renderer keeps the
# whole comment under a lower, user-facing limit (65,000 characters); this bound is the state alone.
MAX_STATE_CHARS = 48_000
# Resolved history is retained losslessly (the spike's 20-entry PR-Agent cap is a concrete blocker);
# beyond this many entries the state no longer fits and the write fails closed, it is never pruned.
MAX_RESOLVED = 500

_MARKER = re.compile(r"<!--\s*code-reviewer:dynamic-review-state:v1\s+([A-Za-z0-9+/=]+)\s*-->")
_SHA = re.compile(r"[0-9a-f]{40}")


class StateError(Exception):
    """The stored state cannot be trusted. `code` is stable; `detail` names a field, not a value."""

    def __init__(self, code: ErrorCode, detail: str) -> None:
        super().__init__(f"{code.value}: {detail}")
        self.code = code
        self.detail = detail


def _invalid(detail: str) -> StateError:
    return StateError(ErrorCode.DYNAMIC_POLICY_VIOLATION, detail)


@dataclass(frozen=True)
class ResolvedFinding:
    """A finding that an earlier run affirmatively resolved, with the run that resolved it."""

    finding: Finding
    resolved_sha: str


@dataclass(frozen=True)
class ReviewState:
    """The active findings, the resolved history and the exact head they are current as of."""

    reviewed_sha: str
    findings: tuple[Finding, ...]
    resolved: tuple[ResolvedFinding, ...]


def empty_state() -> ReviewState:
    """The state before the first Dynamic review: no findings and no resolved history."""
    return ReviewState(reviewed_sha="", findings=(), resolved=())


def _sha(value: Any, field: str) -> str:
    if not isinstance(value, str) or not _SHA.fullmatch(value):
        raise _invalid(f"{field} must be a 40 character lower-case commit id")
    return value


def _object(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise _invalid(f"{field} must be an object")
    return value


def _fields(data: dict[str, Any], allowed: set[str], prefix: str) -> None:
    for key in data:
        if key not in allowed:
            named = bool(re.fullmatch(r"[A-Za-z0-9_.-]{1,40}", key))
            raise _invalid(f"unknown field {prefix}{key if named else '<invalid name>'}")


def _resolved_entry(data: Any) -> ResolvedFinding:
    entry = _object(data, "a resolved finding")
    _fields(entry, {"resolvedSha", "finding"}, "resolved.")
    resolved_sha = _sha(entry.get("resolvedSha"), "resolved.resolvedSha")
    finding_data = _object(entry.get("finding"), "resolved.finding")
    # The reviewedSha a resolved finding carries is the run that raised it, not the resolver.
    raised_sha = _sha(finding_data.get("reviewedSha"), "resolved.finding.reviewedSha")
    return ResolvedFinding(
        finding=parse_finding(finding_data, raised_sha), resolved_sha=resolved_sha
    )


def parse_state_payload(payload: dict[str, Any]) -> ReviewState:
    """Validate one decoded payload. Raises `StateError`; never returns a half valid state."""
    try:
        return _parse_state_payload(payload)
    except FindingsError as error:
        # A finding in the state is validated exactly like model output; its error becomes the
        # codec's own, so a caller only has to know one error type for untrusted state.
        raise StateError(error.code, error.detail) from None


def _parse_state_payload(payload: dict[str, Any]) -> ReviewState:
    _fields(payload, {"schemaVersion", "reviewedSha", "findings", "resolved"}, "")
    version = payload.get("schemaVersion")
    if isinstance(version, bool) or not isinstance(version, int) or version != STATE_SCHEMA_VERSION:
        raise _invalid(f"the state schema version must be {STATE_SCHEMA_VERSION}")
    reviewed_sha = _sha(payload.get("reviewedSha"), "reviewedSha")
    findings_value = payload.get("findings")
    if not isinstance(findings_value, list):
        raise _invalid("findings must be a list")
    findings: list[Finding] = []
    for entry in findings_value:
        # An active finding the latest run did not re-raise is carried over unchanged, so it keeps
        # the head it was raised at: it is validated against its own `reviewedSha`, not the state's.
        raised_sha = _sha(_object(entry, "a finding").get("reviewedSha"), "findings.reviewedSha")
        findings.append(parse_finding(entry, raised_sha))
    if len(findings) > 30:
        raise _invalid("findings may hold at most 30 entries")
    resolved_value = payload.get("resolved")
    if not isinstance(resolved_value, list):
        raise _invalid("resolved must be a list")
    if len(resolved_value) > MAX_RESOLVED:
        raise _invalid(f"resolved may hold at most {MAX_RESOLVED} entries")
    resolved: list[ResolvedFinding] = []
    seen: set[str] = set()
    for entry in resolved_value:
        item = _resolved_entry(entry)
        if item.finding.id in seen:
            raise _invalid("resolved must not repeat a finding id")
        seen.add(item.finding.id)
        resolved.append(item)
    return ReviewState(
        reviewed_sha=reviewed_sha, findings=tuple(findings), resolved=tuple(resolved)
    )


def _finding_json(finding: Finding) -> dict[str, Any]:
    return {
        "id": finding.id,
        "priority": finding.priority,
        "confidence": finding.confidence,
        "title": finding.title,
        "body": finding.body,
        "path": finding.path,
        "lineStart": finding.line_start,
        "lineEnd": finding.line_end,
        "evidence": list(finding.evidence),
        "reviewedSha": finding.reviewed_sha,
    }


def state_payload(state: ReviewState) -> dict[str, Any]:
    return {
        "schemaVersion": STATE_SCHEMA_VERSION,
        "reviewedSha": state.reviewed_sha,
        "findings": [_finding_json(finding) for finding in state.findings],
        "resolved": [
            {
                "resolvedSha": entry.resolved_sha,
                "finding": _finding_json(entry.finding),
            }
            for entry in state.resolved
        ],
    }


def encode_state(state: ReviewState) -> str:
    """The single hidden marker line that carries the state, or "" for an empty state.

    The payload is base64 so it holds no `-->`, no newline and no `<`: nothing a finding body
    contains can close the marker or split it, and the visible text can never forge it.
    """
    if state.reviewed_sha == "" and not state.findings and not state.resolved:
        return ""
    raw = json.dumps(state_payload(state), ensure_ascii=True, separators=(",", ":"))
    encoded = base64.b64encode(raw.encode("ascii")).decode("ascii")
    if len(encoded) > MAX_STATE_CHARS:
        raise StateError(
            ErrorCode.REVIEW_STATE_TRUNCATED,
            f"the review state exceeds {MAX_STATE_CHARS} characters",
        )
    return f"{MARKER_PREFIX}{encoded}{MARKER_SUFFIX}"


def decode_state(text: str) -> ReviewState | None:
    """The state of the last marker in `text`, or None when there is none.

    The last marker wins: the runner always appends its own state and any earlier marker is either a
    previous state (an edit in progress) or text that no escaping could produce. A marker that does
    not decode is corrupt and fails closed rather than being treated as "no state".
    """
    matches = _MARKER.findall(text)
    if not matches:
        return None
    encoded = matches[-1]
    try:
        raw = base64.b64decode(encoded, validate=True)
        payload = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise _invalid("the review state is not a valid payload") from None
    return parse_state_payload(_object(payload, "the review state"))


def render_previous_state(state: ReviewState, *, max_chars: int = 16_000) -> str:
    """The bounded text handed to the model as the previous review state.

    Only the active findings are listed; the resolved history stays in the stored state. Each line
    carries the id so the model can keep it stable and can name it in `resolvedIds`.
    """
    if not state.findings:
        return ""
    lines: list[str] = ["Active findings from earlier reviews (keep their ids stable):"]
    for finding in state.findings:
        line = (
            f"- id={finding.id} [{finding.priority}] confidence={finding.confidence:.2f} "
            f"{finding.path}:{finding.line_start}-{finding.line_end} — {finding.title}"
        )
        if len("\n".join([*lines, line])) > max_chars:
            lines.append("- (more active findings are not shown here; they stay active)")
            break
        lines.append(line)
    return "\n".join(lines)
