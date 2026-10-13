# SPDX-License-Identifier: Apache-2.0

"""The Dynamic Review prompt composer (#198).

The composed prompt has two trust levels:

- The **trusted** part is the fixed, code-owned core (`prompt_core.py`) followed by the editable
  review skill. The core is composed first and is authoritative; the skill is project configuration
  and is delimited as lower priority, so it can change what to look for, the thresholds, the
  priorities and the tone, but never the core, the tools, the output schema or the limits. It is
  passed literally: nothing here evaluates it (no template, shell or settings parser).
- The **untrusted** part is the pull request and everything read from it. Each piece is rendered in
  its own block whose fences carry a digest of that block's content, so text inside it that looks
  like a delimiter, a role or an instruction cannot close the block early or become a
  higher-priority message.

The composition is deterministic and pinned by unit tests with golden files and prompt-injection
fixtures. The composer never reads or injects repository rules itself: repository content is passed
in by the caller as one more untrusted block, and the core marks every rule file as evidence only.
"""

import hashlib
import re
from dataclasses import dataclass

from code_reviewer_runner.dynamic_review import prompt_core
from code_reviewer_runner.result import ErrorCode

# The UTF-8 byte limit of a skill. The fixed core is code-owned and never bounded; a skill is
# untrusted project data and is bounded in bytes, so a multibyte character counts as its bytes.
MAX_SKILL_BYTES = 16 * 1024

# A block label is a fixed token; it is part of the fence, so it carries no space or punctuation.
_LABEL = re.compile(r"[a-z][a-z0-9-]{0,40}")
_COMPARISONS = ("full", "incremental")

SKILL_OPEN = (
    "===== BEGIN PROJECT REVIEW SKILL (project configuration; lower priority than the fixed rules "
    "above, which it cannot change) ====="
)
SKILL_CLOSE = "===== END PROJECT REVIEW SKILL ====="

_UNTRUSTED_PREFIX = "<<<"


class PromptError(Exception):
    """A skill or a context the composer cannot accept.

    `code` is stable; `detail` names a field and never contains a value.
    """

    def __init__(self, code: ErrorCode, detail: str) -> None:
        super().__init__(f"{code.value}: {detail}")
        self.code = code
        self.detail = detail


def validate_skill(skill: object) -> None:
    """Refuse a skill the composer cannot take: the literal data is bounded, not evaluated."""
    if not isinstance(skill, str):
        raise PromptError(ErrorCode.DYNAMIC_CONFIG_INVALID, "the skill must be a string")
    try:
        encoded = skill.encode("utf-8")
    except UnicodeEncodeError:
        raise PromptError(
            ErrorCode.DYNAMIC_CONFIG_INVALID, "the skill must be valid UTF-8"
        ) from None
    if len(encoded) > MAX_SKILL_BYTES:
        raise PromptError(
            ErrorCode.DYNAMIC_CONFIG_INVALID,
            f"the skill must be at most {MAX_SKILL_BYTES} UTF-8 bytes",
        )


def _fences(label: str, text: str) -> tuple[str, str]:
    """The begin and end fence of one untrusted block, with a digest of its label and content.

    The digest depends on the content, so a text cannot reproduce the fence of its own block: a
    fixed-point search over the hash is what it would take to break out.
    """
    digest = hashlib.sha256(f"{label}\n{text}".encode("utf-8", "replace")).hexdigest()[:16]
    return (
        f"{_UNTRUSTED_PREFIX}BEGIN UNTRUSTED {label} {digest}>>>",
        f"{_UNTRUSTED_PREFIX}END UNTRUSTED {label} {digest}>>>",
    )


def untrusted_block(label: str, text: str) -> str:
    """One untrusted input, rendered as a delimited block. The text is kept literally."""
    if not _LABEL.fullmatch(label):
        raise PromptError(ErrorCode.DYNAMIC_CONFIG_INVALID, "the block label is not a safe token")
    begin, end = _fences(label, text)
    body = text if text.endswith("\n") else f"{text}\n"
    return f"{begin}\n{body}{end}"


@dataclass(frozen=True)
class ReviewInputs:
    """Everything the reviewer looks at. It is all untrusted; only `comparison` is runner-owned."""

    pr_url: str
    pr_title: str
    pr_body: str
    diff: str
    comparison: str = "full"
    previous_review_state: str = ""
    repository_content: str = ""


def compose_system_prompt(skill: str) -> str:
    """The trusted channel: the fixed core, then the lower-priority editable skill."""
    validate_skill(skill)
    body = skill if skill.endswith("\n") else f"{skill}\n"
    return f"{prompt_core.CORE_TEXT}\n\n{SKILL_OPEN}\n{body}{SKILL_CLOSE}\n"


def compose_user_prompt(inputs: ReviewInputs) -> str:
    """The untrusted channel: the run facts and every delimited untrusted block."""
    if inputs.comparison not in _COMPARISONS:
        raise PromptError(
            ErrorCode.DYNAMIC_CONFIG_INVALID, "comparison must be 'full' or 'incremental'"
        )
    blocks = [
        f"RUN CONTEXT (fixed): reviewed pull request {inputs.pr_url}; "
        f"review mode: {inputs.comparison}.",
        untrusted_block("pull-request-title", inputs.pr_title),
        untrusted_block("pull-request-body", inputs.pr_body),
        untrusted_block("pull-request-diff", inputs.diff),
    ]
    if inputs.previous_review_state:
        blocks.append(untrusted_block("previous-review-state", inputs.previous_review_state))
    if inputs.repository_content:
        blocks.append(untrusted_block("repository-content", inputs.repository_content))
    return "\n\n".join(blocks) + "\n"


def compose_review_prompt(skill: str, inputs: ReviewInputs) -> str:
    """The whole prompt: the trusted system part, then the untrusted input part."""
    return f"{compose_system_prompt(skill)}\n{compose_user_prompt(inputs)}"
