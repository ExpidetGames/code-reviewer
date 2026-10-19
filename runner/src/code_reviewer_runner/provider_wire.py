# SPDX-License-Identifier: Apache-2.0

"""How the Dynamic proxy speaks to a provider (#511).

The engine always speaks the OpenAI chat protocol to the proxy. A provider that speaks it too
(OpenRouter) needs nothing in between; a provider with a protocol of its own (Anthropic's Messages
API) gets a wire that translates the request the proxy has already checked and the answer it gets
back, so everything after the proxy (the budget ledger, the audit, the wrap-up, the stream the
engine reads) keeps working on one shape: an OpenAI chat completion whose `usage` is what the
provider's cost rule reads.

A wire is built per model (`LlmProviderSpec.wire`), because what a request may carry depends on it.

**Prompt caching (#539)** is part of what a wire decides. Every wire places its own breakpoints and
none copies a mark from the engine: the pinned OpenCode puts a `cache_control` on its messages when
the model id says `claude`, and a request that carried those next to the wire's own would mark one
prefix twice (and a fifth breakpoint is a 400 at Anthropic).
"""

from collections.abc import Callable
from typing import Any, Final, Protocol

from code_reviewer_runner.job_loop.jsonvalues import as_object

# The one breakpoint every mark is made of: the provider's default lifetime of five minutes. Every
# read renews the entry for free and a tool loop calls the model every few seconds, so it never
# expires inside a run; a one hour write costs 2x instead of 1.25x and pays only if the same prefix
# is read again after more than five minutes, which the prefix of one conversation never is.
CACHE_CONTROL: Final = {"type": "ephemeral"}


class UpstreamWire(Protocol):
    def url(self, base: str) -> str:
        """The address of the provider's endpoint for a chat call, from its API base."""
        ...

    def headers(self, api_key: str) -> dict[str, str]:
        """The headers of a call, the credential among them."""
        ...

    def encode_request(self, request: dict[str, Any]) -> dict[str, Any]:
        """The provider's request for a chat request that passed the proxy's allow-list.

        Raises `LimitError` for a request the provider cannot take without changing its meaning.
        """
        ...

    def decode_response(self, body: bytes) -> bytes:
        """The OpenAI chat completion (JSON bytes) for the provider's answer to a 200."""
        ...

    def reserved_output_tokens(self, allowance: int) -> int:
        """The output the cost limit reserves per call, at most the `allowance` the call may use.

        The allowance is the hard cap sent as `max_tokens`, and an answer above it fails the run.
        The reservation is what the ledger holds back before the call; a provider whose calls
        rarely use the whole allowance (thinking raises it, #533) reserves less, so a larger
        allowance does not make the cost guard stop a run earlier.
        """
        ...


class OpenAiChatWire:
    """A provider that speaks the protocol of the engine: nothing is translated."""

    def url(self, base: str) -> str:
        return f"{base}/chat/completions"

    def headers(self, api_key: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    def encode_request(self, request: dict[str, Any]) -> dict[str, Any]:
        return request

    def decode_response(self, body: bytes) -> bytes:
        return body

    def reserved_output_tokens(self, allowance: int) -> int:
        return allowance


def _plain(entry: dict[str, Any]) -> dict[str, Any]:
    """A copy of a message, a part or a tool without a `cache_control` of its own."""
    return {key: value for key, value in entry.items() if key != "cache_control"}


def _plain_all(
    items: object, clean: Callable[[dict[str, Any]], dict[str, Any]]
) -> list[Any] | None:
    """The list with `clean` applied to every object in it; anything else in it passes unchanged,
    so one malformed entry never keeps the marks of the others."""
    if not isinstance(items, list):
        return None
    entries: list[Any] = items  # pyright: ignore[reportUnknownVariableType]
    return [clean(entry) if isinstance(entry, dict) else entry for entry in entries]  # pyright: ignore[reportUnknownVariableType, reportUnknownArgumentType]


def _clean_call(call: dict[str, Any]) -> dict[str, Any]:
    cleaned = _plain(call)
    function: Any = cleaned.get("function")
    if isinstance(function, dict):
        cleaned["function"] = _plain(function)  # pyright: ignore[reportUnknownArgumentType]
    return cleaned


def _clean_message(message: Any) -> Any:
    if not isinstance(message, dict):
        return message
    cleaned = _plain(message)  # pyright: ignore[reportUnknownArgumentType]
    parts = _plain_all(cleaned.get("content"), _plain)
    if parts is not None:
        cleaned["content"] = parts
    # The engine marks the tool calls of an assistant message as well.
    calls = _plain_all(cleaned.get("tool_calls"), _clean_call)
    if calls is not None:
        cleaned["tool_calls"] = calls
    return cleaned


def _clean_tool(tool: Any) -> Any:
    if not isinstance(tool, dict):
        return tool
    cleaned = _plain(tool)  # pyright: ignore[reportUnknownArgumentType]
    function: Any = cleaned.get("function")
    if isinstance(function, dict):
        cleaned["function"] = _plain(function)  # pyright: ignore[reportUnknownArgumentType]
    return cleaned


def _mark_static_prefix(messages: list[Any]) -> None:
    """Mark the end of the leading system messages, the static prefix of the conversation."""
    last: dict[str, Any] | None = None
    for message in messages:
        entry = as_object(message)
        if entry is None or entry.get("role") not in ("system", "developer"):
            break
        last = entry
    if last is None:
        return
    content = last.get("content")
    if isinstance(content, str) and content.strip():
        last["content"] = [{"type": "text", "text": content, "cache_control": dict(CACHE_CONTROL)}]
        return
    if not isinstance(content, list) or not content:
        return
    parts: list[Any] = content  # pyright: ignore[reportUnknownVariableType]
    final = as_object(parts[-1])
    if final is not None and final.get("type") == "text" and str(final.get("text", "")).strip():
        final["cache_control"] = dict(CACHE_CONTROL)


class OpenRouterWire(OpenAiChatWire):
    """OpenRouter: the chat protocol as it is, plus the breakpoints a Claude behind it needs.

    A model of Anthropic (`anthropic/...`) caches only when asked, and OpenRouter documents two
    ways, both used once: a `cache_control` on the text of the system message (the static prefix)
    and the top-level `cache_control`, its automatic caching of the last block that moves forward
    with the conversation. Any other upstream (OpenAI, DeepSeek, Grok, Moonshot, Gemini 2.5 and
    newer) caches by itself, and a parameter it does not know next to `provider.require_parameters`
    would answer "no endpoint found", so those get no mark. Marks the engine put on its messages or
    tools are dropped for every model: the breakpoints of a request are the ones set here.
    """

    def __init__(self, model: str) -> None:
        self._caches_on_request = model.lower().startswith("anthropic/")

    def encode_request(self, request: dict[str, Any]) -> dict[str, Any]:
        body = {key: value for key, value in request.items() if key != "cache_control"}
        raw_messages: Any = body.get("messages")
        if isinstance(raw_messages, list):
            messages = [_clean_message(message) for message in raw_messages]  # pyright: ignore[reportUnknownVariableType]
            body["messages"] = messages
        raw_tools: Any = body.get("tools")
        if isinstance(raw_tools, list):
            body["tools"] = [_clean_tool(tool) for tool in raw_tools]  # pyright: ignore[reportUnknownVariableType]
        if self._caches_on_request and isinstance(body.get("messages"), list):
            _mark_static_prefix(body["messages"])
            body["cache_control"] = dict(CACHE_CONTROL)
        return body
