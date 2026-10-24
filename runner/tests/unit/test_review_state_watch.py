# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down the review state watch: PR-Agent shortens the review comment when the review and the
hidden record of earlier findings together exceed what GitHub accepts, and it says so only in a log
line (or not at all). The watch wraps the one function that does the shortening and records whether
the record did not fit or the visible review was cut, so the runner can report the loss instead of
a success."""

import importlib
import inspect
from collections.abc import Iterator
from typing import Any

import pytest
from pr_agent.algo import review_finding_state

from code_reviewer_runner.review_state_watch import (
    ReviewStateWatch,
    WatchError,
    install_review_state_watch,
)

LIMIT = 4000
# Any: PR-Agent ships no type information, and the tests replace attributes of the module.
pr_reviewer: Any = importlib.import_module("pr_agent.tools.pr_reviewer")


def finding(index: int, size: int) -> dict[str, Any]:
    return {
        "finding_id": f"id-{index}",
        "state": "ACTIVE",
        "path": "greeting.py",
        "body": f"finding {index} " + "x" * size,
    }


def state_of(findings: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "findings": findings,
        "last_run": {"complete": True, "excluded_files": [], "head_sha": "a", "run_id": ""},
    }


@pytest.fixture
def watch() -> Iterator[ReviewStateWatch]:
    watch, undo = install_review_state_watch()
    try:
        yield watch
    finally:
        undo()


# CR-49-T03
def test_a_review_and_state_that_fit_the_limit_are_not_reported(watch: ReviewStateWatch) -> None:
    result = pr_reviewer.append_review_state("short review", state_of([finding(1, 100)]), LIMIT)

    assert "short review" in result
    assert watch.state_did_not_fit is False
    assert watch.text_cut is False


# CR-49-T01
def test_a_state_that_does_not_fit_the_limit_is_reported_and_the_error_still_reaches_pr_agent(
    watch: ReviewStateWatch,
) -> None:
    state = state_of([finding(i, 500) for i in range(20)])

    with pytest.raises(ValueError):
        pr_reviewer.append_review_state("review", state, LIMIT)

    assert watch.state_did_not_fit is True
    assert watch.text_cut is False


# CR-49-T02
def test_a_visible_review_that_was_cut_to_make_room_for_the_state_is_reported(
    watch: ReviewStateWatch,
) -> None:
    state = state_of([finding(i, 100) for i in range(10)])

    result = pr_reviewer.append_review_state("review text " * 200, state, LIMIT)

    assert len(result) <= LIMIT
    assert watch.text_cut is True
    assert watch.state_did_not_fit is False


def test_a_call_without_a_limit_is_never_reported(watch: ReviewStateWatch) -> None:
    result = pr_reviewer.append_review_state("review " * 5000, state_of([finding(1, 10)]))

    assert len(result) > LIMIT
    assert watch.text_cut is False
    assert watch.state_did_not_fit is False


def test_an_invalid_state_is_not_mistaken_for_a_state_that_is_too_large(
    watch: ReviewStateWatch,
) -> None:
    with pytest.raises(ValueError):
        pr_reviewer.append_review_state("review", {"schema_version": 7}, LIMIT)

    assert watch.state_did_not_fit is False


def test_the_result_of_the_wrapped_function_is_unchanged(watch: ReviewStateWatch) -> None:
    state = state_of([finding(1, 100)])

    wrapped = pr_reviewer.append_review_state("review", state, LIMIT)

    assert wrapped == review_finding_state.append_review_state("review", state, LIMIT)


def test_the_original_function_is_back_after_the_job() -> None:
    before = pr_reviewer.append_review_state

    _, undo = install_review_state_watch()
    assert pr_reviewer.append_review_state is not before
    undo()

    assert pr_reviewer.append_review_state is before


def test_a_module_without_the_function_is_refused() -> None:
    class Empty:
        pass

    with pytest.raises(WatchError):
        install_review_state_watch(Empty())


def test_a_function_with_another_signature_is_refused() -> None:
    class Moved:
        @staticmethod
        def append_review_state(body: str) -> str:
            return body

    with pytest.raises(WatchError):
        install_review_state_watch(Moved())


# The watch relies on how PR-Agent 0.47.0 uses the function. An upgrade that changes it fails here
# instead of silently turning the watch blind.
def test_pr_agent_still_calls_the_function_from_the_review_tool_with_a_limit() -> None:
    source = inspect.getsource(pr_reviewer.PRReviewer._prepare_pr_review)  # pyright: ignore[reportPrivateUsage]

    assert "append_review_state(" in source
    assert "max_chars=self._review_comment_max_chars()" in source
    assert list(inspect.signature(review_finding_state.append_review_state).parameters) == [
        "review_body",
        "state",
        "max_chars",
    ]


def test_an_unexpected_error_in_the_extra_pass_is_logged_with_its_class_only() -> None:
    from loguru import logger

    class Module:
        @staticmethod
        def append_review_state(review_body: str, state: Any, max_chars: int | None = None) -> str:
            if max_chars is None:
                raise RuntimeError("secret detail that must not be logged")
            return review_body

    lines: list[str] = []
    sink = logger.add(lambda message: lines.append(str(message)), level="WARNING")
    module = Module()
    try:
        _, undo = install_review_state_watch(module)
        module.append_review_state("review", {}, 100)
        undo()
    finally:
        logger.remove(sink)

    assert len(lines) == 1
    assert "RuntimeError" in lines[0]
    assert "secret detail" not in lines[0]


def test_an_invalid_state_in_the_extra_pass_is_not_worth_a_warning() -> None:
    from loguru import logger

    lines: list[str] = []
    sink = logger.add(lambda message: lines.append(str(message)), level="WARNING")
    try:
        _, undo = install_review_state_watch()
        with pytest.raises(ValueError):
            pr_reviewer.append_review_state("review", {"schema_version": 7}, LIMIT)
        undo()
    finally:
        logger.remove(sink)

    assert lines == []
