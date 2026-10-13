# SPDX-License-Identifier: Apache-2.0

"""Publishes one Dynamic Review into the single persistent summary comment (#199).

The publisher owns the whole write:

1. page the pull request's comments and select the bot-owned summary by its exact hidden identity
   marker **and** its author (the bot login); a human copy of the marker never authorizes an edit,
   and two bot summaries fail closed;
2. read and validate the previous state from that comment; a corrupt or unsupported state fails
   closed, it is never replaced by an empty one;
3. refuse a stale result: the state of the comment may only be the reviewed head of this job or the
   head this job compared against; a comment that already holds a newer head is left alone;
4. redact the known secrets of the job from the findings before they are stored, so a secret the
   model echoed never reaches GitHub or the next prompt;
5. reconcile the run with the previous state, render the comment, and create it (first run) or edit
   it (every run after);
6. a create/edit that timed out re-reads the comment for the same reviewed head instead of blindly
   creating a second one.

The state only advances with a confirmed successful write: the comment GitHub returns is the new
state. A write that was already accepted before a lost lease cannot be recalled; the next run
reconciles from whatever state it finds, which is why staleness is checked before the write.
"""

import re
from dataclasses import dataclass, replace

from code_reviewer_runner.dynamic_findings import DynamicFindings, Finding
from code_reviewer_runner.dynamic_review.github import (
    Comment,
    CommentsClient,
    GitHubError,
    HttpCommentsClient,
)
from code_reviewer_runner.dynamic_review.reconcile import reconcile
from code_reviewer_runner.dynamic_review.render import (
    IDENTITY_MARKER,
    RenderError,
    render_comment,
    web_base_of,
)
from code_reviewer_runner.dynamic_review.state import (
    ResolvedFinding,
    ReviewState,
    StateError,
    decode_state,
)
from code_reviewer_runner.job import Job
from code_reviewer_runner.redaction import Redactor
from code_reviewer_runner.result import ErrorCode

_PR_NUMBER = re.compile(r"/pull/([1-9][0-9]{0,8})(?:$|[/?#])")


class PublishError(Exception):
    """The review could not be published. `code` is stable."""

    def __init__(self, code: ErrorCode, detail: str) -> None:
        super().__init__(f"{code.value}: {detail}")
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class Published:
    comment_url: str
    created: bool


@dataclass
class Publisher:
    """Everything one publication needs. The client is the narrow GitHub client (or a double)."""

    client: CommentsClient
    bot_login: str
    repository: str
    pr_number: int
    web_base: str = ""
    redactor: Redactor | None = None

    def publish(
        self,
        run: DynamicFindings,
        *,
        head_sha: str,
        previous_reviewed_sha: str | None,
    ) -> Published:
        if run.reviewed_sha != head_sha:
            raise PublishError(
                ErrorCode.DYNAMIC_POLICY_VIOLATION,
                "the run did not review the exact head of the job",
            )
        try:
            comments = self.client.list_comments(self.pr_number)
        except GitHubError as error:
            raise PublishError(error.code, error.detail) from None
        existing = self._summary_comment(comments)
        previous = self._previous_state(existing, head_sha, previous_reviewed_sha)
        redacted = redact_findings(run, self.redactor)
        state = reconcile(previous, redacted)
        body = self._render(state)
        return self._write(existing, body, head_sha)

    # -- selection and state ---------------------------------------------------------------

    def _summary_comment(self, comments: list[Comment]) -> Comment | None:
        bot = self.bot_login.casefold()
        candidates = [
            comment
            for comment in comments
            if comment.author.casefold() == bot and IDENTITY_MARKER in comment.body
        ]
        if len(candidates) > 1:
            raise PublishError(
                ErrorCode.DYNAMIC_POLICY_VIOLATION,
                "more than one bot-owned Dynamic summary comment exists",
            )
        return candidates[0] if candidates else None

    def _previous_state(
        self,
        existing: Comment | None,
        head_sha: str,
        previous_reviewed_sha: str | None,
    ) -> ReviewState:
        if existing is None:
            return ReviewState(reviewed_sha="", findings=(), resolved=())
        try:
            state = decode_state(existing.body)
        except StateError as error:
            raise PublishError(error.code, error.detail) from None
        if state is None:
            raise PublishError(
                ErrorCode.DYNAMIC_POLICY_VIOLATION,
                "the bot-owned summary comment holds no review state",
            )
        allowed = {head_sha}
        if previous_reviewed_sha:
            allowed.add(previous_reviewed_sha)
        if state.reviewed_sha and state.reviewed_sha not in allowed:
            # The summary already holds a newer head (a result that arrived late): do not overwrite.
            raise PublishError(
                ErrorCode.REVIEW_NOT_PUBLISHED,
                "a newer review is already published for this pull request",
            )
        return redact_state(state, self.redactor)

    # -- rendering and writing -------------------------------------------------------------

    def _render(self, state: ReviewState) -> str:
        try:
            return render_comment(state, repository=self.repository, web_base=self.web_base)
        except RenderError as error:
            raise PublishError(error.code, error.detail) from None

    def _write(self, existing: Comment | None, body: str, head_sha: str) -> Published:
        if existing is not None:
            return self._edit(existing.id, body)
        try:
            created = self.client.create_comment(self.pr_number, body)
        except GitHubError as error:
            if error.code is not ErrorCode.GIT_UNAVAILABLE:
                raise PublishError(error.code, error.detail) from None
            # The create may have been accepted before the answer was lost. Never create blindly.
            found = self._find_published(head_sha)
            if found is None:
                raise PublishError(error.code, error.detail) from None
            return Published(comment_url=found.url, created=True)
        return Published(comment_url=created.url, created=True)

    def _edit(self, comment_id: str, body: str) -> Published:
        try:
            edited = self.client.edit_comment(comment_id, body)
        except GitHubError as error:
            raise PublishError(error.code, error.detail) from None
        return Published(comment_url=edited.url, created=False)

    def _find_published(self, head_sha: str) -> Comment | None:
        """Re-read after an ambiguous create: the same reviewed head and bot identity means ours."""
        try:
            comments = self.client.list_comments(self.pr_number)
        except GitHubError:
            return None
        bot = self.bot_login.casefold()
        for comment in comments:
            if comment.author.casefold() != bot or IDENTITY_MARKER not in comment.body:
                continue
            try:
                state = decode_state(comment.body)
            except StateError:
                continue
            if state is not None and state.reviewed_sha == head_sha:
                return comment
        return None


def redact_text(text: str, redactor: Redactor | None) -> str:
    return text if redactor is None else redactor.redact(text)


def redact_findings(run: DynamicFindings, redactor: Redactor | None) -> DynamicFindings:
    if redactor is None:
        return run
    return DynamicFindings(
        reviewed_sha=run.reviewed_sha,
        findings=tuple(_redact_finding(finding, redactor) for finding in run.findings),
        resolved_ids=tuple(redactor.redact(finding_id) for finding_id in run.resolved_ids),
    )


def redact_state(state: ReviewState, redactor: Redactor | None) -> ReviewState:
    if redactor is None:
        return state
    return replace(
        state,
        findings=tuple(_redact_finding(finding, redactor) for finding in state.findings),
        resolved=tuple(
            ResolvedFinding(
                finding=_redact_finding(entry.finding, redactor),
                resolved_sha=entry.resolved_sha,
            )
            for entry in state.resolved
        ),
    )


def _redact_finding(finding: Finding, redactor: Redactor) -> Finding:
    """Redact the free text of a finding. The id is redacted too, deterministically, so identity
    stays stable across runs; a path is a validated repository-relative location and is kept."""
    return replace(
        finding,
        id=redactor.redact(finding.id),
        title=redactor.redact(finding.title),
        body=redactor.redact(finding.body),
        evidence=tuple(redactor.redact(item) for item in finding.evidence),
    )


def publisher_for(job: Job) -> Publisher:
    """The publisher one Dynamic job writes through: its narrowed installation token, its bot
    login and the workspace-less comment routes of its repository. The engine (#197) calls this
    once it has validated the run's findings."""
    if job.base is None:
        raise PublishError(
            ErrorCode.DYNAMIC_POLICY_VIOLATION, "a Dynamic job without checkout facts"
        )
    match = _PR_NUMBER.search(job.pr_url)
    if match is None:
        raise PublishError(ErrorCode.DYNAMIC_POLICY_VIOLATION, "the pull request url has no number")
    return Publisher(
        client=HttpCommentsClient(job.git.base_url, job.base.repository, job.git.token),
        bot_login=job.git.bot_login,
        repository=job.base.repository,
        pr_number=int(match.group(1)),
        web_base=web_base_of(job.git.base_url),
        redactor=Redactor(job.secrets),
    )
