# SPDX-License-Identifier: Apache-2.0

"""Pins down the model proxy over real loopback sockets (#197).

The proxy's policy is unit-tested without a socket; what only a socket can show lives here: the
bearer capability on the wire, the redirect handling of the real upstream transport and the bound on
how much of an upstream answer is read. Both ends are loopback fakes; nothing leaves the host.
"""

import json
import socket
import threading
from collections.abc import Callable
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from code_reviewer_runner.dynamic_review import proxy as proxy_module
from code_reviewer_runner.dynamic_review.adapter import _http_request  # pyright: ignore[reportPrivateUsage]
from code_reviewer_runner.dynamic_review.budget import BudgetLedger, DynamicLimits, UnitCosts
from code_reviewer_runner.dynamic_review.config import new_proxy_capability
from code_reviewer_runner.dynamic_review.proxy import (
    ModelProxy,
    _http_post,  # pyright: ignore[reportPrivateUsage]
    capabilities_from_config,
)
from code_reviewer_runner.result import ErrorCode

UPSTREAM_KEY = "sk-or-v1-workspace-key-0123456789"
CAPABILITIES = json.dumps(
    {
        "tool_choice_required": True,
        "structured_output": True,
        "max_output_tokens": 4096,
        "input_usd_per_mtok": 1,
        "output_usd_per_mtok": 4,
    }
)
ANSWER = {
    "id": "chatcmpl-1",
    "choices": [{"message": {"role": "assistant", "content": "{}"}}],
    "usage": {"prompt_tokens": 10, "completion_tokens": 5, "cost": 0.0001},
}


# 1 USD per million input tokens, 4 USD per million output tokens: a call has a price.
UNIT_COSTS = UnitCosts(input_usd_per_mtok=Decimal(1), output_usd_per_mtok=Decimal(4))


class Listener:
    """A loopback HTTP server that records what it receives and answers as scripted."""

    def __init__(self, respond: Callable[[BaseHTTPRequestHandler], None]) -> None:
        self.requests: list[tuple[str, dict[str, str], bytes]] = []
        listener = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length)
                listener.requests.append(
                    (self.path, {key: value for key, value in self.headers.items()}, body)
                )
                respond(self)

            def log_message(self, format: str, *args: Any) -> None:
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def __enter__(self) -> "Listener":
        self._thread.start()
        return self

    def __exit__(self, *args: object) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5.0)


def reply(handler: BaseHTTPRequestHandler, status: int, body: bytes) -> None:
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def answer_ok(handler: BaseHTTPRequestHandler) -> None:
    reply(handler, 200, json.dumps(ANSWER).encode())


def request_body() -> bytes:
    return json.dumps(
        {
            "model": "deepseek/deepseek-v4.1-flash",
            "messages": [{"role": "user", "content": "hello"}],
            "tool_choice": "required",
        }
    ).encode()


def call(url: str, token: str | None) -> tuple[int, Any]:
    headers = {"Content-Type": "application/json"}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(f"{url}/v1/chat/completions", data=request_body(), headers=headers)
    try:
        with urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read())
    except HTTPError as error:
        return error.code, json.loads(error.read())


def started_proxy(
    upstream_url: str, capability: str, ledger: BudgetLedger | None = None, **limits: Any
) -> Any:
    proxy = ModelProxy(
        ledger=ledger or BudgetLedger(DynamicLimits(**limits), unit_costs=UNIT_COSTS),
        base_path="/v1",
        model="deepseek/deepseek-v4.1-flash",
        upstream_url=f"{upstream_url}/v1/chat/completions",
        upstream_api_key=UPSTREAM_KEY,
        upstream_model="deepseek/deepseek-v4.1-flash",
        capabilities=capabilities_from_config(CAPABILITIES),
        capability=capability,
    )
    return proxy.serve("127.0.0.1").start()


# #197-T04
def test_the_served_proxy_answers_only_the_holder_of_the_job_capability() -> None:
    capability = new_proxy_capability()
    with Listener(answer_ok) as upstream:
        server = started_proxy(upstream.url, capability)
        try:
            missing = call(server.url, None)
            wrong = call(server.url, new_proxy_capability())
            real_key = call(server.url, UPSTREAM_KEY)
            assert upstream.requests == []

            allowed = call(server.url, capability)
        finally:
            server.stop()

    for status, document in (missing, wrong, real_key):
        assert status == 401
        assert document["error"]["code"] == ErrorCode.DYNAMIC_POLICY_VIOLATION.value
    assert allowed[0] == 200
    assert len(upstream.requests) == 1
    forwarded = upstream.requests[0][1]
    assert forwarded["Authorization"] == f"Bearer {UPSTREAM_KEY}"
    assert capability not in json.dumps(forwarded)


def redirect_to(target: str, status: int) -> Callable[[BaseHTTPRequestHandler], None]:
    def respond(handler: BaseHTTPRequestHandler) -> None:
        handler.send_response(status)
        handler.send_header("Location", f"{target}/stolen")
        handler.send_header("Content-Length", "0")
        handler.end_headers()

    return respond


# #197-T04
def test_a_redirect_from_the_provider_is_never_followed_and_fails_closed() -> None:
    capability = new_proxy_capability()
    for status in (301, 302, 303, 307, 308):
        with Listener(answer_ok) as elsewhere:
            with Listener(redirect_to(elsewhere.url, status)) as upstream:
                server = started_proxy(upstream.url, capability)
                try:
                    code, document = call(server.url, capability)
                finally:
                    server.stop()

            # The workspace key was sent once, to the configured destination, and nowhere else.
            assert len(upstream.requests) == 1
            assert elsewhere.requests == []
        assert (
            code == 403
        )  # a deterministic refusal, not a 5xx the engine would retry (each retry is a call)
        assert document["error"]["code"] == ErrorCode.DYNAMIC_POLICY_VIOLATION.value


# #197-T12
def test_the_upstream_answer_is_read_only_up_to_one_byte_past_the_bound() -> None:
    huge = b"x" * (2 * 1024 * 1024)

    def answer_huge(handler: BaseHTTPRequestHandler) -> None:
        reply(handler, 200, huge)

    with Listener(answer_huge) as upstream:
        status, body = _http_post(f"{upstream.url}/v1/chat/completions", b"{}", {}, 101)

    assert status == 200
    assert len(body) == 101


# #197-T12
def test_a_provider_answer_over_the_response_bound_fails_closed_through_the_proxy() -> None:
    capability = new_proxy_capability()

    def answer_huge(handler: BaseHTTPRequestHandler) -> None:
        reply(handler, 200, b"x" * (1024 * 1024))

    with Listener(answer_huge) as upstream:
        server = started_proxy(upstream.url, capability, max_response_bytes=1000)
        try:
            code, document = call(server.url, capability)
        finally:
            server.stop()

    assert code == 403
    assert document["error"]["code"] == ErrorCode.DYNAMIC_BUDGET_EXCEEDED.value


# #197-T04
def test_the_engine_client_does_not_follow_a_redirect_either() -> None:
    with Listener(answer_ok) as elsewhere, Listener(redirect_to(elsewhere.url, 307)) as engine:
        status, _ = _http_request("POST", f"{engine.url}/session", b"{}", {}, 5.0)

    assert status == 307
    assert elsewhere.requests == []


class SilentListener:
    """A loopback server that accepts one connection and never answers it."""

    def __init__(self) -> None:
        self._socket = socket.socket()
        self._socket.bind(("127.0.0.1", 0))
        self._socket.listen(1)
        self._held: list[socket.socket] = []
        self._thread = threading.Thread(target=self._accept, daemon=True)

    def _accept(self) -> None:
        try:
            self._held.append(self._socket.accept()[0])
        except OSError:
            return

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self._socket.getsockname()[1]}"

    def __enter__(self) -> "SilentListener":
        self._thread.start()
        return self

    def __exit__(self, *args: object) -> None:
        self._socket.close()
        for connection in self._held:
            connection.close()
        self._thread.join(timeout=5.0)


def unused_loopback_url() -> str:
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    return f"http://127.0.0.1:{port}"


# #236-T04
def test_an_upstream_that_never_answers_ends_the_call_with_llm_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("NO_PROXY", "127.0.0.1")
    monkeypatch.setattr(proxy_module, "_REQUEST_TIMEOUT_SECONDS", 0.3)
    capability = new_proxy_capability()
    ledger = BudgetLedger(DynamicLimits(), unit_costs=UNIT_COSTS)
    with SilentListener() as upstream:
        server = started_proxy(upstream.url, capability, ledger)
        try:
            code, document = call(server.url, capability)
        finally:
            server.stop()

    # A 5xx of its own, not the 403 of a refusal and not a budget code.
    assert code == 504
    assert document["error"]["code"] == ErrorCode.LLM_TIMEOUT.value
    assert ledger.failure is not None
    assert ledger.failure.code is ErrorCode.LLM_TIMEOUT


# #236-T05
def test_an_upstream_that_refuses_the_connection_ends_the_call_with_llm_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("NO_PROXY", "127.0.0.1")
    capability = new_proxy_capability()
    ledger = BudgetLedger(DynamicLimits(), unit_costs=UNIT_COSTS)
    server = started_proxy(unused_loopback_url(), capability, ledger)
    try:
        code, document = call(server.url, capability)
    finally:
        server.stop()

    assert code == 502
    assert document["error"]["code"] == ErrorCode.LLM_UNAVAILABLE.value
    assert ledger.failure is not None
    assert ledger.failure.code is ErrorCode.LLM_UNAVAILABLE
