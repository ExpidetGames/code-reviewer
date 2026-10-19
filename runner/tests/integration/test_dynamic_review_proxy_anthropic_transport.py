# SPDX-License-Identifier: Apache-2.0

"""The model proxy over real loopback sockets with the Anthropic provider (#511).

The wire is unit-tested without a socket; what only a socket shows lives here: the key travels in
`x-api-key` and not in `Authorization`, the real transport reads the Messages answer, the engine
reads a chat completion and a stream of it, and the cost of the calls is in the ledger. Both ends
are loopback fakes; nothing leaves the host."""

import json
import threading
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from code_reviewer_runner.dynamic_review.budget import BudgetLedger, DynamicLimits, UnitCosts
from code_reviewer_runner.dynamic_review.config import new_proxy_capability
from code_reviewer_runner.dynamic_review.proxy import ModelProxy, capabilities_from_config
from code_reviewer_runner.llm_providers import ANTHROPIC
from code_reviewer_runner.result import ErrorCode

KEY = "dummy-anthropic-api03-workspace-key-0123456789"
MODEL = "claude-sonnet-5"
UNIT_COSTS = UnitCosts(input_usd_per_mtok=Decimal(2), output_usd_per_mtok=Decimal(10))
CAPABILITIES = json.dumps(
    {"tool_choice_required": True, "structured_output": True, "max_output_tokens": 8192}
)


class Claude:
    """A loopback Claude API: records what it receives, answers the next scripted message."""

    def __init__(self, *answers: tuple[int, dict[str, Any]]) -> None:
        self.answers = list(answers)
        self.requests: list[tuple[str, dict[str, str], dict[str, Any]]] = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", "0"))
                body: dict[str, Any] = json.loads(self.rfile.read(length))
                fake.requests.append(
                    (self.path, {key.lower(): value for key, value in self.headers.items()}, body)
                )
                status, document = fake.answers.pop(0)
                data = json.dumps(document).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, format: str, *args: Any) -> None:
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def base(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}/api/v1"

    def __enter__(self) -> "Claude":
        self._thread.start()
        return self

    def __exit__(self, *args: object) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5.0)


def message(content: list[dict[str, Any]], stop_reason: str, **usage: Any) -> dict[str, Any]:
    return {
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "model": MODEL,
        "content": content,
        "stop_reason": stop_reason,
        "usage": {"input_tokens": 1000, "output_tokens": 200, **usage},
    }


def chat(stream: bool = False) -> dict[str, Any]:
    return {
        "model": MODEL,
        "stream": stream,
        "messages": [
            {"role": "system", "content": "You review code."},
            {"role": "user", "content": "review this change " + "context " * 400},
        ],
        "tools": [
            {
                "type": "function",
                "function": {"name": "read", "parameters": {"type": "object", "properties": {}}},
            }
        ],
        "tool_choice": "auto",
        "temperature": 0.2,
    }


def call(url: str, token: str, body: dict[str, Any]) -> tuple[int, bytes]:
    request = Request(
        f"{url}/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
    )
    try:
        with urlopen(request, timeout=10) as response:
            return response.status, response.read()
    except HTTPError as error:
        return error.code, error.read()


def started(upstream: Claude, capability: str, ledger: BudgetLedger) -> Any:
    wire = ANTHROPIC.wire(MODEL)
    proxy = ModelProxy(
        ledger=ledger,
        base_path="/v1",
        model=MODEL,
        upstream_url=wire.url(upstream.base),
        upstream_api_key=KEY,
        upstream_model=MODEL,
        capabilities=capabilities_from_config(CAPABILITIES),
        capability=capability,
        provider=ANTHROPIC,
    )
    return proxy.serve("127.0.0.1").start()


# #511-T26
def test_a_tool_loop_over_real_sockets_reaches_the_messages_api_and_is_costed_exactly() -> None:
    capability = new_proxy_capability()
    ledger = BudgetLedger(DynamicLimits(), unit_costs=UNIT_COSTS)
    answers = (
        (
            200,
            message(
                [{"type": "tool_use", "id": "toolu_1", "name": "read", "input": {"path": "a.py"}}],
                "tool_use",
                cache_creation_input_tokens=300,
            ),
        ),
        (200, message([{"type": "text", "text": "done"}], "end_turn", cache_read_input_tokens=300)),
    )
    with Claude(*answers) as upstream:
        server = started(upstream, capability, ledger)
        try:
            first = call(server.url, capability, chat())
            second = call(server.url, capability, chat(stream=True))
        finally:
            server.stop()

    assert first[0] == 200 and second[0] == 200
    completion = json.loads(first[1])
    assert completion["choices"][0]["message"]["tool_calls"][0]["function"]["name"] == "read"
    assert b"data: [DONE]" in second[1]
    assert len(upstream.requests) == 2
    path, headers, body = upstream.requests[0]
    assert path == "/api/v1/messages"
    assert headers["x-api-key"] == KEY
    assert headers["anthropic-version"] == "2023-06-01"
    assert "authorization" not in headers
    assert capability not in json.dumps(headers) + json.dumps(body)
    # Sonnet 5 takes no sampling parameter: the engine's temperature never reached the API.
    assert all("temperature" not in sent for _, _, sent in upstream.requests)
    # Sonnet 5: $2 in, $10 out, $0.20 cache read, $2.50 cache write per million tokens.
    first_cost = Decimal(1000) * 2 + Decimal(200) * 10 + Decimal(300) * Decimal("2.5")
    second_cost = Decimal(1000) * 2 + Decimal(200) * 10 + Decimal(300) * Decimal("0.2")
    usage = ledger.usage(MODEL)
    assert usage.ai_calls == 2
    assert usage.cost_usd is not None
    assert Decimal(repr(usage.cost_usd)) == (first_cost + second_cost) / 1_000_000


# #511-T25
def test_an_overloaded_provider_ends_the_call_with_a_stable_code_over_real_sockets() -> None:
    capability = new_proxy_capability()
    ledger = BudgetLedger(DynamicLimits(), unit_costs=UNIT_COSTS)
    overloaded = {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}
    with Claude((529, overloaded)) as upstream:
        server = started(upstream, capability, ledger)
        try:
            status, body = call(server.url, capability, chat())
        finally:
            server.stop()

    assert status == 529
    assert json.loads(body)["error"]["code"] == ErrorCode.LLM_UNAVAILABLE.value
    assert b"Overloaded" not in body
