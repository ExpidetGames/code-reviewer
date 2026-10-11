# SPDX-License-Identifier: Apache-2.0

"""Pins down that no text from the project's settings (`job.env`) or from a repository's
`.pr_agent.toml` is ever evaluated by Dynaconf. A value that starts with `@format` or `@jinja` is
evaluated by Dynaconf when it is read and can pull an environment variable or any other setting,
the installation token and the LLM key included, into the prompt, and from there into a public
comment (CR-25 finding). The tests run PR-Agent's real settings code: its Dynaconf object and
loaders, `_apply_repo_settings_file`, the prompt template, the token budget and the fallback list.

Negative controls ("would be evaluated") document the danger; if one of them starts to fail, the
protection is no longer needed in that form and should be reviewed."""

import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from jinja2.sandbox import SandboxedEnvironment
from pr_agent.git_providers import utils as untyped_provider_utils
from support import API_KEY, TOKEN, current, make_job, pr_agent_module, request_scope

from code_reviewer_runner.job import Job
from code_reviewer_runner.pr_agent_config import (
    AUTO_CAST_SETTING,
    InvalidOption,
    build_environment,
)
from code_reviewer_runner.pr_agent_runtime import configure_settings
from code_reviewer_runner.repo_settings_guard import (
    RepoSettingsGuard,
    install_repo_settings_guard,
)

provider_utils: Any = untyped_provider_utils  # Any: PR-Agent ships no type information

CANARY = "canary-value-from-the-process-environment"

# Every kind of reference Dynaconf can evaluate and that could carry a secret or a file out.
EVALUATED_TEXTS = [
    "@format {env[CANARY_ENV]}",
    "@format {this.openrouter.key}",
    "@format {this.github.user_token}",
    "@jinja {{ this.openrouter.key }}",
    "@jinja {{ this.github.user_token }}",
    "@jinja {{ env.CANARY_ENV }}",
    "@get openrouter.key",
    "@get github.user_token",
    "@read_file /etc/hosts",
    "@merge openrouter.key=x",
    "@insert 0 x",
    '@json {"key": "value"}',
    "@int 5",
    "@bool true",
    "@del",
    "@none",
    "@empty",
    "@format @jinja {{ this.openrouter.key }}",
    "@int @format {this.github.user_token}",
]


@pytest.fixture(autouse=True)
def canary(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("CANARY_ENV", CANARY)
    yield


def prompt_with(extra_instructions: str) -> str:
    """The system prompt of the review, rendered the way PR-Agent renders it."""
    system = current().pr_review_prompt.system
    variables = {"extra_instructions": extra_instructions, "num_max_findings": 3}
    return SandboxedEnvironment().from_string(system).render(variables)


def assert_no_secret(text: str) -> None:
    for secret in (TOKEN, API_KEY, CANARY):
        assert secret not in text


def apply_repo_file(directory: Path, content: str) -> None:
    path = directory / ".pr_agent.toml"
    path.write_text(content)
    provider_utils._apply_repo_settings_file(str(path))


def fresh_settings() -> Any:
    """A new Dynaconf object configured exactly like PR-Agent's own (same loaders and options)."""
    Dynaconf: Any = pr_agent_module("dynaconf").Dynaconf
    config_loader = pr_agent_module("pr_agent.config_loader")

    return Dynaconf(
        envvar_prefix=False,
        load_dotenv=False,
        settings_files=[os.path.join(config_loader.current_dir, "settings", "configuration.toml")],
        **config_loader.dynconf_kwargs,
    )


# CR-45-T01
def test_a_project_rule_that_references_the_llm_key_stays_literal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENROUTER__KEY", API_KEY)  # even where the key is in the environment
    rule = "@format {env[OPENROUTER__KEY]}"
    job = make_job(env={"PR_REVIEWER__EXTRA_INSTRUCTIONS": rule})

    with request_scope() as settings:
        configure_settings(job, settings, RepoSettingsGuard())

        value = settings.pr_reviewer.extra_instructions
        prompt = prompt_with(value)

    assert value == rule
    assert rule in prompt
    assert API_KEY not in prompt


# CR-45-T02
def test_a_project_rule_that_references_the_github_token_stays_literal() -> None:
    rule = "@jinja {{ this.github.user_token }}"
    job = make_job(env={"PR_REVIEWER__EXTRA_INSTRUCTIONS": rule})

    with request_scope() as settings:
        configure_settings(job, settings, RepoSettingsGuard())

        value = settings.pr_reviewer.extra_instructions
        prompt = prompt_with(value)

    assert value == rule
    assert rule in prompt
    assert TOKEN not in prompt


# CR-45-T01 / CR-45-T02
@pytest.mark.parametrize("text", EVALUATED_TEXTS)
def test_every_kind_of_reference_in_a_job_option_stays_the_text_that_was_sent(
    text: str,
) -> None:
    job = make_job(
        env={
            "PR_REVIEWER__EXTRA_INSTRUCTIONS": text,
            "PR_DESCRIPTION__EXTRA_INSTRUCTIONS": text,
            "PR_CODE_SUGGESTIONS__EXTRA_INSTRUCTIONS": text,
            "PR_QUESTIONS__EXTRA_INSTRUCTIONS": text,
        }
    )

    with request_scope() as settings:
        configure_settings(job, settings, RepoSettingsGuard())

        for section in ("pr_reviewer", "pr_description", "pr_code_suggestions", "pr_questions"):
            value = settings.get(f"{section}.extra_instructions")
            assert value == text
            assert type(value) is str


# CR-45-T03
def test_a_repository_rule_that_references_a_secret_stays_literal(
    tmp_path: Path,
) -> None:
    job = make_job()
    guard, uninstall = install_repo_settings_guard()
    try:
        with request_scope() as settings:
            configure_settings(job, settings, guard)

            apply_repo_file(
                tmp_path,
                "[pr_reviewer]\n"
                'extra_instructions = "@format {env[CANARY_ENV]} {this.openrouter.key} '
                '{this.github.user_token}"\n',
            )

            value = settings.pr_reviewer.extra_instructions
            prompt = prompt_with(value)
    finally:
        uninstall()

    assert value == "@format {env[CANARY_ENV]} {this.openrouter.key} {this.github.user_token}"
    assert "{this.openrouter.key}" in prompt
    assert_no_secret(prompt)


# CR-45-T03
@pytest.mark.parametrize("text", EVALUATED_TEXTS)
def test_every_kind_of_reference_in_a_repository_file_stays_the_text_that_was_sent(
    tmp_path: Path, text: str
) -> None:
    guard, uninstall = install_repo_settings_guard()
    try:
        with request_scope() as settings:
            configure_settings(make_job(), settings, guard)

            content = "".join(
                f'[{section}]\nextra_instructions = """{text}"""\n'
                for section in ("pr_reviewer", "pr_description", "pr_code_suggestions")
            )
            apply_repo_file(tmp_path, content)

            for section in ("pr_reviewer", "pr_description", "pr_code_suggestions"):
                value = settings.get(f"{section}.extra_instructions")
                assert value == text
                assert type(value) is str
    finally:
        uninstall()


# CR-45-T01 (negative control)
def test_negative_control_dynaconf_evaluates_an_environment_value_when_it_is_not_told_otherwise(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(AUTO_CAST_SETTING, raising=False)
    monkeypatch.setenv("OPENROUTER__KEY", API_KEY)
    monkeypatch.setenv("PR_REVIEWER__EXTRA_INSTRUCTIONS", "@format {env[OPENROUTER__KEY]}")

    assert fresh_settings().pr_reviewer.extra_instructions == API_KEY


# CR-45-T01
def test_the_first_load_of_the_environment_the_runner_builds_evaluates_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Even a stray variable that starts with a marker stays text, because the runner's environment
    # tells Dynaconf not to evaluate before it reads the first variable.
    for name in list(os.environ):
        monkeypatch.delenv(name)
    for name, value in build_environment(make_job(), {"PATH": "/usr/bin"}).items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("CANARY_ENV", CANARY)
    monkeypatch.setenv("PR_REVIEWER__EXTRA_INSTRUCTIONS", "@format {env[CANARY_ENV]}")
    monkeypatch.setenv("PR_DESCRIPTION__EXTRA_INSTRUCTIONS", "@jinja {{ env.CANARY_ENV }}")

    settings = fresh_settings()

    assert settings.pr_reviewer.extra_instructions == "@format {env[CANARY_ENV]}"
    assert settings.pr_description.extra_instructions == "@jinja {{ env.CANARY_ENV }}"


# CR-45-T04
def test_text_options_keep_any_text_even_when_it_looks_like_a_number_a_list_or_a_date() -> None:
    texts = ["true", "123", "[1]", "2026-01-01", "1.5", "{a = 1}", "null", "0x10", "1_000", ""]
    for text in texts:
        job = make_job(env={"PR_REVIEWER__EXTRA_INSTRUCTIONS": text})
        with request_scope() as settings:
            configure_settings(job, settings, RepoSettingsGuard())

            value = settings.pr_reviewer.extra_instructions

        assert value == text
        assert type(value) is str


# CR-45-T04
def test_switch_and_number_options_are_typed_by_their_default_in_pr_agent() -> None:
    job = make_job(
        env={
            "PR_REVIEWER__INLINE_KEY_ISSUES": "true",
            "PR_REVIEWER__REQUIRE_SCORE_REVIEW": "false",
            "PR_REVIEWER__NUM_MAX_FINDINGS": "3",
        }
    )

    with request_scope() as settings:
        configure_settings(job, settings, RepoSettingsGuard())

        assert settings.pr_reviewer.inline_key_issues is True
        assert settings.pr_reviewer.require_score_review is False
        assert settings.pr_reviewer.num_max_findings == 3
        assert type(settings.pr_reviewer.num_max_findings) is int


# CR-45-T04
@pytest.mark.parametrize(
    ("key", "text"),
    [
        ("PR_REVIEWER__NUM_MAX_FINDINGS", "[1]"),
        ("PR_REVIEWER__NUM_MAX_FINDINGS", "2026-01-01"),
        ("PR_REVIEWER__NUM_MAX_FINDINGS", "@int 5"),
        ("PR_REVIEWER__INLINE_KEY_ISSUES", "123"),
        ("PR_REVIEWER__INLINE_KEY_ISSUES", "@format {env[CANARY_ENV]}"),
    ],
)
def test_a_value_that_does_not_fit_a_switch_or_number_option_is_refused(
    key: str, text: str
) -> None:
    job = make_job(env={key: text})

    with request_scope() as settings, pytest.raises(InvalidOption) as caught:
        configure_settings(job, settings, RepoSettingsGuard())

    assert caught.value.key == key
    assert text not in str(caught.value)


# CR-45-T04 (a new PR-Agent version must not bring an option type this mapping does not handle)
def test_every_option_of_the_four_tools_has_a_switch_number_or_text_default() -> None:
    with request_scope() as settings:
        for section in ("pr_reviewer", "pr_description", "pr_code_suggestions", "pr_questions"):
            for name, value in settings.get(section).items():
                assert isinstance(value, bool | int | str), f"{section}.{name}"


# CR-45-T01 / CR-45-T02 (the secrets are not where an `{env[...]}` reference looks)
def test_the_secrets_are_settings_that_pr_agent_uses_and_not_environment_variables() -> None:
    job: Job = make_job()
    handler_class = pr_agent_module("pr_agent.algo.ai_handlers.litellm_ai_handler").LiteLLMAIHandler
    provider_class = pr_agent_module("pr_agent.git_providers.github_provider").GithubProvider

    with request_scope() as settings:
        configure_settings(job, settings, RepoSettingsGuard())

        handler: Any = handler_class()
        provider: Any = provider_class()

    assert handler._provider_request_params["openrouter"]["api_key"] == API_KEY
    assert provider.auth.token == TOKEN
    assert all(TOKEN not in value and API_KEY not in value for value in os.environ.values())


# CR-45-T05
def test_the_context_window_of_the_job_is_the_budget_for_a_model_pr_agent_does_not_know() -> None:
    get_max_tokens = pr_agent_module("pr_agent.algo.token_budget").get_max_tokens

    llm = {
        "provider": "openrouter",
        "model": "vendor/unknown-model",
        "apiKey": API_KEY,
        "maxTokens": 100000,
    }
    job = make_job(llm=llm)

    with request_scope() as settings:
        configure_settings(job, settings, RepoSettingsGuard())

        assert settings.config.max_model_tokens == 100000
        assert settings.config.custom_model_max_tokens == 100000
        assert get_max_tokens("openrouter/vendor/unknown-model") == 100000


# CR-45-T05 (negative control: why the clamp has to move as well)
def test_negative_control_the_default_clamp_would_cut_a_larger_window_to_32000() -> None:
    get_max_tokens = pr_agent_module("pr_agent.algo.token_budget").get_max_tokens

    with request_scope() as settings:
        settings.set("config.custom_model_max_tokens", 100000)

        assert get_max_tokens("openrouter/vendor/unknown-model") == 32000


# CR-45-T06
def test_the_fallback_models_of_the_job_are_what_pr_agent_tries_after_the_model() -> None:
    get_all_models = pr_agent_module("pr_agent.algo.pr_processing")._get_all_models  # pyright: ignore[reportPrivateUsage]

    llm = {
        "provider": "openrouter",
        "model": "deepseek/deepseek-chat",
        "apiKey": API_KEY,
        "fallbackModels": ["qwen/qwen3-coder", "openrouter/google/gemini-2.5-flash"],
    }

    with request_scope() as settings:
        configure_settings(make_job(llm=llm), settings, RepoSettingsGuard())
        settings.set("config.model", "openrouter/deepseek/deepseek-chat")

        assert get_all_models() == [
            "openrouter/deepseek/deepseek-chat",
            "openrouter/qwen/qwen3-coder",
            "openrouter/google/gemini-2.5-flash",
        ]


# CR-45-T06
def test_without_fallback_models_pr_agent_tries_only_the_model() -> None:
    get_all_models = pr_agent_module("pr_agent.algo.pr_processing")._get_all_models  # pyright: ignore[reportPrivateUsage]

    with request_scope() as settings:
        configure_settings(make_job(), settings, RepoSettingsGuard())
        settings.set("config.model", "openrouter/deepseek/deepseek-chat")

        assert get_all_models() == ["openrouter/deepseek/deepseek-chat"]


# CR-45-T03 (texts PR-Agent stores in its settings itself, here the body of a linked ticket)
def test_a_ticket_text_that_pr_agent_stores_in_its_settings_stays_literal() -> None:
    ticket = {"title": "A ticket", "body": "@format {this.openrouter.key} {this.github.user_token}"}

    with request_scope() as settings:
        configure_settings(make_job(), settings, RepoSettingsGuard())

        settings.set("related_tickets", [ticket])

        assert settings.get("related_tickets")[0]["body"] == ticket["body"]
