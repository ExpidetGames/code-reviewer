# SPDX-License-Identifier: LicenseRef-Proprietary

"""The engine's side of one connection, as the relay sees it (#550).

The relay writes the answer through a sink, so the policy can be tested without a socket and the
loopback server (`server.py`) is a thin shell around it.
"""

from collections.abc import Sequence
from typing import Protocol


class ClientGone(Exception):
    """The engine closed its side. The call to the provider is cancelled."""


class ResponseSink(Protocol):
    def start(self, status: int, headers: Sequence[tuple[str, str]], length: int | None) -> None:
        """Begin the answer. `length` None: the body follows chunk by chunk, of unknown length."""
        ...

    def write(self, data: bytes) -> None:
        """Hand on bytes of the body. Raises `ClientGone`."""
        ...

    def end(self) -> None:
        """The answer is complete."""
        ...

    def abort(self) -> None:
        """Drop the connection without completing the answer, so the engine sees a cut stream and
        not a short, complete one."""
        ...
