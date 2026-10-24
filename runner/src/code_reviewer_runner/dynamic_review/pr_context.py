# SPDX-License-Identifier: LicenseRef-Proprietary

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
earlier findings). Its instruction-shaped framing (`<system-reminder>`, chat-template tokens) is
escaped like tool results are (#232/#243, `tagescape.py`), and then it is capped in bytes, so the
cap bounds the final size even after `<` has grown to `&lt;` and a cut can never leave half of a
tag. It counts against the review input bound as a small, fixed share. It then travels only in the
fenced, digest-closed data blocks of the user prompt (#198); it never reaches the system prompt,
the engine config, a command or a permission.

The whole read has its own deadline (`CONTEXT_DEADLINE_SECONDS`, across every request and every
page), far below the job's: a slow GitHub ends the preparation with `git_unavailable` instead of
holding the user lease and the slot.

The prior state lists finding ids as the model stored them. They reach the model escaped like the
rest, so an id that the escape would change could never be named back in `resolvedIds`; the
findings parser therefore refuses such an id (`dynamic_findings.py`), and none is ever stored.
"""

import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from code_reviewer_runner.dynamic_review.github import (
    CommentsClient,
    GitHubError,
    HttpCommentsClient,
    PullRequestText,
)
from code_reviewer_runner.dynamic_review.limits import CheckoutError, CheckoutReason
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
# All the requests of one context read together (the pull request and every page of comments), and
# the longest any one of them may wait. The job's own deadline is far longer; this read must not
# spend it, nor hold the user lease and the slot, on a slow GitHub.
CONTEXT_DEADLINE_SECONDS = 60.0
CONTEXT_REQUEST_TIMEOUT_SECONDS = 10.0


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
    # Escape, then cap: the cap bounds the final size, and a cut inside `&lt;` or at a lone `<`
    # cannot form a tag.
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
    deadline_seconds: float = CONTEXT_DEADLINE_SECONDS,
    clock: Callable[[], float] = time.monotonic,
) -> PreparationContext:
    """Read the title, body and prior state of the job's own pull request, or fail closed.

    Only the repository and the pull request the claim names are read, with the job's token and the
    publisher's own comment selection. A failure is a `CheckoutError` with the stable code; its
    text never carries a value from GitHub. The whole read must end within `deadline_seconds`.
    """
    base = job.base
    if base is None:
        raise CheckoutError(CheckoutReason.INVALID_REQUEST, ErrorCode.DYNAMIC_POLICY_VIOLATION)
    deadline = clock() + deadline_seconds

    def time_left() -> float:
        return deadline - clock()

    try:
        client = client or HttpCommentsClient(
            job.git.base_url,
            base.repository,
            job.git.token,
            request_timeout=CONTEXT_REQUEST_TIMEOUT_SECONDS,
            time_left=time_left,
        )
        publisher = publisher_for(job, client)
        _may_continue(cancelled, time_left)
        text = client.get_pull_request(publisher.pr_number)
        _may_continue(cancelled, time_left)
        state = publisher.read_previous_state(
            base.head_sha,
            base.previous_reviewed_sha,
            base.attempted_shas,
            base.attempted_shas_truncated,
        )
        _may_continue(cancelled, time_left)
    except (GitHubError, PublishError) as error:
        raise CheckoutError(CheckoutReason.CONTEXT, error.code) from None
    return PreparationContext(
        metadata=metadata_text(text.title, text.body), prior_state=prior_state_text(state)
    )


def _may_continue(cancelled: Callable[[], bool], time_left: Callable[[], float]) -> None:
    if cancelled():
        raise CheckoutError(CheckoutReason.CANCELLED)
    if time_left() <= 0:
        raise CheckoutError(CheckoutReason.TIMEOUT, ErrorCode.GIT_UNAVAILABLE)
