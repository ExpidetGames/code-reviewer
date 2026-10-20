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
def front(upstream_url: str, **limits: Any) -> Generator[Front]:
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
    server = PassthroughServer(proxy, "127.0.0.1", 0).start()
    try:
        yield Front(proxy, server, capability)
    finally:
        server.stop()


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
            assert gated.client_closed.wait(10), "the provider's connection was not closed"
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
