# SPDX-License-Identifier: Apache-2.0

"""Pins down how a Diff job asks OpenRouter for `provider.require_parameters` (#270).

PR-Agent 0.47.0 has no setting for it (`litellm.extra_body` takes three other keys, and the only
`provider` settings are provider selectors the product must not use), so the runner wraps the one
place that builds OpenRouter's request controls. The wrapper is tied to the PR-Agent version it was
written for, like the identity patch."""

import inspect
from collections.abc import Iterator
from dataclasses import replace
from importlib import import_module
from typing import Any

import pytest
from support import fake_provider

from code_reviewer_runner.error_mapping import classify_failure
from code_reviewer_runner.llm_providers import OPENROUTER
from code_reviewer_runner.require_parameters_patch import (
    RequireParametersPatchError,
    apply_require_parameters_patch,
)
from code_reviewer_runner.result import ErrorCode

# PR-Agent ships no type information: the class is `Any` on purpose.
LiteLLMAIHandler: Any = import_module(
    "pr_agent.algo.ai_handlers.litellm_ai_handler"
).LiteLLMAIHandler


class NoControls:
    """A handler class from a PR-Agent version that no longer builds OpenRouter controls."""


class WrongSignature:
    def _apply_openrouter_request_controls(self, only: str) -> str:
        return only


@pytest.fixture
def handler() -> Any:  # Any: PR-Agent's handler is untyped
    # No __init__: constructing a handler reads the settings of a request. The controls are all the
    # method reads, so the test shows what it returns for a handler without any setting.
    instance = object.__new__(LiteLLMAIHandler)
    instance._openrouter_controls = {}  # pyright: ignore[reportPrivateUsage]
    return instance


@pytest.fixture
def patched() -> Iterator[None]:
    undo = apply_require_parameters_patch(provider=OPENROUTER)
    try:
        yield
    finally:
        undo()


def controls(handler: Any, kwargs: dict[str, Any] | None = None) -> dict[str, Any]:
    result: dict[str, Any] = handler._apply_openrouter_request_controls(
        "openrouter/vendor/model", kwargs if kwargs is not None else {"model": "m"}, None
    )
    return result


# #270-T03, #424-T05
@pytest.mark.usefixtures("patched")
def test_the_request_controls_of_a_diff_job_carry_required_parameters(handler: Any) -> None:
    assert controls(handler)["extra_body"] == {"provider": {"require_parameters": True}}


# #270-T03
@pytest.mark.usefixtures("patched")
def test_required_parameters_join_the_other_extra_body_fields_without_replacing_them(
    handler: Any,
) -> None:
    kwargs = {"model": "m", "extra_body": {"user": "someone", "provider": {"sort": "latency"}}}

    body = controls(handler, kwargs)["extra_body"]

    assert body == {"user": "someone", "provider": {"sort": "latency", "require_parameters": True}}


# #270-T04
def test_without_the_patch_the_request_controls_stay_as_pr_agent_builds_them(
    handler: Any,
) -> None:
    assert "extra_body" not in controls(handler)


# #270-T03
def test_undoing_the_patch_restores_the_original_method(handler: Any) -> None:
    undo = apply_require_parameters_patch(provider=OPENROUTER)
    undo()

    assert "extra_body" not in controls(handler)


# #270-T03
def test_applying_the_patch_twice_does_not_wrap_it_twice(handler: Any) -> None:
    first = apply_require_parameters_patch(provider=OPENROUTER)
    second = apply_require_parameters_patch(provider=OPENROUTER)
    try:
        assert controls(handler)["extra_body"] == {"provider": {"require_parameters": True}}
    finally:
        second()
        first()
    assert "extra_body" not in controls(handler)


# #270-T03
def test_a_pr_agent_that_does_not_fit_the_patch_is_refused_and_nothing_is_changed() -> None:
    for handler_class in (NoControls, WrongSignature):
        before = dict(vars(handler_class))
        with pytest.raises(RequireParametersPatchError):
            apply_require_parameters_patch(handler_class, provider=OPENROUTER)
        assert dict(vars(handler_class)) == before


# #270-T03
def test_the_method_the_patch_wraps_still_has_the_shape_it_was_written_for() -> None:
    method = LiteLLMAIHandler._apply_openrouter_request_controls

    assert list(inspect.signature(method).parameters) == [
        "self",
        "model",
        "kwargs",
        "inherited_reasoning_effort",
    ]


# #270-T06
def test_openrouter_finding_no_provider_for_the_parameters_is_the_existing_provider_error() -> None:
    # What the openai/litellm exceptions carry: a class from their module and a `status_code`.
    not_found = type("NotFoundError", (Exception,), {"__module__": "litellm"})
    error = not_found(
        "OpenrouterException - No endpoints found that can handle the requested parameters."
    )
    error.status_code = 404  # type: ignore[attr-defined]

    assert classify_failure([error], []) is ErrorCode.MODEL_UNKNOWN


class FakeHandler:
    """A handler of a provider with its own request controls method and body field."""

    def apply_fakeai_request_controls(
        self, model: str, kwargs: dict[str, Any], inherited_reasoning_effort: Any
    ) -> dict[str, Any]:
        return {**kwargs, "extra_body": {"routing": {"order": ["a"]}}}


# #424-T05
def test_the_patch_follows_the_mechanism_of_the_provider_it_is_given() -> None:
    handler = object.__new__(FakeHandler)
    undo = apply_require_parameters_patch(FakeHandler, provider=fake_provider())
    try:
        body = handler.apply_fakeai_request_controls("fakeai/m", {"model": "m"}, None)["extra_body"]
    finally:
        undo()

    assert body == {"routing": {"order": ["a"], "strict": True}}
    assert (
        "strict"
        not in handler.apply_fakeai_request_controls("fakeai/m", {}, None)["extra_body"]["routing"]
    )


# #424-T05
def test_a_provider_without_the_mechanism_cannot_be_patched() -> None:
    without = replace(fake_provider(), require_parameters=None)

    with pytest.raises(RequireParametersPatchError):
        apply_require_parameters_patch(FakeHandler, provider=without)
