# SPDX-License-Identifier: LicenseRef-Proprietary

"""The short note a failed Dynamic run leaves in the summary comment of its pull request (#299).

A failed run used to leave the pull request silent: the reason was only in the Runs view. The note
says that the Dynamic Review did not complete and why, in words a developer can act on. Like the
Runs view, it translates a stable code into one fixed sentence; the sentence never comes from the
failure itself.

What the note may hold is closed: a fixed frame, the fixed sentence of the code, the stable code,
the stable reason when the run has one, and the head the run was reviewing. Nothing that came from
the repository, the model, a provider or a log (a path, a file name, a diff line, a message, a
secret) can reach it, because none of it is an input here: `failure_note_for` takes a code, a
reason and a commit id, and drops a reason that is not a known stable name.

Every `ErrorCode` is classified exactly once, either with a sentence or as silent, and a unit test
fails for a code that is neither, so a new code cannot slip in without a decision. The silent codes
are the failures where the runner cannot write safely or where a note would say nothing a developer
can act on: the job is no longer ours (`lease_lost`), the token is refused (`git_auth`,
`git_forbidden`), the job was refused before it started, or the runner itself broke.
"""

import re
from dataclasses import dataclass
from types import MappingProxyType

from code_reviewer_runner.dynamic_review.limits import CheckoutReason
from code_reviewer_runner.result import ErrorCode

# One fixed sentence per code, written for the developer who opened the pull request.
FAILURE_SENTENCES: MappingProxyType[ErrorCode, str] = MappingProxyType(
    {
        ErrorCode.CHECKOUT_INCOMPLETE: (
            "The pull request could not be prepared, so this commit was not reviewed."
        ),
        ErrorCode.DYNAMIC_BUDGET_EXCEEDED: (
            "The review used up its cost or time limit before it could give a result."
        ),
        ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED: (
            "The configured model does not support the features Dynamic Review needs."
        ),
        ErrorCode.LLM_AUTH: "The model provider rejected the credentials set for this project.",
        ErrorCode.LLM_RATE_LIMIT: "The model provider limited the rate of requests.",
        ErrorCode.LLM_TIMEOUT: "The model provider did not answer in time.",
        ErrorCode.LLM_UNAVAILABLE: "The model provider was not available.",
        ErrorCode.LLM_BAD_REQUEST: "The model provider rejected the request.",
        ErrorCode.LLM_QUOTA: "The quota of the model provider account is used up.",
        ErrorCode.LLM_CONTEXT_LENGTH_EXCEEDED: (
            "The pull request is too large for the context window of the configured model."
        ),
        ErrorCode.LLM_OUTPUT_INVALID: (
            "The model returned an answer that could not be turned into a review."
        ),
        ErrorCode.MODEL_UNKNOWN: "The configured model is not known to the model provider.",
        ErrorCode.TIMEOUT: "The review did not finish within its time limit.",
    }
)

# Everything else writes nothing: it stays visible in the Runs view only.
NO_NOTE_CODES: frozenset[ErrorCode] = frozenset(set(ErrorCode) - set(FAILURE_SENTENCES))

# The stable names a reason may have. Today only a Dynamic checkout failure has one; a new family
# of reasons is added here on purpose, so a free text can never take its place.
_REASONS = frozenset(reason.value for reason in CheckoutReason)
_SHA = re.compile(r"[0-9a-f]{40}")


@dataclass(frozen=True)
class FailureNote:
    """The whole content of a note: stable values only. Build it with `failure_note_for`."""

    code: ErrorCode
    reason: str | None
    head_sha: str

    @property
    def sentence(self) -> str:
        return FAILURE_SENTENCES[self.code]


def failure_note_for(code: ErrorCode, reason: str | None, head_sha: str) -> FailureNote | None:
    """The note for a failed run, or None when the failure writes nothing.

    A reason that is not a known stable name is dropped (the code still stands); a head that is not
    a full commit id means there is nothing to say a developer could tie to the pull request.
    """
    if code not in FAILURE_SENTENCES or not _SHA.fullmatch(head_sha):
        return None
    return FailureNote(code, reason if reason in _REASONS else None, head_sha)


def render_note(note: FailureNote) -> str:
    """The note as a block quote: fixed text, the code, the reason and the head."""
    facts = f"Code: `{note.code.value}`"
    if note.reason is not None:
        facts += f" · Reason: `{note.reason}`"
    return "\n".join(
        [
            f"> **⚠️ Dynamic Review did not complete** for commit `{note.head_sha}`.",
            ">",
            f"> {note.sentence}",
            ">",
            f"> {facts}",
            ">",
            "> Push a new commit or ask for a new review to try again.",
        ]
    )
