# SPDX-License-Identifier: Apache-2.0

"""Maps what went wrong inside PR-Agent to a stable error code.

PR-Agent catches nearly every exception itself and only logs it, so the runner reads the exception
off the log record (see log_capture) and classifies it here. Only the code leaves the runner, never
the exception text, which may carry data from the pull request or the provider.

Exceptions are matched by class name and attributes instead of imported classes, so this module has
no dependency on litellm, openai or PyGithub being importable.
"""

import re
from collections.abc import Sequence

from code_reviewer_runner.result import ErrorCode

_MAX_CHAIN = 12

# HTTP status of an LLM provider error (openai and litellm exceptions carry `status_code`).
_LLM_STATUS = {
    400: ErrorCode.LLM_BAD_REQUEST,
    401: ErrorCode.LLM_AUTH,
    402: ErrorCode.LLM_QUOTA,
    403: ErrorCode.LLM_AUTH,
    404: ErrorCode.MODEL_UNKNOWN,
    408: ErrorCode.LLM_TIMEOUT,
    422: ErrorCode.LLM_BAD_REQUEST,
    429: ErrorCode.LLM_RATE_LIMIT,
}
# Class names of the openai/litellm hierarchy, most specific first through the MRO walk.
_LLM_CLASS_NAMES = {
    "AuthenticationError": ErrorCode.LLM_AUTH,
    "PermissionDeniedError": ErrorCode.LLM_AUTH,
    "RateLimitError": ErrorCode.LLM_RATE_LIMIT,
    "APITimeoutError": ErrorCode.LLM_TIMEOUT,
    "Timeout": ErrorCode.LLM_TIMEOUT,
    "APIConnectionError": ErrorCode.LLM_UNAVAILABLE,
    "InternalServerError": ErrorCode.LLM_UNAVAILABLE,
    "ServiceUnavailableError": ErrorCode.LLM_UNAVAILABLE,
    "BadGatewayError": ErrorCode.LLM_UNAVAILABLE,
    "BadRequestError": ErrorCode.LLM_BAD_REQUEST,
    "UnprocessableEntityError": ErrorCode.LLM_BAD_REQUEST,
    "NotFoundError": ErrorCode.MODEL_UNKNOWN,
}


def llm_status_code(status: int) -> ErrorCode | None:
    """The code for the HTTP status of an LLM provider answer, None for a status no rule knows.

    The one table behind both engines: the static path reads the status off an exception, the
    Dynamic proxy off the response, so the same provider answer cannot get two different codes.
    """
    code = _LLM_STATUS.get(status)
    if code is not None:
        return code
    return ErrorCode.LLM_UNAVAILABLE if status >= 500 else None


# The ways providers say that a request does not fit the model's context: OpenAI's error code, and
# the texts of OpenRouter and of the providers behind it ("maximum context length is N tokens",
# "prompt is too long", "exceeds the context window"). Only the shape of the answer is read.
_CONTEXT_LENGTH = re.compile(
    r"context[_ ]length|context window|prompt is too long|input is too long", re.IGNORECASE
)
_CONTEXT_LENGTH_STATUSES = frozenset({400, 413})


def is_context_length_exceeded(status: int, text: str) -> bool:
    """True for a provider answer that says the request is larger than the model's context.

    Only for a status a provider uses for it (400, 413): the same words on a 5xx are the provider's
    own trouble. A `bad request` that is about something else keeps `llm_bad_request`.
    """
    return status in _CONTEXT_LENGTH_STATUSES and _CONTEXT_LENGTH.search(text) is not None


_GITHUB_STATUS = {
    401: ErrorCode.GIT_AUTH,
    429: ErrorCode.GIT_RATE_LIMIT,
    403: ErrorCode.GIT_FORBIDDEN,
    404: ErrorCode.PR_NOT_FOUND,
    422: ErrorCode.GIT_UNPROCESSABLE,
}
_ATTEMPT_ERROR = re.compile(r"Attempts:.*?\b([A-Za-z]*(?:Error|Timeout|Exception))\b")
# The wording of PR-Agent 0.47.0 for an answer that is no usable output: the tools raise a
# FallbackEligibleError (a ValueError that is also used for "the diff does not fit", so the class
# alone says nothing) and only the text tells the cases apart.
_OUTPUT_INVALID = re.compile(
    r"Failed to parse|schema validation|invalid YAML|Failed to load YAML"
    r"|did not contain a non-empty review mapping|No valid review output was produced",
    re.I,
)
_MODEL_UNKNOWN = re.compile(r"Ensure \S+ is defined in MAX_TOKENS")


def _chain(error: BaseException) -> list[BaseException]:
    """The exception and everything that caused it, outermost first, without cycles."""
    seen: set[int] = set()
    pending: list[BaseException] = [error]
    ordered: list[BaseException] = []
    while pending and len(ordered) < _MAX_CHAIN:
        current = pending.pop(0)
        if id(current) in seen:
            continue
        seen.add(id(current))
        ordered.append(current)
        for link in (current.__cause__, current.__context__):
            if link is not None:
                pending.append(link)
    return ordered


def _classes(error: BaseException) -> list[tuple[str, str]]:
    """(module root, class name) of the exception's class and all its bases."""
    return [(cls.__module__.split(".")[0], cls.__name__) for cls in type(error).__mro__]


def _github_error(error: BaseException, status: int) -> ErrorCode | None:
    if status == 403 and "rate limit" in str(getattr(error, "data", "")).lower():
        return ErrorCode.GIT_RATE_LIMIT
    if status >= 500:
        return ErrorCode.GIT_UNAVAILABLE
    return _GITHUB_STATUS.get(status)


def _from_type(error: BaseException) -> ErrorCode | None:
    classes = _classes(error)
    names = {name for _, name in classes}
    modules = {module for module, _ in classes}
    status = getattr(error, "status", None)
    status_code = getattr(error, "status_code", None)
    if "RateLimitExceededException" in names:
        return ErrorCode.GIT_RATE_LIMIT
    if "GithubException" in names and isinstance(status, int):
        return _github_error(error, status)
    # requests (used by PyGithub) before the LLM names: requests has a class called Timeout too.
    if "requests" in modules and "RequestException" in names:
        return ErrorCode.GIT_UNAVAILABLE
    if modules & {"openai", "litellm"}:
        llm_code = llm_status_code(status_code) if isinstance(status_code, int) else None
        if llm_code is not None:
            return llm_code
        for module, name in classes:
            if module in ("openai", "litellm") and name in _LLM_CLASS_NAMES:
                return _LLM_CLASS_NAMES[name]
    if names & {"YAMLError", "JSONDecodeError", "ValidationError"}:
        return ErrorCode.LLM_OUTPUT_INVALID
    if isinstance(error, TimeoutError):  # also asyncio.TimeoutError
        return ErrorCode.LLM_TIMEOUT
    return None


def _from_text(text: str) -> ErrorCode | None:
    if _MODEL_UNKNOWN.search(text):
        return ErrorCode.MODEL_UNKNOWN
    attempt = _ATTEMPT_ERROR.search(text)
    if attempt is not None:
        return _LLM_CLASS_NAMES.get(attempt.group(1))
    if _OUTPUT_INVALID.search(text):
        return ErrorCode.LLM_OUTPUT_INVALID
    if "Failed to get git provider" in text:
        return ErrorCode.GIT_PROVIDER_INIT
    return None


def classify_failure(
    exceptions: Sequence[BaseException], messages: Sequence[str]
) -> ErrorCode | None:
    """The code for the first failure that can be classified.

    Returns None when nothing was observed at all, UNKNOWN when something was but no rule matched.
    """
    if not exceptions and not messages:
        return None
    chains = [_chain(error) for error in exceptions]
    for chain in chains:
        for error in chain:
            code = _from_type(error)
            if code is not None:
                return code
    for chain in chains:
        for error in chain:
            code = _from_text(str(error))
            if code is not None:
                return code
    for message in messages:
        code = _from_text(message)
        if code is not None:
            return code
    return ErrorCode.UNKNOWN
