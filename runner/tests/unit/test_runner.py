"""Pins down the orchestration of one job: which PR-Agent call is made, how its outcome becomes ok,
the comment URL and the error code, and that the patch and the recorder are undone afterwards. The
real PR-Agent code is imported, but its `handle_request` is replaced by a test double, so nothing
reaches a network."""

import asyncio
import io
import json
import subprocess
import time
from collections.abc import Awaitable, Callable
from typing import Any

import pytest
from github import GithubException
from litellm.exceptions import AuthenticationError
from loguru import logger
from pr_agent.agent.pr_agent import PRAgent
from pr_agent.git_providers.github_provider import GithubProvider

from code_reviewer_runner import runner
from code_reviewer_runner.job import Job, parse_job
from code_reviewer_runner.log_capture import LogCapture
from code_reviewer_runner.redaction import Redactor
from code_reviewer_runner.result import ErrorCode, JobResult

TOKEN = "dummy-installation-token-0123456789"
API_KEY = "dummy-openrouter-key-0123456789"
PR_URL = "https://github.com/octo/repo/pull/7"
REVIEW_MARKER = "<!-- pr-agent:review:full -->"

Double = Callable[..., Awaitable[bool]]


def current_settings() -> Any:  # Any: PR-Agent ships no type information
    from pr_agent.config_loader import get_settings

    return get_settings()  # pyright: ignore[reportUnknownVariableType]


def job_json(**overrides: Any) -> dict[str, Any]:
    job: dict[str, Any] = {
        "prUrl": PR_URL,
        "command": "review",
        "git": {
            "provider": "github",
            "baseUrl": "https://api.github.com",
            "token": TOKEN,
            "botLogin": "code-reviewer[bot]",
        },
        "llm": {"provider": "openrouter", "model": "deepseek/deepseek-chat", "apiKey": API_KEY},
    }
    job.update(overrides)
    return job


def make_job(**overrides: Any) -> Job:
    return parse_job(json.dumps(job_json(**overrides)))


def provider_with_pull() -> Any:  # Any: PR-Agent's provider methods are untyped
    class Pull:
        def create_issue_comment(self, body: str) -> Any:
            return type("Comment", (), {"html_url": "https://github.com/octo/repo/pull/7#c1"})()

    instance = object.__new__(GithubProvider)
    instance.pr = Pull()  # type: ignore[assignment]
    instance.issue_main = None
    instance.max_comment_chars = 65000
    return instance


def run(job: Job | None = None) -> tuple[JobResult, LogCapture]:
    capture = LogCapture(Redactor([TOKEN, API_KEY]))
    logger.remove()
    sink = logger.add(capture, level="INFO", format="{message}")
    try:
        return runner.run_job(job or make_job(), capture, time.monotonic()), capture
    finally:
        logger.remove(sink)


def use_double(monkeypatch: pytest.MonkeyPatch, double: Double) -> list[tuple[Any, ...]]:
    calls: list[tuple[Any, ...]] = []

    async def handle_request(
        self: Any, pr_url: str, request: Any, notify: Any = None, propagate_tool_errors: Any = None
    ) -> bool:
        calls.append((pr_url, request, propagate_tool_errors))
        return await double()

    monkeypatch.setattr(PRAgent, "handle_request", handle_request)
    return calls


# CR-10-T01
def test_handle_request_is_called_once_with_the_pull_request_and_the_command(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def double() -> bool:
        provider_with_pull().publish_comment(f"## PR Reviewer Guide\n\n{REVIEW_MARKER}\n\nbody")
        return True

    calls = use_double(monkeypatch, double)

    result, _ = run()

    assert calls == [(PR_URL, ["review"], True)]
    assert result.ok is True
    assert result.error_code is None
    assert result.exit_code == 0
    assert result.comment_url == "https://github.com/octo/repo/pull/7#c1"


def test_the_typed_settings_are_in_place_while_the_command_runs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: dict[str, Any] = {}

    async def double() -> bool:
        settings = current_settings()
        seen["progress"] = settings.config.publish_output_progress
        seen["final_update"] = settings.pr_reviewer.final_update_message
        seen["labels"] = settings.pr_reviewer.enable_review_labels_effort
        seen["fallbacks"] = settings.config.fallback_models
        return True

    use_double(monkeypatch, double)

    run()

    assert seen == {"progress": False, "final_update": False, "labels": False, "fallbacks": []}


def test_the_settings_of_one_job_do_not_leak_into_the_global_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def double() -> bool:
        return True

    use_double(monkeypatch, double)
    before = current_settings().config.publish_output_progress

    run()

    assert current_settings().config.publish_output_progress == before


def test_ok_stays_true_without_a_comment_url_when_a_command_other_than_review_posted_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def double() -> bool:
        return True

    use_double(monkeypatch, double)

    for command in ("improve", "describe"):
        result, _ = run(make_job(command=command))

        assert result.ok is True, command
        assert result.comment_url is None


def test_a_review_that_returned_normally_but_posted_no_review_is_not_published(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def double() -> bool:
        provider_with_pull().publish_comment("some unrelated comment")
        return True

    use_double(monkeypatch, double)

    result, _ = run()

    assert result.ok is False
    assert result.exit_code == 1
    assert result.error_code is ErrorCode.REVIEW_NOT_PUBLISHED
    assert result.comment_url is None


def test_ask_passes_the_encoded_question_and_returns_the_answer_comment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def double() -> bool:
        provider_with_pull().publish_comment("### **Ask** ❓\n\nthe answer")
        return True

    calls = use_double(monkeypatch, double)

    result, _ = run(make_job(command="ask", args=["Why?"]))

    assert calls[0][1] == ["ask", "__pr_agent_encoded_text__:Why%3F"]
    assert result.comment_url == "https://github.com/octo/repo/pull/7#c1"


# CR-10-T05
def test_an_exception_from_handle_request_becomes_a_failed_result_with_a_stable_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def double() -> bool:
        raise RuntimeError(f"exploded with {TOKEN}")

    use_double(monkeypatch, double)

    result, _ = run()

    assert result.ok is False
    assert result.exit_code == 1
    assert result.error_code is ErrorCode.UNKNOWN
    assert TOKEN not in result.to_line()
    assert "Traceback" not in result.log_tail


def test_a_false_return_is_classified_from_the_exception_pr_agent_logged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def double() -> bool:
        try:
            raise AuthenticationError(
                message="bad key", llm_provider="openrouter", model="openrouter/x/y"
            )
        except AuthenticationError:
            logger.exception("Failed to process the command.")
        return False

    use_double(monkeypatch, double)

    result, _ = run()

    assert result.ok is False
    assert result.error_code is ErrorCode.LLM_AUTH


def test_a_github_404_logged_by_pr_agent_maps_to_pr_not_found(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def double() -> bool:
        try:
            raise GithubException(404, {"message": "Not Found"}, {})
        except GithubException:
            logger.exception("Failed to process the command.")
        return False

    use_double(monkeypatch, double)

    result, _ = run()

    assert result.error_code is ErrorCode.PR_NOT_FOUND


def test_a_failure_comment_makes_the_job_fail_even_though_handle_request_returned_true(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def double() -> bool:
        provider_with_pull().publish_comment("Failed to review PR: boom")
        return True

    use_double(monkeypatch, double)

    result, _ = run()

    assert result.ok is False
    assert result.error_code is ErrorCode.COMMAND_FAILED
    assert result.comment_url is None


def test_a_command_the_tool_marked_as_failed_makes_the_job_fail(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def double() -> bool:
        from pr_agent.algo.run_details import record_command_failure

        record_command_failure()
        return True

    use_double(monkeypatch, double)

    result, _ = run()

    assert result.ok is False
    assert result.error_code is ErrorCode.COMMAND_FAILED


def test_token_usage_and_cost_from_the_run_details_are_reported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def double() -> bool:
        from decimal import Decimal

        from pr_agent.algo.run_details import get_run_details

        details = get_run_details()
        assert details is not None
        details.model_used = "openrouter/deepseek/deepseek-chat"
        details.prompt_tokens = 1200
        details.completion_tokens = 300
        details.total_tokens = 1500
        details.num_ai_calls = 2
        details.known_cost_call_count = 2
        details.total_cost_usd = Decimal("0.0042")
        return True

    use_double(monkeypatch, double)

    result, _ = run()

    assert result.usage is not None
    assert result.usage.to_json() == {
        "model": "openrouter/deepseek/deepseek-chat",
        "promptTokens": 1200,
        "completionTokens": 300,
        "totalTokens": 1500,
        "aiCalls": 2,
        "fallbackUsed": False,
        "costUsd": 0.0042,
    }


def test_cost_is_null_when_no_call_could_be_priced(monkeypatch: pytest.MonkeyPatch) -> None:
    async def double() -> bool:
        return True

    use_double(monkeypatch, double)

    result, _ = run()

    assert result.usage is not None
    assert result.usage.cost_usd is None


# CR-10-T07
def test_a_secret_pr_agent_logs_never_reaches_the_result(monkeypatch: pytest.MonkeyPatch) -> None:
    async def double() -> bool:
        logger.info(f"calling GitHub with {TOKEN} and LLM with {API_KEY}")
        logger.warning(f"upstream echoed {API_KEY}")
        return True

    use_double(monkeypatch, double)

    result, _ = run()

    line = result.to_line()
    assert TOKEN not in line
    assert API_KEY not in line
    assert "[REDACTED]" in result.log_tail


# CR-10-T03
def test_a_missing_identity_method_stops_the_job_before_handle_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def double() -> bool:
        return True

    calls = use_double(monkeypatch, double)
    monkeypatch.delattr(GithubProvider, "_resolve_user_login")

    result, _ = run()

    assert result.ok is False
    assert result.error_code is ErrorCode.IDENTITY_PATCH_FAILED
    assert result.exit_code == 1
    assert calls == []


def test_another_pr_agent_version_stops_the_job_before_handle_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from code_reviewer_runner import identity_patch

    async def double() -> bool:
        return True

    calls = use_double(monkeypatch, double)
    monkeypatch.setattr(identity_patch, "PATCHED_FOR_VERSION", "9.9.9")

    result, _ = run()

    assert result.error_code is ErrorCode.PR_AGENT_VERSION_MISMATCH
    assert calls == []


def test_the_patch_and_the_recorder_are_removed_after_the_job(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def double() -> bool:
        return True

    use_double(monkeypatch, double)
    provider_class: Any = GithubProvider
    before = (
        provider_class._resolve_user_login,
        provider_class.publish_comment,
        provider_class.edit_comment,
    )

    run()

    assert before == (
        provider_class._resolve_user_login,
        provider_class.publish_comment,
        provider_class.edit_comment,
    )


def test_the_identity_patch_is_active_while_the_command_runs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[str] = []

    async def double() -> bool:
        seen.append(provider_with_pull()._resolve_user_login())
        return True

    use_double(monkeypatch, double)

    run()

    assert seen == ["code-reviewer[bot]"]


# CR-10-T04
@pytest.mark.parametrize("raw", ["", "not json", "{}", '{"command": "review"}'])
def test_an_invalid_job_gets_one_result_line_and_never_reaches_pr_agent(
    raw: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    def must_not_run(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("PR-Agent must not be started for an invalid job")

    monkeypatch.setattr(runner, "run_job", must_not_run)
    out = io.StringIO()

    code = runner.main([], stdin=io.StringIO(raw), stdout=out)

    lines = out.getvalue().splitlines()
    assert code == 1
    assert len(lines) == 1
    result = json.loads(lines[0])
    assert result["ok"] is False
    assert result["errorCode"] == "invalid_job"
    assert result["commentUrl"] is None


# CR-10-T06
def test_a_command_outside_the_allowed_set_is_refused_before_anything_starts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def must_not_run(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("PR-Agent must not be started for an invalid command")

    monkeypatch.setattr(runner, "run_job", must_not_run)
    out = io.StringIO()
    job = job_json(command="review; rm -rf /")

    code = runner.main([], stdin=io.StringIO(json.dumps(job)), stdout=out)

    assert code == 1
    assert json.loads(out.getvalue())["errorCode"] == "invalid_command"


# CR-10-T09
def test_a_manipulated_pull_request_url_starts_no_process_and_opens_no_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def must_not_spawn(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("no process may be started")

    monkeypatch.setattr(subprocess, "Popen", must_not_spawn)
    monkeypatch.setattr(runner, "run_job", must_not_spawn)
    out = io.StringIO()
    job = job_json(prUrl="https://github.com/o/r/pull/1; id")

    # The socket guard of the unit tests raises on any outbound connection attempt.
    code = runner.main([], stdin=io.StringIO(json.dumps(job)), stdout=out)

    assert code == 1
    assert json.loads(out.getvalue())["errorCode"] == "invalid_job"


# CR-10-T07
def test_a_refusal_does_not_echo_the_secrets_of_the_rejected_job() -> None:
    out = io.StringIO()
    job = job_json(prUrl=f"https://github.com/{TOKEN}/r/pull/x")

    runner.main([], stdin=io.StringIO(json.dumps(job)), stdout=out)

    assert TOKEN not in out.getvalue()
    assert API_KEY not in out.getvalue()


def test_the_result_is_a_single_line_of_json_with_the_agreed_fields() -> None:
    out = io.StringIO()

    runner.main([], stdin=io.StringIO("{}"), stdout=out)

    assert out.getvalue().endswith("\n")
    result = json.loads(out.getvalue())
    assert set(result) == {"ok", "durationMs", "commentUrl", "errorCode", "logTail", "usage"}
    assert isinstance(result["durationMs"], int)


def test_the_result_never_carries_a_secret_even_when_it_slipped_into_the_log_tail() -> None:
    result = JobResult(
        ok=False,
        duration_ms=1,
        comment_url=None,
        error_code=ErrorCode.UNKNOWN,
        log_tail=f"leaked {TOKEN}",
    )
    out = io.StringIO()

    runner._ResultChannel(out).write(result, [TOKEN])  # pyright: ignore[reportPrivateUsage]

    assert TOKEN not in out.getvalue()
    assert json.loads(out.getvalue())["ok"] is False


# The command stops by itself when RUNNER_JOB_TIMEOUT_SECONDS passes (best effort).
def test_a_command_that_awaits_past_the_timeout_is_stopped_with_the_timeout_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def double() -> bool:
        await asyncio.sleep(30)
        return True

    use_double(monkeypatch, double)
    capture = LogCapture(Redactor([TOKEN, API_KEY]))

    result = runner.run_job(make_job(), capture, time.monotonic(), timeout_seconds=0.2)

    assert result.ok is False
    assert result.error_code is ErrorCode.TIMEOUT
    assert result.exit_code == 1
    assert result.duration_ms < 5000


def test_a_timeout_error_inside_pr_agent_is_not_mistaken_for_the_job_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def double() -> bool:
        raise TimeoutError

    use_double(monkeypatch, double)
    capture = LogCapture(Redactor([]))

    result = runner.run_job(make_job(), capture, time.monotonic(), timeout_seconds=60)

    assert result.error_code is ErrorCode.LLM_TIMEOUT


def test_the_timeout_is_read_from_the_environment_of_the_parent() -> None:
    assert runner._timeout_from({"RUNNER_JOB_TIMEOUT_SECONDS": "90"}) == 90.0  # pyright: ignore[reportPrivateUsage]
    for bad in (
        {},
        {"RUNNER_JOB_TIMEOUT_SECONDS": ""},
        {"RUNNER_JOB_TIMEOUT_SECONDS": "abc"},
        {"RUNNER_JOB_TIMEOUT_SECONDS": "0"},
        {"RUNNER_JOB_TIMEOUT_SECONDS": "-5"},
        {"RUNNER_JOB_TIMEOUT_SECONDS": "inf"},
    ):
        assert runner._timeout_from(bad) is None  # pyright: ignore[reportPrivateUsage]


def test_a_system_exit_from_a_library_still_gives_a_failed_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def double() -> bool:
        raise SystemExit(3)

    use_double(monkeypatch, double)

    result, _ = run()

    assert result.ok is False
    assert result.error_code is ErrorCode.UNKNOWN


def test_main_answers_with_one_redacted_line_even_if_the_run_blows_up_with_a_base_exception(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def explode(*args: Any, **kwargs: Any) -> None:
        raise SystemExit(f"fatal {TOKEN}")

    monkeypatch.setattr(runner, "run_job", explode)
    out = io.StringIO()

    code = runner.main([], stdin=io.StringIO(json.dumps(job_json())), stdout=out)

    assert code == 1
    assert len(out.getvalue().splitlines()) == 1
    assert json.loads(out.getvalue())["errorCode"] == "runner_error"
    assert TOKEN not in out.getvalue()


def test_a_failure_comment_that_names_unparsable_model_output_gives_llm_output_invalid(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def double() -> bool:
        provider_with_pull().publish_comment(
            "Failed to review PR: Failed to parse the model answer"
        )
        return True

    use_double(monkeypatch, double)

    result, _ = run()

    assert result.error_code is ErrorCode.LLM_OUTPUT_INVALID


class UndecodableStdin(io.StringIO):
    def read(self, size: int | None = -1) -> str:
        raise UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid start byte")


def test_input_that_is_not_utf8_text_is_an_invalid_job() -> None:
    out = io.StringIO()

    code = runner.main([], stdin=UndecodableStdin(), stdout=out)

    assert code == 1
    assert json.loads(out.getvalue())["errorCode"] == "invalid_job"


def test_absurdly_deep_json_is_an_invalid_job_not_a_crash() -> None:
    out = io.StringIO()

    code = runner.main([], stdin=io.StringIO("[" * 200_000), stdout=out)

    assert code == 1
    assert json.loads(out.getvalue())["errorCode"] == "invalid_job"
