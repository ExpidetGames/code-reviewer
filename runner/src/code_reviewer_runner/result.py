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
    usage: Usage | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "durationMs": self.duration_ms,
            "commentUrl": self.comment_url,
            "errorCode": self.error_code.value if self.error_code else None,
            "logTail": self.log_tail,
            "usage": self.usage.to_json() if self.usage else None,
        }

    def to_line(self) -> str:
        """One line of JSON, ASCII only, so nothing in a log can break the framing."""
        return json.dumps(self.to_json(), ensure_ascii=True, separators=(",", ":"))

    @property
    def exit_code(self) -> int:
        return 0 if self.ok else 1
