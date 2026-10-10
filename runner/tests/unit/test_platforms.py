"""Pins down the table that maps the platform of a job (`git.provider`) to PR-Agent settings."""

import json
from typing import Any

import pytest
from support import API_KEY, TOKEN, make_job, make_job_dict

from code_reviewer_runner.identity_patch import apply_identity_patch
from code_reviewer_runner.job import JobError, parse_job
from code_reviewer_runner.platforms import PLATFORMS, platform_for
from code_reviewer_runner.pr_agent_config import build_environment, build_secret_settings
from code_reviewer_runner.result import ErrorCode


def test_the_mvp_supports_github_only() -> None:
    assert set(PLATFORMS) == {"github"}
    assert platform_for("gitlab") is None
    assert platform_for("") is None


# CR-29-T19
def test_a_github_job_becomes_the_pr_agent_settings_of_a_github_user_mode_provider() -> None:
    job = make_job(
        prUrl="https://ghe.example.com/octo/repo/pull/7",
        git={**make_job_dict()["git"], "baseUrl": "https://ghe.example.com/api/v3"},
    )

    env = build_environment(job, {})

    assert job.git.provider == "github"
    assert env["CONFIG__GIT_PROVIDER"] == "github"
    assert env["GITHUB__DEPLOYMENT_TYPE"] == "user"
    assert env["GITHUB__BASE_URL"] == "https://ghe.example.com/api/v3"
    assert build_secret_settings(job) == {"github.user_token": TOKEN, "openrouter.key": API_KEY}


# CR-29-T19
def test_the_bot_identity_of_the_job_is_what_the_identity_patch_gives_pr_agent() -> None:
    job = make_job()

    class Provider:
        def _resolve_user_login(self) -> str:
            return ""

    undo = apply_identity_patch(job.git.bot_login, provider_class=Provider)
    try:
        login: Any = Provider()._resolve_user_login()  # pyright: ignore[reportPrivateUsage]
    finally:
        undo()

    assert login == "code-reviewer[bot]"


# CR-29-T20
@pytest.mark.parametrize("provider", ["gitlab", "bitbucket", "GitHub", "", "github ", None, 7])
def test_a_job_from_a_platform_that_is_not_in_the_table_is_an_invalid_job(provider: Any) -> None:
    job = make_job_dict(git={**make_job_dict()["git"], "provider": provider})

    with pytest.raises(JobError) as refusal:
        parse_job(json.dumps(job))

    assert refusal.value.code is ErrorCode.INVALID_JOB
