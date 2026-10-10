"""Pins down the identity patch (variant B): PR-Agent is run with an installation token, which
cannot call GET /user, so the login PR-Agent posts as is injected. The patch is tied to the exact
PR-Agent version it was written for and refuses to apply to anything else."""

from collections.abc import Iterator
from typing import Any

import pytest
from github import GithubException
from pr_agent.git_providers.github_provider import GithubProvider

from code_reviewer_runner.identity_patch import (
    PATCHED_FOR_VERSION,
    IdentityPatchError,
    apply_identity_patch,
    check_pr_agent_version,
)
from code_reviewer_runner.result import ErrorCode


class NoIdentityMethod:
    """A provider class from a PR-Agent version that no longer has the patched method."""


class WrongSignature:
    def _resolve_user_login(self, extra: str) -> str:
        return extra


@pytest.fixture
def provider() -> Iterator[Any]:  # Any: PR-Agent's provider methods are untyped
    # No __init__: constructing a provider would build a GitHub client. The identity code only
    # needs the instance, so the test shows what happens when GitHub answers 403 to GET /user.
    instance = object.__new__(GithubProvider)

    def forbidden() -> str:
        raise GithubException(403, {"message": "Resource not accessible by integration"}, {})

    instance.get_user_id = forbidden  # type: ignore[method-assign]
    yield instance


# CR-10-T02
def test_the_patched_method_returns_the_bot_login_without_asking_github(
    provider: Any,
) -> None:
    undo = apply_identity_patch("code-reviewer[bot]")
    try:
        login = provider._resolve_user_login()  # pyright: ignore[reportPrivateUsage]
    finally:
        undo()

    assert login == "code-reviewer[bot]"


def test_the_patch_feeds_the_authorship_check_that_decides_whether_a_review_is_edited(
    provider: Any,
) -> None:
    class Author:
        login = "Code-Reviewer[bot]"

    class Comment:
        user = Author()

    undo = apply_identity_patch("code-reviewer[bot]")
    try:
        authored = provider.is_comment_authored_by_pr_agent(Comment())
    finally:
        undo()

    assert authored is True


def test_without_the_patch_the_authorship_check_cannot_be_answered(
    provider: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Inside GitHub Actions PR-Agent assumes the Actions bot identity instead of failing.
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)

    class Comment:
        user = type("Author", (), {"login": "code-reviewer[bot]"})()

    with pytest.raises(RuntimeError):
        provider.is_comment_authored_by_pr_agent(Comment())


def test_undoing_the_patch_restores_the_original_method() -> None:
    original = GithubProvider._resolve_user_login  # pyright: ignore[reportPrivateUsage]

    undo = apply_identity_patch("code-reviewer[bot]")
    assert GithubProvider._resolve_user_login is not original  # pyright: ignore[reportPrivateUsage]
    undo()

    assert GithubProvider._resolve_user_login is original  # pyright: ignore[reportPrivateUsage]


# CR-10-T03
def test_a_provider_without_the_patched_method_is_refused_with_a_stable_code() -> None:
    with pytest.raises(IdentityPatchError) as caught:
        apply_identity_patch("code-reviewer[bot]", provider_class=NoIdentityMethod)

    assert caught.value.code is ErrorCode.IDENTITY_PATCH_FAILED
    assert not hasattr(NoIdentityMethod, "_resolve_user_login")


def test_a_method_with_a_different_signature_is_refused() -> None:
    with pytest.raises(IdentityPatchError) as caught:
        apply_identity_patch("code-reviewer[bot]", provider_class=WrongSignature)

    assert caught.value.code is ErrorCode.IDENTITY_PATCH_FAILED


def test_the_installed_pr_agent_version_is_the_one_the_patch_was_written_for() -> None:
    check_pr_agent_version()

    assert PATCHED_FOR_VERSION == "0.47.0"


def test_any_other_pr_agent_version_is_refused_with_a_stable_code() -> None:
    with pytest.raises(IdentityPatchError) as caught:
        check_pr_agent_version(installed="0.48.0")

    assert caught.value.code is ErrorCode.PR_AGENT_VERSION_MISMATCH


def test_a_missing_pr_agent_distribution_is_a_version_mismatch() -> None:
    with pytest.raises(IdentityPatchError) as caught:
        check_pr_agent_version(installed=None, lookup=lambda: None)

    assert caught.value.code is ErrorCode.PR_AGENT_VERSION_MISMATCH
