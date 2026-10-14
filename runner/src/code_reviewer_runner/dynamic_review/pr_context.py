# SPDX-License-Identifier: Apache-2.0

"""The pull request text and the prior review state the Dynamic engine is given (#201).

The trusted preparer (`supervisor.production_preparer`) reads two things for the job and hands them
to the verified preparation (#196), which redacts the job's secrets in them and counts them against
its byte budget:

- the **title and body** of the job's own pull request, with the job's narrowed token, and
- the **prior state**: the active findings of the bot-owned persisted summary of that same pull
  request (#199), read with the publisher's own selection (exact identity marker and bot author),
  validation and head accounting. A corrupt, unsupported or unaccountable state, or a GitHub
  failure, ends the preparation with a stable code: the history is never replaced by an empty
  state.

Everything read here is untrusted data (a person wrote the title and the body, a model wrote the
earlier findings). It is capped in bytes first, so it counts against the review input bound as a
small, fixed share, and its instruction-shaped framing (`<system-reminder>`, chat-template tokens)
is escaped like tool results are (#232/#243, `tagescape.py`). It then travels only in the fenced,
digest-closed data blocks of the user prompt (#198); it never reaches the system prompt, the
engine config, a command or a permission.
"""

import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from code_reviewer_runner.dynamic_review.github import (
    CommentsClient,
    GitHubError,
    HttpCommentsClient,
    PullRequestText,
)
from code_reviewer_runner.dynamic_review.limits import CheckoutError
from code_reviewer_runner.dynamic_review.publish import PublishError, publisher_for
from code_reviewer_runner.dynamic_review.state import ReviewState, render_previous_state
from code_reviewer_runner.dynamic_review.tagescape import escape_text
from code_reviewer_runner.job import Job
from code_reviewer_runner.result import ErrorCode

# The most UTF-8 bytes of each piece the model is given, the cut marker included. A pull request
# description can be 65,000 characters; the review reads the code, not an essay, and every byte
# here is a token the budget (#231) cannot spend on the code.
MAX_TITLE_BYTES = 1024
MAX_BODY_BYTES = 16 * 1024
MAX_PRIOR_STATE_BYTES = 16 * 1024
TRUNCATION_MARKER = "\n[cut by the runner: longer than the review input allows]"


@dataclass(frozen=True)
class PreparationContext:
    """What `prepare_job_content` takes as `metadata` and `prior_state`."""

    metadata: str
    prior_state: str


class ContextClient(CommentsClient, Protocol):
    """The calls the context needs: the comments (prior state) and the pull request (text)."""

    def get_pull_request(self, pr_number: int) -> PullRequestText: ...


def _capped(text: str, cap: int) -> str:
    """At most `cap` UTF-8 bytes, cut on a character boundary and marked when something is cut.

    A lone surrogate (a JSON escape in the GitHub answer) is not encodable; it becomes `?` instead
    of failing the job.
    """
    raw = text.encode("utf-8", "replace")
    if len(raw) <= cap:
        return raw.decode("utf-8")
    marker = TRUNCATION_MARKER.encode("utf-8")
    return raw[: cap - len(marker)].decode("utf-8", "ignore") + TRUNCATION_MARKER


def _untrusted(text: str, cap: int) -> str:
    return _capped(escape_text(text), cap)


def metadata_text(title: str, body: str) -> str:
    """The `metadata` of the preparation: the bounded, escaped title and body as the JSON object
    `inputs.split_metadata` reads."""
    return json.dumps(
        {"title": _untrusted(title, MAX_TITLE_BYTES), "body": _untrusted(body, MAX_BODY_BYTES)},
        ensure_ascii=True,
    )


def prior_state_text(state: ReviewState) -> str:
    """The `prior_state` of the preparation: the active findings, bounded and escaped."""
    return _untrusted(render_previous_state(state), MAX_PRIOR_STATE_BYTES)


def load_context(
    job: Job,
    *,
    client: ContextClient | None = None,
    cancelled: Callable[[], bool] = lambda: False,
) -> PreparationContext:
    """Read the title, body and prior state of the job's own pull request, or fail closed.

    Only the repository and the pull request the claim names are read, with the job's token and the
    publisher's own comment selection. A failure is a `CheckoutError` with the stable code; its
    text never carries a value from GitHub.
    """
    base = job.base
    if base is None:
        raise CheckoutError(ErrorCode.DYNAMIC_POLICY_VIOLATION)
    client = client or HttpCommentsClient(job.git.base_url, base.repository, job.git.token)
    try:
        publisher = publisher_for(job, client)
        _not_cancelled(cancelled)
        text = client.get_pull_request(publisher.pr_number)
        _not_cancelled(cancelled)
        state = publisher.read_previous_state(base.head_sha, base.previous_reviewed_sha)
    except (GitHubError, PublishError) as error:
        raise CheckoutError(error.code) from None
    return PreparationContext(
        metadata=metadata_text(text.title, text.body), prior_state=prior_state_text(state)
    )


def _not_cancelled(cancelled: Callable[[], bool]) -> None:
    if cancelled():
        raise CheckoutError()
