# SPDX-License-Identifier: Apache-2.0

"""Doubles for the unit tests of the passthrough proxy (#550); not a test file.

`ScriptedUpstream` stands behind the `Upstream` seam and answers what a test scripts (a status,
headers and the chunks of a body, or an exception in place of a chunk); `MemorySink` is the
engine's side of the connection. Both write to one `timeline`, so a test can tell that the first
byte reached the engine before the last one was read from the provider.
"""

import json
import secrets
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fakes.wire.formats import (
    FAMILIES,
    Family,
    Turn,
    answer,
    auth_value,
    error_body,
    stream,
)

from code_reviewer_runner.dynamic_review.budget import BudgetLedger, DynamicLimits, UnitCosts
from code_reviewer_runner.dynamic_review.passthrough.admission import PassthroughTarget
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily, spec_of
from code_reviewer_runner.dynamic_review.passthrough.price_book import PriceBook
from code_reviewer_runner.dynamic_review.passthrough.proxy import PassthroughProxy
from code_reviewer_runner.dynamic_review.passthrough.sink import ClientGone
from code_reviewer_runner.dynamic_review.passthrough.upstream import (
    UpstreamError,
    UpstreamRequest,
)

REAL_KEY = "sk-real-key-0123456789abcdefABCDEF"
MODEL = "acme-model-9"
ALLOWANCE = 8192
PRICES = UnitCosts(
    input_usd_per_mtok=Decimal(3),
    output_usd_per_mtok=Decimal(15),
    cache_read_usd_per_mtok=Decimal("0.3"),
    cache_write_usd_per_mtok=Decimal("3.75"),
    cache_write_1h_usd_per_mtok=Decimal(6),
)


def worst_case(body_bytes: int, output_cap: int = 1000, prices: UnitCosts = PRICES) -> Decimal:
    """The most a call can cost (N8 of the review of PR #569): the bytes of the request as tokens
    at the dearest input price there is (plain input or either cache write), and the whole output
    cap at the dearest output price."""
    dearest = max(
        price
        for price in (
            prices.input_usd_per_mtok,
            prices.cache_write_usd_per_mtok,
            prices.cache_write_1h_usd_per_mtok,
        )
        if price is not None
    )
    return (dearest * body_bytes + prices.output_usd_per_mtok * output_cap) / 1_000_000


FAKE: dict[WireFamily, Family] = {
    WireFamily.OPENAI_CHAT: "chat",
    WireFamily.OPENAI_RESPONSES: "responses",
    WireFamily.ANTHROPIC_MESSAGES: "messages",
    WireFamily.GOOGLE: "google",
}
assert set(FAKE.values()) == set(FAMILIES)
TURN = Turn(tool="read", args={"filePath": "/x"})


@dataclass
class Scripted:
    """One answer of the provider: chunks are bytes, or an exception raised in their place."""

    status: int = 200
    headers: list[tuple[str, str]] = field(
        default_factory=lambda: [("content-type", "text/event-stream")]
    )
    chunks: Sequence[bytes | Exception | Callable[[], None]] = ()
    # Raised by `send` instead of answering.
    fails: UpstreamError | None = None


class ScriptedResponse:
    def __init__(self, script: Scripted, timeline: list[str]) -> None:
        self.status = script.status
        self.headers = list(script.headers)
        self._chunks = list(script.chunks)
        self._timeline = timeline
        self.closed = False
        self.reads = 0
        # The timeout each read was given (the proxy sets it before every read).
        self.read_timeouts: list[float | None] = []

    def read(self, size: int, timeout: float | None = None) -> bytes:
        self.reads += 1
        self.read_timeouts.append(timeout)
        # A chunk that is a function is something that happens between two reads (the clock moves).
        chunk = self._next()
        if chunk is None:
            self._timeline.append("read:end")
            return b""
        if isinstance(chunk, Exception):
            self._timeline.append("read:error")
            raise chunk
        self._timeline.append(f"read:{len(self._timeline)}")
        return chunk

    def _next(self) -> bytes | Exception | None:
        while self._chunks:
            chunk = self._chunks.pop(0)
            if isinstance(chunk, (bytes, Exception)):
                return chunk
            chunk()
        return None

    def close(self) -> None:
        self.closed = True


class ScriptedUpstream:
    def __init__(self, *answers: Scripted, on_send: Callable[[], None] | None = None) -> None:
        self._answers = list(answers)
        self.requests: list[UpstreamRequest] = []
        self.timeouts: list[float] = []
        self.responses: list[ScriptedResponse] = []
        self.timeline: list[str] = []
        self._on_send = on_send

    def send(self, request: UpstreamRequest, timeout: float) -> ScriptedResponse:
        self.requests.append(request)
        self.timeouts.append(timeout)
        self.timeline.append("send")
        if self._on_send is not None:
            self._on_send()
        script = self._answers.pop(0) if len(self._answers) > 1 else self._answers[0]
        if script.fails is not None:
            raise script.fails
        response = ScriptedResponse(script, self.timeline)
        self.responses.append(response)
        return response


class MemorySink:
    def __init__(self, timeline: list[str] | None = None, gone_after: int | None = None) -> None:
        self.timeline = timeline if timeline is not None else []
        self.status = 0
        self.headers: list[tuple[str, str]] = []
        self.length: int | None = -1
        self.chunks: list[bytes] = []
        self.ended = False
        self.aborted = False
        self._gone_after = gone_after

    def start(self, status: int, headers: Sequence[tuple[str, str]], length: int | None) -> None:
        self.status, self.headers, self.length = status, list(headers), length
        self.timeline.append("start")

    def write(self, data: bytes) -> None:
        if self._gone_after is not None and len(self.chunks) >= self._gone_after:
            self.timeline.append("gone")
            raise ClientGone
        self.chunks.append(data)
        self.timeline.append(f"write:{len(self.chunks)}")

    def end(self) -> None:
        self.ended = True
        self.timeline.append("end")

    def abort(self) -> None:
        self.aborted = True
        self.timeline.append("abort")

    @property
    def body(self) -> bytes:
        return b"".join(self.chunks)

    def everything(self) -> bytes:
        """Every byte the engine got: status line headers and body."""
        head = "".join(f"{name}: {value}\n" for name, value in self.headers).encode()
        return head + self.body


@dataclass
class Rig:
    proxy: PassthroughProxy
    ledger: BudgetLedger
    upstream: ScriptedUpstream
    family: WireFamily
    capability: str
    clock: list[float]

    def headers(
        self, *extra: tuple[str, str], capability: str | None = None
    ) -> list[tuple[str, str]]:
        spec = spec_of(self.family)
        value = spec.key_value(capability or self.capability)
        sent = [
            (spec.key_header, value),
            ("Content-Type", "application/json"),
            ("Accept-Encoding", "gzip, deflate, br, zstd"),
            ("x-session-id", "ses_1"),
        ]
        if self.family is WireFamily.ANTHROPIC_MESSAGES:
            sent += [("anthropic-version", "2023-06-01")]
        return [*sent, *extra]

    def body(self, size: int = 6000, **overrides: Any) -> bytes:
        """A body of the closed schema of the family, padded to about `size` bytes of text."""
        padding = "x" * size
        document: dict[str, Any]
        if self.family is WireFamily.GOOGLE:
            document = {
                "contents": [{"role": "user", "parts": [{"text": padding}]}],
                "generationConfig": {"maxOutputTokens": 1000},
            }
        elif self.family is WireFamily.OPENAI_RESPONSES:
            document = {
                "model": MODEL,
                "stream": True,
                "max_output_tokens": 1000,
                "input": [{"role": "user", "content": [{"type": "input_text", "text": padding}]}],
            }
        else:
            document = {
                "model": MODEL,
                "stream": True,
                "max_tokens": 1000,
                "messages": [{"role": "user", "content": padding}],
            }
        document.update(overrides)
        return json.dumps(document).encode()

    def target(self) -> str:
        return spec_of(self.family).engine_target(MODEL)

    def post(
        self,
        body: bytes | None = None,
        *,
        sink: MemorySink | None = None,
        headers: list[tuple[str, str]] | None = None,
        target: str | None = None,
        method: str = "POST",
    ) -> MemorySink:
        body = self.body() if body is None else body
        sink = sink or MemorySink(self.upstream.timeline)
        sent = self.headers() if headers is None else headers
        sent = [*sent, ("Content-Length", str(len(body)))]
        self.proxy.handle(method, target or self.target(), sent, lambda length: body[:length], sink)
        return sink


def rig(
    family: WireFamily,
    *answers: Scripted,
    limit: str = "5.00",
    deadline: float = 600.0,
    limits: DynamicLimits | None = None,
    prices: UnitCosts | PriceBook = PRICES,
    superseded: Callable[[], bool] = lambda: False,
    on_send: Callable[[], None] | None = None,
    unknown_cost_ends_run: bool = True,
) -> Rig:
    clock = [0.0]
    ledger = BudgetLedger(
        limits or DynamicLimits(max_cost_usd=Decimal(limit), deadline_seconds=deadline),
        window_tokens=1_000_000,
        output_tokens=ALLOWANCE,
        unit_costs=PRICES,
        # An own key (#553) tolerates a cost that is not known; the proxy and the ledger agree.
        unknown_cost_tolerated=not unknown_cost_ends_run,
        clock=lambda: clock[0],
    )
    upstream = ScriptedUpstream(*answers, on_send=on_send)
    capability = secrets.token_urlsafe(32)
    proxy = PassthroughProxy(
        ledger=ledger,
        target=PassthroughTarget(family=family, model=MODEL, output_allowance=ALLOWANCE),
        upstream=upstream,
        upstream_api_key=REAL_KEY,
        capability=capability,
        prices=prices,
        superseded=superseded,
        unknown_cost_ends_run=unknown_cost_ends_run,
    )
    return Rig(proxy, ledger, upstream, family, capability, clock)


def streamed(family: WireFamily, call: int = 1, **options: Any) -> Scripted:
    """A 200 stream of the generic fake for `call`, one chunk per event."""
    events = stream(FAKE[family], TURN, call, MODEL, **options)
    return Scripted(chunks=list(events))


def document(family: WireFamily, call: int = 1) -> Scripted:
    body = json.dumps(answer(FAKE[family], TURN, call, MODEL)).encode()
    return Scripted(headers=[("content-type", "application/json")], chunks=[body[:40], body[40:]])


def failing(family: WireFamily, status: int, detail: str = "", **headers: str) -> Scripted:
    body = json.dumps(error_body(FAKE[family], status, detail)).encode()
    return Scripted(
        status=status,
        headers=[("content-type", "application/json"), *headers.items()],
        chunks=[body],
    )


def real_key_header(family: WireFamily) -> str:
    return auth_value(FAKE[family], REAL_KEY)


def conversation(family: WireFamily, *turns: tuple[str, str], pad: int = 0) -> bytes:
    """A body of the family's closed schema from `(kind, text)` turns, kind one of `system`,
    `user`, `assistant` and `tool` (a tool result). The order is kept as given, so a test can put
    the same text in the system prompt, in a result or in what the assistant said. `pad` puts that
    many bytes of text in a user message first, so the body weighs what the fake provider's usage
    says it did."""
    if pad:
        turns = (("user", "x" * pad), *turns)
    system: list[str] = [text for kind, text in turns if kind == "system"]
    rest = [(kind, text) for kind, text in turns if kind != "system"]
    document: dict[str, Any]
    if family is WireFamily.GOOGLE:
        contents: list[dict[str, Any]] = []
        for kind, text in rest:
            if kind == "tool":
                part: dict[str, Any] = {
                    "functionResponse": {"name": "read", "response": {"output": text}}
                }
            else:
                part = {"text": text}
            contents.append({"role": "model" if kind == "assistant" else "user", "parts": [part]})
        document = {"contents": contents, "generationConfig": {"maxOutputTokens": 1000}}
        if system:
            document["systemInstruction"] = {"parts": [{"text": text} for text in system]}
    elif family is WireFamily.OPENAI_RESPONSES:
        items: list[dict[str, Any]] = []
        for kind, text in turns:
            if kind == "tool":
                items.append({"type": "function_call_output", "call_id": "c1", "output": text})
            elif kind == "assistant":
                items.append(
                    {"role": "assistant", "content": [{"type": "output_text", "text": text}]}
                )
            else:
                part_type = "input_text"
                items.append({"role": kind, "content": [{"type": part_type, "text": text}]})
        document = {"model": MODEL, "stream": True, "max_output_tokens": 1000, "input": items}
    elif family is WireFamily.ANTHROPIC_MESSAGES:
        messages: list[dict[str, Any]] = []
        for kind, text in rest:
            if kind == "tool":
                block: dict[str, Any] = {
                    "type": "tool_result",
                    "tool_use_id": "c1",
                    "content": text,
                }
                messages.append({"role": "user", "content": [block]})
            elif kind == "assistant":
                messages.append({"role": "assistant", "content": [{"type": "text", "text": text}]})
            else:
                messages.append({"role": "user", "content": text})
        document = {"model": MODEL, "stream": True, "max_tokens": 1000, "messages": messages}
        if system:
            document["system"] = "\n".join(system)
    else:
        chat: list[dict[str, Any]] = []
        for kind, text in turns:
            if kind == "tool":
                chat.append({"role": "tool", "tool_call_id": "c1", "content": text})
            else:
                chat.append({"role": kind, "content": text})
        document = {"model": MODEL, "stream": True, "max_tokens": 1000, "messages": chat}
    return json.dumps(document).encode()
