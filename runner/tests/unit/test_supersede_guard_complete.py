# SPDX-License-Identifier: LicenseRef-Proprietary

"""The write guard covers every way the pinned PR-Agent writes to GitHub (#396).

`GUARDED_WRITES` is a list somebody wrote. This test reads the provider itself: every method that
reaches a GitHub write API is either guarded or a helper whose callers are all guarded. A PR-Agent
upgrade that adds a writer (or moves a write into a method nobody guarded) fails here, instead of
publishing after a push replaced the run.
"""

import inspect
import re
from typing import Any

import pytest

from code_reviewer_runner.supersede import GUARDED_WRITES

pytestmark = pytest.mark.unit

# What a write to GitHub looks like in the provider's source: PyGithub calls that change state, and
# a raw request with a verb that changes state.
_WRITE_CALL = re.compile(
    r"\.(create_review|create_issue_comment|create_comment|create_reaction|delete_reaction"
    r"|add_to_labels|set_labels|create_git_commit|create_git_tree|create_git_ref|create_file"
    r"|update_file|edit|delete|create_review_comment|create_pull|merge)\("
    r"|requestJsonAndCheck\(\s*[\"'](?:POST|PATCH|PUT|DELETE)[\"']"
    r"|graphql_query\(\s*[\"'(]*\s*mutation",
)

# Private helpers that write but are only reachable through a guarded method; the test checks the
# reachability, this list only names them so that a new one is a conscious decision.
_HELPERS_BEHIND_A_GUARD = {
    "_publish_inline_comments_fallback_with_verification",
    "_upsert_check_run",
    "_verify_code_comment",
}


def _provider() -> type[Any]:
    from pr_agent.git_providers.github_provider import GithubProvider

    return GithubProvider


def _methods(provider: type[Any]) -> dict[str, str]:
    return {
        name: inspect.getsource(function)
        for name, function in inspect.getmembers(provider, inspect.isfunction)
        if not name.startswith("__")
    }


def _writers(methods: dict[str, str]) -> set[str]:
    return {name for name, source in methods.items() if _WRITE_CALL.search(source)}


def _callers(methods: dict[str, str], name: str) -> set[str]:
    call = re.compile(rf"self\.{re.escape(name)}\(")
    return {caller for caller, source in methods.items() if call.search(source)}


def _guarded_from_every_entry(methods: dict[str, str], name: str, seen: frozenset[str]) -> bool:
    """True when every chain of callers that reaches `name` passes through a guarded method."""
    if name in GUARDED_WRITES:
        return True
    if name in seen:
        return True  # a cycle adds no new entry point
    callers = _callers(methods, name)
    if not callers:
        return False
    return all(_guarded_from_every_entry(methods, caller, seen | {name}) for caller in callers)


# #396-T07
def test_every_method_that_writes_to_github_is_guarded_or_only_reached_through_a_guarded_one() -> (
    None
):
    methods = _methods(_provider())
    writers = _writers(methods)

    # The detector sees the writers the guard lists (it would be blind otherwise).
    assert writers & set(GUARDED_WRITES), "the detector found no guarded writer"

    unguarded = sorted(
        name for name in writers if not _guarded_from_every_entry(methods, name, frozenset())
    )
    assert unguarded == [], (
        f"these methods write to GitHub and can be reached without a guard: {unguarded}"
    )


# #396-T07
def test_the_helpers_that_write_behind_a_guard_are_named_here() -> None:
    methods = _methods(_provider())
    writers = _writers(methods)
    helpers = {name for name in writers if name not in GUARDED_WRITES}
    assert helpers <= _HELPERS_BEHIND_A_GUARD, sorted(helpers - _HELPERS_BEHIND_A_GUARD)


# #396-T07
def test_the_guarded_names_all_exist_on_the_pinned_provider() -> None:
    methods = _methods(_provider())
    assert [name for name in GUARDED_WRITES if name not in methods] == []
