# SPDX-License-Identifier: Apache-2.0

"""The identity patch for variant B (installation token in PR-Agent's user mode).

A GitHub App installation token cannot call `GET /user`, which PR-Agent's GitHub provider uses to
learn which login it posts as. Without the login, a second review of the same pull request cannot
tell its own comment from somebody else's and fails instead of editing it. PR-Agent resolves the
login in exactly one place, `GithubProvider._resolve_user_login`; the patch makes it return the
app's bot login (`<slug>[bot]`), which is what GitHub puts into `comment.user.login`.

The patch reaches into a private method, so it is tied to the version it was written and tested for.
Any other version is refused instead of being patched blindly. `tests/unit/test_identity_funnel.py`
reads PR-Agent's real source and fails when an upgrade changes what the patch relies on.
"""

import inspect
from collections.abc import Callable
from importlib.metadata import PackageNotFoundError, version
from typing import Any

from code_reviewer_runner.identity_funnel import FunnelError, verify_identity_funnel
from code_reviewer_runner.job import BOT_LOGIN_PATTERN
from code_reviewer_runner.result import ErrorCode

PATCHED_FOR_VERSION = "0.47.0"
BOT_SUFFIX = "[bot]"
_METHOD = "_resolve_user_login"
_EXPECTED_SIGNATURE = ["self"]
# Set on the replacement, so a second application finds the real method instead of wrapping it.
_ORIGINAL_ATTRIBUTE = "__identity_patch_original__"
_LOGIN_ATTRIBUTE = "__identity_patch_login__"


class IdentityPatchError(Exception):
    def __init__(self, code: ErrorCode, detail: str) -> None:
        super().__init__(f"{code.value}: {detail}")
        self.code = code
        self.detail = detail


def _installed_version() -> str | None:
    try:
        return version("pr-agent")
    except PackageNotFoundError:
        return None


def check_pr_agent_version(
    installed: str | None = None, lookup: Callable[[], str | None] = _installed_version
) -> None:
    """Refuse any PR-Agent version other than the one the patch was written for."""
    actual = installed if installed is not None else lookup()
    if actual != PATCHED_FOR_VERSION:
        raise IdentityPatchError(
            ErrorCode.PR_AGENT_VERSION_MISMATCH,
            f"the identity patch was written for pr-agent {PATCHED_FOR_VERSION}, found "
            f"{actual or 'none'}; check the identity patch against the new release "
            "(tests/unit/test_identity_funnel.py) and then raise PATCHED_FOR_VERSION and the pin",
        )


def _refusal(provider_class: type[Any], problem: str) -> IdentityPatchError:
    return IdentityPatchError(
        ErrorCode.IDENTITY_PATCH_FAILED,
        f"{provider_class.__name__}.{_METHOD} {problem} "
        f"(pr-agent {_installed_version() or 'unknown'}, patch written for {PATCHED_FOR_VERSION})",
    )


def apply_identity_patch(
    bot_login: str, provider_class: type[Any] | None = None
) -> Callable[[], None]:
    """Make `_resolve_user_login` return `bot_login`. Returns a function that undoes the patch.

    Everything the patch relies on is checked first, and a failed check changes nothing: the method
    exists and takes only `self`, the chain that asks it for the login is intact, and there is a
    login to return. Applying the patch twice does not wrap it twice.
    """
    if not isinstance(bot_login, str):  # pyright: ignore[reportUnnecessaryIsInstance]
        raise TypeError("the bot login must be a string")
    if not BOT_LOGIN_PATTERN.fullmatch(bot_login):
        # No fallback to another identity: PR-Agent would post under a login it cannot recognise.
        # parse_job guarantees this already; the patch does not rely on its caller.
        raise IdentityPatchError(
            ErrorCode.IDENTITY_PATCH_FAILED, "the bot login of the job is empty or not an app login"
        )
    if not bot_login.endswith(BOT_SUFFIX):
        # GitHub reports an app's comments as `<slug>[bot]`. parse_job appends the suffix, so a bare
        # slug here would make PR-Agent miss its own comments; refuse it instead of normalizing.
        raise IdentityPatchError(
            ErrorCode.IDENTITY_PATCH_FAILED,
            f"the bot login must end with {BOT_SUFFIX}, the login GitHub reports for an app",
        )
    if provider_class is None:
        from pr_agent.git_providers.github_provider import GithubProvider

        provider_class = GithubProvider
    current = getattr(provider_class, _METHOD, None)
    if not callable(current):
        raise _refusal(provider_class, "does not exist")
    original = getattr(current, _ORIGINAL_ATTRIBUTE, current)
    parameters = list(inspect.signature(original).parameters)
    if parameters != _EXPECTED_SIGNATURE:
        raise _refusal(
            provider_class,
            f"has a different signature: expected {_expected_signature_text()}, "
            f"found {inspect.signature(original)}",
        )
    try:
        verify_identity_funnel(provider_class)
    except FunnelError as error:
        raise IdentityPatchError(
            error.code,
            f"{error.detail} (pr-agent {_installed_version() or 'unknown'}, "
            f"patch written for {PATCHED_FOR_VERSION})",
        ) from error

    if getattr(current, _LOGIN_ATTRIBUTE, None) == bot_login:
        return lambda: None  # already patched with this login: nothing to wrap, nothing to undo

    def resolved_login(self: object) -> str:
        return bot_login

    setattr(resolved_login, _ORIGINAL_ATTRIBUTE, original)
    setattr(resolved_login, _LOGIN_ATTRIBUTE, bot_login)
    setattr(provider_class, _METHOD, resolved_login)

    def undo() -> None:
        setattr(provider_class, _METHOD, original)

    return undo


def _expected_signature_text() -> str:
    return f"({', '.join(_EXPECTED_SIGNATURE)})"
