# SPDX-License-Identifier: Apache-2.0

"""Pins down the model proxy over real loopback sockets (#197).

The proxy's policy is unit-tested without a socket; what only a socket can show lives here: the
bearer capability on the wire, the redirect handling of the real upstream transport and the bound on
how much of an upstream answer is read. Both ends are loopback fakes; nothing leaves the host.
"""

import json
import threading
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from code_reviewer_runner.dynamic_review.config import new_proxy_capability
from code_reviewer_runner.dynamic_review.limits import BudgetLedger, DynamicLimits
from code_reviewer_runner.dynamic_review.proxy import ModelProxy, capabilities_from_config
from code_reviewer_runner.result import ErrorCode

UPSTREAM_KEY = "sk-or-v1-workspace-key-0123456789"
CAPABILITIES = json.dumps(
    {"tool_choice_required": True, "structured_output": True, "max_output_tokens": 4096}
)
ANSWER = {
    "id": "chatcmpl-1",
    "choices": [{"message": {"role": "assistant", "content": "{}"}}],
    "usage": {"prompt_tokens": 10, "completion_tokens": 5},
}


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
            "model": "deepseek-v4.1-flash",
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


def started_proxy(upstream_url: str, capability: str, **limits: int) -> Any:
    proxy = ModelProxy(
        ledger=BudgetLedger(DynamicLimits(**limits)),
        base_path="/v1",
        model="deepseek-v4.1-flash",
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
