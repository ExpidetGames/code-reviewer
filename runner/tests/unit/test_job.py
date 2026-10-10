"""Pins down how the runner validates the job it reads from stdin: the shape, the allowed commands,
the pull request URL and the host it may point to. A bad job must be refused with a stable error
code before PR-Agent is imported, and the refusal must never echo a value from the job."""

import json
from typing import Any

import pytest

from code_reviewer_runner.job import Command, JobError, parse_job
from code_reviewer_runner.result import ErrorCode

TOKEN = "ghs_dummyInstallationToken0123456789"
API_KEY = "sk-or-v1-dummyOpenRouterKey0123456789"


def valid_job(**overrides: Any) -> dict[str, Any]:
    job: dict[str, Any] = {
        "prUrl": "https://github.com/octo/repo/pull/7",
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


def parse(job: dict[str, Any]) -> Any:
    return parse_job(json.dumps(job))


def refusal(raw: str) -> JobError:
    with pytest.raises(JobError) as caught:
        parse_job(raw)
    return caught.value


# CR-10-T01
def test_a_valid_job_is_parsed_into_typed_fields() -> None:
    job = parse(valid_job())

    assert job.command is Command.REVIEW
    assert job.pr_url == "https://github.com/octo/repo/pull/7"
    assert job.git.token == TOKEN
    assert job.git.bot_login == "code-reviewer[bot]"
    assert job.llm.api_key == API_KEY
    assert job.args == ()
    assert job.env == {}


def test_the_bot_login_gets_the_bot_suffix_when_it_is_missing() -> None:
    job = parse(valid_job(git={**valid_job()["git"], "botLogin": "code-reviewer"}))

    assert job.git.bot_login == "code-reviewer[bot]"


@pytest.mark.parametrize("command", ["review", "improve", "describe"])
def test_every_allowed_command_is_accepted(command: str) -> None:
    assert parse(valid_job(command=command)).command.value == command


def test_ask_takes_the_question_as_its_only_argument() -> None:
    job = parse(valid_job(command="ask", args=["What does this change do?"]))

    assert job.command is Command.ASK
    assert job.args == ("What does this change do?",)


# CR-10-T04
@pytest.mark.parametrize(
    "raw",
    ["", "not json", "[1, 2]", '"text"', "null", '{"prUrl": '],
)
def test_input_that_is_not_a_json_object_is_an_invalid_job(raw: str) -> None:
    assert refusal(raw).code is ErrorCode.INVALID_JOB


# CR-10-T04
@pytest.mark.parametrize(
    "path",
    ["prUrl", "git", "git.token", "git.botLogin", "git.baseUrl", "llm", "llm.apiKey", "llm.model"],
)
def test_a_missing_required_field_is_an_invalid_job_that_names_the_field(path: str) -> None:
    job = valid_job()
    target: dict[str, Any] = job
    *parents, leaf = path.split(".")
    for key in parents:
        target = target[key]
    del target[leaf]

    error = refusal(json.dumps(job))

    assert error.code is ErrorCode.INVALID_JOB
    assert path in error.detail


@pytest.mark.parametrize("token", ["", "   ", "has space", "line\nbreak", 42, None])
def test_a_token_that_is_empty_or_not_a_clean_string_is_an_invalid_job(token: Any) -> None:
    job = valid_job(git={**valid_job()["git"], "token": token})

    assert refusal(json.dumps(job)).code is ErrorCode.INVALID_JOB


def test_an_unknown_top_level_field_is_an_invalid_job() -> None:
    error = refusal(json.dumps(valid_job(surprise=True)))

    assert error.code is ErrorCode.INVALID_JOB
    assert "surprise" in error.detail


def test_only_the_github_provider_and_the_openrouter_llm_are_supported() -> None:
    gitlab = valid_job(git={**valid_job()["git"], "provider": "gitlab"})
    openai = valid_job(llm={**valid_job()["llm"], "provider": "openai"})

    assert refusal(json.dumps(gitlab)).code is ErrorCode.INVALID_JOB
    assert refusal(json.dumps(openai)).code is ErrorCode.INVALID_JOB


# CR-10-T06
@pytest.mark.parametrize(
    "command",
    ["review; rm -rf /", "merge", "REVIEW", "review ", "add_docs", "", 7, None, ["review"]],
)
def test_a_command_outside_the_allowed_set_is_an_invalid_command(command: Any) -> None:
    assert refusal(json.dumps(valid_job(command=command))).code is ErrorCode.INVALID_COMMAND


def test_a_job_without_a_command_is_an_invalid_job() -> None:
    job = valid_job()
    del job["command"]

    assert refusal(json.dumps(job)).code is ErrorCode.INVALID_JOB


def test_arguments_are_only_allowed_for_ask_and_must_be_a_single_question() -> None:
    assert refusal(json.dumps(valid_job(args=["--config.model=x"]))).code is ErrorCode.INVALID_JOB
    assert refusal(json.dumps(valid_job(command="ask"))).code is ErrorCode.INVALID_JOB
    assert refusal(json.dumps(valid_job(command="ask", args=[""]))).code is ErrorCode.INVALID_JOB
    assert refusal(json.dumps(valid_job(command="ask", args=["a", "b"]))).code is (
        ErrorCode.INVALID_JOB
    )
    assert refusal(json.dumps(valid_job(command="ask", args=["x" * 4001]))).code is (
        ErrorCode.INVALID_JOB
    )


# CR-10-T09
@pytest.mark.parametrize(
    "pr_url",
    [
        "https://github.com/o/r/pull/1; id",
        "https://github.com/o/r/pull/1 && id",
        "https://github.com/o/r/pull/",
        "https://github.com/o/r/pull/abc",
        "https://github.com/o/r/pull/0",
        "https://github.com/o/r/pull/1/files",
        "https://github.com/o/r/pull/1?x=1",
        "https://github.com/o/r/pull/1#fragment",
        "https://github.com/o/r/issues/1",
        "https://github.com/o/pull/1",
        "https://user:pass@github.com/o/r/pull/1",
        "https://evil.example.com/o/r/pull/1",
        "https://github.com.evil.example.com/o/r/pull/1",
        "http://github.com/o/r/pull/1",
        "file:///etc/passwd",
        "ftp://github.com/o/r/pull/1",
        "github.com/o/r/pull/1",
        "$(id)",
        "",
        42,
        None,
    ],
)
def test_a_manipulated_pull_request_url_is_an_invalid_job(pr_url: Any) -> None:
    assert refusal(json.dumps(valid_job(prUrl=pr_url))).code is ErrorCode.INVALID_JOB


def test_the_pull_request_must_live_on_the_host_of_the_configured_git_api() -> None:
    enterprise = valid_job(
        prUrl="https://ghe.example.com/o/r/pull/3",
        git={**valid_job()["git"], "baseUrl": "https://ghe.example.com/api/v3"},
    )
    mismatch = valid_job(
        prUrl="https://github.com/o/r/pull/3",
        git={**valid_job()["git"], "baseUrl": "https://ghe.example.com/api/v3"},
    )

    assert parse(enterprise).pr_url == "https://ghe.example.com/o/r/pull/3"
    assert refusal(json.dumps(mismatch)).code is ErrorCode.INVALID_JOB


def test_plain_http_is_only_accepted_for_loopback_hosts() -> None:
    loopback = valid_job(
        prUrl="http://127.0.0.1:4010/o/r/pull/3",
        git={**valid_job()["git"], "baseUrl": "http://127.0.0.1:4010/api/v3"},
    )
    remote = valid_job(
        prUrl="http://ghe.example.com/o/r/pull/3",
        git={**valid_job()["git"], "baseUrl": "http://ghe.example.com/api/v3"},
    )

    assert parse(loopback).git.base_url == "http://127.0.0.1:4010/api/v3"
    assert refusal(json.dumps(remote)).code is ErrorCode.INVALID_JOB


@pytest.mark.parametrize(
    "base_url",
    [
        "https://user:pass@api.github.com",
        "https://api.github.com?x=1",
        "https://api.github.com#x",
        "ftp://api.github.com",
        "api.github.com",
        "",
    ],
)
def test_a_malformed_git_api_base_url_is_an_invalid_job(base_url: str) -> None:
    job = valid_job(git={**valid_job()["git"], "baseUrl": base_url})

    assert refusal(json.dumps(job)).code is ErrorCode.INVALID_JOB


def test_extra_environment_values_must_be_pr_agent_settings_as_strings() -> None:
    job = parse(valid_job(env={"PR_REVIEWER__NUM_MAX_FINDINGS": "3"}))

    assert job.env == {"PR_REVIEWER__NUM_MAX_FINDINGS": "3"}
    for bad in ({"PATH": "/tmp"}, {"lower__case": "x"}, {"PR_REVIEWER__X": 3}, ["A__B"]):
        assert refusal(json.dumps(valid_job(env=bad))).code is ErrorCode.INVALID_JOB


def test_extra_environment_cannot_replace_credentials_or_the_model() -> None:
    for key in ("GITHUB__USER_TOKEN", "OPENROUTER__KEY", "CONFIG__MODEL", "GITHUB__BASE_URL"):
        error = refusal(json.dumps(valid_job(env={key: "attacker"})))

        assert error.code is ErrorCode.INVALID_JOB


# CR-10-T07
def test_a_refusal_never_contains_a_value_from_the_job() -> None:
    job = valid_job(
        prUrl=f"https://evil.example.com/{TOKEN}/r/pull/1",
        git={**valid_job()["git"], "botLogin": f"bad login {API_KEY}"},
    )

    error = refusal(json.dumps(job))

    assert TOKEN not in error.detail
    assert API_KEY not in error.detail
    assert TOKEN not in str(error)


def test_input_beyond_the_size_limit_is_an_invalid_job() -> None:
    assert refusal(" " * (1024 * 1024 + 1)).code is ErrorCode.INVALID_JOB
