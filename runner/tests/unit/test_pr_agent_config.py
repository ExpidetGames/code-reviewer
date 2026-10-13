# SPDX-License-Identifier: Apache-2.0

"""Pins down how a job becomes PR-Agent configuration: endpoints and model names go into the process
environment as strings (the environment wins over a repository settings file); secrets, booleans,
numbers, lists and the options of the job are typed settings set inside the request scope; and
neither the environment of the parent process nor a secret of the job reaches `os.environ`."""

import json
from collections.abc import Callable, Mapping
from typing import Any

import pytest

from code_reviewer_runner.job import RESERVED_OPTIONS, Job, parse_job
from code_reviewer_runner.pr_agent_config import (
    InvalidOption,
    build_environment,
    build_option_settings,
    build_request,
    build_secret_settings,
    build_typed_settings,
)
from code_reviewer_runner.repo_settings_guard import PROTECTED_SETTINGS

TOKEN = "dummy-installation-token-0123456789"
API_KEY = "dummy-openrouter-key-0123456789"


def make_job_dict(command: str = "review", **extra: object) -> dict[str, Any]:
    return {
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


def make_job(command: str = "review", **extra: object) -> Job:
    return parse_job(json.dumps(make_job_dict(command, **extra)))


def defaults(known: Mapping[str, object]) -> Callable[[str], object]:
    """What PR-Agent's own settings answer for the default of an option (None: unknown)."""
    return lambda name: known.get(name)


def environment(job: Job | None = None, base: Mapping[str, str] | None = None) -> dict[str, str]:
    return build_environment(job or make_job(), base or {})


# CR-10-T01
def test_the_environment_puts_pr_agent_into_user_mode_and_pins_the_github_endpoint() -> None:
    env = environment()

    assert env["CONFIG__GIT_PROVIDER"] == "github"
    assert env["GITHUB__DEPLOYMENT_TYPE"] == "user"
    assert env["GITHUB__BASE_URL"] == "https://api.github.com"


# CR-10-T01
def test_the_installation_token_and_the_llm_key_are_typed_settings() -> None:
    assert build_secret_settings(make_job()) == {
        "github.user_token": TOKEN,
        "openrouter.key": API_KEY,
    }


# CR-45-T07
def test_no_secret_of_the_job_is_in_the_environment() -> None:
    env = environment()

    assert not any(TOKEN in value or API_KEY in value for value in env.values())
    for name in ("GITHUB__USER_TOKEN", "OPENROUTER__KEY", "OPENROUTER_API_KEY"):
        assert name not in env


# CR-45-T01
def test_dynaconf_is_told_not_to_evaluate_values_before_it_reads_the_first_one() -> None:
    # Dynaconf reads this variable when its settings are created, which is before PR-Agent's own
    # module sets it. Without it the first load of the environment would still evaluate `@format`.
    assert environment()["AUTO_CAST_FOR_DYNACONF"] == "false"


def test_the_environment_pins_the_model_and_the_llm_endpoint() -> None:
    env = environment()

    assert env["CONFIG__MODEL"] == "openrouter/deepseek/deepseek-chat"
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


# CR-45-T06
def test_without_fallback_models_the_list_is_emptied_so_no_model_of_another_vendor_is_tried() -> (
    None
):
    assert build_typed_settings(make_job())["config.fallback_models"] == []


# CR-45-T06
def test_the_fallback_models_of_the_job_become_the_typed_list_with_the_openrouter_prefix() -> None:
    llm = {**make_job_dict()["llm"], "fallbackModels": ["qwen/qwen3-coder", "openrouter/a/b"]}

    settings = build_typed_settings(make_job(llm=llm))

    assert settings["config.fallback_models"] == ["openrouter/qwen/qwen3-coder", "openrouter/a/b"]


# CR-45-T06
def test_the_fallback_models_are_not_in_the_environment() -> None:
    # An environment value wins over a typed one after every settings file, so it must not exist.
    llm = {**make_job_dict()["llm"], "fallbackModels": ["qwen/qwen3-coder"]}

    assert "CONFIG__FALLBACK_MODELS" not in environment(make_job(llm=llm))


def test_the_weak_and_the_reasoning_model_are_pinned_to_the_job_model() -> None:
    env = environment()

    assert env["CONFIG__MODEL_WEAK"] == "openrouter/deepseek/deepseek-chat"
    assert env["CONFIG__MODEL_REASONING"] == "openrouter/deepseek/deepseek-chat"


def test_the_job_can_point_the_llm_endpoint_at_a_fake_through_its_own_field() -> None:
    job = make_job(llm={**make_job_dict()["llm"], "baseUrl": "http://127.0.0.1:4011/api/v1"})

    assert environment(job)["OPENROUTER__API_BASE"] == "http://127.0.0.1:4011/api/v1"


# CR-45-T05
def test_the_context_window_sets_the_custom_limit_and_lifts_the_clamp_to_the_same_value() -> None:
    sized = make_job(llm={**make_job_dict()["llm"], "maxTokens": 100000})

    settings = build_typed_settings(sized)

    assert settings["config.custom_model_max_tokens"] == 100000
    assert settings["config.max_model_tokens"] == 100000
    assert type(settings["config.max_model_tokens"]) is int


# CR-45-T05
def test_without_a_context_window_the_limits_of_pr_agent_stay_untouched() -> None:
    settings = build_typed_settings(make_job())

    assert "config.custom_model_max_tokens" not in settings
    assert "config.max_model_tokens" not in settings
    assert "CONFIG__CUSTOM_MODEL_MAX_TOKENS" not in environment()
    assert "CONFIG__MAX_MODEL_TOKENS" not in environment()


# CR-45-T01
def test_the_options_of_the_job_are_never_put_into_the_environment() -> None:
    job = make_job(
        env={"PR_REVIEWER__NUM_MAX_FINDINGS": "3", "PR_REVIEWER__EXTRA_INSTRUCTIONS": "x"}
    )

    env = environment(job)

    assert not any(name.startswith("PR_") for name in env)


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
        "DATA_GYM_CACHE_DIR": "/opt/bpe-cache",
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
    assert env["DATA_GYM_CACHE_DIR"] == "/opt/bpe-cache"
    assert "GITHUB__USER_TOKEN" not in env
    assert "parent-token" not in env.values()
    assert "GITHUB_APP_PRIVATE_KEY_PATH" not in env
    assert "OPENROUTER_API_KEY" not in env
    assert "AWS_SECRET_ACCESS_KEY" not in env
    assert "CONFIG" not in env


def test_the_job_cannot_override_what_the_runner_pins() -> None:
    # parse_job already refuses reserved keys; the builders must not let one through either.
    job = make_job()
    object.__setattr__(job, "env", {"GITHUB__USER_TOKEN": "attacker", "CONFIG__MODEL": "evil"})

    env = environment(job)

    assert "GITHUB__USER_TOKEN" not in env
    assert env["CONFIG__MODEL"] == "openrouter/deepseek/deepseek-chat"
    assert build_secret_settings(job)["github.user_token"] == TOKEN


def test_typed_settings_switch_review_labels_progress_comments_and_the_update_message_off() -> None:
    settings = build_typed_settings(make_job())

    assert settings["config.publish_output"] is True
    assert settings["config.publish_output_progress"] is False
    assert settings["config.use_global_settings_file"] is False
    assert settings["config.output_run_cost"] is True
    assert settings["config.fallback_models"] == []
    assert settings["pr_reviewer.final_update_message"] is False
    assert settings["pr_reviewer.enable_review_labels_security"] is False
    assert settings["pr_reviewer.enable_review_labels_effort"] is False
    assert settings["litellm.turn_off_message_logging"] is True


def test_typed_settings_are_real_booleans_numbers_and_lists_not_strings() -> None:
    for key, value in build_typed_settings(make_job()).items():
        if key == "config.config_branch":
            assert value == ""
            continue
        assert isinstance(value, bool | int | list), key


# CR-45-T01
def test_the_first_typed_setting_switches_dynaconf_evaluation_off() -> None:
    # Every later `set` of a text value goes through Dynaconf's parser; the switch must come first.
    assert next(iter(build_typed_settings(make_job()))) == "AUTO_CAST_FOR_DYNACONF"
    assert build_typed_settings(make_job())["AUTO_CAST_FOR_DYNACONF"] is False


def test_a_repository_cannot_move_its_settings_to_another_branch_or_directory() -> None:
    settings = build_typed_settings(make_job())

    assert settings["config.config_branch"] == ""
    assert settings["config.enable_per_directory_settings"] is False


# CR-45 review
def test_the_options_the_runner_pins_are_exactly_the_reserved_options_of_the_job() -> None:
    pinned = {
        key
        for key in {**build_typed_settings(make_job()), **{p: 0 for p in PROTECTED_SETTINGS}}
        if key.split(".")[0] == "pr_reviewer"
    }

    assert {key.replace(".", "__").upper() for key in pinned} == RESERVED_OPTIONS


# CR-45 review
@pytest.mark.parametrize("key", sorted(RESERVED_OPTIONS))
def test_a_reserved_option_is_refused_even_when_it_bypasses_the_job_validation(key: str) -> None:
    with pytest.raises(InvalidOption) as caught:
        build_option_settings({key: "true"}, defaults({}))

    assert caught.value.key == key


# CR-45 review
def test_the_context_files_are_pinned_to_the_default_branch() -> None:
    assert build_typed_settings(make_job())["config.repo_context_from_default_branch"] is True


# CR-45-T04
@pytest.mark.parametrize(
    "text", ["true", "123", "[1]", "2026-01-01", "1.5", "{a = 1}", "@format x"]
)
def test_an_option_that_holds_text_in_pr_agent_stays_the_text_that_was_sent(text: str) -> None:
    settings = build_option_settings(
        {"PR_REVIEWER__EXTRA_INSTRUCTIONS": text}, defaults({"pr_reviewer.extra_instructions": ""})
    )

    assert settings == {"pr_reviewer.extra_instructions": text}
    assert type(settings["pr_reviewer.extra_instructions"]) is str


# CR-45-T04
def test_a_boolean_option_takes_true_and_false_and_a_number_option_takes_an_integer() -> None:
    settings = build_option_settings(
        {
            "PR_REVIEWER__INLINE_KEY_ISSUES": "true",
            "PR_REVIEWER__REQUIRE_SCORE_REVIEW": " False ",
            "PR_REVIEWER__NUM_MAX_FINDINGS": "3",
            "PR_CODE_SUGGESTIONS__NUM_CODE_SUGGESTIONS_PER_CHUNK": "-1",
        },
        defaults(
            {
                "pr_reviewer.inline_key_issues": False,
                "pr_reviewer.require_score_review": True,
                "pr_reviewer.num_max_findings": 10,
                "pr_code_suggestions.num_code_suggestions_per_chunk": 4,
            }
        ),
    )

    assert settings == {
        "pr_reviewer.inline_key_issues": True,
        "pr_reviewer.require_score_review": False,
        "pr_reviewer.num_max_findings": 3,
        "pr_code_suggestions.num_code_suggestions_per_chunk": -1,
    }
    assert type(settings["pr_reviewer.num_max_findings"]) is int


# CR-45-T04
@pytest.mark.parametrize(
    ("default", "text"),
    [
        (False, "yes"),
        (False, "1"),
        (False, ""),
        (False, "[true]"),
        (3, "three"),
        (3, "1.5"),
        (3, "2026-01-01"),
        (3, "[1]"),
        (3, ""),
        (3, "true"),
        (3, "1" * 40),
        (3, "@int 5"),
    ],
)
def test_a_value_the_type_of_the_option_does_not_allow_is_refused_by_option_name(
    default: object, text: str
) -> None:
    with pytest.raises(InvalidOption) as caught:
        build_option_settings(
            {"PR_REVIEWER__OPTION": text}, defaults({"pr_reviewer.option": default})
        )

    assert caught.value.key == "PR_REVIEWER__OPTION"
    assert not text or text not in str(caught.value)


# CR-45-T04
def test_an_option_pr_agent_does_not_know_is_kept_as_text() -> None:
    settings = build_option_settings({"PR_REVIEWER__NOT_AN_OPTION": "7"}, defaults({}))

    assert settings == {"pr_reviewer.not_an_option": "7"}


# CR-45-T04, #203
def test_a_review_option_maps_to_its_settings_section() -> None:
    settings = build_option_settings({"PR_REVIEWER__A": "x"}, defaults({}))

    assert settings == {"pr_reviewer.a": "x"}


# CR-10-T01, #203
def test_review_becomes_a_single_word_request() -> None:
    assert build_request(make_job("review")) == ["review"]
