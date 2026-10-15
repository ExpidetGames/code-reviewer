# SPDX-License-Identifier: Apache-2.0

"""Where the usage of the run in progress can be read when the run does not end normally (#273).

A run that fails after it used the model still cost what it cost. The paths that end a run without
a normal return (a command that raises, the timeout, the watchdog that ends a run that does not
stop) have no `Usage` in their hands, so the run registers where to read it: a Dynamic run
watches its ledger, a Diff run records what PR-Agent measured when its command ends. Only a run
that reached the model reports anything: a run that never did reports `None`, as before.
"""

from collections.abc import Callable

from code_reviewer_runner.result import Usage


class UsageProbe:
    def __init__(self) -> None:
        self._read: Callable[[], Usage | None] | None = None

    def watch(self, read: Callable[[], Usage | None]) -> None:
        """Read the usage from `read` from now on (a ledger that goes on counting)."""
        self._read = read

    def record(self, usage: Usage | None) -> None:
        """Remember the usage of a command that has ended."""
        self._read = lambda: usage

    def usage(self) -> Usage | None:
        """What the run used so far, or None when it never reached the model."""
        if self._read is None:
            return None
        usage = self._read()
        return usage if usage is not None and usage.used_the_model else None
