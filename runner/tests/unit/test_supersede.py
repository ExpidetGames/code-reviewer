# SPDX-License-Identifier: LicenseRef-Proprietary

"""A run that a newer push replaced (#396): the signal, and the guard of the writes."""

import os
import signal

import pytest

from code_reviewer_runner.supersede import (
    GUARDED_WRITES,
    SupersedeSignal,
    WriteGuardError,
    handling_the_signal,
    install_write_guard,
)

pytestmark = pytest.mark.unit


class FakeProvider:
    """Every guarded method, recording what it was asked to write."""

    def __init__(self) -> None:
        self.written: list[str] = []


def _provider_class() -> type[FakeProvider]:
    namespace: dict[str, object] = {}

    def make(name: str):
        def write(self: FakeProvider, *args: object, **kwargs: object) -> str:
            self.written.append(name)
            return f"wrote {name}"

        return write

    for name in GUARDED_WRITES:
        namespace[name] = make(name)
    return type("Provider", (FakeProvider,), namespace)


# #396-T07
def test_a_write_passes_until_the_run_is_superseded_and_is_nothing_after() -> None:
    signal_ = SupersedeSignal()
    provider_class = _provider_class()
    guard, undo = install_write_guard(signal_, provider_class)
    provider = provider_class()
    try:
        assert provider.publish_comment("hello") == "wrote publish_comment"  # type: ignore[attr-defined]
        signal_.set()
        for name, default in GUARDED_WRITES.items():
            assert getattr(provider, name)("body") == default
        assert provider.written == ["publish_comment"]
        assert guard.blocked == list(GUARDED_WRITES)
    finally:
        undo()
    # Undone: a new call reaches the provider again.
    signal_.clear()
    assert provider_class().edit_comment("c", "b") == "wrote edit_comment"  # type: ignore[attr-defined]


# #396-T07
def test_a_failure_notice_is_a_write_and_is_blocked() -> None:
    signal_ = SupersedeSignal()
    provider_class = _provider_class()
    _guard, undo = install_write_guard(signal_, provider_class)
    provider = provider_class()
    try:
        signal_.set()
        provider.publish_comment("Failed to review PR: boom")  # type: ignore[attr-defined]
        provider.start_check_run("name", "summary")  # type: ignore[attr-defined]
        provider.publish_labels(["bug"])  # type: ignore[attr-defined]
    finally:
        undo()
    assert provider.written == []


# #396-T07
def test_the_guard_fails_closed_when_the_provider_lacks_a_write() -> None:
    class Partial:
        def publish_comment(self, *args: object) -> None: ...

    with pytest.raises(WriteGuardError, match="publish_persistent_comment"):
        install_write_guard(SupersedeSignal(), Partial)


# #396-T07
def test_the_installed_pr_agent_has_every_guarded_write() -> None:
    from pr_agent.git_providers.github_provider import GithubProvider

    _guard, undo = install_write_guard(SupersedeSignal(), GithubProvider)
    undo()


# #396-T03
def test_sigusr1_sets_the_signal_and_the_previous_handler_comes_back() -> None:
    signal_ = SupersedeSignal()
    before = signal.getsignal(signal.SIGUSR1)

    with handling_the_signal(signal_):
        assert not signal_.is_set()
        os.kill(os.getpid(), signal.SIGUSR1)
        assert signal_.is_set()

    assert signal.getsignal(signal.SIGUSR1) == before
