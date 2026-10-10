"""Pins down how a job becomes PR-Agent configuration: host-only values and secrets go into the
process environment as strings (the environment wins over a repository settings file), booleans and
lists are typed settings, and the environment of the parent process never leaks into PR-Agent."""

import json
from collections.abc import Mapping

from pr_agent.algo.utils import decode_user_text_args

from code_reviewer_runner.job import Job, parse_job
from code_reviewer_runner.pr_agent_config import (
    build_environment,
    build_request,
    build_typed_settings,
)

TOKEN = "ghs_dummyInstallationToken0123456789"
API_KEY = "sk-or-v1-dummyOpenRouterKey0123456789"


def make_job(command: str = "review", **extra: object) -> Job:
    raw = {
        "prUrl": "https://github.com/octo/repo/pull/7",
        "command": command,
        "git": {
            "provider": "github",
            "baseUrl": "https://api.github.com",
            "token": TOKEN,
            "botLogin": "code-reviewer[bot]",
        },
        "llm": {"provider": "openrouter", "model": "deepseek/deepseek-chat", "apiKey": API_KEY},
        **extra,
    }
    return parse_job(json.dumps(raw))


def environment(job: Job | None = None, base: Mapping[str, str] | None = None) -> dict[str, str]:
    return build_environment(job or make_job(), base or {})


# CR-10-T01
def test_the_environment_puts_pr_agent_into_user_mode_with_the_installation_token() -> None:
    env = environment()

    assert env["CONFIG__GIT_PROVIDER"] == "github"
    assert env["GITHUB__DEPLOYMENT_TYPE"] == "user"
    assert env["GITHUB__USER_TOKEN"] == TOKEN
    assert env["GITHUB__BASE_URL"] == "https://api.github.com"


def test_the_environment_pins_the_model_the_key_and_the_llm_endpoint() -> None:
    env = environment()

    assert env["CONFIG__MODEL"] == "openrouter/deepseek/deepseek-chat"
    assert env["OPENROUTER__KEY"] == API_KEY
    assert env["OPENROUTER__API_BASE"] == "https://openrouter.ai/api/v1"


def test_a_model_name_that_already_has_the_openrouter_prefix_is_not_prefixed_twice() -> None:
    job = parse_job(
        json.dumps(
            {
                "prUrl": "https://github.com/octo/repo/pull/7",
                "command": "review",
                "git": {
                    "provider": "github",
                    "baseUrl": "https://api.github.com",
                    "token": TOKEN,
                    "botLogin": "x",
                },
                "llm": {
                    "provider": "openrouter",
                    "model": "openrouter/deepseek/deepseek-chat",
                    "apiKey": API_KEY,
                },
            }
        )
    )

    assert environment(job)["CONFIG__MODEL"] == "openrouter/deepseek/deepseek-chat"


def test_the_fallback_models_are_emptied_so_a_failing_model_never_reaches_another_vendor() -> None:
    assert environment()["CONFIG__FALLBACK_MODELS"] == ""


def test_the_job_can_point_the_llm_endpoint_at_a_fake_through_its_env() -> None:
    job = make_job(env={"OPENROUTER__API_BASE": "http://127.0.0.1:4011/api/v1"})

    assert environment(job)["OPENROUTER__API_BASE"] == "http://127.0.0.1:4011/api/v1"


def test_extra_pr_agent_settings_from_the_job_are_passed_on_as_strings() -> None:
    job = make_job(
        env={"CONFIG__CUSTOM_MODEL_MAX_TOKENS": "64000", "PR_REVIEWER__NUM_MAX_FINDINGS": "3"}
    )

    env = environment(job)

    assert env["CONFIG__CUSTOM_MODEL_MAX_TOKENS"] == "64000"
    assert env["PR_REVIEWER__NUM_MAX_FINDINGS"] == "3"


def test_litellm_and_tiktoken_are_kept_offline_and_quiet() -> None:
    env = environment()

    assert env["LITELLM_LOCAL_MODEL_COST_MAP"] == "True"
    assert env["LITELLM_LOG"] == "ERROR"


# CR-10-T07
def test_nothing_from_the_parent_environment_leaks_except_the_plain_runtime_variables() -> None:
    parent = {
        "PATH": "/usr/bin",
        "HOME": "/home/runner",
        "LANG": "C.UTF-8",
        "DATA_GYM_CACHE_DIR": "/opt/tiktoken-cache",
        "GITHUB_APP_PRIVATE_KEY_PATH": "/secret/app.pem",
        "OPENROUTER_API_KEY": "should-not-pass",
        "GITHUB__USER_TOKEN": "parent-token",
        "CONFIG": "stray",
        "AWS_SECRET_ACCESS_KEY": "nope",
    }

    env = environment(base=parent)

    assert env["PATH"] == "/usr/bin"
    assert env["HOME"] == "/home/runner"
    assert env["LANG"] == "C.UTF-8"
    assert env["DATA_GYM_CACHE_DIR"] == "/opt/tiktoken-cache"
    assert env["GITHUB__USER_TOKEN"] == TOKEN
    assert "GITHUB_APP_PRIVATE_KEY_PATH" not in env
    assert "OPENROUTER_API_KEY" not in env
    assert "AWS_SECRET_ACCESS_KEY" not in env
    assert "CONFIG" not in env


def test_the_job_cannot_override_what_the_runner_pins() -> None:
    # parse_job already refuses reserved keys; the builder must not let one through either.
    job = make_job()
    object.__setattr__(job, "env", {"GITHUB__USER_TOKEN": "attacker", "CONFIG__MODEL": "evil"})

    env = environment(job)

    assert env["GITHUB__USER_TOKEN"] == TOKEN
    assert env["CONFIG__MODEL"] == "openrouter/deepseek/deepseek-chat"


def test_typed_settings_switch_review_labels_progress_comments_and_the_update_message_off() -> None:
    settings = build_typed_settings()

    assert settings["config.publish_output"] is True
    assert settings["config.publish_output_progress"] is False
    assert settings["config.use_global_settings_file"] is False
    assert settings["config.output_run_cost"] is True
    assert settings["config.fallback_models"] == []
    assert settings["pr_reviewer.final_update_message"] is False
    assert settings["pr_reviewer.enable_review_labels_security"] is False
    assert settings["pr_reviewer.enable_review_labels_effort"] is False
    assert settings["litellm.turn_off_message_logging"] is True


def test_typed_settings_are_real_booleans_and_lists_not_strings() -> None:
    for key, value in build_typed_settings().items():
        assert isinstance(value, bool | list), key


# CR-10-T01
def test_review_improve_and_describe_become_a_single_word_request() -> None:
    assert build_request(make_job("review")) == ["review"]
    assert build_request(make_job("improve")) == ["improve"]
    assert build_request(make_job("describe")) == ["describe"]


def test_ask_encodes_the_question_so_it_can_never_be_read_as_a_settings_override() -> None:
    request = build_request(make_job("ask", args=["--config.model=evil What changed?"]))

    assert request[0] == "ask"
    assert len(request) == 2
    assert request[1].startswith("__pr_agent_encoded_text__:")
    assert decode_user_text_args([request[1]]) == "--config.model=evil What changed?"
