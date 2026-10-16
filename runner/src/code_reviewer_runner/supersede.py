# SPDX-License-Identifier: Apache-2.0

"""A run that a newer push replaced (#396): what the job process does when it is told.

The app answers a heartbeat with `job.superseded: true`; the job host (`job_loop/host.py`) then
sends the
job process `SIGUSR1`, once. From that moment the process

- lets every model request that is **in flight finish**, so its cost is measured (the Diff meter and
  the
  Dynamic ledger count it as they always do),
- **refuses every further model request** (`SupersededError` in the Diff meter, a refusal of the
  Dynamic
  model proxy),
- **publishes nothing** to the pull request (`install_write_guard`: every write of the GitHub
  provider is a
  no-op, the Dynamic path checks before it writes), and
- ends with the stable code `superseded` and the usage it measured.

The signal is process wide, like the process: one run per process. Tests build their own
`SupersedeSignal`.
"""

import signal
import threading
from collections.abc import Callable, Generator
from contextlib import contextmanager
from typing import Any

SUPERSEDE_SIGNAL = signal.SIGUSR1


class SupersededError(Exception):
    """A model request was refused because the run was superseded. Nothing was sent."""


class SupersedeSignal:
    """True once the run was told that it was superseded. Safe to set from a signal handler."""

    def __init__(self) -> None:
        self._event = threading.Event()

    def set(self) -> None:
        self._event.set()

    def is_set(self) -> bool:
        return self._event.is_set()

    def clear(self) -> None:
        self._event.clear()


# The one of this process. The job process is one run, so a module level value is the run's.
PROCESS_SIGNAL = SupersedeSignal()


@contextmanager
def handling_the_signal(target: SupersedeSignal = PROCESS_SIGNAL) -> Generator[None]:
    """Turns `SIGUSR1` into `target.set()` for the duration. Not the main thread: nothing to
    install."""

    def on_signal(signum: int, frame: object) -> None:
        target.set()

    try:
        previous = signal.signal(SUPERSEDE_SIGNAL, on_signal)
    except ValueError:
        yield
        return
    try:
        yield
    finally:
        signal.signal(SUPERSEDE_SIGNAL, previous)


class WriteGuardError(Exception):
    """The provider does not have a write method the guard was written for."""


# Every method of PR-Agent's GitHub provider that changes something on GitHub, and what a guarded
# call
# returns instead (None unless the caller reads a truth value). A method that is missing is an
# error:
# the guard fails closed, like the other patches, and the PR-Agent version is pinned.
GUARDED_WRITES: dict[str, Any] = {
    "publish_description": None,
    "publish_persistent_comment": None,
    "publish_comment": None,
    "publish_inline_comment": None,
    "publish_inline_comments": None,
    "publish_labels": None,
    "edit_comment": None,
    "reply_to_comment_from_comment_id": None,
    "remove_initial_comment": None,
    "remove_comment": None,
    "resolve_comment_thread": False,
    "add_reaction": None,
    "remove_reaction": False,
    "create_or_update_pr_file": None,
    "start_check_run": False,
    "finish_check_run": False,
    "auto_approve": False,
}


class WriteGuard:
    """Lets writes through until the run is superseded, then turns every one into a no-op."""

    def __init__(self) -> None:
        self.blocked: list[str] = []


def install_write_guard(
    signal_: SupersedeSignal = PROCESS_SIGNAL, provider_class: type[Any] | None = None
) -> tuple[WriteGuard, Callable[[], None]]:
    """Wraps the write methods of the GitHub provider. Returns the guard and a function that undoes
    it.

    Install it last (outermost), so a blocked write is not seen by the comment recorder either.
    """
    if provider_class is None:
        from pr_agent.git_providers.github_provider import GithubProvider

        provider_class = GithubProvider
    missing = [name for name in GUARDED_WRITES if not callable(getattr(provider_class, name, None))]
    if missing:
        raise WriteGuardError(f"the provider has no {', '.join(missing)}")
    guard = WriteGuard()
    originals = {name: getattr(provider_class, name) for name in GUARDED_WRITES}

    def guarded(name: str, original: Callable[..., Any]) -> Callable[..., Any]:
        def call(self: Any, *args: Any, **kwargs: Any) -> Any:
            if signal_.is_set():
                guard.blocked.append(name)
                return GUARDED_WRITES[name]
            return original(self, *args, **kwargs)

        call.__name__ = name
        call.__doc__ = original.__doc__
        return call

    for name, original in originals.items():
        setattr(provider_class, name, guarded(name, original))

    def undo() -> None:
        for name, original in originals.items():
            setattr(provider_class, name, original)

    return guard, undo
