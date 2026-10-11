"""Pins down what the identity patch relies on in the installed, real PR-Agent: the chain from the
review tool to `_resolve_user_login` that decides whether a comment is PR-Agent's own. The tests
read PR-Agent's source (no network). When a PR-Agent upgrade changes one of these places, a test
here fails: read the changed code, decide whether the patch still gives the right identity, and
only then update the fingerprints and `PATCHED_FOR_VERSION` together with the pin."""

import ast
import inspect
import sys
from typing import Any

import pytest
from pr_agent.agent import pr_agent as pr_agent_module
from pr_agent.algo import comment_identity, review_finding_state
from pr_agent.algo.comment_identity import PRReviewIdentity
from pr_agent.git_providers.git_provider import GitProvider
from pr_agent.git_providers.github_provider import GithubProvider
from pr_agent.tools.pr_reviewer import PRReviewer

from code_reviewer_runner.identity_funnel import (
    FUNNEL,
    FunnelError,
    fingerprint,
    function_tree,
    self_calls,
    verify_identity_funnel,
)
from code_reviewer_runner.identity_patch import (
    PATCHED_FOR_VERSION,
    IdentityPatchError,
    apply_identity_patch,
)
from code_reviewer_runner.result import ErrorCode

# The fingerprints are hashes of the syntax tree, which differs between Python minor versions.
FINGERPRINT_PYTHON = (3, 13)

# Fingerprints of the code the patch relies on, taken from PR-Agent PATCHED_FOR_VERSION (a hash of
# the syntax tree, so comments, formatting and docstrings do not change it). The first group is the
# login chain; the second decides which deployment type, which comments and which review branch
# PR-Agent uses, where a change would bypass the patch or post duplicates.
FINGERPRINTS_FOR_0_47_0 = {
    "GithubProvider._resolve_user_login": "55901c51d57450e3",
    "GithubProvider._agent_login": "9e1cca1165e9fced",
    "GithubProvider.is_comment_authored_by_pr_agent": "ae0e1e11fab2156d",
    "GithubProvider.supports_review_finding_state": "72a280fa559c9136",
    "GitProvider._iter_persistent_comments": "83b8ed0cbf692ecb",
    "GithubProvider._deployment_type": "7c9296ae5c0b70a7",
    "comment_identity.comment_matches_identity": "a1d3ee0b4b63cbc9",
    "comment_identity.comment_carries_other_identity": "68fb6f4e578d134d",
    "comment_identity.hidden_marker_forms": "84a40a8e0b1093a6",
    "PRReviewer._review_comment_authorship_available": "b30659553deca3a0",
    "PRReviewer._review_finding_state_in_play": "ee6991ca5ecc7abf",
    # Not part of the identity chain: the function the review state watch wraps to notice that the
    # review comment was shortened to fit GitHub's limit (review_state_watch.py).
    "review_finding_state.append_review_state": "c1c9200939f260f2",
}

HOW_TO_FIX = (
    "PR-Agent code that the identity patch or the review state watch relies on has changed. Read "
    "the diff of the release, check that the patched _resolve_user_login still decides which "
    "comment is PR-Agent's own and that append_review_state still shortens a review only when "
    "the comment limit forces it (review_state_watch.py), then update FINGERPRINTS_FOR_0_47_0 and "
    "PATCHED_FOR_VERSION together with the pin in pyproject.toml."
)


def _target(name: str) -> Any:  # Any: PR-Agent ships no type information
    owners: dict[str, Any] = {
        "GithubProvider": GithubProvider,
        "GitProvider": GitProvider,
        "PRReviewer": PRReviewer,
        "comment_identity": comment_identity,
        "review_finding_state": review_finding_state,
    }
    owner, method = name.split(".")
    return getattr(owners[owner], method)


def test_the_fingerprints_in_this_file_belong_to_the_version_the_patch_was_written_for() -> None:
    assert PATCHED_FOR_VERSION == "0.47.0"


# CR-30-T01
def test_the_login_method_and_its_callers_exist_on_the_real_github_provider() -> None:
    for method, callee in FUNNEL:
        assert callable(getattr(GithubProvider, method, None)), method
        assert callee in self_calls(getattr(GithubProvider, method)), (method, callee)
    assert callable(getattr(GithubProvider, "supports_review_finding_state", None))


# CR-30-T02
def test_the_login_method_takes_no_argument_besides_self_and_returns_a_string() -> None:
    signature = inspect.signature(GithubProvider._resolve_user_login)  # pyright: ignore[reportPrivateUsage]

    assert list(signature.parameters) == ["self"]
    assert signature.return_annotation is str


def test_the_authorship_check_compares_the_comment_author_with_the_agent_login() -> None:
    source = inspect.getsource(_target("GithubProvider.is_comment_authored_by_pr_agent"))

    assert "casefold()" in source
    assert "self._agent_login()" in source


# CR-30-T04
@pytest.mark.parametrize("name", sorted(FINGERPRINTS_FOR_0_47_0))
def test_the_code_the_patch_relies_on_is_unchanged_since_the_patch_was_written(name: str) -> None:
    assert sys.version_info[:2] == FINGERPRINT_PYTHON, (
        "the fingerprints were recorded on Python "
        f"{FINGERPRINT_PYTHON[0]}.{FINGERPRINT_PYTHON[1]}; this interpreter is "
        f"{sys.version_info[0]}.{sys.version_info[1]}. Run the tests on the recorded version, "
        "or re-record the fingerprints on the new one."
    )

    assert fingerprint(_target(name)) == FINGERPRINTS_FOR_0_47_0[name], f"{name}: {HOW_TO_FIX}"


def test_the_persistent_comment_lookup_still_asks_for_authorship() -> None:
    lookup = _target("GitProvider._iter_persistent_comments")

    assert "is_comment_authored_by_pr_agent" in self_calls(lookup)
    assert "require_agent_authorship" in inspect.signature(lookup).parameters


def _authorship_requests(function: Any) -> int:
    """How often a function asks for authorship: a keyword argument or a key of a dict."""
    return sum(
        1
        for node in ast.walk(function_tree(function))
        if (isinstance(node, ast.keyword) and node.arg == "require_agent_authorship")
        or (isinstance(node, ast.Constant) and node.value == "require_agent_authorship")
    )


def test_the_review_tool_still_asks_for_authorship_where_it_reads_and_writes_its_comment() -> None:
    requests = {
        "PRReviewer.run": _authorship_requests(PRReviewer.run),
        "PRReviewer._load_review_finding_state": _authorship_requests(
            PRReviewer._load_review_finding_state  # pyright: ignore[reportPrivateUsage]
        ),
    }

    assert requests == {"PRReviewer.run": 3, "PRReviewer._load_review_finding_state": 1}, (
        f"{requests}: {HOW_TO_FIX}"
    )


def test_the_incomplete_files_notice_still_asks_the_provider_whether_a_comment_is_its_own() -> None:
    notice = pr_agent_module._publish_incomplete_files_comment  # pyright: ignore[reportPrivateUsage]

    assert "is_comment_authored_by_pr_agent" in {
        node.attr for node in ast.walk(function_tree(notice)) if isinstance(node, ast.Attribute)
    }, HOW_TO_FIX


def test_the_real_github_provider_passes_the_runtime_check_of_the_chain() -> None:
    verify_identity_funnel(GithubProvider)


# CR-30-T03
def test_a_provider_whose_caller_was_renamed_fails_the_chain_check_with_a_stable_code() -> None:
    class Renamed:
        def _resolve_user_login(self) -> str:
            return ""

        def _login_of_agent(self) -> str:
            return self._resolve_user_login()

        def is_comment_authored_by_pr_agent(self, comment: object) -> bool:
            return self._agent_login() != ""  # pyright: ignore

        def supports_review_finding_state(self) -> bool:
            return True

    with pytest.raises(FunnelError) as caught:
        verify_identity_funnel(Renamed)

    assert caught.value.code is ErrorCode.IDENTITY_PATCH_FAILED
    assert "Renamed._agent_login" in caught.value.detail


def test_a_provider_that_answers_without_the_login_method_fails_the_chain_check() -> None:
    class Bypassed:
        def _agent_login(self) -> str:
            return "hard-coded"

        def is_comment_authored_by_pr_agent(self, comment: object) -> bool:
            return self._agent_login() != ""

        def supports_review_finding_state(self) -> bool:
            return True

    with pytest.raises(FunnelError) as caught:
        verify_identity_funnel(Bypassed)

    assert "self._resolve_user_login()" in caught.value.detail


def test_a_provider_without_the_finding_state_capability_fails_the_chain_check() -> None:
    class NoCapability:
        def _agent_login(self) -> str:
            return self._resolve_user_login()

        def _resolve_user_login(self) -> str:
            return ""

        def is_comment_authored_by_pr_agent(self, comment: object) -> bool:
            return self._agent_login() != ""

    with pytest.raises(FunnelError) as caught:
        verify_identity_funnel(NoCapability)

    assert "supports_review_finding_state" in caught.value.detail


def test_a_fingerprint_ignores_comments_and_docstrings_but_not_behaviour() -> None:
    def base(self: Any) -> str:
        """Docstring."""
        # a comment
        return self.name

    def reworded(self: Any) -> str:
        """Another docstring."""
        return self.name

    def changed(self: Any) -> str:
        return self.other

    assert fingerprint(base) == fingerprint(reworded)
    assert fingerprint(base) != fingerprint(changed)


# CR-30-T03
def test_a_method_whose_source_cannot_be_parsed_fails_the_chain_check_not_the_runner() -> None:
    # A multi-line string whose continuation starts at column 0 makes textwrap.dedent leave an
    # indented first line behind, which ast.parse refuses with an IndentationError.
    namespace: dict[str, Any] = {}
    exec(
        "class Odd:\n"
        "    def _agent_login(self):\n"
        "        return self._resolve_user_login('a\\\nb')\n",
        namespace,
    )

    with pytest.raises(FunnelError) as caught:
        verify_identity_funnel(namespace["Odd"])

    assert caught.value.code is ErrorCode.IDENTITY_PATCH_FAILED


@pytest.mark.parametrize("builtin", [len, "text".upper])
def test_a_method_without_readable_python_source_fails_the_chain_check(builtin: Any) -> None:
    with pytest.raises(FunnelError) as caught:
        self_calls(builtin)

    assert caught.value.code is ErrorCode.IDENTITY_PATCH_FAILED
    assert "cannot be read" in caught.value.detail


def test_the_patch_turns_an_unreadable_source_into_a_refusal_with_the_patch_code() -> None:
    class Opaque:
        def _resolve_user_login(self) -> str:
            return ""

        _agent_login = len
        is_comment_authored_by_pr_agent = len
        supports_review_finding_state = len

    with pytest.raises(IdentityPatchError) as caught:
        apply_identity_patch("code-reviewer[bot]", provider_class=Opaque)

    assert caught.value.code is ErrorCode.IDENTITY_PATCH_FAILED


# CR-30-T02
def test_with_the_patch_only_the_comment_of_the_app_is_found_as_the_agents_own_review() -> None:
    """The whole chain on the real provider, through the helpers no fingerprint watches: the
    persistent-comment lookup, the identity markers and the deployment type. Without the patch a
    bare provider cannot tell whose comment is whose."""

    def comment(author: str, body: str) -> Any:
        user = type("User", (), {"login": author})()
        return type("Comment", (), {"user": user, "body": body})()

    review = f"{PRReviewIdentity.REGULAR.value}\n\n## PR Reviewer Guide\n\nfindings"
    ours = comment("code-reviewer[bot]", review)
    foreign = comment("somebody-else", review)
    provider: Any = object.__new__(GithubProvider)
    provider.deployment_type = "user"
    provider.get_issue_comments_newest_first = lambda: [foreign, ours]  # type: ignore[method-assign]

    undo = apply_identity_patch("code-reviewer[bot]")
    try:
        lookup = _target("GitProvider._iter_persistent_comments")
        found: list[Any] = [
            found_comment
            for found_comment, _ in lookup(
                provider,
                [PRReviewIdentity.REGULAR.value],
                identity_marker=PRReviewIdentity.REGULAR.value,
                require_agent_authorship=True,
            )
        ]
        supported = provider.supports_review_finding_state()
    finally:
        undo()

    assert found == [ours]
    assert supported is True
