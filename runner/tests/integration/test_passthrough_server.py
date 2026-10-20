# SPDX-License-Identifier: Apache-2.0

"""The passthrough proxy on a real loopback socket against the generic fakes of `fakes/wire` (#550).

The proxy and its policy are the production code; the provider is the strict fake of `fakes/wire`
(or a small gated server where a test must hold an answer half way) behind `LoopbackUpstream`, and
the engine is a plain HTTP client holding the dummy capability. What a test sees is what the real
engine would see.
"""

import http.client
import json
import secrets
import socket
import sys
import threading
import time
from collections.abc import Generator
from contextlib import contextmanager
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fakes.wire.formats import AUTH_HEADER, Turn, auth_value, stream, usage_for
from fakes.wire.upstream import ScriptedUpstream

from code_reviewer_runner.dynamic_review.budget import BudgetLedger, DynamicLimits, UnitCosts
from code_reviewer_runner.dynamic_review.passthrough.admission import PassthroughTarget
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily
from code_reviewer_runner.dynamic_review.passthrough.proxy import PassthroughProxy
from code_reviewer_runner.dynamic_review.passthrough.server import PassthroughServer
from code_reviewer_runner.result import ErrorCode
from passthrough_loopback import LoopbackUpstream

REAL_KEY = "sk-real-key-0123456789abcdefABCDEF"
MODEL = "acme-chat-9"
PRICES = UnitCosts(Decimal(3), Decimal(15))
TURN = Turn(tool="read", args={"filePath": "/x"})


class Front:
    def __init__(self, proxy: PassthroughProxy, server: PassthroughServer, capability: str) -> None:
        self.proxy, self.server, self.capability = proxy, server, capability

    @property
    def ledger(self) -> BudgetLedger:
        return self.proxy.ledger

    def connection(self) -> http.client.HTTPConnection:
        host, port = self.server.url.removeprefix("http://").split(":")
        return http.client.HTTPConnection(host, int(port), timeout=15)

    def headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.capability}",
            "Content-Type": "application/json",
            "Accept-Encoding": "gzip, deflate, br, zstd",
        }

    def body(self, **extra: Any) -> bytes:
        document: dict[str, Any] = {
            "model": MODEL,
            "stream": True,
            "max_tokens": 1000,
            "messages": [{"role": "user", "content": "x" * 6000}],
            # A request that offers tools is a step of the loop: the fake takes the next turn.
            "tools": [{"type": "function", "function": {"name": "read"}}],
        }
        document.update(extra)
        return json.dumps(document).encode()


@contextmanager
def front(
    upstream_url: str, *, server: dict[str, Any] | None = None, **limits: Any
) -> Generator[Front]:
    ledger = BudgetLedger(
        DynamicLimits(max_cost_usd=Decimal(5), **limits),
        window_tokens=1_000_000,
        output_tokens=8192,
        unit_costs=PRICES,
    )
    capability = secrets.token_urlsafe(32)
    proxy = PassthroughProxy(
        ledger=ledger,
        target=PassthroughTarget(WireFamily.OPENAI_CHAT, MODEL, 8192),
        upstream=LoopbackUpstream(upstream_url + "/v1"),
        upstream_api_key=REAL_KEY,
        capability=capability,
        prices=PRICES,
    )
    running = PassthroughServer(proxy, "127.0.0.1", 0, **(server or {})).start()
    try:
        yield Front(proxy, running, capability)
    finally:
        running.stop()


class Gated:
    """A provider that sends the first event, then waits for the test before it sends the rest."""

    def __init__(self) -> None:
        self.first_sent = threading.Event()
        self.release = threading.Event()
        self.client_closed = threading.Event()
        self.requests = 0
        gated = self
        events = stream("chat", TURN, 1, MODEL)

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self) -> None:
                gated.requests += 1
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                self._chunk(events[0])
                gated.first_sent.set()
                gated.release.wait(10)
                try:
                    for event in events[1:]:
                        self._chunk(event)
                        time.sleep(0.05)
                    self.wfile.write(b"0\r\n\r\n")
                except OSError:
                    gated.client_closed.set()

            def _chunk(self, data: bytes) -> None:
                self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
                self.wfile.flush()

            def log_message(self, format: str, *args: Any) -> None:
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.events = events

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def stop(self) -> None:
        self.release.set()
        self.server.shutdown()
        self.server.server_close()


@contextmanager
def fake_provider(script: list[Turn] | None = None) -> Generator[ScriptedUpstream]:
    with ScriptedUpstream(
        "chat", script or [TURN, Turn(text="done")], MODEL, real_key=REAL_KEY
    ) as upstream:
        yield upstream


# #550-T08
def test_a_real_call_goes_through_with_the_real_key_and_is_settled() -> None:
    with fake_provider() as provider, front(provider.url) as f:
        connection = f.connection()
        connection.request("POST", "/v1/chat/completions", f.body(), f.headers())
        response = connection.getresponse()
        data = response.read()
        assert response.status == 200
        assert response.getheader("Content-Type") == "text/event-stream"
        assert data == b"".join(stream("chat", TURN, 1, MODEL, include_usage=False))
        # The tool-less request says nothing about usage: the fake states none, and the run fails
        # closed. A request that asks for it is settled (next test).
        assert f.ledger.failure is not None
        assert f.ledger.failure.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED
        received = provider.records[0]
        assert received.headers[AUTH_HEADER["chat"]] == auth_value("chat", REAL_KEY)
        assert f.capability not in json.dumps(received.headers)
        assert received.headers["accept-encoding"] == "identity"


# #550-T08
def test_a_request_that_asks_for_usage_is_settled_at_the_price_of_its_tokens() -> None:
    with fake_provider() as provider, front(provider.url) as f:
        body = f.body(
            stream_options={"include_usage": True},
            tools=[{"type": "function", "function": {"name": "read"}}],
        )
        connection = f.connection()
        connection.request("POST", "/v1/chat/completions", body, f.headers())
        response = connection.getresponse()
        data = response.read()
        assert response.status == 200
        assert data == b"".join(stream("chat", TURN, 1, MODEL))
        used = usage_for(1)
        usage = f.ledger.usage(MODEL)
        assert (usage.ai_calls, usage.prompt_tokens, usage.completion_tokens) == (
            1,
            used.input,
            used.output,
        )
        assert usage.cost_usd is not None and usage.cost_usd > 0
        assert f.ledger.failure is None
        # The same connection serves the next call.
        connection.request("POST", "/v1/chat/completions", body, f.headers())
        again = connection.getresponse()
        again.read()
        assert again.status == 200 and f.ledger.model_calls == 2


# #550-T08
def test_the_first_event_reaches_the_engine_before_the_provider_has_sent_the_last() -> None:
    gated = Gated()
    try:
        with front(gated.url) as f:
            body = f.body(stream_options={"include_usage": True})
            connection = f.connection()
            connection.request("POST", "/v1/chat/completions", body, f.headers())
            response = connection.getresponse()
            assert gated.first_sent.wait(5)
            first = response.read1(65536)
            assert first.startswith(b"data: ")
            assert not gated.release.is_set()
            gated.release.set()
            rest = response.read()
            assert b"[DONE]" in rest
            assert f.ledger.usage(MODEL).ai_calls == 1
            assert f.ledger.failure is None
    finally:
        gated.stop()


# #550-T09
def test_an_engine_that_closes_its_connection_does_not_hide_the_usage_of_the_call() -> None:
    gated = Gated()
    try:
        with front(gated.url) as f:
            connection = f.connection()
            connection.request("POST", "/v1/chat/completions", f.body(), f.headers())
            response = connection.getresponse()
            assert gated.first_sent.wait(5)
            assert response.read1(65536).startswith(b"data: ")
            connection.close()
            gated.release.set()
            deadline = time.monotonic() + 5
            while f.ledger.usage(MODEL).ai_calls == 0 and time.monotonic() < deadline:
                time.sleep(0.05)
            assert f.proxy.wait_idle(5)
            usage = f.ledger.usage(MODEL)
            # The proxy read the rest of the answer for its usage, then closed the provider's
            # connection: the call is settled at the provider's own figures, nothing is hidden.
            assert usage.ai_calls == 1
            assert usage.cost_usd is not None and usage.cost_usd > 0
            assert f.ledger.failure is None
    finally:
        gated.stop()


# #550-T07
def test_a_redirect_from_the_provider_is_not_followed() -> None:
    hits: list[str] = []

    class Target(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            hits.append(self.path)
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, format: str, *args: Any) -> None:
            return

    class Redirecting(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            self.rfile.read(int(self.headers.get("Content-Length") or 0))
            self.send_response(307)
            self.send_header("Location", f"http://127.0.0.1:{target.server_address[1]}/stolen")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, format: str, *args: Any) -> None:
            return

    target = ThreadingHTTPServer(("127.0.0.1", 0), Target)
    redirecting = ThreadingHTTPServer(("127.0.0.1", 0), Redirecting)
    for server in (target, redirecting):
        threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with front(f"http://127.0.0.1:{redirecting.server_address[1]}") as f:
            connection = f.connection()
            connection.request("POST", "/v1/chat/completions", f.body(), f.headers())
            response = connection.getresponse()
            response.read()
            assert response.status == 502
            assert hits == []
            assert f.ledger.failure is not None
            assert f.ledger.failure.code is ErrorCode.DYNAMIC_POLICY_VIOLATION
    finally:
        for server in (target, redirecting):
            server.shutdown()
            server.server_close()


# #550-T10
def test_an_error_body_that_quotes_the_key_reaches_the_engine_as_our_sentence() -> None:
    with fake_provider() as provider, front(provider.url) as f:
        provider.quote_key = True
        provider.fail_next(500)
        connection = f.connection()
        connection.request("POST", "/v1/chat/completions", f.body(), f.headers())
        response = connection.getresponse()
        data = response.read()
        assert response.status == 500
        assert REAL_KEY.encode() not in data and REAL_KEY[:12].encode() not in data
        # The provider's words are not passed on at all: the engine gets our sentence.
        assert b"fake upstream" not in data
        assert json.loads(data)["error"]["code"] == "llm_unavailable"
        # The key was in the provider's answer: it really did quote the one the proxy sent.
        assert REAL_KEY in provider.records[0].headers["authorization"]


# #550-T04
def test_a_refused_request_is_answered_on_the_wire_and_the_connection_stays_usable() -> None:
    with fake_provider() as provider, front(provider.url) as f:
        connection = f.connection()
        connection.request("GET", "/v1/models", headers=f.headers())
        response = connection.getresponse()
        response.read()
        assert response.status == 403
        # A fresh connection (a refusal that did not read the body closes the old one).
        connection = f.connection()
        connection.request("POST", "/v1/chat/completions", f.body(model="other"), f.headers())
        response = connection.getresponse()
        assert response.status == 403
        assert json.loads(response.read())["error"]["code"] == "model_not_allowed"
        assert provider.records == []


# #550-T01
def test_a_request_with_a_wrong_capability_is_a_401_and_never_reaches_the_provider() -> None:
    with fake_provider() as provider, front(provider.url) as f:
        connection = f.connection()
        headers = {**f.headers(), "Authorization": "Bearer nope"}
        connection.request("POST", "/v1/chat/completions", f.body(), headers)
        response = connection.getresponse()
        response.read()
        assert response.status == 401
        assert provider.records == []


# #550-T06
def test_a_chunked_request_and_an_oversized_one_are_refused_before_the_body_is_read() -> None:
    with fake_provider() as provider, front(provider.url, max_request_bytes=3000) as f:
        host, port = f.server.url.removeprefix("http://").split(":")
        with socket.create_connection((host, int(port)), timeout=10) as raw:
            raw.sendall(
                (
                    "POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\n"
                    f"Authorization: Bearer {f.capability}\r\nContent-Type: application/json\r\n"
                    "Transfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n"
                ).encode()
            )
            assert raw.recv(65536).startswith(b"HTTP/1.1 411")
        connection = f.connection()
        connection.request("POST", "/v1/chat/completions", f.body(), f.headers())
        response = connection.getresponse()
        response.read()
        assert response.status == 413
        assert provider.records == []


# -- B4 and the limits of the server, on a real socket ----


def _raw(f: Front) -> socket.socket:
    host, port = f.server.url.removeprefix("http://").split(":")
    return socket.create_connection((host, int(port)), timeout=5)


def _closed_within(connection: socket.socket, seconds: float) -> bool:
    """Whether the server closes the connection (a read of b"" or a reset) within `seconds`."""
    connection.settimeout(seconds)
    try:
        return connection.recv(1) == b""
    except (ConnectionError, OSError) as error:
        return not isinstance(error, TimeoutError)


# #550-B4-P03
def test_a_second_request_while_the_first_is_streaming_is_refused_with_a_429() -> None:
    gated = Gated()
    try:
        with front(gated.url) as f:
            first = f.connection()
            first.request("POST", "/v1/chat/completions", f.body(), f.headers())
            response = first.getresponse()
            assert gated.first_sent.wait(5)
            assert response.read1(65536).startswith(b"data: ")
            second = f.connection()
            second.request("POST", "/v1/chat/completions", f.body(), f.headers())
            refused = second.getresponse()
            data = json.loads(refused.read())
            assert refused.status == 429 and refused.getheader("retry-after") == "1"
            assert data["error"]["code"] == "call_in_flight"
            assert gated.requests == 1
            gated.release.set()
            assert b"[DONE]" in response.read()
            assert f.ledger.failure is None and f.ledger.model_calls == 1
            # The call is over: the next one is served.
            again = f.connection()
            again.request("POST", "/v1/chat/completions", f.body(), f.headers())
            assert again.getresponse().status == 200
    finally:
        gated.stop()


# #550-S06-S02
def test_a_connection_that_says_nothing_is_closed_after_the_short_first_wait() -> None:
    with (
        fake_provider() as provider,
        front(provider.url, server={"first_request_timeout": 0.4, "idle_timeout": 30.0}) as f,
    ):
        silent = _raw(f)
        assert _closed_within(silent, 4.0)
        silent.close()


# #550-R2-N7
def test_a_connection_that_has_served_a_request_may_idle_longer_than_a_new_one() -> None:
    with (
        fake_provider() as provider,
        front(provider.url, server={"first_request_timeout": 0.4, "idle_timeout": 30.0}) as f,
    ):
        connection = f.connection()
        connection.request("POST", "/v1/chat/completions", f.body(), f.headers())
        assert connection.getresponse().read() and True
        time.sleep(1.0)  # longer than the first wait
        connection.request("POST", "/v1/chat/completions", f.body(), f.headers())
        assert connection.getresponse().status == 200


# #550-S06-S02
def test_a_connection_that_idles_after_a_request_is_closed_after_the_idle_wait() -> None:
    with (
        fake_provider() as provider,
        front(provider.url, server={"first_request_timeout": 5.0, "idle_timeout": 0.5}) as f,
    ):
        raw = _raw(f)
        body = f.body()
        head = (
            "POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\n"
            f"Authorization: Bearer {f.capability}\r\nContent-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\n\r\n"
        )
        raw.sendall(head.encode() + body)
        raw.settimeout(5)
        assert raw.recv(4096).startswith(b"HTTP/1.1 200")
        # The rest of the answer, then silence: the server closes after the idle wait.
        deadline = time.monotonic() + 4.0
        closed = False
        while time.monotonic() < deadline and not closed:
            try:
                closed = raw.recv(65536) == b""
            except TimeoutError:
                break
        assert closed
        raw.close()


# #550-S06-S03
def test_a_body_that_stalls_is_cut_and_frees_the_one_call() -> None:
    with fake_provider() as provider, front(provider.url, server={"io_timeout": 0.4}) as f:
        stalled = _raw(f)
        body = f.body()
        head = (
            "POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\n"
            f"Authorization: Bearer {f.capability}\r\nContent-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\n\r\n"
        )
        stalled.sendall(head.encode() + body[:10])
        assert _closed_within(stalled, 4.0), "a stalled body held the connection"
        stalled.close()
        assert f.ledger.model_calls == 0
        # The slot of the one call is free again: a whole request is served at once.
        connection = f.connection()
        connection.request("POST", "/v1/chat/completions", f.body(), f.headers())
        assert connection.getresponse().status == 200


# #550-S06-S04
def test_more_connections_than_the_server_allows_are_closed_at_once() -> None:
    with (
        fake_provider() as provider,
        front(provider.url, server={"max_connections": 2, "idle_timeout": 30.0}) as f,
    ):
        held = [_raw(f), _raw(f)]
        time.sleep(0.2)
        extra = _raw(f)
        assert _closed_within(extra, 3.0), "a third connection was served"
        extra.close()
        # When one goes, the next one is served again.
        held[0].close()
        time.sleep(0.3)
        connection = f.connection()
        connection.request(
            "POST", "/v1/chat/completions", f.body(), {"Content-Type": "application/json"}
        )
        assert connection.getresponse().status == 401
        held[1].close()
