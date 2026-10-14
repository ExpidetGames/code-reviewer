# SPDX-License-Identifier: Apache-2.0

"""Pins down how long the engine's turn may take, and how a failed turn is told apart (#293).

A production run of this repository's own pull request died after about 339 s with
`dynamic_engine_unavailable: the engine is not reachable`. The message call is one blocking POST
that only returns when the whole agentic turn is done, and its socket timeout was capped at 300 s,
so a normal review turn outlived it. With the token and call caps gone the cost limit and the
wall clock are the bounds of a turn, and the wrap-up of the ledger acts inside it, so the socket
must never be what ends it. The ledger deadline, watched by the run, stays the real bound.

The clock is moved by hand and the transport is scripted, so nothing here waits.
"""

from collections.abc import Callable, Mapping
from pathlib import Path

import pytest
import test_dynamic_review_deadline_order as order
from test_dynamic_review_deadline_order import Clock, engine_with

from code_reviewer_runner.dynamic_review.adapter import (
    TURN_TIMEOUT_MARGIN_SECONDS,
    EngineClient,
    EngineError,
    EngineTimeout,
    _http_request,  # pyright: ignore[reportPrivateUsage]
)
from code_reviewer_runner.dynamic_review.budget import LimitError
from code_reviewer_runner.result import ErrorCode

Transport = Callable[..., tuple[int, bytes]]


def recording_transport(clock: Clock, *, takes: float = 0.0) -> tuple[Transport, list[float]]:
    """A message call that answers after `takes` seconds on the clock; records its timeout."""
    timeouts: list[float] = []

    def transport(
        method: str, url: str, body: bytes | None, headers: Mapping[str, str], timeout: float
    ) -> tuple[int, bytes]:
        timeouts.append(timeout)
        clock.now += takes
        return 200, b"{}"

    return transport, timeouts


# #293-T14
def test_the_message_call_may_take_as_long_as_the_job_has_left_not_300_seconds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(order, "DEADLINE", 600.0)
    clock = Clock()
    transport, timeouts = recording_transport(clock)
    engine, client = engine_with(tmp_path, clock, transport)

    engine._send(client, "session")  # pyright: ignore[reportPrivateUsage]

    assert timeouts == [600.0 + TURN_TIMEOUT_MARGIN_SECONDS]


# #293-T14
def test_the_timeout_follows_the_time_that_is_left(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(order, "DEADLINE", 600.0)
    clock = Clock()
    transport, timeouts = recording_transport(clock)
    engine, client = engine_with(tmp_path, clock, transport)
    clock.now = 100.0  # the engine took 100 s to start

    engine._send(client, "session")  # pyright: ignore[reportPrivateUsage]

    assert timeouts == [500.0 + TURN_TIMEOUT_MARGIN_SECONDS]


# #293-T14: the margin keeps the run's own watch, not the socket, the one that ends a turn at the
# deadline, so the ledger decides what the result is.
def test_the_margin_is_a_few_seconds_so_the_deadline_is_noticed_first() -> None:
    assert 1.0 <= TURN_TIMEOUT_MARGIN_SECONDS <= 30.0


# #293-T15
def test_a_turn_that_runs_into_the_client_timeout_long_before_the_deadline_has_its_own_reason(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(order, "DEADLINE", 600.0)
    clock = Clock()

    def transport(
        method: str, url: str, body: bytes | None, headers: Mapping[str, str], timeout: float
    ) -> tuple[int, bytes]:
        clock.now = 339.0
        raise EngineTimeout()

    engine, client = engine_with(tmp_path, clock, transport)

    with pytest.raises(EngineError) as raised:
        engine._send(client, "session")  # pyright: ignore[reportPrivateUsage]

    assert not isinstance(raised.value, LimitError)
    assert raised.value.code is ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE
    assert raised.value.detail.startswith("engine_turn_timeout:")
    assert "not reachable" not in raised.value.detail


# #293-T15
def test_a_turn_that_times_out_at_the_deadline_is_still_a_budget_outcome(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(order, "DEADLINE", 600.0)
    clock = Clock()

    def transport(
        method: str, url: str, body: bytes | None, headers: Mapping[str, str], timeout: float
    ) -> tuple[int, bytes]:
        clock.now = 600.0
        raise EngineTimeout()

    engine, client = engine_with(tmp_path, clock, transport)

    with pytest.raises(LimitError) as raised:
        engine._send(client, "session")  # pyright: ignore[reportPrivateUsage]

    assert raised.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED


# #293-T15
def test_an_engine_that_exited_is_told_apart_from_one_that_is_not_reachable(
    tmp_path: Path,
) -> None:
    clock = Clock()

    def transport(
        method: str, url: str, body: bytes | None, headers: Mapping[str, str], timeout: float
    ) -> tuple[int, bytes]:
        clock.now = 1.0
        raise order.UNREACHABLE

    engine, client = engine_with(tmp_path, clock, transport)
    engine._is_running = lambda: False  # type: ignore[method-assign]  # pyright: ignore[reportPrivateUsage]

    with pytest.raises(EngineError) as raised:
        engine._send(client, "session")  # pyright: ignore[reportPrivateUsage]

    assert raised.value.code is ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE
    assert raised.value.detail.startswith("engine_exited:")


# #293-T15
def test_an_engine_that_runs_but_cannot_be_reached_says_so(tmp_path: Path) -> None:
    clock = Clock()

    def transport(
        method: str, url: str, body: bytes | None, headers: Mapping[str, str], timeout: float
    ) -> tuple[int, bytes]:
        clock.now = 1.0
        raise EngineError(ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "engine_unreachable: x")

    engine, client = engine_with(tmp_path, clock, transport)

    with pytest.raises(EngineError) as raised:
        engine._send(client, "session")  # pyright: ignore[reportPrivateUsage]

    assert raised.value.detail == "engine_unreachable: x"


# #293-T15: the real transport tells a timeout from a refused connection.
def test_the_transport_names_a_socket_timeout_and_a_refused_connection_differently() -> None:
    import socket
    import threading

    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        port = listener.getsockname()[1]
        held = threading.Event()

        def accept_and_hold() -> None:
            connection, _ = listener.accept()
            held.wait(5.0)
            connection.close()

        thread = threading.Thread(target=accept_and_hold, daemon=True)
        thread.start()
        try:
            with pytest.raises(EngineTimeout):
                _http_request("POST", f"http://127.0.0.1:{port}/x", b"{}", {}, 0.3)
        finally:
            held.set()
            thread.join(timeout=5.0)

    with socket.socket() as closed:
        closed.bind(("127.0.0.1", 0))
        free_port = closed.getsockname()[1]
    with pytest.raises(EngineError) as refused:
        _http_request("POST", f"http://127.0.0.1:{free_port}/x", b"{}", {}, 1.0)
    assert not isinstance(refused.value, EngineTimeout)
    assert refused.value.detail.startswith("engine_unreachable:")


# #293-T16: the duration of each message call is kept, for the result log.
def test_the_duration_of_the_message_call_is_recorded_on_the_ledger_clock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(order, "DEADLINE", 600.0)
    clock = Clock()
    transport, _ = recording_transport(clock, takes=123.4)
    engine, client = engine_with(tmp_path, clock, transport)
    clock.now = 10.0

    engine._send(client, "session")  # pyright: ignore[reportPrivateUsage]

    assert engine.turn_seconds == [pytest.approx(123.4)]  # pyright: ignore[reportUnknownMemberType]


# #293-T16
def test_the_duration_is_recorded_when_the_call_fails_too(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(order, "DEADLINE", 600.0)
    clock = Clock()

    def transport(
        method: str, url: str, body: bytes | None, headers: Mapping[str, str], timeout: float
    ) -> tuple[int, bytes]:
        clock.now += 339.0
        raise EngineTimeout()

    engine, client = engine_with(tmp_path, clock, transport)

    with pytest.raises(EngineError):
        engine._send(client, "session")  # pyright: ignore[reportPrivateUsage]

    assert engine.turn_seconds == [pytest.approx(339.0)]  # pyright: ignore[reportUnknownMemberType]


def test_the_client_names_the_message_timeout_it_was_given() -> None:
    seen: list[float] = []

    def transport(
        method: str, url: str, body: bytes | None, headers: Mapping[str, str], timeout: float
    ) -> tuple[int, bytes]:
        seen.append(timeout)
        return 200, b"{}"

    client = EngineClient("http://127.0.0.1:1", "/export", transport=transport)
    client.send_message("s", model="m", parts=[], schema={}, timeout=777.0)

    assert seen == [777.0]
