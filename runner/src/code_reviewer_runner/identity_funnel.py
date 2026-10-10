"""Reads PR-Agent's own source to prove the places the identity patch relies on.

PR-Agent decides whether a comment is its own in a chain of three methods: the review tool asks
`is_comment_authored_by_pr_agent`, which asks `_agent_login`, which asks `_resolve_user_login`, the
one method the patch replaces. If an upgrade moves a step of that chain, the patch would still
apply and PR-Agent would silently fall back to `GET /user`, which an installation token cannot call:
the next review would post a duplicate or fail instead of editing its comment. Reading the source
turns that into a loud failure.
"""

import ast
import hashlib
import inspect
import textwrap
from collections.abc import Callable
from typing import Any

from code_reviewer_runner.result import ErrorCode

# Each step: a method and the `self.<name>()` it has to call.
FUNNEL: tuple[tuple[str, str], ...] = (
    ("is_comment_authored_by_pr_agent", "_agent_login"),
    ("_agent_login", "_resolve_user_login"),
)
# The review tool needs this to be answerable without a network call in user mode.
CAPABILITY_METHOD = "supports_review_finding_state"


class FunnelError(Exception):
    """The identity chain of PR-Agent is not the one the patch was written for."""

    def __init__(self, detail: str) -> None:
        super().__init__(f"{ErrorCode.IDENTITY_PATCH_FAILED.value}: {detail}")
        self.code = ErrorCode.IDENTITY_PATCH_FAILED
        self.detail = detail


def function_tree(function: Callable[..., Any]) -> ast.FunctionDef:
    """The parsed definition of a function, read from the installed source."""
    source = textwrap.dedent(inspect.getsource(function))
    module = ast.parse(source)
    definition = module.body[0]
    if not isinstance(definition, ast.FunctionDef):
        raise FunnelError(f"{function.__qualname__} is not a plain function definition")
    return definition


def self_calls(function: Callable[..., Any]) -> set[str]:
    """Names of the methods the function calls on its own instance (`self.name(...)`)."""
    names: set[str] = set()
    for node in ast.walk(function_tree(function)):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "self"
        ):
            names.add(node.func.attr)
    return names


def fingerprint(function: Callable[..., Any]) -> str:
    """A hash of what a function does: comments, formatting and its docstring do not count."""
    tree = function_tree(function)
    tree.name = "function"
    first = tree.body[0] if tree.body else None
    if (
        isinstance(first, ast.Expr)
        and isinstance(first.value, ast.Constant)
        and isinstance(first.value.value, str)
    ):
        tree.body = tree.body[1:] or [ast.Pass()]
    return hashlib.sha256(ast.dump(tree).encode()).hexdigest()[:16]


def verify_identity_funnel(provider_class: type[Any]) -> None:
    """Raise a `FunnelError` naming the step that no longer holds."""
    for method, callee in FUNNEL:
        function = getattr(provider_class, method, None)
        if not callable(function):
            raise FunnelError(f"{provider_class.__name__}.{method} does not exist")
        if callee not in self_calls(function):
            raise FunnelError(f"{provider_class.__name__}.{method} no longer calls self.{callee}()")
    if not callable(getattr(provider_class, CAPABILITY_METHOD, None)):
        raise FunnelError(f"{provider_class.__name__}.{CAPABILITY_METHOD} does not exist")
