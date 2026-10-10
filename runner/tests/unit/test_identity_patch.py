"""Pins down the identity patch (variant B): PR-Agent is run with an installation token, which
cannot call GET /user, so the login PR-Agent posts as is injected. The patch is tied to the exact
PR-Agent version it was written for and refuses to apply to anything else."""

import inspect
from collections.abc import Iterator
from importlib.metadata import version
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


# CR-30-T01
def test_the_real_pr_agent_still_has_a_callable_login_method_on_its_github_provider() -> None:
    method = getattr(GithubProvider, "_resolve_user_login", None)

    assert callable(method)
    assert version("pr-agent") == PATCHED_FOR_VERSION


# CR-30-T02
def test_the_patch_on_the_real_provider_returns_the_login_of_the_job_and_keeps_the_signature() -> (
    None
):
    original = inspect.signature(GithubProvider._resolve_user_login)  # pyright: ignore[reportPrivateUsage]
    # No __init__ and no network: a bare instance cannot reach GitHub, so a returned login proves
    # that the patch answered on its own.
    instance: Any = object.__new__(GithubProvider)

    undo = apply_identity_patch("my-review-app[bot]")
    try:
        login = instance._resolve_user_login()  # pyright: ignore[reportPrivateUsage]
        patched = inspect.signature(GithubProvider._resolve_user_login)  # pyright: ignore[reportPrivateUsage]
    finally:
        undo()

    assert login == "my-review-app[bot]"
    assert list(patched.parameters) == list(original.parameters) == ["self"]


# CR-30-T03
def test_a_missing_method_fails_loudly_with_the_method_name_and_the_pr_agent_version() -> None:
    with pytest.raises(IdentityPatchError) as caught:
        apply_identity_patch("code-reviewer[bot]", provider_class=NoIdentityMethod)

    assert caught.value.code is ErrorCode.IDENTITY_PATCH_FAILED
    assert "NoIdentityMethod._resolve_user_login" in caught.value.detail
    assert "does not exist" in caught.value.detail
    assert f"pr-agent {version('pr-agent')}" in caught.value.detail


# CR-30-T03
def test_a_method_that_is_not_callable_anymore_is_refused() -> None:
    class Renamed:
        _resolve_user_login = "moved to a property"

    with pytest.raises(IdentityPatchError) as caught:
        apply_identity_patch("code-reviewer[bot]", provider_class=Renamed)

    assert caught.value.code is ErrorCode.IDENTITY_PATCH_FAILED
    assert Renamed._resolve_user_login == "moved to a property"  # pyright: ignore[reportPrivateUsage]


# CR-30-T04
def test_a_changed_signature_is_refused_and_the_error_shows_expected_and_found() -> None:
    with pytest.raises(IdentityPatchError) as caught:
        apply_identity_patch("code-reviewer[bot]", provider_class=WrongSignature)

    assert caught.value.code is ErrorCode.IDENTITY_PATCH_FAILED
    assert "(self, extra: str) -> str" in caught.value.detail
    assert "(self)" in caught.value.detail
    assert f"pr-agent {version('pr-agent')}" in caught.value.detail


# CR-30-T04
def test_a_refused_patch_leaves_the_provider_class_untouched() -> None:
    before = WrongSignature._resolve_user_login  # pyright: ignore[reportPrivateUsage]

    with pytest.raises(IdentityPatchError):
        apply_identity_patch("code-reviewer[bot]", provider_class=WrongSignature)

    assert WrongSignature._resolve_user_login is before  # pyright: ignore[reportPrivateUsage]


# CR-30-T05
def test_a_version_mismatch_names_both_versions_and_says_to_check_the_patch() -> None:
    with pytest.raises(IdentityPatchError) as caught:
        check_pr_agent_version(installed="0.48.0")

    detail = caught.value.detail
    assert "0.48.0" in detail
    assert PATCHED_FOR_VERSION in detail
    assert "check the identity patch" in detail
    assert "PATCHED_FOR_VERSION" in detail


# CR-30-T06
def test_applying_the_patch_a_second_time_does_not_wrap_the_patch() -> None:
    original = GithubProvider._resolve_user_login  # pyright: ignore[reportPrivateUsage]
    instance: Any = object.__new__(GithubProvider)

    undo_first = apply_identity_patch("code-reviewer[bot]")
    first = GithubProvider._resolve_user_login  # pyright: ignore[reportPrivateUsage]
    undo_second = apply_identity_patch("code-reviewer[bot]")
    try:
        second = GithubProvider._resolve_user_login  # pyright: ignore[reportPrivateUsage]
        login = instance._resolve_user_login()  # pyright: ignore[reportPrivateUsage]
    finally:
        undo_second()
        undo_first()

    assert login == "code-reviewer[bot]"
    assert second is first
    assert GithubProvider._resolve_user_login is original  # pyright: ignore[reportPrivateUsage]


# CR-30-T06
def test_applying_the_patch_again_with_another_login_replaces_the_login_instead_of_stacking() -> (
    None
):
    original = GithubProvider._resolve_user_login  # pyright: ignore[reportPrivateUsage]
    instance: Any = object.__new__(GithubProvider)

    undo_first = apply_identity_patch("first-app[bot]")
    undo_second = apply_identity_patch("second-app[bot]")
    try:
        login = instance._resolve_user_login()  # pyright: ignore[reportPrivateUsage]
    finally:
        undo_second()
        undo_first()

    assert login == "second-app[bot]"
    assert GithubProvider._resolve_user_login is original  # pyright: ignore[reportPrivateUsage]


# CR-30-T07
@pytest.mark.parametrize("login", ["", "   ", "[bot]", " [bot]"])
def test_the_patch_refuses_an_empty_login_instead_of_falling_back_to_another_identity(
    login: str,
) -> None:
    original = GithubProvider._resolve_user_login  # pyright: ignore[reportPrivateUsage]

    with pytest.raises(IdentityPatchError) as caught:
        apply_identity_patch(login)

    assert caught.value.code is ErrorCode.IDENTITY_PATCH_FAILED
    assert "login" in caught.value.detail
    assert GithubProvider._resolve_user_login is original  # pyright: ignore[reportPrivateUsage]


def test_the_patch_refuses_to_apply_when_the_login_chain_of_pr_agent_has_moved() -> None:
    class Moved:
        def _resolve_user_login(self) -> str:
            return ""

        def _agent_login(self) -> str:
            return "someone"  # no longer asks _resolve_user_login

        def is_comment_authored_by_pr_agent(self, comment: object) -> bool:
            return self._agent_login() != ""

        def supports_review_finding_state(self) -> bool:
            return True

    with pytest.raises(IdentityPatchError) as caught:
        apply_identity_patch("code-reviewer[bot]", provider_class=Moved)

    assert caught.value.code is ErrorCode.IDENTITY_PATCH_FAILED
    assert "_agent_login" in caught.value.detail
