# SPDX-License-Identifier: Apache-2.0

"""Publishes one Dynamic Review into the single persistent summary comment (#199).

The publisher owns the whole write:

1. page the pull request's comments and select the bot-owned summary by its exact hidden identity
   marker **and** its author (the bot login, a `Bot` account and, when GitHub names it, the app
   slug: `Comment.is_written_by`); a human copy of the marker never authorizes an edit, and two bot
   summaries fail closed;
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
state. A write that was already accepted before a lost lease cannot be recalled. The next run
reconciles from the state it finds **only if** that state is one it can account for: the head it
reviews, the head the app reports as the last successful review (`previousReviewedSha`), or a head
the app reports it attempted (`attemptedShas`, #255): an earlier job of this pull request that did
not succeed, which may have written the summary before it failed, lost its lease or was replaced.
Any other head is refused with `review_not_published` and the comment is left as it is. That is
fail-closed by design - the safe choice, because a state of unknown origin could be a newer review
that must not be overwritten: the app never names a job newer than the one it hands out, so a late
result of an older run still finds a head it cannot account for.

One exception closes the last wedge (#257): the list of attempted heads is bounded, so after more
heads than it holds the head of the comment can fall out of it. The app then says so
(`attemptedShasTruncated`), and a head this job cannot account for on the bot-owned summary (the
exact marker and author, a valid state) is recovered with a full review: the old state is dropped
entirely, nothing of it is carried over as active or resolved, and the same comment is rewritten. A
comment that is not the bot's, a corrupt state and a claim that was not truncated stay fail-closed.
The price is a late result of an older run, which a truncated claim can no longer tell from a lost
head; the next push reviews again.
"""

import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace

from code_reviewer_runner.dynamic_findings import DynamicFindings, Finding
from code_reviewer_runner.dynamic_review.failure_note import FailureNote, failure_note_for
from code_reviewer_runner.dynamic_review.github import (
    Comment,
    CommentsClient,
    GitHubError,
    HttpCommentsClient,
)
from code_reviewer_runner.dynamic_review.reconcile import reconcile
from code_reviewer_runner.dynamic_review.render import (
    IDENTITY_MARKER,
    NO_REVIEW_MARKER,
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

# The stable token in the result log that a run started over after a state reset (#257); the Runs
# view shows the log, so an operator can see it.
STATE_RESET_CODE = "state_reset_attempted_shas_truncated"
_EMPTY_STATE = ReviewState(reviewed_sha="", findings=(), resolved=())
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
    # True when the summary was rewritten from scratch after a state reset (#257).
    reset: bool = False


@dataclass
class Publisher:
    """Everything one publication needs. The client is the narrow GitHub client (or a double)."""

    client: CommentsClient
    bot_login: str
    repository: str
    pr_number: int
    web_base: str = ""
    redactor: Redactor | None = None
    # Asked right before the one write (#396): False means the run was superseded since the checks
    # before, and nothing is written.
    may_write: Callable[[], bool] | None = None

    def publish(
        self,
        run: DynamicFindings,
        *,
        head_sha: str,
        previous_reviewed_sha: str | None,
        attempted_shas: Sequence[str] = (),
        attempted_shas_truncated: bool = False,
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
        previous, reset = self._previous_state(
            existing, head_sha, previous_reviewed_sha, attempted_shas, attempted_shas_truncated
        )
        redacted = redact_findings(run, self.redactor)
        state = reconcile(previous, redacted)
        body = self._render(state, reset=reset, stopped_early=run.stopped_early)
        published = self._write(existing, body, head_sha)
        return replace(published, reset=reset)

    def publish_failure(
        self,
        note: FailureNote,
        *,
        head_sha: str,
        previous_reviewed_sha: str | None,
        attempted_shas: Sequence[str] = (),
        attempted_shas_truncated: bool = False,
    ) -> Published:
        """Puts the note of a failed run into the summary (#299): the same comment as a review.

        The state is validated exactly as for a review. An earlier review stays as it is, findings
        and head alike; only the note on top of it is added or replaced. When there is no summary
        yet, one is created whose state holds no findings and the head of the failed run, which is
        a head the app reports as attempted, so the next run (of any runner version) can read it.
        A head this job cannot account for is refused, never overwritten, and a state that would be
        dropped by a reset is not dropped for a note.
        """
        try:
            comments = self.client.list_comments(self.pr_number)
        except GitHubError as error:
            raise PublishError(error.code, error.detail) from None
        existing = self._summary_comment(comments)
        previous, reset = self._previous_state(
            existing, head_sha, previous_reviewed_sha, attempted_shas, attempted_shas_truncated
        )
        if reset:
            raise PublishError(
                ErrorCode.REVIEW_NOT_PUBLISHED,
                "the earlier summary is not accounted for, so no note is written over it",
            )
        state = previous if existing is not None else ReviewState(head_sha, (), ())
        # A summary that is only a note has the state of a clean review; its mark says which it is.
        never_reviewed = existing is None or NO_REVIEW_MARKER in existing.body
        body = self._render(state, failure_note=note, never_reviewed=never_reviewed)
        return self._write(existing, body, head_sha)

    def read_previous_state(
        self,
        head_sha: str,
        previous_reviewed_sha: str | None,
        attempted_shas: Sequence[str] = (),
        attempted_shas_truncated: bool = False,
    ) -> ReviewState:
        """The state the next review starts from (#201): the bot-owned summary of this pull
        request, validated exactly as a write validates it, or an empty state when there is no
        summary yet. A state this job cannot account for fails closed, here as at the write."""
        try:
            comments = self.client.list_comments(self.pr_number)
        except GitHubError as error:
            raise PublishError(error.code, error.detail) from None
        state, _ = self._previous_state(
            self._summary_comment(comments),
            head_sha,
            previous_reviewed_sha,
            attempted_shas,
            attempted_shas_truncated,
        )
        return state

    # -- selection and state ---------------------------------------------------------------

    def _summary_comment(self, comments: list[Comment]) -> Comment | None:
        candidates = [
            comment
            for comment in comments
            if comment.is_written_by(self.bot_login) and IDENTITY_MARKER in comment.body
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
        attempted_shas: Sequence[str],
        attempted_shas_truncated: bool,
    ) -> tuple[ReviewState, bool]:
        """The state to reconcile from and whether it is a reset (#257): the bot's own summary was
        dropped because its head could not be accounted for."""
        if existing is None:
            return _EMPTY_STATE, False
        try:
            state = decode_state(existing.body)
        except StateError as error:
            raise PublishError(error.code, error.detail) from None
        if state is None:
            raise PublishError(
                ErrorCode.DYNAMIC_POLICY_VIOLATION,
                "the bot-owned summary comment holds no review state",
            )
        allowed = {head_sha, *attempted_shas}
        if previous_reviewed_sha:
            allowed.add(previous_reviewed_sha)
        if state.reviewed_sha and state.reviewed_sha not in allowed:
            if attempted_shas_truncated:
                # The bot's own summary, but its head fell out of the bounded list (#257): a full
                # review that rewrites it. Nothing is merged from a state it cannot account for.
                return _EMPTY_STATE, True
            # A head this job cannot account for: a newer review (a result that arrived late) or a
            # state the app never produced. Both are refused, never merged.
            raise PublishError(
                ErrorCode.REVIEW_NOT_PUBLISHED,
                "a newer review is already published for this pull request",
            )
        return redact_state(state, self.redactor), False

    # -- rendering and writing -------------------------------------------------------------

    def _render(
        self,
        state: ReviewState,
        *,
        reset: bool = False,
        stopped_early: str | None = None,
        failure_note: FailureNote | None = None,
        never_reviewed: bool = False,
    ) -> str:
        try:
            return render_comment(
                state,
                repository=self.repository,
                web_base=self.web_base,
                reset=reset,
                stopped_early=stopped_early,
                failure_note=failure_note,
                never_reviewed=never_reviewed,
            )
        except RenderError as error:
            raise PublishError(error.code, error.detail) from None

    def _may_write_now(self) -> None:
        if self.may_write is not None and not self.may_write():
            raise PublishError(
                ErrorCode.SUPERSEDED,
                "the run was superseded by a newer push, so nothing was written",
            )

    def _write(self, existing: Comment | None, body: str, head_sha: str) -> Published:
        self._may_write_now()
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
        self._may_write_now()
        try:
            edited = self.client.edit_comment(comment_id, body)
        except GitHubError as error:
            if error.code is not ErrorCode.GIT_UNAVAILABLE:
                raise PublishError(error.code, error.detail) from None
            # The edit may have been accepted before the answer was lost (#255): when our own
            # comment now holds exactly the body we sent, the write landed and the run is done.
            found = self._find_edited(comment_id, body)
            if found is None:
                raise PublishError(error.code, error.detail) from None
            return Published(comment_url=found.url, created=False)
        return Published(comment_url=edited.url, created=False)

    def _find_edited(self, comment_id: str, body: str) -> Comment | None:
        """Re-read after an ambiguous edit. An edit keeps the head of a re-review, so the head
        cannot tell it apart: the bot-owned comment must carry byte for byte the body we wrote."""
        try:
            comments = self.client.list_comments(self.pr_number)
        except GitHubError:
            return None
        for comment in comments:
            if (
                comment.id == comment_id
                and comment.is_written_by(self.bot_login)
                and comment.body == body
            ):
                return comment
        return None

    def _find_published(self, head_sha: str) -> Comment | None:
        """Re-read after an ambiguous create: the same reviewed head and bot identity means ours."""
        try:
            comments = self.client.list_comments(self.pr_number)
        except GitHubError:
            return None
        for comment in comments:
            if not comment.is_written_by(self.bot_login) or IDENTITY_MARKER not in comment.body:
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
        stopped_early=run.stopped_early,
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


def publisher_for(
    job: Job,
    client: CommentsClient | None = None,
    may_write: Callable[[], bool] | None = None,
) -> Publisher:
    """The publisher one Dynamic job writes through: its narrowed installation token, its bot
    login and the workspace-less comment routes of its repository. The engine (#197) calls this
    once it has validated the run's findings. `client` replaces the HTTP client (the preparation
    of #201 reads through the same publisher and passes its own)."""
    if job.base is None:
        raise PublishError(
            ErrorCode.DYNAMIC_POLICY_VIOLATION, "a Dynamic job without checkout facts"
        )
    match = _PR_NUMBER.search(job.pr_url)
    if match is None:
        raise PublishError(ErrorCode.DYNAMIC_POLICY_VIOLATION, "the pull request url has no number")
    return Publisher(
        client=client or HttpCommentsClient(job.git.base_url, job.base.repository, job.git.token),
        bot_login=job.git.bot_login,
        repository=job.base.repository,
        pr_number=int(match.group(1)),
        web_base=web_base_of(job.git.base_url),
        redactor=Redactor(job.secrets),
        may_write=may_write,
    )


def publish_run(
    job: Job, run: DynamicFindings, may_write: Callable[[], bool] | None = None
) -> Published:
    """Writes one finished run into the persistent summary comment of the job's own pull request.

    The step the supervisor takes once the engine's findings are validated (#201): after it, the
    pull request has exactly one summary of this kind, created or edited in place. Any failure
    leaves the previous comment as it was (nothing is written before the state it builds on is
    read and validated)."""
    base = job.base
    if base is None:
        raise PublishError(
            ErrorCode.DYNAMIC_POLICY_VIOLATION, "a Dynamic job without checkout facts"
        )
    return publisher_for(job, may_write=may_write).publish(
        run,
        head_sha=base.head_sha,
        previous_reviewed_sha=base.previous_reviewed_sha,
        attempted_shas=base.attempted_shas,
        attempted_shas_truncated=base.attempted_shas_truncated,
    )


def publish_failure_note(
    job: Job,
    code: ErrorCode,
    reason: str | None,
    may_write: Callable[[], bool] | None = None,
) -> Published | None:
    """Writes the note of a failed Dynamic run into the summary comment of the job's own pull
    request (#299). Returns None when this failure writes nothing. Raises `PublishError` when the
    write fails; the caller keeps the failure it already has and never lets this change it."""
    base = job.base
    if base is None:
        raise PublishError(
            ErrorCode.DYNAMIC_POLICY_VIOLATION, "a Dynamic job without checkout facts"
        )
    note = failure_note_for(code, reason, base.head_sha)
    if note is None:
        return None
    return publisher_for(job, may_write=may_write).publish_failure(
        note,
        head_sha=base.head_sha,
        previous_reviewed_sha=base.previous_reviewed_sha,
        attempted_shas=base.attempted_shas,
        attempted_shas_truncated=base.attempted_shas_truncated,
    )
