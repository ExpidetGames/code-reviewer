# SPDX-License-Identifier: Apache-2.0

"""The time and connection limits of the passthrough proxy (#550, should-fix 6).

Every wait of the proxy is bounded by the time the job has left: connecting to the provider (each
attempt gets what is left of the call's budget, never a fallback), resolving its name, the TLS
handshake, and the engine's side of the loopback socket (reading its body, writing the answer).
Without them a stalled engine or a hanging resolver holds the one call the job may have, and with
it the whole review.
"""

import socket
import threading
from typing import Any

import pytest

from code_reviewer_runner.dynamic_review.passthrough.server import _Sink, bounded_wait  # pyright: ignore[reportPrivateUsage]
from code_reviewer_runner.dynamic_review.passthrough.sink import ClientGone
from code_reviewer_runner.dynamic_review.passthrough.upstream import (
    HttpsUpstream,
    UpstreamError,
    UpstreamFailure,
    UpstreamRequest,
)

ANSWER = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nok"
PUBLIC = ["93.184.216.34", "93.184.216.35"]


def request() -> UpstreamRequest:
    return UpstreamRequest("/chat/completions", {"content-type": "application/json"}, b"{}")


class Wire:
    """A connection whose clock the test moves: what each step was given as its timeout."""

    def __init__(self, advance: dict[int, float] | None = None, fail: set[int] | None = None):
        self.now = 0.0
        self.connect_timeouts: list[float] = []
        self.tls_timeouts: list[float | None] = []
        self.resolve_calls = 0
        self._advance = advance or {}
        self._fail = fail or set()

    def clock(self) -> float:
        return self.now

    def connect(self, address: tuple[str, int], timeout: float) -> Any:
        attempt = len(self.connect_timeouts)
        self.connect_timeouts.append(timeout)
        self.now += self._advance.get(attempt, 0.0)
        if attempt in self._fail:
            raise TimeoutError
        client, server = socket.socketpair()
        threading.Thread(target=self._serve, args=(server,), daemon=True).start()
        return client

    def tls(self, raw: Any, hostname: str) -> Any:
        self.tls_timeouts.append(raw.gettimeout())
        return raw

    @staticmethod
    def _serve(server: socket.socket) -> None:
        with server:
            received = b""
            while b"\r\n\r\n" not in received:
                received += server.recv(65536)
            server.sendall(ANSWER)

    def upstream(self, resolve: Any = None) -> HttpsUpstream:
        def default(host: str) -> list[str]:
            self.resolve_calls += 1
            return PUBLIC

        return HttpsUpstream(
            "https://api.example.com/v1",
            resolve=resolve or default,
            connect=self.connect,
            tls=self.tls,
            clock=self.clock,
        )


# #550-S06-U01
def test_a_call_with_no_time_left_makes_no_connection_and_no_lookup() -> None:
    wire = Wire()
    for timeout in (0.0, -1.0):
        with pytest.raises(UpstreamError) as raised:
            wire.upstream().send(request(), timeout)
        assert raised.value.kind is UpstreamFailure.TIMEOUT
        assert not raised.value.sent
    # Not the 120 seconds that a falsy timeout used to fall back to.
    assert wire.connect_timeouts == [] and wire.resolve_calls == 0


# #550-S06-U02
def test_each_connect_attempt_gets_what_is_left_of_the_budget_of_the_call() -> None:
    wire = Wire(advance={0: 3.0}, fail={0})
    response = wire.upstream().send(request(), 5.0)
    assert response.status == 200
    # The first address took 3 of the 5 seconds and failed; the second gets the 2 that are left.
    assert wire.connect_timeouts == [5.0, 2.0]


# #550-S06-U02
def test_when_the_first_attempt_used_up_the_budget_there_is_no_second_one() -> None:
    wire = Wire(advance={0: 5.0}, fail={0})
    with pytest.raises(UpstreamError) as raised:
        wire.upstream().send(request(), 5.0)
    assert raised.value.kind is UpstreamFailure.TIMEOUT
    assert wire.connect_timeouts == [5.0]


# #550-S06-U03
def test_the_tls_handshake_gets_what_is_left_after_the_connection() -> None:
    wire = Wire(advance={0: 1.5})
    wire.upstream().send(request(), 5.0).close()
    assert wire.tls_timeouts == [pytest.approx(3.5)]


# #550-S06-U04
def test_a_lookup_that_does_not_come_back_is_a_timeout_not_a_hung_call() -> None:
    release = threading.Event()
    started = threading.Event()

    def hanging(host: str) -> list[str]:
        started.set()
        release.wait(10)
        return PUBLIC

    wire = Wire()
    try:
        with pytest.raises(UpstreamError) as raised:
            wire.upstream(hanging).send(request(), 0.3)
        assert started.is_set()
        assert raised.value.kind is UpstreamFailure.TIMEOUT
        assert not raised.value.sent
        assert wire.connect_timeouts == []
    finally:
        release.set()


# #550-S06-U04
def test_a_lookup_that_raises_is_unreachable_and_one_that_answers_in_time_is_used() -> None:
    wire = Wire()

    def broken(host: str) -> list[str]:
        raise OSError("no such host")

    with pytest.raises(UpstreamError) as raised:
        wire.upstream(broken).send(request(), 5.0)
    assert raised.value.kind is UpstreamFailure.UNREACHABLE
    assert wire.upstream().send(request(), 5.0).status == 200


# -- the engine's side of the loopback socket ----


# #550-S06-S01
def test_a_wait_on_the_engines_socket_is_never_longer_than_the_job_has_left() -> None:
    assert bounded_wait(500.0, 60.0) == 60.0
    assert bounded_wait(12.5, 60.0) == 12.5
    # 0 would make the socket non-blocking: never.
    assert bounded_wait(0.0, 60.0) > 0 and bounded_wait(-3.0, 60.0) > 0


class Connection:
    def __init__(self) -> None:
        self.timeouts: list[float | None] = []

    def settimeout(self, value: float | None) -> None:
        self.timeouts.append(value)


class Handler:
    """The part of a request handler the sink uses."""

    def __init__(self, wfile: "Wfile") -> None:
        self.connection = Connection()
        self.wfile = wfile

    def send_response(self, status: int) -> None:
        return None

    def send_header(self, name: str, value: str) -> None:
        return None

    def end_headers(self) -> None:
        return None


class Wfile:
    def __init__(self, error: Exception | None = None) -> None:
        self.error, self.data = error, b""

    def write(self, data: bytes) -> None:
        if self.error is not None:
            raise self.error
        self.data += data

    def flush(self) -> None:
        return None


# #550-S06-S01
def test_every_write_to_the_engine_is_bounded_by_the_time_left() -> None:
    handler = Handler(Wfile())
    left = [40.0]
    sink = _Sink(handler, lambda: left[0], 60.0)  # type: ignore[arg-type]
    sink.start(200, [], None)
    sink.write(b"one")
    left[0] = 4.0
    sink.write(b"two")
    assert handler.connection.timeouts[-2:] == [40.0, 4.0]
    assert handler.wfile.data.count(b"\r\n") >= 4  # chunked


# #550-S06-S01
def test_a_write_that_times_out_is_an_engine_that_went_away() -> None:
    handler = Handler(Wfile(TimeoutError()))
    sink = _Sink(handler, lambda: 10.0, 60.0)  # type: ignore[arg-type]
    with pytest.raises(ClientGone):
        sink.write(b"data")
