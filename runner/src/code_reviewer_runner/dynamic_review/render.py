# SPDX-License-Identifier: Apache-2.0

"""Renders one Dynamic Review state into the single persistent summary comment (#199).

The visible part is written for the reader and stays close to the Diff Review comment: a headline,
the active findings by priority with a confidence and a commit-pinned link, then the resolved
history. The hidden part is the state of `state.py`, appended as one base64 marker so it can never
be forged or broken by finding text.

Untrusted model output is never rendered raw. Text is HTML-escaped (so a finding cannot inject HTML
or a second state marker), `@` is neutralised so a finding cannot mention a person, and links are
built only from a validated repository-relative path and the reviewed commit — never from a value
in the finding. Two independent bounds are enforced: 65,000 characters and 64 KiB of UTF-8,
whichever is hit first. A state over its caps or its budget is reduced first (`fit_state`: oldest
resolved history, then the lowest priority active findings, which the view counts in a visible
"N further findings not shown" line and never marks resolved), so the comment stays updatable. When
the state fits but the visible text cannot, the detail is reduced (never an active finding) and, if
even the minimal view does not fit, the render fails with `review_text_truncated` and the caller
keeps the previous comment.
"""

import html
import re
from urllib.parse import quote, urlsplit

from code_reviewer_runner.dynamic_findings import Finding
from code_reviewer_runner.dynamic_review.reconcile import summary_counts
from code_reviewer_runner.dynamic_review.state import (
    ResolvedFinding,
    ReviewState,
    StateError,
    encode_state,
    fit_state,
)
from code_reviewer_runner.dynamic_review.wrap_up import STOPPED_EARLY_NOTICES
from code_reviewer_runner.result import ErrorCode

MAX_COMMENT_CHARS = 65_000
MAX_COMMENT_BYTES = 64 * 1024
# The exact hidden identity marker of the bot-owned summary; the publisher selects the comment by it
# (never by the visible heading, which a human comment could copy).
IDENTITY_MARKER = "<!-- code-reviewer:dynamic-review:summary -->"
# The presentation mapping the issue asks for: a stable label per priority.
PRIORITY_LABELS = {
    "P0": "🚨 P0 · Critical",
    "P1": "🔴 P1 · High",
    "P2": "🟠 P2 · Medium",
    "P3": "🔵 P3 · Low",
}
_HEADING = "## 🤖 Dynamic Review"
# Shown once on a summary that was rewritten from scratch after a state reset (#257). It is a
# constant, never built from untrusted text; the next normal run does not carry it forward.
RESET_NOTICE = (
    "> **Full review after a state reset:** earlier findings were not carried over. The findings "
    "below are re-derived from scratch."
)
_MENTION = re.compile(r"(?<![A-Za-z0-9_])@(?=[A-Za-z0-9])")
_ZERO_WIDTH = "\u200b"


class RenderError(Exception):
    """The comment cannot be rendered within its bounds. `code` is stable."""

    def __init__(self, code: ErrorCode, detail: str) -> None:
        super().__init__(f"{code.value}: {detail}")
        self.code = code
        self.detail = detail


def web_base_of(api_base_url: str) -> str:
    """The web host of a GitHub API base URL, for commit-pinned links.

    `https://api.github.com` maps to `https://github.com`; a loopback fake keeps its own origin.
    """
    parts = urlsplit(api_base_url)
    netloc = parts.netloc
    if netloc == "api.github.com":
        return "https://github.com"
    return f"{parts.scheme}://{netloc}" if parts.scheme and netloc else ""


def _safe(text: str) -> str:
    """Escape HTML and neutralise mentions: untrusted text can never become markup or a ping."""
    escaped = html.escape(text, quote=False)
    return _MENTION.sub(f"@{_ZERO_WIDTH}", escaped)


def _link(repository: str, head_sha: str, web_base: str, finding: Finding) -> str:
    label = f"`{_safe(finding.path)}:{finding.line_start}-{finding.line_end}`"
    if not web_base or "/" not in repository or not head_sha:
        return label
    path = quote(finding.path, safe="/")
    url = (
        f"{web_base}/{repository}/blob/{head_sha}/{path}#L{finding.line_start}-L{finding.line_end}"
    )
    return f"[{label}]({url})"


def _finding_block(
    finding: Finding,
    *,
    repository: str,
    head_sha: str,
    web_base: str,
    detail: int,
) -> str:
    heading = f"#### {PRIORITY_LABELS[finding.priority]} — {_safe(finding.title)}"
    meta = f"{_link(repository, head_sha, web_base, finding)} · {_confidence(finding.confidence)}"
    lines = [heading, meta]
    if detail >= 2 and finding.body:
        lines.append("")
        lines.append(_safe(finding.body))
    if detail >= 3 and finding.evidence:
        lines.append("")
        lines.append("<details><summary>Evidence</summary>")
        lines.append("")
        for item in finding.evidence:
            lines.append(f"- `{_safe(item)}`")
        lines.append("")
        lines.append("</details>")
    return "\n".join(lines)


def _confidence(confidence: float) -> str:
    return f"confidence {round(confidence * 100)}%"


def _resolved_line(entry: ResolvedFinding, *, web_base: str, repository: str, short: bool) -> str:
    finding = entry.finding
    label = f"`{_safe(finding.path)}:{finding.line_start}-{finding.line_end}`"
    sha = entry.resolved_sha[:7]
    if short:
        return f"- ~~{_safe(finding.title)}~~ ({label})"
    return f"- ~~{_safe(finding.title)}~~ ({label}, resolved in `{sha}`)"


def _visible(
    state: ReviewState,
    *,
    repository: str,
    web_base: str,
    detail: int,
    reset: bool,
    stopped_early: str | None,
) -> str:
    counts = summary_counts(state.findings)
    active_total = len(state.findings)
    resolved_total = len(state.resolved)
    headline = (
        f"**{active_total} active finding(s)**: "
        f"P0 {counts['P0']} · P1 {counts['P1']} · P2 {counts['P2']} · P3 {counts['P3']}"
    )
    parts = [IDENTITY_MARKER, _HEADING, ""]
    notice = STOPPED_EARLY_NOTICES.get(stopped_early or "")
    if notice is not None:
        parts.extend([notice, ""])
    if reset:
        parts.extend([RESET_NOTICE, ""])
    parts.append(headline)
    if not state.findings:
        parts.append("")
        parts.append("No active findings.")
    for finding in state.findings:
        parts.append("")
        parts.append(
            _finding_block(
                finding,
                repository=repository,
                head_sha=state.reviewed_sha,
                web_base=web_base,
                detail=detail,
            )
        )
    if state.omitted_findings:
        noun = "finding" if state.omitted_findings == 1 else "findings"
        parts.append("")
        parts.append(
            f"_{state.omitted_findings} further {noun} not shown: the summary keeps the highest "
            "priority and most recent active findings that fit; none of them was resolved._"
        )
    if resolved_total:
        parts.append("")
        parts.append(f"### Resolved findings ({resolved_total})")
        parts.append("")
        # The history is retained in the state; the view may shorten it when space is tight.
        shown = state.resolved if detail >= 3 else state.resolved[-20:]
        if len(shown) < resolved_total:
            parts.append(
                f"_The {resolved_total - len(shown)} oldest are kept in the review state._"
            )
            parts.append("")
        for entry in shown:
            parts.append(
                _resolved_line(entry, web_base=web_base, repository=repository, short=detail < 2)
            )
    parts.append("")
    if reset:
        parts.append(
            "_Dynamic Review found these with the read-only engine; a new review state starts "
            "below and is reconciled on the next push._"
        )
    else:
        parts.append(
            "_Dynamic Review found these with the read-only engine; the previous review state is "
            "kept below and reconciled on the next push._"
        )
    return "\n".join(parts)


def render_comment(
    state: ReviewState,
    *,
    repository: str,
    web_base: str = "",
    reset: bool = False,
    stopped_early: str | None = None,
) -> str:
    """The full comment body: the visible view plus the hidden state marker.

    `reset` (#257) adds the one-shot notice of a review that started over; it is not part of the
    state, so the next normal run renders without it. `stopped_early` (#293) does the same for a
    review that was wrapped up at its cost or time limit: one of two constant notices, chosen by
    the runner's own reason and never built from other text.

    A state over the caps or the state budget is first reduced by `fit_state` (oldest resolved
    history, then the lowest priority active findings, which the view then counts), so the comment
    that is written can always be read and updated by the next run. Raises
    `RenderError(REVIEW_TEXT_TRUNCATED)` when even the minimal view cannot fit.
    """
    state = fit_state(state)
    try:
        marker = encode_state(state)
    except StateError as error:
        raise RenderError(error.code, error.detail) from None
    suffix = f"\n\n{marker}" if marker else ""
    for detail in (3, 2, 1):
        visible = _visible(
            state,
            repository=repository,
            web_base=web_base,
            detail=detail,
            reset=reset,
            stopped_early=stopped_early,
        )
        body = f"{visible}{suffix}"
        if _fits(body):
            return body
    raise RenderError(
        ErrorCode.REVIEW_TEXT_TRUNCATED,
        "the summary cannot be shown within the comment limit",
    )


def _fits(text: str) -> bool:
    return len(text) <= MAX_COMMENT_CHARS and len(text.encode("utf-8")) <= MAX_COMMENT_BYTES
