# SPDX-License-Identifier: LicenseRef-Proprietary

"""Loopback ports for the engines the engine tests start themselves (#713). Not a test file.

`opencode serve` takes its port on the command line, so a test has to choose one first. Choosing
by binding port 0 and closing again hands the number to whoever asks next, and under pytest-xdist
four workers start engines at the same time. Two defences:

- every xdist worker draws from a band of its own, below the range the kernel hands out for port 0
  (the fakes bind port 0), so two workers never choose the same number;
- an engine that exits before it answers (its port was taken after all) is started again on another
  port, up to `START_ATTEMPTS` times, as the runner's own adapter does.
"""

import os
import random
import socket
from collections.abc import Callable

START_ATTEMPTS = 3
BAND_START = 20000
BAND_SIZE = 1000
_DRAWS = 100


class EngineExitedEarly(AssertionError):
    """The engine process ended before it was healthy: the port it was given may have been taken."""


def _worker_index() -> int:
    worker = os.environ.get("PYTEST_XDIST_WORKER", "")
    return int(worker[2:]) % 20 if worker.startswith("gw") and worker[2:].isdigit() else 0


def free_port() -> int:
    """A loopback port nobody listens on, from the band of this xdist worker."""
    start = BAND_START + _worker_index() * BAND_SIZE
    for _ in range(_DRAWS):
        port = start + random.randrange(BAND_SIZE)
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
        return port
    with socket.socket() as probe:  # the band is full: let the kernel choose
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def start_on_free_port[Started](
    start: Callable[[int], Started],
    wait_healthy: Callable[[Started, int], None],
    stop: Callable[[Started], None],
) -> tuple[int, Started]:
    """Start an engine on a free port; on a new port again if it exits before it answers.

    `wait_healthy` raises `EngineExitedEarly` for an engine that ended; any other error is final.
    A failed engine is stopped with `stop` before the next attempt or before the error leaves.
    """
    for attempt in range(START_ATTEMPTS):
        port = free_port()
        started = start(port)
        try:
            wait_healthy(started, port)
        except EngineExitedEarly:
            stop(started)
            if attempt + 1 == START_ATTEMPTS:
                raise
        except BaseException:
            stop(started)
            raise
        else:
            return port, started
    raise EngineExitedEarly  # unreachable: the last attempt raises
