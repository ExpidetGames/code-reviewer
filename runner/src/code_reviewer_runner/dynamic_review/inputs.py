# SPDX-License-Identifier: LicenseRef-Proprietary

"""What the reviewer is given, taken from the verified preparation (#197, wiring of #196).

`PreparedContent` (#196) is the only source: the sanitized base-to-head diff, the sanitized prior
state, the metadata the trusted preparer supplied and the exact comparison mode the preparation
ended up with (a requested incremental review whose previous tree was unavailable is a declared
full review, and the prompt says so). The claim's own `comparison` is a request, not the mode.
Everything here is untrusted data for the prompt and is delimited there.
"""

import json
from typing import Any

from code_reviewer_runner.dynamic_review.checkout import PreparedContent
from code_reviewer_runner.dynamic_review.prompts import ReviewInputs
from code_reviewer_runner.job_loop.jsonvalues import as_object

# At most this many omitted or skipped paths are listed to the model; the rest is one count line.
MAX_LIMITATION_LINES = 200


def split_metadata(metadata: str) -> tuple[str, str]:
    """The pull request title and body out of the preparer's metadata text.

    The trusted preparer supplies `{"title": ..., "body": ...}`; any other text is the body, so
    nothing the preparer sent is dropped.
    """
    try:
        value: Any = json.loads(metadata)
    except ValueError:
        return "", metadata
    document = as_object(value)
    title: Any = document.get("title") if document else None
    body: Any = document.get("body") if document else None
    if isinstance(title, str) and isinstance(body, str):
        return title, body
    return "", metadata


def limitations(content: PreparedContent) -> str:
    """Skipped and omitted paths as plain lines, so a limitation is never claimed as reviewed."""
    lines = [f"skipped ({entry.reason.value}): {entry.path}" for entry in content.skipped]
    lines += [f"omitted ({entry.reason.value}): {entry.path}" for entry in content.omissions]
    if len(lines) > MAX_LIMITATION_LINES:
        extra = len(lines) - MAX_LIMITATION_LINES
        lines = [*lines[:MAX_LIMITATION_LINES], f"... and {extra} more"]
    return "\n".join(lines)


def review_inputs(pr_url: str, content: PreparedContent) -> ReviewInputs:
    """The prompt inputs of one run: the real title, body, diff and prior state (#196)."""
    title, body = split_metadata(content.metadata)
    incremental = content.comparison == "incremental"
    return ReviewInputs(
        pr_url=pr_url,
        pr_title=title,
        pr_body=body,
        diff=content.diff,
        comparison=content.comparison,
        previous_review_state=content.prior_state,
        incremental_diff=content.previous_diff if incremental else "",
        limitations=limitations(content),
    )
