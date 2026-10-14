# SPDX-License-Identifier: Apache-2.0

"""The result of one job: the stable error codes and the JSON the runner prints on stdout."""

import json
from dataclasses import dataclass
from enum import StrEnum
from typing import Any


class ErrorCode(StrEnum):
    """Stable codes a caller may branch on. Never put free text where a code is expected."""

    # The job itself was refused before PR-Agent was loaded.
    INVALID_JOB = "invalid_job"
    INVALID_COMMAND = "invalid_command"
    # The installed PR-Agent no longer matches what the runner was written and tested against.
    PR_AGENT_VERSION_MISMATCH = "pr_agent_version_mismatch"
    IDENTITY_PATCH_FAILED = "identity_patch_failed"
    # A failure inside the runner itself (a bug, not a property of the job).
    RUNNER_ERROR = "runner_error"
    # PR-Agent ran but reported a failure it handled itself (failure comment, failed flag).
    COMMAND_FAILED = "command_failed"
    LLM_AUTH = "llm_auth"
    LLM_RATE_LIMIT = "llm_rate_limit"
    LLM_TIMEOUT = "llm_timeout"
    LLM_UNAVAILABLE = "llm_unavailable"
    LLM_BAD_REQUEST = "llm_bad_request"
    LLM_QUOTA = "llm_quota"
    LLM_CONTEXT_LENGTH_EXCEEDED = "llm_context_length_exceeded"
    MODEL_UNKNOWN = "model_unknown"
    GIT_AUTH = "git_auth"
    GIT_FORBIDDEN = "git_forbidden"
    GIT_RATE_LIMIT = "git_rate_limit"
    GIT_UNPROCESSABLE = "git_unprocessable"
    GIT_UNAVAILABLE = "git_unavailable"
    GIT_PROVIDER_INIT = "git_provider_init"
    PR_NOT_FOUND = "pr_not_found"
    # The command did not finish within RUNNER_JOB_TIMEOUT_SECONDS.
    TIMEOUT = "timeout"
    # The model answered, but its answer could not be turned into a review.
    LLM_OUTPUT_INVALID = "llm_output_invalid"
    # handle_request returned normally, yet no review comment was recorded (for example because
    # the identity patch no longer matches what GitHub reports).
    REVIEW_NOT_PUBLISHED = "review_not_published"
    # The review comment reached GitHub's size limit and the hidden record of earlier findings no
    # longer fits: the record is not advanced any more, so findings are lost. The review (cut, or a
    # standalone copy) may be on the pull request, and `commentUrl` says where when it can be found.
    REVIEW_STATE_TRUNCATED = "review_state_truncated"
    # The review comment reached GitHub's size limit and part of the visible review was cut off,
    # the record of findings still fits.
    REVIEW_TEXT_TRUNCATED = "review_text_truncated"
    # Dynamic Review (#195). Stable codes a caller branches on; there is never a fallback to Diff.
    DYNAMIC_ENGINE_UNAVAILABLE = "dynamic_engine_unavailable"
    DYNAMIC_ISOLATION_SELF_CHECK_FAILED = "dynamic_isolation_self_check_failed"
    DYNAMIC_CONFIG_INVALID = "dynamic_config_invalid"
    CHECKOUT_INCOMPLETE = "checkout_incomplete"
    DYNAMIC_POLICY_VIOLATION = "dynamic_policy_violation"
    DYNAMIC_BUDGET_EXCEEDED = "dynamic_budget_exceeded"
    DYNAMIC_ACCOUNTING_FAILED = "dynamic_accounting_failed"
    DYNAMIC_MODEL_FEATURES_UNSUPPORTED = "dynamic_model_features_unsupported"
    # The job is not ours any more (its lease was lost, or it was cancelled), or that could not be
    # confirmed right before the summary would have been written (#260). Nothing was written.
    LEASE_LOST = "lease_lost"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class Usage:
    """What the run consumed, as PR-Agent reports it. Cost is None when no call could be priced."""

    model: str | None
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    ai_calls: int
    fallback_used: bool
    cost_usd: float | None

    def to_json(self) -> dict[str, Any]:
        return {
            "model": self.model,
            "promptTokens": self.prompt_tokens,
            "completionTokens": self.completion_tokens,
            "totalTokens": self.total_tokens,
            "aiCalls": self.ai_calls,
            "fallbackUsed": self.fallback_used,
            "costUsd": self.cost_usd,
        }


@dataclass(frozen=True)
class JobResult:
    ok: bool
    duration_ms: int
    comment_url: str | None
    error_code: ErrorCode | None
    log_tail: str
    # True when the log held more than `log_tail` shows (older lines or characters were cut).
    log_truncated: bool = False
    usage: Usage | None = None
    # A finer, stable name for the failure next to `error_code` (for a Dynamic checkout failure
    # the `CheckoutReason`). Never free text; None where a failure has no finer name.
    error_reason: str | None = None

    def to_json(self) -> dict[str, Any]:
        document: dict[str, Any] = {
            "ok": self.ok,
            "durationMs": self.duration_ms,
            "commentUrl": self.comment_url,
            "errorCode": self.error_code.value if self.error_code else None,
            "logTail": self.log_tail,
            "logTruncated": self.log_truncated,
            "usage": self.usage.to_json() if self.usage else None,
        }
        if self.error_reason is not None:
            document["errorReason"] = self.error_reason
        return document

    def to_line(self) -> str:
        """One line of JSON, ASCII only, so nothing in a log can break the framing."""
        return json.dumps(self.to_json(), ensure_ascii=True, separators=(",", ":"))

    @property
    def exit_code(self) -> int:
        return 0 if self.ok else 1
