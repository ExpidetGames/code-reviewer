"""The identity patch for variant B (installation token in PR-Agent's user mode).

A GitHub App installation token cannot call `GET /user`, which PR-Agent's GitHub provider uses to
learn which login it posts as. Without the login, a second review of the same pull request cannot
tell its own comment from somebody else's and fails instead of editing it. PR-Agent resolves the
login in exactly one place, `GithubProvider._resolve_user_login`; the patch makes it return the
app's bot login (`<slug>[bot]`), which is what GitHub puts into `comment.user.login`.

The patch reaches into a private method, so it is tied to the version it was written and tested for.
Any other version is refused instead of being patched blindly (CR-30 adds the guard test).
"""

import inspect
from collections.abc import Callable
from importlib.metadata import PackageNotFoundError, version
from typing import Any

from code_reviewer_runner.result import ErrorCode

PATCHED_FOR_VERSION = "0.47.0"
_METHOD = "_resolve_user_login"


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
            f"the runner supports pr-agent {PATCHED_FOR_VERSION}, found {actual or 'none'}",
        )


def apply_identity_patch(
    bot_login: str, provider_class: type[Any] | None = None
) -> Callable[[], None]:
    """Make `_resolve_user_login` return `bot_login`. Returns a function that undoes the patch."""
    if provider_class is None:
        from pr_agent.git_providers.github_provider import GithubProvider

        provider_class = GithubProvider
    original = getattr(provider_class, _METHOD, None)
    if not callable(original):
        raise IdentityPatchError(
            ErrorCode.IDENTITY_PATCH_FAILED, f"{provider_class.__name__}.{_METHOD} does not exist"
        )
    if list(inspect.signature(original).parameters) != ["self"]:
        raise IdentityPatchError(
            ErrorCode.IDENTITY_PATCH_FAILED, f"{provider_class.__name__}.{_METHOD} has changed"
        )

    def resolved_login(self: object) -> str:
        return bot_login

    setattr(provider_class, _METHOD, resolved_login)

    def undo() -> None:
        setattr(provider_class, _METHOD, original)

    return undo
