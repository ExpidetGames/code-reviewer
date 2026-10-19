# SPDX-License-Identifier: Apache-2.0

"""A fake LLM endpoint for the engine suite (OpenRouter shaped and Anthropic's Messages API, on
loopback only).

The Anthropic provider (#511) reaches the same fake through LiteLLM's real Anthropic code path:
`ANTHROPIC_API_BASE` is the fake's address without `/v1`, and the request is
`POST /api/v1/messages` with the key in `x-api-key`. The answer is a message with the usage the
real API reports (`anthropic_usage`, every field of `Message.usage`, #534) and no charge, as the
Claude API states none.

With `prompt_cache` set both protocols keep the cache rules of the docs
(`fakes/llm/anthropic_cache.py`, #539). The usage of an answer is what the request earns from the
cache: cache tokens in the real shape of the Messages API, or `prompt_tokens_details.cached_tokens`
and `cache_write_tokens` with a `usage.cost` that carries the discount for the OpenRouter shape. A
request the API would refuse (more than four breakpoints, a mark on a message object) is answered
with the 400.

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
import sys
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.llm.anthropic_cache import CacheRequestRejected, PromptCache

# A held request ends by itself after this long, so a broken test cannot leave a thread behind.
_HOLD_LIMIT_SECONDS = 120.0
_POLL_SECONDS = 0.05
_REAL_USAGE = (
    Path(__file__).resolve().parents[3] / "fakes" / "fixtures" / "anthropic-message-usage.json"
)


@dataclass
class LlmRequest:
    path: str
    authorization: str
    body: dict[str, Any]
    # The headers of the Messages API: the key and the version of the protocol.
    api_key: str = ""
    anthropic_version: str = ""

    @property
    def is_messages(self) -> bool:
        return self.path.split("?")[0].endswith("/messages")

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
        top_level: Any = self.body.get("system") if role == "system" else None
        if isinstance(top_level, str):
            parts.append(top_level)
        elif isinstance(top_level, list):
            blocks: list[Any] = top_level  # pyright: ignore[reportUnknownVariableType]
            for block in blocks:
                if isinstance(block, dict):
                    fields: dict[str, Any] = block  # pyright: ignore[reportUnknownVariableType]
                    parts.append(str(fields.get("text", "")))
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
    # What an Anthropic answer reports as its usage (#511): the shape the real API returns (#534).
    anthropic_usage: dict[str, Any] = field(default_factory=lambda: real_anthropic_usage(100, 50))
    # The cache of the provider (#539); None: every answer reports the fixed usage above.
    prompt_cache: PromptCache | None = None
    # USD per million tokens of an input and of an output, for the charge of an OpenRouter answer
    # when `prompt_cache` is set: a read costs 0.1x the input price, a write 1.25x.
    cache_prices: tuple[float, float] = (3.0, 15.0)
    # What the cache refused with a 400, as the provider worded it.
    refused: list[str] = field(default_factory=lambda: [])
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
        request = LlmRequest(
            handler.path,
            handler.headers.get("Authorization", ""),
            body,
            api_key=handler.headers.get("x-api-key", ""),
            anthropic_version=handler.headers.get("anthropic-version", ""),
        )
        with self._changed:
            self.requests.append(request)
            self._changed.notify_all()
            reply = self._reply_for(request)
        if reply.hold and not self._hold(handler):
            return
        if reply.status != 200:
            message = reply.message
            if self.echo_key_in_errors:
                key = request.api_key or request.authorization.split(" ")[-1]
                message = f"Incorrect API key provided: {key}"
            if request.is_messages:
                error = {"type": "error", "error": {"type": "api_error", "message": message}}
                self._send(handler, reply.status, error)
                return
            self._send(handler, reply.status, {"error": {"message": message, "code": reply.status}})
            return
        try:
            usage = self._cached_usage(request)
        except CacheRequestRejected as rejected:
            self.refused.append(str(rejected))
            self._send_refusal(handler, request, str(rejected))
            return
        if request.is_messages:
            self._send(
                handler,
                200,
                anthropic_message(request.model, reply.content, usage or self.anthropic_usage),
            )
            return
        self._send(handler, 200, completion(request.model, reply.content, self.cost, usage))

    def _cached_usage(self, request: LlmRequest) -> dict[str, Any] | None:
        """The usage of an answer from the prompt cache, None when the fake has none."""
        if self.prompt_cache is None:
            return None
        if request.is_messages:
            return self.prompt_cache.usage(request.body, self.anthropic_usage)
        counted = self.prompt_cache.usage(
            chat_as_messages(request.body), real_anthropic_usage(0, 50), minimum=1024
        )
        read, written = counted["cache_read_input_tokens"], counted["cache_creation_input_tokens"]
        fresh = counted["input_tokens"]
        price_in, price_out = self.cache_prices
        charge = ((fresh + 0.1 * read + 1.25 * written) * price_in + 50 * price_out) / 1_000_000
        return {
            "prompt_tokens": fresh + read + written,
            "completion_tokens": 50,
            "total_tokens": fresh + read + written + 50,
            "prompt_tokens_details": {"cached_tokens": read, "cache_write_tokens": written},
            "cost": charge,
        }

    def _send_refusal(
        self, handler: BaseHTTPRequestHandler, request: LlmRequest, text: str
    ) -> None:
        if request.is_messages:
            error = {"type": "error", "error": {"type": "invalid_request_error", "message": text}}
            self._send(handler, 400, error)
            return
        self._send(handler, 400, {"error": {"message": text, "code": 400}})

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


def completion(
    model: str,
    content: str,
    cost: float | None = None,
    stated_usage: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """A non-streaming chat completion in the OpenAI wire format. `cost` is the charge the provider
    states in `usage.cost` (OpenRouter does), left out when None; `stated_usage`, when given, is
    the whole usage (with its own charge)."""
    usage: dict[str, Any] = {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150}
    if cost is not None:
        usage["cost"] = cost
    if stated_usage is not None:
        usage = stated_usage
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


def real_anthropic_usage(
    input_tokens: int = 100, output_tokens: int = 50, **fields: Any
) -> dict[str, Any]:
    """The `usage` of a real Messages API answer with every field it carries (#534), from the
    fixture the other fakes and the unit tests share (`fakes/fixtures/anthropic-message-usage.json`,
    the shape of `Message.usage` in the API reference). `fields` replace or add to them.

    The first real Dynamic run failed on `output_tokens_details`, which a fake that only reports
    the token counts never showed."""
    usage: dict[str, Any] = json.loads(_REAL_USAGE.read_text(encoding="utf-8"))
    usage.update(input_tokens=input_tokens, output_tokens=output_tokens, **fields)
    return usage


def anthropic_message(model: str, content: str, usage: dict[str, Any]) -> dict[str, Any]:
    """A non-streaming answer of the Anthropic Messages API: text and a usage, no charge."""
    return {
        "id": "msg_fake",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": [{"type": "text", "text": content}],
        "stop_reason": "end_turn",
        "stop_sequence": None,
        "usage": usage,
    }


def classify(request: LlmRequest) -> str:
    """Which prompt a request holds. `/review` is the only tool (#203), so everything is a review
    (a new canned answer for another kind of prompt is added here when a tool returns)."""
    return "review"


def chat_as_messages(body: dict[str, Any]) -> dict[str, Any]:
    """An OpenAI-shaped request as the cache sees it: the same blocks in the same order, a mark on a
    part or at the top level kept, a mark on a message object left out (OpenRouter takes the
    message and ignores what it does not know; a test reads the recorded body for such a mark)."""
    messages: list[dict[str, Any]] = []
    for raw in body.get("messages", []):
        content: Any = raw.get("content")
        parts: list[Any] = (
            [{"type": "text", "text": content}] if isinstance(content, str) else list(content or [])
        )
        extra = {
            key: value
            for key, value in raw.items()
            if key not in ("role", "content", "cache_control")
        }
        if extra:
            parts.append({"type": "text", "text": json.dumps(extra, sort_keys=True)})
        messages.append({"role": raw.get("role", "user"), "content": parts})
    shaped: dict[str, Any] = {"model": body.get("model", ""), "messages": messages}
    if "cache_control" in body:
        shaped["cache_control"] = body["cache_control"]
    return shaped
