# SPDX-License-Identifier: Apache-2.0

"""Pins down which bot logins are valid. One public pattern, `BOT_LOGIN_PATTERN`, is the only
definition: the job parser and the identity patch both use it, so they cannot disagree."""

import json
from typing import Any

import pytest

from code_reviewer_runner.identity_patch import IdentityPatchError, apply_identity_patch
from code_reviewer_runner.job import BOT_LOGIN_PATTERN, JobError, parse_job
from code_reviewer_runner.result import ErrorCode

# The longest app slug GitHub allows is 39 characters; the suffix comes on top.
LONGEST_SLUG = "a" * 39

ACCEPTED = [
    "octo-bot",
    "octo-bot[bot]",
    "Octo-Bot",
    "a",
    "7bot",
    LONGEST_SLUG,
    f"{LONGEST_SLUG}[bot]",
]
REJECTED = [
    "",
    "   ",
    "[bot]",
    "-octo",
    "octo bot",
    " octo-bot",
    "octo-bot\n",
    "octo_bot",
    "octo.bot",
    "octo/bot",
    "octo-bot[bot",
    "octo-bot[BOT]",
    "octo-bot[bot][bot]",
    "octo-bot[bot] ",
    "octö-bot",
    "a" * 40,
    f"{'a' * 40}[bot]",
]


def job_with_bot_login(bot_login: str) -> str:
    job: dict[str, Any] = {
        "prUrl": "https://github.com/octo/repo/pull/7",
        "command": "review",
        "git": {
            "provider": "github",
            "baseUrl": "https://api.github.com",
            "token": "dummy-installation-token-0123456789",
            "botLogin": bot_login,
        },
        "llm": {
            "provider": "openrouter",
            "model": "deepseek/deepseek-chat",
            "apiKey": "dummy-openrouter-key-0123456789",
        },
    }
    return json.dumps(job)


# #83
@pytest.mark.parametrize("login", ACCEPTED)
def test_the_pattern_accepts_an_app_slug_with_or_without_the_bot_suffix(login: str) -> None:
    assert BOT_LOGIN_PATTERN.fullmatch(login) is not None


# #83
@pytest.mark.parametrize("login", REJECTED)
def test_the_pattern_rejects_what_is_not_an_app_login(login: str) -> None:
    assert BOT_LOGIN_PATTERN.fullmatch(login) is None


# #83
@pytest.mark.parametrize("login", ACCEPTED)
def test_a_job_with_a_valid_bot_login_is_parsed_and_always_carries_the_suffix(login: str) -> None:
    job = parse_job(job_with_bot_login(login))

    assert job.git.bot_login == (login if login.endswith("[bot]") else f"{login}[bot]")


# #83
@pytest.mark.parametrize("login", REJECTED)
def test_a_job_with_an_invalid_bot_login_is_an_invalid_job(login: str) -> None:
    with pytest.raises(JobError) as caught:
        parse_job(job_with_bot_login(login))

    assert caught.value.code is ErrorCode.INVALID_JOB


# #83
@pytest.mark.parametrize("login", REJECTED)
def test_the_identity_patch_refuses_the_same_logins_as_the_job_parser(login: str) -> None:
    with pytest.raises(IdentityPatchError) as caught:
        apply_identity_patch(login)

    assert caught.value.code is ErrorCode.IDENTITY_PATCH_FAILED


# #121
@pytest.mark.parametrize("login", [login for login in ACCEPTED if not login.endswith("[bot]")])
def test_the_identity_patch_refuses_a_valid_slug_without_the_bot_suffix(login: str) -> None:
    # parse_job always appends the suffix; the patch must not install a login GitHub never reports.
    with pytest.raises(IdentityPatchError) as caught:
        apply_identity_patch(login)

    assert caught.value.code is ErrorCode.IDENTITY_PATCH_FAILED
    assert "[bot]" in caught.value.detail


# #121
@pytest.mark.parametrize("login", [login for login in ACCEPTED if login.endswith("[bot]")])
def test_the_identity_patch_accepts_what_the_job_parser_produces(login: str) -> None:
    parsed = parse_job(job_with_bot_login(login)).git.bot_login

    undo = apply_identity_patch(parsed)
    undo()
