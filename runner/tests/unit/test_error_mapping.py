"""Pins down how failures inside PR-Agent become stable error codes. PR-Agent swallows its own
exceptions and only logs them, so the runner reads the exception off the log record and walks its
cause chain; free text never reaches the caller, only the code."""

import json

import pydantic
import pytest
import requests
import yaml
from github import GithubException, RateLimitExceededException
from litellm.exceptions import (
    AuthenticationError,
    BadRequestError,
    ContextWindowExceededError,
    InternalServerError,
    NotFoundError,
    RateLimitError,
    Timeout,
)

from code_reviewer_runner.error_mapping import classify_failure
from code_reviewer_runner.result import ErrorCode

MODEL = "openrouter/deepseek/deepseek-chat"


def llm_error(kind: type[Exception]) -> Exception:
    return kind(message="provider says no", llm_provider="openrouter", model=MODEL)  # type: ignore[call-arg]


def exhausted_fallbacks(cause: Exception) -> Exception:
    # What retry_with_fallback_models raises when the last model failed.
    failure = Exception(
        f"Failed to generate prediction with any model of ['{MODEL}']. "
        f"Attempts: {MODEL}: {type(cause).__name__}: {cause}"
    )
    failure.__cause__ = cause
    return failure


# CR-10-T05
@pytest.mark.parametrize(
    ("error", "code"),
    [
        (AuthenticationError, ErrorCode.LLM_AUTH),
        (RateLimitError, ErrorCode.LLM_RATE_LIMIT),
        (Timeout, ErrorCode.LLM_TIMEOUT),
        (InternalServerError, ErrorCode.LLM_UNAVAILABLE),
        (BadRequestError, ErrorCode.LLM_BAD_REQUEST),
        (ContextWindowExceededError, ErrorCode.LLM_BAD_REQUEST),
        (NotFoundError, ErrorCode.MODEL_UNKNOWN),
    ],
)
def test_an_llm_provider_error_behind_the_fallback_wrapper_maps_to_its_code(
    error: type[Exception], code: ErrorCode
) -> None:
    assert classify_failure([exhausted_fallbacks(llm_error(error))], []) is code


def test_the_error_type_in_the_fallback_message_is_used_when_the_cause_chain_is_lost() -> None:
    message = (
        "Failed to generate prediction with any model of ['m']. "
        "Attempts: openrouter/x/y:free: RateLimitError: 429 slow down"
    )

    assert classify_failure([Exception(message)], []) is ErrorCode.LLM_RATE_LIMIT


def test_an_asyncio_timeout_maps_to_the_llm_timeout_code() -> None:
    assert classify_failure([TimeoutError()], []) is ErrorCode.LLM_TIMEOUT
    assert classify_failure([TimeoutError()], []) is ErrorCode.LLM_TIMEOUT


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (401, ErrorCode.GIT_AUTH),
        (403, ErrorCode.GIT_FORBIDDEN),
        (404, ErrorCode.PR_NOT_FOUND),
        (422, ErrorCode.GIT_UNPROCESSABLE),
    ],
)
def test_a_github_error_maps_by_its_http_status(status: int, code: ErrorCode) -> None:
    assert classify_failure([GithubException(status, {"message": "x"}, {})], []) is code


def test_a_github_rate_limit_is_not_reported_as_a_plain_forbidden() -> None:
    primary = RateLimitExceededException(403, {"message": "API rate limit exceeded"}, {})
    secondary = GithubException(403, {"message": "You have exceeded a secondary rate limit"}, {})

    assert classify_failure([primary], []) is ErrorCode.GIT_RATE_LIMIT
    assert classify_failure([secondary], []) is ErrorCode.GIT_RATE_LIMIT


def test_a_connection_problem_with_github_maps_to_unavailable() -> None:
    assert classify_failure([requests.ConnectionError("down")], []) is ErrorCode.GIT_UNAVAILABLE


def test_the_provider_init_failure_reports_the_real_cause_when_there_is_one() -> None:
    wrapped = ValueError("Failed to get git provider for https://github.com/o/r/pull/1")
    wrapped.__cause__ = GithubException(401, {"message": "Bad credentials"}, {})
    bare = ValueError("Failed to get git provider for https://github.com/o/r/pull/1")

    assert classify_failure([wrapped], []) is ErrorCode.GIT_AUTH
    assert classify_failure([bare], []) is ErrorCode.GIT_PROVIDER_INIT


def test_an_unknown_model_without_a_token_limit_maps_to_model_unknown() -> None:
    error = Exception(
        "Ensure openrouter/x/y is defined in MAX_TOKENS in ./pr_agent/algo/__init__.py"
    )

    assert classify_failure([error], []) is ErrorCode.MODEL_UNKNOWN


def test_the_cause_chain_is_walked_through_context_as_well() -> None:
    outer = RuntimeError("tool failed")
    outer.__context__ = GithubException(404, {"message": "Not Found"}, {})

    assert classify_failure([outer], []) is ErrorCode.PR_NOT_FOUND


def test_the_first_exception_that_can_be_classified_decides() -> None:
    noise = ValueError("harmless")
    real = exhausted_fallbacks(llm_error(AuthenticationError))

    assert classify_failure([noise, real], []) is ErrorCode.LLM_AUTH


def test_messages_are_a_last_resort_when_no_exception_was_logged() -> None:
    assert (
        classify_failure(
            [], ["Failed to generate prediction with any model. Attempts: m: Timeout: x"]
        )
        is ErrorCode.LLM_TIMEOUT
    )


def test_an_unclassifiable_failure_is_unknown_and_nothing_at_all_is_none() -> None:
    assert classify_failure([ValueError("whatever")], ["something odd"]) is ErrorCode.UNKNOWN
    assert classify_failure([], []) is None


def test_a_cyclic_cause_chain_does_not_loop_forever() -> None:
    first = RuntimeError("a")
    second = RuntimeError("b")
    first.__cause__ = second
    second.__cause__ = first

    assert classify_failure([first], []) is ErrorCode.UNKNOWN


@pytest.mark.parametrize(
    "error",
    [
        requests.Timeout("slow"),
        requests.ConnectTimeout("slow"),
        requests.ReadTimeout("slow"),
        requests.ConnectionError("down"),
    ],
)
def test_a_requests_timeout_or_connection_error_is_github_unavailable_not_an_llm_timeout(
    error: Exception,
) -> None:
    assert classify_failure([error], []) is ErrorCode.GIT_UNAVAILABLE


@pytest.mark.parametrize("status", [500, 502, 503, 504])
def test_a_github_server_error_maps_to_unavailable(status: int) -> None:
    assert classify_failure([GithubException(status, {"message": "x"}, {})], []) is (
        ErrorCode.GIT_UNAVAILABLE
    )


def test_a_github_429_maps_to_rate_limit() -> None:
    assert classify_failure([GithubException(429, {"message": "slow down"}, {})], []) is (
        ErrorCode.GIT_RATE_LIMIT
    )


@pytest.mark.parametrize(
    "error",
    [
        yaml.YAMLError("bad yaml"),
        json.JSONDecodeError("bad", "{", 0),
        pydantic.ValidationError.from_exception_data("Review", []),
    ],
)
def test_malformed_model_output_maps_to_llm_output_invalid(error: Exception) -> None:
    assert classify_failure([error], []) is ErrorCode.LLM_OUTPUT_INVALID


def test_a_failure_comment_text_about_unparsable_output_maps_to_llm_output_invalid() -> None:
    assert (
        classify_failure([], ["Failed to review PR: Failed to parse YAML output of the model"])
        is ErrorCode.LLM_OUTPUT_INVALID
    )
