# SPDX-License-Identifier: Apache-2.0

"""A fake OpenAI-compatible LLM endpoint for the engine suite (OpenRouter shaped, loopback only).

PR-Agent talks to it through LiteLLM's real OpenRouter code path: `OPENROUTER__API_BASE` points at
`http://127.0.0.1:<port>/api/v1`, and the request is `POST /api/v1/chat/completions` with the key in
the `Authorization` header. The fake records every request (headers and body, so a test can read the
prompt and the key that arrived) and answers from scripts:

- a reply per kind of prompt (review, improve, reflect, describe, ask), chosen from the system
  prompt of the request, so one endpoint serves all four commands;
- a fixed error status for every request (429, 401, ...), optionally quoting the received key in the
  message like "Incorrect API key provided";
- a reply for one model (`by_model`), so a test can fail or empty the primary model and let a
  fallback model answer;
- the charge of every answer in `usage.cost`, like OpenRouter states it (#274; `cost`, None leaves
  it out);
- a held request: the server waits until the client hangs up (or the test releases it), and says
  whether the client did, so a test can prove the connection was closed without sleeping.

The replies are canned. They satisfy the output contract of each PR-Agent tool and say nothing
about review quality.
"""

import json
import select
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

# A held request ends by itself after this long, so a broken test cannot leave a thread behind.
_HOLD_LIMIT_SECONDS = 120.0
_POLL_SECONDS = 0.05


@dataclass
class LlmRequest:
    path: str
    authorization: str
    body: dict[str, Any]

    @property
    def model(self) -> str:
        return str(self.body.get("model", ""))

    @property
    def system(self) -> str:
        return self._text("system")

    @property
    def user(self) -> str:
        return self._text("user")

    @property
    def prompt(self) -> str:
        return f"{self.system}\n{self.user}"

    def _text(self, role: str) -> str:
        parts: list[str] = []
        for message in self.body.get("messages", []):
            if message.get("role") != role:
                continue
            content = message.get("content")
            if isinstance(content, str):
                parts.append(content)
            elif isinstance(content, list):
                pieces: list[Any] = content  # pyright: ignore[reportUnknownVariableType]
                for piece in pieces:
                    if isinstance(piece, dict):
                        fields: dict[str, Any] = piece  # pyright: ignore[reportUnknownVariableType]
                        parts.append(str(fields.get("text", "")))
        return "\n".join(parts)


@dataclass
class Reply:
    """What to answer. `content` is the assistant text; `status` other than 200 makes an error."""

    content: str = ""
    status: int = 200
    message: str = "error"
    hold: bool = False


@dataclass
class FakeLlm:
    replies: dict[str, str] = field(default_factory=lambda: {})
    # Answers every request when set, whatever it asks for.
    override: Reply | None = None
    # The reply for the requests that name one model (before `replies`; `override` still wins).
    by_model: dict[str, Reply] = field(default_factory=lambda: {})
    # The charge of an answer in USD, stated in `usage.cost` like OpenRouter; None leaves it out.
    cost: float | None = 0.00042
    # Error messages quote the key that arrived, like a provider that says "Incorrect API key".
    echo_key_in_errors: bool = False
    requests: list[LlmRequest] = field(default_factory=lambda: [])
    # Held requests whose client hung up before the test released them.
    disconnected: list[str] = field(default_factory=lambda: [])
    release: threading.Event = field(default_factory=threading.Event)

    def __post_init__(self) -> None:
        self._lock = threading.Lock()
        self._changed = threading.Condition(self._lock)
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        fake = self

        class Handler(BaseHTTPRequestHandler):
            # HTTP/1.0: one request per connection, so a hung up client is the end of the exchange.
            def log_message(self, format: str, *args: Any) -> None:
                return

            def do_POST(self) -> None:
                fake._handle(self)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self.release.set()
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=10)

    @property
    def port(self) -> int:
        assert self._server is not None
        return int(self._server.server_address[1])

    @property
    def base_url(self) -> str:
        """`llm.baseUrl` of a job."""
        return f"http://127.0.0.1:{self.port}/api/v1"

    def wait_for_request(self, timeout: float = 90.0) -> None:
        """Block until the first request has arrived."""
        deadline = time.monotonic() + timeout
        with self._changed:
            while not self.requests:
                remaining = deadline - time.monotonic()
                assert remaining > 0, "the job never asked the model"
                self._changed.wait(remaining)

    def wait_for_disconnect(self, timeout: float = 60.0) -> bool:
        """Block until a held request saw its client hang up. True if one did."""
        deadline = time.monotonic() + timeout
        with self._changed:
            while not self.disconnected:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._changed.wait(remaining)
        return True

    # ------------------------------------------------------------------ answering

    def _reply_for(self, request: LlmRequest) -> Reply:
        if self.override is not None:
            return self.override
        if request.model in self.by_model:
            return self.by_model[request.model]
        kind = classify(request)
        if kind not in self.replies:
            return Reply(status=500, message=f"the fake LLM has no reply for a {kind} prompt")
        return Reply(content=self.replies[kind])

    def _handle(self, handler: BaseHTTPRequestHandler) -> None:
        length = int(handler.headers.get("Content-Length") or 0)
        raw = handler.rfile.read(length) if length else b"{}"
        try:
            body: dict[str, Any] = json.loads(raw)
        except ValueError:
            body = {}
        request = LlmRequest(handler.path, handler.headers.get("Authorization", ""), body)
        with self._changed:
            self.requests.append(request)
            self._changed.notify_all()
            reply = self._reply_for(request)
        if reply.hold and not self._hold(handler):
            return
        if reply.status != 200:
            message = reply.message
            if self.echo_key_in_errors:
                message = f"Incorrect API key provided: {request.authorization.split(' ')[-1]}"
            self._send(handler, reply.status, {"error": {"message": message, "code": reply.status}})
            return
        self._send(handler, 200, completion(request.model, reply.content, self.cost))

    def _hold(self, handler: BaseHTTPRequestHandler) -> bool:
        """Wait until released or hung up. Returns True if the request should still be answered."""
        deadline = time.monotonic() + _HOLD_LIMIT_SECONDS
        connection = handler.connection
        while time.monotonic() < deadline:
            if self.release.wait(_POLL_SECONDS):
                return True
            readable, _, _ = select.select([connection], [], [], 0)
            if readable and connection.recv(1, 2) == b"":  # 2 = MSG_PEEK: end of stream
                with self._changed:
                    self.disconnected.append("held request")
                    self._changed.notify_all()
                return False
        return False

    def _send(self, handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
        data = json.dumps(payload).encode()
        try:
            handler.send_response(status)
            handler.send_header("Content-Type", "application/json")
            handler.send_header("Content-Length", str(len(data)))
            handler.end_headers()
            handler.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            return


def completion(model: str, content: str, cost: float | None = None) -> dict[str, Any]:
    """A non-streaming chat completion in the OpenAI wire format. `cost` is the charge the provider
    states in `usage.cost` (OpenRouter does), left out when None."""
    usage: dict[str, Any] = {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150}
    if cost is not None:
        usage["cost"] = cost
    return {
        "id": "chatcmpl-fake",
        "object": "chat.completion",
        "created": 1_700_000_000,
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
        "usage": usage,
    }


def classify(request: LlmRequest) -> str:
    """Which prompt a request holds. `/review` is the only tool (#203), so everything is a review
    (a new canned answer for another kind of prompt is added here when a tool returns)."""
    return "review"
